import { db, getMeta } from "../core/db.js";
import { loadSettings } from "../core/config.js";
import { safeJson } from "../core/util.js";
import { readRuntime, VERSION } from "../core/runtime.js";
import { normaliseQuestions, approvalChoices } from "../core/questions.js";
import { getTask, listTasks, partsOf, stepsFor, type Task, type State } from "../engine/tasks.js";
import { getPlaybook } from "../engine/playbooks.js";
import { isPaused } from "../engine/engine.js";
import { latestApproval } from "../approvals/approvals.js";
import { AGENTS } from "../agents/catalog.js";
import { taskNow, etaText } from "./ops.js";
import { listTimers } from "../core/timers.js";
import { listActivity, progressFrom, type ActivityRow } from "../live/activity.js";
import { snapshot } from "../live/bus.js";

/**
 * Read-side data for the live dashboard (W19, module 5.26). Everything is plain words, not codes:
 * states become labels ("Waiting for you"), steps become stages (Waiting → Understand & plan → Building →
 * Reviewing → PR open → Done), and every action the page can take is described here as {method, path, body}
 * on an EXISTING route, so the page has no logic of its own about what is allowed.
 */

export type Tone = "work" | "you" | "ok" | "bad" | "wait";
export type StageKey = "waiting" | "plan" | "build" | "review" | "pr" | "done";
export interface Action { label: string; method: "POST"; path: string; body?: Record<string, unknown>; ask?: string; primary?: boolean; local?: boolean }

export const STAGES: [StageKey, string][] = [
  ["waiting", "Waiting"], ["plan", "Understand & plan"], ["build", "Building"], ["review", "Reviewing"], ["pr", "PR open"], ["done", "Done"],
];

export const STATE_LABEL: Record<string, string> = {
  DETECTED: "Just arrived", TRIAGED: "Sized", NEEDS_INFO: "Question for you", AWAITING_START: "Waiting for your start",
  QUEUED: "Queued", RUNNING: "Working", PAUSED: "Paused", AWAITING_APPROVAL: "Waiting for you", PUBLISHING: "Raising the PR",
  DONE: "Done", CANCELLED: "Cancelled", FAILED: "Failed", REJECTED: "Changes asked", STALE: "Approval out of date",
  FAILED_PUBLISH: "PR could not be raised", WAITING_PARTS: "Building the repositories", PART_READY: "Ready, waiting for the others",
  ASKING_LEAD: "Asked the lead", PR_OPEN: "PR open",
};

const TONE: Record<string, Tone> = {
  DETECTED: "wait", TRIAGED: "wait", QUEUED: "wait", NEEDS_INFO: "you", AWAITING_START: "you", AWAITING_APPROVAL: "you",
  STALE: "you", PAUSED: "you", REJECTED: "work", RUNNING: "work", PUBLISHING: "work", WAITING_PARTS: "work", PART_READY: "work",
  ASKING_LEAD: "work", DONE: "ok", CANCELLED: "wait", FAILED: "bad", FAILED_PUBLISH: "bad",
};

const STEP_STAGE: Record<string, StageKey> = {
  prepare_workspace: "plan", context_pack: "plan", analyse: "plan", plan: "plan", plan_review: "plan", plan_gate: "plan",
  requirements_interview: "plan", requirements_confirm: "plan", requirements_handoff: "plan",
  understand: "plan", contract: "plan", lead_plan: "plan",
  fix_prepare: "plan", fix_plan: "plan", qa_prepare: "plan", qa_plan: "plan", fetch_pr: "plan",
  implement_test: "build", run_parts: "build", fix_apply: "build", qa_run: "build",
  reviews: "review", propose_memory: "review", prepublish: "review", report: "review", request_approval: "review",
  integration_check: "review", fix_review: "review", fix_gate: "review", review_pr: "review", review_gate: "review",
  qa_triage: "review", qa_gate: "review", part_ready: "review",
  publish: "pr", publish_parts: "pr", fix_publish: "pr", post_review: "pr", qa_publish: "pr", ticket_report: "pr", record_memory: "pr",
};

const STEP_TEXT: Record<string, string> = {
  prepare_workspace: "Prepared the workspace", context_pack: "Read the project notes", analyse: "Understood the ticket",
  plan: "Wrote the plan", plan_review: "Checked the plan", plan_gate: "Plan approval", implement_test: "Built and tested",
  reviews: "Code, security and QA review", propose_memory: "Noted what it learned", prepublish: "Final checks",
  report: "Wrote the PR description", request_approval: "PR approval", publish: "Raised the PR", ticket_report: "Sent the ticket report",
  record_memory: "Updated the project notes", requirements_interview: "Asked about the requirements", requirements_confirm: "Requirements confirmed",
  requirements_handoff: "Handed over to planning", understand: "Read the ticket and every repository", contract: "Agreed how the repositories connect",
  lead_plan: "Planned every repository", run_parts: "Built the repositories", integration_check: "Checked the repositories fit together",
  publish_parts: "Raised the PRs", part_ready: "Part ready", fix_prepare: "Read the PR comments and checks", fix_plan: "Decided what to fix",
  fix_apply: "Made the fixes", fix_review: "Checked the fixes", fix_gate: "Fixes shown to you", fix_publish: "Pushed the fixes",
  qa_prepare: "Got the PR ready to test", qa_plan: "Wrote the test plan", qa_run: "Ran the tests", qa_triage: "Sorted the findings",
  qa_gate: "QA result shown to you", qa_publish: "Posted the QA result", fetch_pr: "Read the PR", review_pr: "Reviewed the PR",
  review_gate: "Review shown to you", post_review: "Posted the review",
};

/** The agent that usually does a step (steps.agent is only filled when the step ends). */
const STEP_AGENT: Record<string, string> = {
  analyse: "analyst", plan: "planner", plan_review: "plan-reviewer", implement_test: "implementer", reviews: "reviewer", report: "reporter",
  propose_memory: "memory-keeper", record_memory: "memory-keeper", understand: "lead", contract: "contract", lead_plan: "lead-planner",
  run_parts: "coordinator", integration_check: "integration-reviewer", review_pr: "pr-reviewer", fix_plan: "comment-resolver",
  fix_apply: "implementer", fix_review: "reviewer", qa_plan: "qa-planner", qa_run: "qa-tester", qa_triage: "qa-triager",
  requirements_interview: "interviewer", ticket_report: "report-writer",
};

const AGENT_NAME: Record<string, string> = {
  triage: "Sorter", analyst: "Analyst", planner: "Planner", "plan-reviewer": "Plan checker", implementer: "Implementer", reviewer: "Reviewer",
  reporter: "PR writer", "memory-keeper": "Note keeper", "rules-writer": "Rules writer", onboarder: "Onboarder", "doc-reader": "Document reader",
  intent: "Conductor", interviewer: "Interviewer", explorer: "Explorer", lead: "Lead engineer", contract: "Contract writer",
  "lead-planner": "Lead planner", coordinator: "Coordinator", "integration-reviewer": "Integration checker", analyser: "Analyser",
  "pr-reviewer": "PR reviewer", screenshotter: "Screenshot taker", "comment-resolver": "Comment fixer", "qa-planner": "QA planner",
  "qa-tester": "QA engineer", "qa-triager": "QA sorter", "stack-profiler": "Setup checker", "report-writer": "Report writer",
};

/** What the ready (idle) agents do, for the Agents view. */
const AGENT_ROLE: [string, string][] = [
  ["intent", "Reads your Teams messages and decides what to do."],
  ["planner", "Reads the ticket, designs and code, then writes the plan."],
  ["implementer", "Writes the code and runs the tests for one repository."],
  ["reviewer", "Checks the change against the plan and the team's standards."],
  ["lead", "Splits a ticket across repositories and keeps them in step."],
  ["pr-reviewer", "Reviews a pull request and shows you the comments first."],
  ["comment-resolver", "Works through review comments and failing checks on your PR."],
  ["qa-tester", "Tests a PR like a user would and drafts issues for you."],
];

export const agentName = (a?: string | null) => (a ? AGENT_NAME[a] ?? a.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "");

/** The model behind an agent, in short words ("Opus", "Sonnet", "Haiku", "Test model"). */
export function agentTier(agent?: string | null, model?: string | null): string {
  const s = loadSettings();
  if (s.models.provider === "mock") return "Test model";
  const m = (model ?? (agent && AGENTS[agent] ? s.models[AGENTS[agent].tier] : "") ?? "").toLowerCase();
  if (m.includes("opus")) return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku")) return "Haiku";
  const tier = agent && AGENTS[agent]?.tier;
  return tier ? tier[0].toUpperCase() + tier.slice(1) : "";
}

function steps(t: Task): string[] {
  try { return getPlaybook(t.playbook ?? "").steps.map((s) => s.name); } catch { return []; }
}
const currentStep = (t: Task) => steps(t)[t.step_index];

export function stateLabel(t: Pick<Task, "state" | "data">): string {
  if (t.state === "DONE" && hasOpenPr(t)) return STATE_LABEL.PR_OPEN;
  if (t.state === "PAUSED" && t.data?.stuck) return "Stuck";                // E13: an agent hit its round limit
  return STATE_LABEL[t.state] ?? t.state.toLowerCase().replace(/_/g, " ");
}
export const stateTone = (t: Pick<Task, "state">): Tone => TONE[t.state] ?? "wait";

function prUrls(t: Pick<Task, "data">): string[] {
  return [t.data.pr?.url, ...(Array.isArray(t.data.prs) ? t.data.prs.map((x: any) => x?.url) : [])].filter((x): x is string => typeof x === "string" && !!x);
}
const prLabel = (url: string) => { const m = /\/pull\/(\d+)/.exec(url); return m ? `#${m[1]}` : url; };
const hasOpenPr = (t: Pick<Task, "data">) => prUrls(t).length > 0 && !t.data.merged && !t.data.prMerged && !t.data.prClosed;

/** Board stage of a task: where the work is, independent of who it waits for. */
export function stageOf(t: Task): StageKey {
  if (t.state === "DONE") return hasOpenPr(t) ? "pr" : "done";
  if (t.state === "CANCELLED") return "done";
  if (["DETECTED", "TRIAGED", "AWAITING_START"].includes(t.state)) return "waiting";
  if (t.state === "PUBLISHING" || t.state === "FAILED_PUBLISH") return "pr";
  if (t.state === "PART_READY") return "review";
  if (t.state === "WAITING_PARTS") return "build";
  const step = currentStep(t);
  if (t.state === "QUEUED" && t.step_index === 0 && !stepsFor(t.id).length) return "waiting";
  if (!step) return t.state === "NEEDS_INFO" ? "plan" : "waiting";
  return STEP_STAGE[step] ?? "plan";
}

/** % of the recipe done for one task. */
function pctOf(t: Task): number {
  if (["DONE", "PART_READY"].includes(t.state)) return 100;
  return progressFrom(t.step_index, steps(t).length);
}

const nowText = (t: Task) => taskNow(t).now;

// ------------------------------------------------------------------ needs you

export interface NeedItem {
  id: string; kind: "question" | "start" | "approval" | "problem"; taskId: string; ref: string; title: string; detail: string;
  options: Action[]; recommended?: number; freeText?: Action; at: string;
}

const short = (s: unknown, n = 220) => { const t = String(s ?? "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const refOf = (t: Task) => t.source_ref ?? t.id;

const APPROVAL_TITLE: Record<string, string> = {
  implement_plan: "Approve the plan?", create_pr: "Raise the PR?", confirm_requirements: "Confirm the requirements?",
  post_review: "Post the review comments?", push_fixes: "Push the fixes?", create_issues: "Post the QA result?", post_jira_comment: "Post the Jira comment?",
};

/** Questions, "start?" for large tasks, approvals and stopped work – each with the actions that answer it. */
export function needsYou(): NeedItem[] {
  const out: NeedItem[] = [];
  for (const t of listTasks({ states: ["NEEDS_INFO", "AWAITING_START", "AWAITING_APPROVAL", "STALE", "PAUSED", "FAILED", "FAILED_PUBLISH"], limit: 100 })) {
    if (t.kind === "part" && t.state !== "NEEDS_INFO") continue;           // the lead carries approvals for its parts
    const ref = refOf(t);
    const base = { taskId: t.id, ref, at: t.updated_at };
    if (t.state === "NEEDS_INFO") {
      const qs = normaliseQuestions(t.data.questions, 10);
      const one = qs.length === 1 ? qs[0] : undefined;
      out.push({
        ...base, id: `q:${t.id}`, kind: "question",
        title: one ? one.question : qs.length ? `${qs.length} questions` : "A question for you",
        detail: one ? short(t.title ?? "") : short(qs.map((q, i) => `${i + 1}. ${q.question}`).join("  ")),
        options: one ? one.options.map((o, i) => ({ label: o, method: "POST" as const, path: "/api/answer", body: { ref: t.id, answer: String(i + 1) } })) : [],
        recommended: one?.options.length ? 0 : undefined,
        freeText: { label: "Answer", method: "POST", path: "/api/answer", body: { ref: t.id }, ask: qs.length > 1 ? "Your answers (one per question, in order)" : "Your answer" },
      });
    } else if (t.state === "AWAITING_START") {
      out.push({
        ...base, id: `s:${t.id}`, kind: "start", title: `Start "${short(t.title ?? ref, 80)}"?${t.size ? ` (size ${t.size})` : ""}`,
        detail: "Large tasks wait for your go-ahead.",
        options: [{ label: "Start", method: "POST", path: `/api/tasks/${encodeURIComponent(t.id)}/start`, primary: true },
          { label: "Later", method: "POST", path: "", local: true }],
        recommended: 0,
      });
    } else if (t.state === "AWAITING_APPROVAL") {
      const a = latestApproval(t.id);
      if (!a || a.state !== "pending") continue;
      const choices = approvalChoices(a.action);
      out.push({
        ...base, id: `a:${a.id}`, kind: "approval", title: APPROVAL_TITLE[a.action] ?? "Approve?", detail: short(t.title ?? ""),
        options: [
          { label: choices[0], method: "POST", path: `/api/approve/${encodeURIComponent(a.id)}`, body: { channel: "dashboard" }, primary: true },
          { label: "Change something", method: "POST", path: `/api/reject/${encodeURIComponent(a.id)}`, body: { channel: "dashboard" }, ask: "What should change?" },
        ],
        recommended: 0,
      });
    } else {
      out.push({
        ...base, id: `p:${t.id}`, kind: "problem", title: stateLabel(t), detail: short(t.error ?? nowText(t)),
        options: [{ label: t.state === "STALE" ? "Refresh" : "Resume", method: "POST", path: `/api/tasks/${encodeURIComponent(t.id)}/resume`, primary: true }],
        recommended: 0,
      });
    }
  }
  const order = { question: 0, approval: 1, start: 2, problem: 3 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.at.localeCompare(b.at));
}

// ------------------------------------------------------------------ working now

export interface WorkingCard {
  taskId: string; ref: string; title: string; repo: string; agent: string; agentLabel: string; tier: string;
  line: string; progress: number; minutes: number; tokens: number; step: string;
}

function runningStep(taskId: string): { name: string; agent: string | null; model: string | null; started_at: string } | undefined {
  return db().prepare("SELECT name, agent, model, started_at FROM steps WHERE task_id=? AND status='running' ORDER BY id DESC LIMIT 1").get(taskId) as any;
}

/** One card per running job: agent, model, ticket and repo, the plain activity line, progress, minutes, tokens. */
export function workingNow(now = Date.now()): WorkingCard[] {
  const act = new Map<string, ActivityRow>(listActivity().map((a) => [a.task_id, a]));
  return listTasks({ states: ["RUNNING", "PUBLISHING"], limit: 50 }).map((t) => {
    const a = act.get(t.id);
    const st = runningStep(t.id);
    const step = a?.step ?? st?.name ?? currentStep(t) ?? "";
    const agent = a?.agent ?? st?.agent ?? STEP_AGENT[step] ?? "";
    const since = a?.started_at ?? st?.started_at ?? t.updated_at;
    const lead = t.kind === "part" && t.data.leadId ? getTask(t.data.leadId) : undefined;
    return {
      taskId: t.id, ref: lead ? refOf(lead) : refOf(t), title: t.title ?? "", repo: t.project_id,
      agent, agentLabel: agentName(agent) || "Working", tier: agentTier(agent, st?.model),
      line: a?.line ?? nowText(t), progress: a?.progress ?? pctOf(t),
      minutes: Math.max(0, Math.round((now - new Date(since).getTime()) / 60_000)),
      tokens: a?.tokens ?? t.tokens_used, step,
    };
  });
}

// ------------------------------------------------------------------ board

export interface BoardCard {
  id: string; ref: string; title: string; size: string | null; state: State; label: string; tone: Tone; stage: StageKey;
  now: string; parts: { repo: string; pct: number; state: string }[]; prs: { url: string; label: string }[];
  tokens: number; cost: number; updated: string; ticketUrl?: string;
}

export function boardCard(t: Task): BoardCard {
  const parts = t.playbook === "dev-lead" ? partsOf(t.id) : [];
  const done = t.state === "DONE";
  return {
    id: t.id, ref: refOf(t), title: t.title ?? "", size: t.size, state: t.state, label: stateLabel(t),
    tone: done ? "ok" : stateTone(t), stage: stageOf(t), now: nowText(t),
    parts: parts.length ? parts.map((p) => ({ repo: p.project_id, pct: pctOf(p), state: stateLabel(p) }))
      : t.playbook === "dev-lead" && Array.isArray(t.data.targets) ? t.data.targets.map((r: string) => ({ repo: r, pct: 0, state: "Not started" }))
      : [{ repo: t.project_id, pct: pctOf(t), state: stateLabel(t) }],
    prs: prUrls(t).map((url) => ({ url, label: prLabel(url) })),
    tokens: t.tokens_used + parts.reduce((n, p) => n + p.tokens_used, 0),
    cost: Math.round((t.cost_usd + parts.reduce((n, p) => n + p.cost_usd, 0)) * 100) / 100,
    updated: t.updated_at, ticketUrl: t.data.ticket?.url,
  };
}

/** The board: every lane with its cards. Finished work stays visible for `doneDays` days. */
export function board(doneDays = 14): { stages: { key: StageKey; label: string; items: BoardCard[] }[] } {
  const since = new Date(Date.now() - doneDays * 86_400_000).toISOString();
  const rows = (db().prepare(`SELECT id FROM tasks WHERE kind != 'part' AND state != 'CANCELLED' AND (state NOT IN ('DONE') OR updated_at >= ?)
    ORDER BY priority ASC, created_at ASC LIMIT 300`).all(since) as { id: string }[]);
  const cards = rows.map((r) => getTask(r.id)).filter((t): t is Task => !!t).map(boardCard);
  return { stages: STAGES.map(([key, label]) => ({ key, label, items: cards.filter((c) => c.stage === key) })) };
}

// ------------------------------------------------------------------ item timeline (the drawer)

export interface TimelineEntry { at: string | null; title: string; who?: string; mark: "done" | "cur" | "ask" | "bad" | "todo" }

/** Everything about one ticket for the drawer: now, stage, what happened, questions, tokens, cost, PRs, actions. */
export function itemTimeline(id: string) {
  const t = getTask(id);
  if (!t) return undefined;
  const parts = t.playbook === "dev-lead" ? partsOf(t.id) : [];
  const ids = [t.id, ...parts.map((p) => p.id)];
  const ph = ids.map(() => "?").join(",");
  const entries: TimelineEntry[] = [];

  entries.push({ at: t.created_at, title: t.source === "jira" ? "Arrived from Jira" : "Work started", who: [t.size ? `size ${t.size}` : "", t.project_id].filter(Boolean).join(" · "), mark: "done" });

  const stepRows = db().prepare(`SELECT task_id, name, agent, model, status, tokens_in, tokens_out, started_at, ended_at, error FROM steps WHERE task_id IN (${ph}) ORDER BY id`).all(...ids) as any[];
  for (const s of stepRows) {
    if (s.status === "skipped") continue;
    const part = s.task_id !== t.id ? parts.find((p) => p.id === s.task_id)?.project_id : undefined;
    const tokens = (s.tokens_in ?? 0) + (s.tokens_out ?? 0);
    const who = [agentName(s.agent ?? STEP_AGENT[s.name]), part, tokens ? `${Math.round(tokens / 1000)}k tokens` : ""].filter(Boolean).join(" · ");
    const mark: TimelineEntry["mark"] = s.status === "running" ? "cur" : s.status === "failed" || s.status === "error" ? "bad" : s.status === "waiting" ? "ask" : "done";
    entries.push({ at: s.ended_at ?? s.started_at, title: (STEP_TEXT[s.name] ?? s.name.replace(/_/g, " ")) + (mark === "bad" && s.error ? `: ${short(s.error, 100)}` : ""), who, mark });
  }

  for (const a of db().prepare(`SELECT * FROM approvals WHERE task_id IN (${ph}) ORDER BY requested_at`).all(...ids) as any[]) {
    entries.push({ at: a.requested_at, title: `Asked you: ${(APPROVAL_TITLE[a.action] ?? "approve?").replace(/\?$/, "").toLowerCase()}`, mark: a.state === "pending" ? "ask" : "done" });
    if (a.decided_at && (a.state === "approved" || a.state === "rejected")) {
      entries.push({ at: a.decided_at, title: a.state === "approved" ? "You approved" : `You asked for changes${a.reason ? `: ${short(a.reason, 120)}` : ""}`, who: a.channel ? `via ${a.channel}` : undefined, mark: "done" });
    }
  }

  for (const c of (Array.isArray(t.data.clarifications) ? t.data.clarifications : []) as any[]) {
    entries.push({ at: c.at ?? null, title: `You answered: ${short(c.reply ?? c.answer, 120)}`, who: short((c.questions ?? []).join(" / "), 140), mark: "done" });
  }

  const SKIP = new Set(["approval_needed", "needs_info"]);
  const seen = new Set<string>();
  for (const n of db().prepare(`SELECT kind, title, created_at FROM notifications WHERE task_id IN (${ph}) AND channel='inbox' ORDER BY created_at`).all(...ids) as any[]) {
    if (SKIP.has(n.kind) || seen.has(n.title)) continue;
    seen.add(n.title);
    entries.push({ at: n.created_at, title: short(n.title, 140), mark: n.kind === "failed" || n.kind === "paused" ? "bad" : "done" });
  }

  const refs = [t.source_ref, t.id].filter(Boolean) as string[];
  const chat = db().prepare(`SELECT ts, direction, text FROM chat_log WHERE item_id IN (${ph}) OR task_ref IN (${refs.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 20`).all(...ids, ...refs) as any[];
  for (const c of chat.reverse()) entries.push({ at: c.ts, title: c.direction === "in" ? `You said: ${short(c.text, 120)}` : `Sent you: ${short(c.text, 120)}`, who: "Teams", mark: "done" });

  entries.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));

  // what is still to come
  const all = steps(t);
  if (!["DONE", "CANCELLED", "FAILED"].includes(t.state)) {
    const startedNow = stepRows.some((s) => s.task_id === t.id && s.status === "running");
    for (const name of all.slice(t.step_index + (startedNow ? 1 : 0))) entries.push({ at: null, title: STEP_TEXT[name] ?? name.replace(/_/g, " "), mark: "todo" });
  }

  const stage = stageOf(t);
  const a = latestApproval(t.id);
  const actions: Action[] = [];
  if (t.state === "AWAITING_START") actions.push({ label: "Start", method: "POST", path: `/api/tasks/${encodeURIComponent(t.id)}/start`, primary: true });
  if (t.state === "AWAITING_APPROVAL" && a?.state === "pending") {
    actions.push({ label: approvalChoices(a.action)[0], method: "POST", path: `/api/approve/${encodeURIComponent(a.id)}`, body: { channel: "dashboard" }, primary: true });
    actions.push({ label: "Change something", method: "POST", path: `/api/reject/${encodeURIComponent(a.id)}`, body: { channel: "dashboard" }, ask: "What should change?" });
  }
  if (["PAUSED", "FAILED", "STALE", "FAILED_PUBLISH"].includes(t.state)) actions.push({ label: t.state === "STALE" ? "Refresh" : "Resume", method: "POST", path: `/api/tasks/${encodeURIComponent(t.id)}/resume`, primary: true });
  const { now, waitingFor } = taskNow(t);
  return {
    ...boardCard(t), now, waitingFor, eta: etaText(t), stageIndex: STAGES.findIndex(([k]) => k === stage),
    stages: STAGES.map(([key, label]) => ({ key, label })),
    agent: agentName(runningStep(t.id)?.agent ?? STEP_AGENT[currentStep(t) ?? ""]) || undefined,
    questions: normaliseQuestions(t.data.questions, 10),
    branch: t.branch, error: t.error ?? undefined, kind: t.kind,
    timeline: entries, actions,
  };
}

// ------------------------------------------------------------------ agents, queue

function queueReason(t: Task, runningCount: number, maxParallel: number): { why: string; tone: Tone } {
  if (t.state === "AWAITING_START") return { why: "Needs your start", tone: "you" };
  if (isPaused()) return { why: "New work is paused", tone: "you" };
  if (t.data.retryAt && new Date(t.data.retryAt).getTime() > Date.now()) {
    return { why: `Tries again at ${new Date(t.data.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, tone: "wait" };
  }
  if (t.data.waitFor) {
    const lead = getTask(t.data.waitFor);
    if (lead && !["DONE", "CANCELLED", "FAILED", "AWAITING_APPROVAL", "NEEDS_INFO"].includes(lead.state)) return { why: `Waits for ${refOf(lead)}`, tone: "wait" };
  }
  if (t.kind === "part" && t.data.leadId) {
    const lead = getTask(t.data.leadId);
    if (lead && lead.data.order !== "parallel") {
      const targets: string[] = lead.data.targets ?? [];
      const before = targets.slice(0, Math.max(0, targets.indexOf(t.project_id)));
      const ps = partsOf(lead.id);
      if (before.some((r) => { const p = ps.find((x) => x.project_id === r); return !!p && !["PART_READY", "DONE"].includes(p.state); })) {
        return { why: "Waits for the repository before it", tone: "wait" };
      }
    }
  }
  if (runningCount >= maxParallel) return { why: "Waiting for a free slot", tone: "wait" };
  return { why: "Starting soon", tone: "work" };
}

/** Busy agents, ready agents with what they do, and the queue with why each item waits. */
export function agents() {
  const s = loadSettings();
  const busy = workingNow();
  const busyAgents = new Set(busy.map((b) => b.agent));
  const queued = listTasks({ states: ["QUEUED", "AWAITING_START"], limit: 100 });
  const queue = queued.map((t, i) => ({ pos: i + 1, taskId: t.id, ref: refOf(t), title: t.title ?? "", repo: t.project_id, ...queueReason(t, busy.length, s.limits.maxParallel) }));
  return {
    slots: { used: busy.length, total: s.limits.maxParallel, perRepo: s.limits.maxPerProject },
    busy,
    ready: AGENT_ROLE.filter(([k]) => !busyAgents.has(k)).map(([k, what]) => ({ agent: k, label: agentName(k), tier: agentTier(k), what })),
    queue,
  };
}

// ------------------------------------------------------------------ background timers

export function timers() {
  return listTimers().map((x) => ({
    name: x.name, detail: x.detail ?? "", every: x.every, lastRun: x.lastRun, nextRun: x.nextRun, state: x.state,
    label: x.state === "running" ? "Running" : x.state === "failed" ? "Failed" : x.state === "healthy" ? "Healthy" : "Scheduled",
    tone: (x.state === "running" ? "work" : x.state === "failed" ? "bad" : x.state === "healthy" ? "ok" : "wait") as Tone,
    error: x.error,
  }));
}

// ------------------------------------------------------------------ connections

export interface ConnectionCard {
  provider: string; name: string; tone: Tone; label: string; account: string; checked: string | null; detail?: string;
  usedFor: string; action?: { label: string; href?: string; hint?: string };
}

const CONN: [string, string, string, boolean][] = [   // provider, name, used for, required
  ["jira", "Jira", "Tickets", true], ["github", "GitHub", "Code and pull requests", true], ["figma", "Figma", "Designs", true],
  ["teams", "Microsoft Teams", "Messages and approvals", true], ["notion", "Notion", "Product documents (optional)", false],
  ["slack", "Slack", "Messages (optional)", false],
];
const FORM_PROVIDERS = new Set(["jira", "github", "slack", "teams", "notion", "figma"]);

/** Every tool: state in plain words, account, last check, and the Connect / Reconnect link. */
export function connections(): ConnectionCard[] {
  const rows = new Map((db().prepare("SELECT * FROM connections").all() as any[]).map((r) => [r.provider, r]));
  let health = new Map<string, any>();
  try { health = new Map((db().prepare("SELECT * FROM connector_health").all() as any[]).map((r) => [r.provider, r])); } catch { /* older database */ }
  const out: ConnectionCard[] = [];
  for (const [p, name, usedFor, required] of CONN) {
    let row = rows.get(p);
    let provider = p;
    if (p === "teams" && rows.get("teams-personal")) { row = rows.get("teams-personal"); provider = "teams-personal"; }
    if (!row && p === "slack") continue;                           // Slack is shown only when it is set up
    const meta = safeJson<any>(row?.meta, {});
    const st = row?.status;
    const tone: Tone = !row ? (required ? "you" : "wait") : st === "connected" ? "ok" : st === "error" ? "bad" : "you";
    const label = !row ? "Not connected" : st === "connected" ? "Connected" : st === "expired" ? "Sign-in expired" : st === "pending-admin" ? "Waiting for admin" : "Not working";
    const href = FORM_PROVIDERS.has(provider) ? `/connect/${provider}` : undefined;
    const action = st === "connected" ? undefined : href ? { label: row ? "Reconnect" : "Connect", href }
      : { label: "Reconnect", hint: `Run "aiw connect ${provider}" in a terminal` };
    const detail = provider === "teams-personal" ? (meta.mode === "bot" ? "Two-way chat" : "Your private chat")
      : meta.auth === "figma-desktop" ? "Figma desktop app" : meta.auth ? "Browser sign-in" : meta.source === "gh-cli" ? "GitHub CLI sign-in" : row ? "Access token" : undefined;
    const card: ConnectionCard = { provider, name, tone, label, account: row?.account ?? "", checked: row?.updated_at ?? null, usedFor, action,
      detail: st !== "connected" && meta.lastError ? short(meta.lastError, 120) : detail };
    // the health loop's last check (intake/health.ts): down / rate limited beats the stored connection status
    const h = row ? health.get(provider === "teams-personal" ? "teams" : provider) : undefined;
    if (h?.state === "down") Object.assign(card, { tone: "bad" as Tone, label: "Disconnected", checked: h.since, detail: h.detail ? short(h.detail, 120) : card.detail,
      action: card.action ?? { label: "Reconnect", hint: `Run "aiw connect ${provider === "teams-personal" ? "teams-personal" : provider}" in a terminal` } });
    else if (h?.state === "limited") Object.assign(card, { tone: "wait" as Tone, label: "Rate limited", checked: h.since, detail: h.detail ? short(h.detail, 120) : card.detail });
    else if (h?.state === "up" && h.last_ok) card.checked = h.last_ok;
    out.push(card);
  }
  const s = loadSettings();
  const mock = s.models.provider === "mock";
  out.push({ provider: "model", name: "Model access", tone: mock ? "you" : "ok", label: mock ? "Test model" : "Connected",
    account: s.models.provider === "claude-login" ? "Claude sign-in" : mock ? "No real work is done" : "API key", checked: null, usedFor: "The agents",
    action: mock ? { label: "Set up", hint: 'Run "aiw setup" to choose real model access' } : undefined });
  return out;
}

// ------------------------------------------------------------------ activity feed

export interface FeedLine { at: string; tone: Tone; text: string; ref?: string; taskId?: string; self?: boolean }

const KIND_TONE: Record<string, Tone> = {
  approval_needed: "you", needs_info: "you", awaiting_start: "you", stale: "you", paused: "bad", failed: "bad", connector_problem: "bad",
  done: "ok", published: "ok", pr_raised: "ok",
};

/** Newest first: inbox notifications and the Teams conversation, in plain words. */
export function feed(limit = 40): FeedLine[] {
  const notes = (db().prepare("SELECT task_id, kind, title, created_at FROM notifications WHERE channel='inbox' ORDER BY created_at DESC LIMIT ?").all(limit) as any[])
    .map((n) => ({ at: n.created_at, tone: KIND_TONE[n.kind] ?? (/answer(ed)? .*(itself|without asking)/i.test(n.title) ? "ok" : "work"), text: short(n.title, 160), taskId: n.task_id ?? undefined,
      self: /itself|without asking/i.test(n.title) || undefined }));
  const chat = (db().prepare("SELECT ts, direction, text, task_ref FROM chat_log ORDER BY id DESC LIMIT ?").all(limit) as any[])
    .map((c) => ({ at: c.ts, tone: (c.direction === "in" ? "wait" : "work") as Tone, text: `${c.direction === "in" ? "You" : "Sent you"}: ${short(c.text, 140)}`, ref: c.task_ref ?? undefined }));
  return [...notes, ...chat].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit) as FeedLine[];
}

// ------------------------------------------------------------------ overview (the full snapshot)

function uptimeText(startedAt?: string): string {
  if (!startedAt) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 60_000));
  return m < 60 ? `up ${m} m` : `up ${Math.floor(m / 60)} h ${m % 60} m`;
}

/** Everything the page shows at once – also the snapshot the stream sends on connect. */
export function overview() {
  const rt = readRuntime();
  const paused = isPaused();
  const needs = needsYou();
  const working = workingNow();
  const b = board();
  const conns = connections();
  const counts = Object.fromEntries((db().prepare("SELECT state, COUNT(*) AS n FROM tasks WHERE kind != 'part' GROUP BY state").all() as any[]).map((r) => [r.state, r.n]));
  const n = (...st: string[]) => st.reduce((x, s) => x + (counts[s] ?? 0), 0);
  const s = loadSettings();
  const needConn = conns.filter((c) => c.tone !== "ok" && c.tone !== "wait");
  return {
    at: new Date().toISOString(),
    service: { running: true, paused, pausedUntil: paused ? getMeta("paused_until") ?? null : null, version: rt?.version ?? VERSION,
      startedAt: rt?.startedAt ?? null, uptime: uptimeText(rt?.startedAt), mock: s.models.provider === "mock" },
    top: {
      needsYou: needs.length, agentsBusy: working.length, slots: s.limits.maxParallel,
      inProgress: n("RUNNING", "QUEUED", "PUBLISHING", "WAITING_PARTS", "NEEDS_INFO", "AWAITING_APPROVAL", "STALE", "PAUSED", "REJECTED", "FAILED_PUBLISH", "ASKING_LEAD"),
      waiting: n("DETECTED", "TRIAGED", "AWAITING_START"),
      connections: { ok: conns.filter((c) => c.tone === "ok").length, total: conns.length, toCheck: needConn.length },
    },
    needs, working, board: b, feed: feed(), timers: timers(), connections: conns,
  };
}

/** The overview, shared between clients for a moment (the bus drops it as soon as something changes). */
export const overviewSnapshot = () => snapshot(overview);

// ------------------------------------------------------------------ routes for api/server.ts

type Handler = (m: RegExpMatchArray, body: any, url: URL) => unknown;
class NotFound extends Error { status = 404; }

/** Read-only routes for the dashboard. Hook-in: `for (const [m, re, h] of dashboardRoutes) r(m, re, h);` in api/server.ts. */
export const dashboardRoutes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/overview$/, () => overview()],
  ["GET", /^\/api\/needs$/, () => needsYou()],
  ["GET", /^\/api\/working$/, () => workingNow()],
  ["GET", /^\/api\/board$/, (_m, _b, u) => board(Number(u.searchParams.get("days") ?? 14) || 14)],
  ["GET", /^\/api\/items\/([^/]+)\/timeline$/, (m) => itemTimeline(decodeURIComponent(m[1])) ?? Promise.reject(new NotFound("item not found"))],
  ["GET", /^\/api\/agents$/, () => agents()],
  ["GET", /^\/api\/timers$/, () => timers()],
  ["GET", /^\/api\/connections$/, () => connections()],
  ["GET", /^\/api\/feed$/, (_m, _b, u) => feed(Math.min(200, Number(u.searchParams.get("limit") ?? 40) || 40))],
];
