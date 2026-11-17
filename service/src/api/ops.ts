import fs from "node:fs";
import { db, getMeta } from "../core/db.js";
import { loadProjects, loadSettings } from "../core/config.js";
import { safeJson } from "../core/util.js";
import { listConnections } from "../connectors/registry.js";
import { getTask, listTasks, stepsFor, partsOf, type Task } from "../engine/tasks.js";
import { latestApproval } from "../approvals/approvals.js";
import { inbox } from "../notify/router.js";
import { isPaused } from "../engine/engine.js";
import { costReport } from "../engine/budget.js";
import { getPlaybook } from "../engine/playbooks.js";
import { costText } from "../engine/steps.js";
import { normaliseQuestions, questionTexts } from "../core/questions.js";

/** Read-side operations shared by the CLI, the MCP server, the hooks and the local API. */
export function statusSnapshot() {
  const counts = db().prepare("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").all() as { state: string; n: number }[];
  const pausedUntil = getMeta("paused_until");
  return {
    paused: isPaused() ? pausedUntil : null,
    profile: loadSettings().profile,
    provider: loadSettings().models.provider,
    connections: listConnections().map((c) => ({ provider: c.provider, account: c.account, status: c.status })),
    projects: loadProjects().map((p) => ({ id: p.id, jira: p.jira?.keys, repo: p.github?.repo, path: p.local.path, roles: p.roles, autonomy: p.autonomy, status: p.status })),
    tasks: Object.fromEntries(counts.map((c) => [c.state, c.n])),
    lastPoll: safeJson<{ at: string; items: number; tasks: number; errors: string[] } | null>(getMeta("last_poll"), null),
    setup: db().prepare("SELECT step, status, detail FROM setup_progress ORDER BY updated_at").all(),
  };
}

const STEP_LABEL: Record<string, string> = {
  prepare_workspace: "preparing the workspace", context_pack: "reading the project Brain", analyse: "analysing the requirements",
  plan: "planning", plan_review: "reviewing the plan", plan_gate: "waiting for plan approval", implement_test: "implementing and testing",
  reviews: "code / security / QA review", propose_memory: "noting what it learned", prepublish: "final checks (rebase, secret scan, tests)",
  report: "writing the PR description", request_approval: "waiting for PR approval", publish: "raising the PR", record_memory: "updating the Brain",
  requirements_interview: "asking you about the requirements", requirements_confirm: "waiting for you to confirm the requirements",
  requirements_handoff: "handing over to planning",
  understand: "reading the ticket and the code of every repository", contract: "agreeing how the repositories connect",
  lead_plan: "planning every repository", run_parts: "building the repositories", integration_check: "checking the repositories fit together",
  publish_parts: "raising the PRs", part_ready: "done – waiting for the other repositories",
};

/** Plain-language "where is it now" for one task – used by Claude Code (MCP), the Teams chat and the daily check-up. */
export function taskNow(t: Task): { now: string; waitingFor?: string } {
  let total = 0, name = "";
  try { const pb = getPlaybook(t.playbook ?? ""); total = pb.steps.length; name = pb.steps[t.step_index]?.name ?? ""; } catch { /* not triaged yet */ }
  const stepText = name ? `${STEP_LABEL[name] ?? name.replace(/_/g, " ")} (step ${t.step_index + 1} of ${total})` : "";
  const attempt = name === "implement_test" && t.data.implementAttempt ? `, attempt ${t.data.implementAttempt} of ${t.data.implementLoops ?? 3}` : "";
  switch (t.state) {
    case "DETECTED": case "TRIAGED": return { now: "just picked up – sizing the work" };
    case "QUEUED": return { now: stepText ? `queued – next: ${stepText}` : "queued" };
    case "RUNNING": return { now: `${stepText}${attempt}` || "working" };
    case "NEEDS_INFO": return { now: `asked you ${normaliseQuestions(t.data.questions, 10).length > 1 ? "some questions" : "a question"}`, waitingFor: "your answer in Teams" };
    case "AWAITING_START": return { now: "waiting to start", waitingFor: "you to say start" };
    case "AWAITING_APPROVAL": {
      const a = latestApproval(t.id);
      const what = a?.action === "implement_plan" ? "your approval of the plan" : a?.action === "confirm_requirements" ? "you to confirm the requirements" : a?.action === "create_pr" ? "your OK to raise the PR" : "your approval";
      return { now: `ready – waiting for ${what}`, waitingFor: `${what} in Teams` };
    }
    case "PUBLISHING": return { now: "raising the PR" };
    case "PAUSED": return { now: `paused: ${t.error ?? "needs attention"}`, waitingFor: "you to resume it" };
    case "STALE": return { now: "the approval went out of date (code changed)", waitingFor: "a refresh" };
    case "WAITING_PARTS": return { now: `${stepText || "building the repositories"} – ${partsOf(t.id).map((p) => `${p.project_id}: ${taskNow(p).now}`).join("; ") || "starting"}` };
    case "PART_READY": return { now: "built and tested – waiting for the other repositories / the integration check" };
    case "ASKING_LEAD": return { now: "asked the lead engineer a question" };
    case "DONE": return { now: t.data.pr?.url ? `done – PR ${t.data.pr.url}` : t.data.prs?.length ? `done – PRs ${t.data.prs.map((x: any) => x.url).join(" ")}` : "done" };
    case "FAILED": return { now: `failed: ${t.error ?? "unknown error"}` };
    // engine v2 (kernel) states
    case "PR_OPEN": { const u = t.data.pr?.url ?? t.data.prs?.map((x: any) => x.url).join(" "); return { now: u ? `PR open – ${u}` : "PR open" }; }
    case "BLOCKED": return { now: `blocked: ${t.error ?? "waiting for a connection or another item"}` };
    case "MERGED": return { now: "PR merged – closing up" };
    case "CLOSED": return { now: "PR closed without merge", waitingFor: "you to reopen or drop it" };
    default: return { now: t.state.toLowerCase().replace(/_/g, " ") };
  }
}

export function taskSummary(t: Task) {
  const { now, waitingFor } = taskNow(t);
  return {
    id: t.id, ref: t.source_ref, title: t.title, project: t.project_id, kind: t.kind, state: t.state, now, waitingFor, size: t.size,
    playbook: t.playbook, step: t.step_index, tokens: t.tokens_used, cost: Math.round(t.cost_usd * 10000) / 10000,
    branch: t.branch, pr: t.data.pr?.url ?? t.data.prs?.map((x: any) => x.url).join(" "), error: t.error, updated: t.updated_at,
    lead: t.data.leadId, targets: t.playbook === "dev-lead" ? t.data.targets : undefined,
  };
}

/** Rough durations of the steps (wall clock, from real runs) – for "how long will it take?". */
const STEP_MINUTES: Record<string, [number, number]> = {
  understand: [3, 8], contract: [2, 4], lead_plan: [3, 6], plan_review: [1, 3], analyse: [2, 5], plan: [2, 5],
  run_parts: [15, 45], implement_test: [10, 30], reviews: [3, 8], prepublish: [1, 3], report: [1, 2],
  integration_check: [3, 8], requirements_interview: [1, 3],
};

/** "Plan in about 5–12 min" while it is working; nothing when it is waiting for you. */
export function etaText(t: Task): string | undefined {
  if (!["RUNNING", "QUEUED", "WAITING_PARTS"].includes(t.state)) return undefined;
  let steps: string[] = [];
  try { steps = getPlaybook(t.playbook ?? "").steps.map((s) => s.name); } catch { return undefined; }
  const rest = steps.slice(t.step_index);
  const gate = rest.findIndex((s) => s === "plan_gate" || s === "request_approval");
  const until = gate >= 0 ? rest.slice(0, gate) : rest;
  const [lo, hi] = until.reduce(([a, b], s) => { const m = STEP_MINUTES[s]; return m ? [a + m[0], b + m[1]] : [a, b]; }, [0, 0]);
  if (!hi) return undefined;
  const what = rest[gate] === "plan_gate" ? "the plan for your approval" : rest[gate] === "request_approval" ? "ready for your PR approval" : "done";
  return `Expected: ${what} in about ${lo}–${hi} min`;
}

/** One short chat answer for "what's the status of KAN-42?". */
export function statusText(ref: string): string | undefined {
  const t = getTask(ref);
  if (!t) return undefined;
  const { now, waitingFor } = taskNow(t);
  const lines = [`- **Now:** ${now}`];
  if (waitingFor) lines.push(`- **Waiting for:** ${waitingFor}`);
  const eta = etaText(t);
  if (eta) lines.push(`- **${eta.replace(/^Expected: /, "Expected:** ")}`);
  if (t.kind !== "part" && t.tokens_used > 0) lines.push(`- **${costText(t).replace(/^Cost so far: /, "Cost so far:** ")}`);
  if (t.data.pr?.url) lines.push(`- **PR:** ${t.data.pr.url}`);
  for (const pr of t.data.prs ?? []) lines.push(`- **PR:** ${pr.url}`);
  if (t.branch) lines.push(`- **Branch:** ${t.branch}`);
  const blocks = [`📌 **${t.source_ref ?? t.id}** – ${t.title ?? ""}`, lines.join("\n")];
  // a ticket across repositories: one line per repository
  const parts = t.playbook === "dev-lead" ? partsOf(t.id) : [];
  if (parts.length) blocks.push(`📦 **Repositories** (${t.data.order === "parallel" ? "built at the same time" : "built in order"})\n${parts.map((p) => `- ${p.project_id}: ${taskNow(p).now}${p.branch ? ` (branch ${p.branch})` : ""}`).join("\n")}`);
  else if (t.playbook === "dev-lead" && t.data.targets?.length) blocks.push(`📦 **Repositories:** ${t.data.targets.join(t.data.order === "parallel" ? " + " : " → ")}`);
  return blocks.join("\n\n");
}

export function taskDetail(ref: string) {
  const t = getTask(ref);
  if (!t) return undefined;
  const a = latestApproval(t.id);
  let report: string | undefined;
  const file = t.data.report?.file ?? t.data.artefact?.file;
  if (file) { try { report = fs.readFileSync(file, "utf8"); } catch { /* removed */ } }
  return {
    ...taskSummary(t),
    ticketUrl: t.data.ticket?.url, questions: t.data.questions ? questionTexts(t.data.questions) : undefined,
    plan: t.data.plan, requirements: t.data.agreedRequirements ?? t.data.requirementsDraft, worktree: t.worktree,
    approval: a ? { id: a.id, action: a.action, state: a.state, head: a.head_sha?.slice(0, 7), expires: a.expires_at, approver: a.approver, channel: a.channel } : undefined,
    steps: stepsFor(t.id).map((s) => ({ name: s.name, status: s.status, agent: s.agent, model: s.model, tokens: s.tokens_in + s.tokens_out, error: s.error, note: safeJson<any>(s.output, {})?.note })),
    report,
  };
}

export function tasksList(states?: string[], limit = 50) {
  return listTasks({ states: states as any, limit }).map(taskSummary).reverse();
}

export function inboxView(all = false) {
  return inbox(all).map((i) => ({ id: i.id, task: i.task_id, ref: i.notice.taskRef, kind: i.kind, title: i.title,
    body: i.notice.questions?.length ? `${i.notice.body}\n${questionTexts(i.notice.questions).map((q) => `• ${q}`).join("\n")}` : i.notice.body, at: i.created_at }));
}

export function inboxSummaryLine(): string {
  const items = inbox(false);
  const approvals = items.filter((i) => i.kind === "approval_needed").length;
  const questions = items.filter((i) => i.kind === "needs_info").length;
  const problems = items.filter((i) => ["failed", "paused", "connector_problem", "stale"].includes(i.kind)).length;
  const running = (db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE state IN ('RUNNING','QUEUED')").get() as any).n;
  const parts = [approvals && `${approvals} awaiting approval`, questions && `${questions} question${questions > 1 ? "s" : ""}`, problems && `${problems} need attention`, running && `${running} in progress`].filter(Boolean);
  return parts.length ? `AIW: ${parts.join(" · ")}` : "AIW: all clear";
}

export function cost(days = 7) { return costReport(days); }
