import fs from "node:fs";
import { loadSettings, getProject, requiredDecisionChannel, engineVersion, type ProjectConfig } from "../core/config.js";
import { normaliseQuestions, questionTexts, resolveReply, type Question } from "../core/questions.js";
import { db, getMeta, setMeta, delMeta, audit } from "../core/db.js";
import { logger } from "../core/log.js";
import { truncate } from "../core/util.js";
import { getRunner, untrusted } from "../agents/runner.js";
import { AGENTS } from "../agents/catalog.js";
import { playbookFor } from "../core/roles.js";
import { groupMembers, describeMembers } from "./routing.js";
import { getPlaybook, stepIndex } from "./playbooks.js";
import { STEPS, BudgetPause, ticketText, type StepResult } from "./steps.js";
import { buildStepCtx, flushUsage, keepWorkspace, applyTicketChange, pause, fail, retryOrFail, finish, askUser, answerHint, liveStep, noteConnectorError, runWithAskDesk, answerScopeOf } from "./stepRun.js";

export { askUser, answerHint };
import {
  getTask, listTasks, transition, mergeData, updateTask, addUsage, startStep, endStep, usageOf, canTransition, jiraKey, partsOf, type Task,
} from "./tasks.js";
import { notify, markInboxRead } from "../notify/router.js";
import { expireApprovals, decide, latestApproval, type Approval } from "../approvals/approvals.js";
import { removeWorktree } from "../git/git.js";
import { clients } from "../connectors/registry.js";
import { clearActivity } from "../live/activity.js";
import { kernelTick, recoverJobs, itemRunning, stopItemJobs, jobForApproval, resumeJob } from "../kernel/runner.js";
import { needsApproval } from "../policy/gate.js";
import { describeInForce } from "../policy/directives.js";
import { isBlockedByConnector, unavailableConnectors } from "../intake/healthGate.js";
import { getRecipe } from "../kernel/recipes.js";
import { readDoc } from "../knowledge/designDoc.js";
import { wakeScopes } from "./steps/scope.js";
const readDocSafe = (id: string) => { try { return readDoc(id); } catch { return undefined; } };

/**
 * Playbook Engine: a deterministic state machine. Code decides the order of steps; agents work inside them.
 * State is checkpointed after every step, so a crash, reboot or sleep resumes from the last finished step.
 */
const running = new Set<string>();
export const isRunning = (id: string) => running.has(id) || itemRunning(id);

/** Only the background service executes work; CLI / MCP processes are clients that ask it to tick. */
let role: "daemon" | "client" = "client";
export function setEngineRole(r: "daemon" | "client"): void { role = r; }
export const engineRole = () => role;

export function isPaused(): boolean {
  const until = getMeta("paused_until");
  if (!until) return false;
  if (until !== "indefinite" && new Date(until).getTime() < Date.now()) { delMeta("paused_until"); return false; }
  return true;
}
export function pauseAll(until?: string): void { setMeta("paused_until", until ?? "indefinite"); audit("user", "service.pause", undefined, { until }); }
export function resumeAll(): void { delMeta("paused_until"); audit("user", "service.resume"); }

/** Flows that exist only as kernel recipes (service/recipes), never as v1 playbooks. */
const RECIPE_ONLY = new Set(["audit", "adopt", "plan_scope", "batch"]);

/** On service start: anything that was RUNNING when we stopped goes back to the queue (resumes at its checkpoint). */
export function recoverInterrupted(): number {
  const stuck = listTasks({ states: ["RUNNING", "PUBLISHING"] });
  const v1 = engineVersion() !== "v2";
  for (const t of stuck) {
    // recipe-only flows (audit, adopt, scopes) have no v1 playbook: an audit runs again in place, the others stop clearly
    if (v1 && t.playbook && RECIPE_ONLY.has(t.playbook)) {
      if (t.playbook === "audit") {
        import("./steps/audit.js").then((m) => m.runAuditInline(t.id)).catch((e) => logger.error("audit recovery failed", { task: t.id, error: e.message }));
      } else transition(t.id, "FAILED", "needs engine v2", { error: `${t.playbook} runs on the new engine only – it was interrupted by a restart` });
      continue;
    }
    if (t.state === "PUBLISHING") transition(t.id, "RUNNING", "recovered after restart");
    transition(t.id, "QUEUED", "recovered after restart");
  }
  // engine v2: jobs left running go back to the queue at the same step (no jobs exist on v1)
  recoverJobs();
  return stuck.length;
}

// ------------------------------------------------------------------ triage

export async function triageTask(t: Task): Promise<Task> {
  let project = getProject(t.project_id);
  if (!project) return transition(t.id, "CANCELLED", "project no longer configured");
  if (t.kind === "request") return startRequest(t);
  // M2: ticket text that tries to give the plugin orders is only ever data – and you are told once
  try {
    const { detectInjection } = await import("../policy/untrusted.js");
    const tk = t.data.ticket ?? {};
    const rep = detectInjection(`${tk.title ?? ""}\n${tk.description ?? ""}\n${(tk.comments ?? []).map((c: any) => c.body).join("\n")}`);
    if (rep.suspicious && !t.data.injectionTold) {
      mergeData(t.id, { injectionTold: true });
      await notify({ kind: "info", taskId: t.id, taskRef: t.source_ref ?? undefined, dedupeKey: `injection:${t.id}`, title: `⚠️ ${t.source_ref ?? t.id}: its text contains instructions aimed at an AI`,
        body: `${rep.flags.map((f) => ({ "ignore-previous": "tells an AI to ignore its instructions", "role-play": "tries to change who the AI is", secrets: "asks for secrets or keys", "repo-action": "asks for pushes, merges or deletes", "hidden-text": "has hidden text" } as Record<string, string>)[f] ?? f).map((x) => `- ${x}`).join("\n")}\n\nI treat it as data only and never follow it. Check who wrote it.` }).catch(() => {});
    }
  } catch { /* never blocks triage */ }
  let size = "S", clear = true, questions: Question[] = [];
  // A product with several repositories (e.g. backend + frontend): ONE lead task reads every repository, decides which
  // ones change and in what order, and runs one part task per repository. Triage only sizes the work here.
  const members = t.kind === "assigned" ? groupMembers(project) : [project];
  const multi = members.length > 1;
  if (["assigned", "ready_for_qa", "epic_created", "design_review"].includes(t.kind)) {
    const def = AGENTS.triage;
    const r = await getRunner().run({ agent: "triage", tier: def.tier, system: def.system + (multi ? `\n\nThis product has several repositories:\n${describeMembers(members)}` : ""), schema: def.schema,
      prompt: `Work item for role(s) ${project.roles.join(", ")}:\n${untrusted(`ticket:${jiraKey(t)}`, truncate(ticketText(t), 6000))}` });
    addUsage(t.id, r.tokensIn + r.tokensOut, r.costUsd);
    const sid = startStep(t.id, t.run_no, -1, "triage");
    endStep(sid, r.ok ? "ok" : "failed", { ...usageOf(r, "triage"), output: r.data });
    if (!r.ok) { mergeData(t.id, { triageError: r.error }); return t; } // stays DETECTED, retried next tick
    size = r.data.size; clear = r.data.clear; questions = normaliseQuestions(r.data.questions, 3);
    if (t.data.agreedRequirements) { clear = true; questions = []; }   // the requester already answered everything in the interview
    // The lead reads the code before asking anything, so it asks better questions than triage (which only sees the ticket).
    if (multi) { clear = true; questions = []; }
    mergeData(t.id, { triage: r.data });
  }
  if (multi) {
    const lead = members[0];                         // the group's lead project owns the task (budget, Brain, status)
    const key = jiraKey(t) || t.source_ref || t.id;
    if (t.project_id !== lead.id || t.source_ref !== key) updateTask(t.id, { project_id: lead.id, source_ref: key });
    mergeData(t.id, { group: members.map((m) => m.id) });
    t = getTask(t.id)!;
    project = lead;
  }
  return afterTriage(t, project, size, clear, questions, multi ? "dev-lead" : undefined);
}

/** Work without a ticket: no AI triage yet – first a requirements interview with the requester. */
async function startRequest(t: Task): Promise<Task> {
  updateTask(t.id, { size: "M", playbook: "dev-request" });
  t = transition(t.id, "TRIAGED", "request without a ticket");
  t = transition(t.id, "QUEUED", "requirements interview");
  const ref = t.source_ref ?? t.id;
  await notify({ kind: "picked_up", taskId: t.id, taskRef: ref, title: `📝 ${ref}: new request`,
    body: `"${truncate(t.data.request?.text ?? t.title ?? "", 400)}"\nBefore planning, I'll ask you some questions here so the requirements are complete. Then you confirm them, approve the plan, and approve the PR.` });
  return t;
}

/** Choose the playbook and move a triaged task to its next state (shared by lead and sibling tasks). */
async function afterTriage(t: Task, project: ProjectConfig, size: string, clear: boolean, questions: Question[], playbook?: string): Promise<Task> {
  // O4: a triage question already answered (same words or the same question re-worded, this ticket or a wider scope)
  // is never asked again – its answer goes in as a clarification
  if (questions.length) {
    try {
      const { findDecision } = await import("../knowledge/decisions.js");
      const known = questions.map((q) => ({ q, d: findDecision(t.id, q.question) }));
      const reuse = known.filter((x) => x.d);
      if (reuse.length) {
        mergeData(t.id, { clarifications: [...(t.data.clarifications ?? []), ...reuse.map((x) => ({ questions: [x.q.question], answer: x.d!.answer, reply: x.d!.answer, by: "decision log", at: new Date().toISOString() }))] });
        questions = known.filter((x) => !x.d).map((x) => x.q);
        if (!questions.length) clear = true;
      }
    } catch { /* the log is optional */ }
  }
  const settings = loadSettings();
  let pb = playbook ?? playbookFor(t.kind, size) ?? "dev-feature";
  // "plan" autonomy means: always get approval before implementing – the fast lane has no plan step, so use the full playbook.
  if (project.autonomy === "plan" && pb === "dev-small-change") pb = "dev-feature";
  updateTask(t.id, { size, playbook: pb });
  t = transition(t.id, "TRIAGED", `size ${size}, playbook ${pb}`);
  const ref = t.source_ref ?? t.id;
  const others = pb === "dev-lead" ? ` I'll read the ticket and the code of every repository (${(t.data.group ?? []).join(", ")}) to decide which ones change and in what order` : "";

  if (!clear) {
    t = transition(t.id, "NEEDS_INFO", "unclear ticket");
    mergeData(t.id, { questions, needInfoFrom: "triage" });
    if (settings.notifications.jiraComments && t.source === "jira") {
      try { await clients.jira()?.addComment(jiraKey(t), `A few questions before starting:\n\n${questionTexts(questions).map((q) => `- ${q}`).join("\n")}`); } catch { /* optional */ }
    }
    await askUser(t, questions.length ? questions : [{ question: "Please describe the expected behaviour and how we know it is done.", options: [] }], "Before I start, the ticket needs a little more detail", `triage:${(t.data.clarifications ?? []).length}`);
    return t;
  }
  if (project.autonomy === "observe") {
    await notify({ kind: "picked_up", taskId: t.id, taskRef: ref, title: `${ref} detected (observe mode)`, body: `${t.title} – size ${size}. No work started (project autonomy: observe).`, url: t.data.ticket?.url });
    t = transition(t.id, "QUEUED", "observe");
    t = transition(t.id, "RUNNING", "observe");
    return transition(t.id, "DONE", "observe mode – notify only");
  }
  if (t.data.burst || (!t.data.manual && needsApproval("start", { id: t.id, project_id: t.project_id, size, owner: "me" }, { settings, project }).ask)) {
    t = transition(t.id, "AWAITING_START", t.data.burst ? "burst" : `ask before starting size ${size}`);
    if (!t.data.burst) await notify({ kind: "burst", taskId: t.id, taskRef: ref, title: `${ref}: start this size-${size} task?`, body: `${t.title}\nReply "start ${ref}" (or just "yes") to begin. Ignore it to skip.`, url: t.data.ticket?.url });
    return t;
  }
  t = transition(t.id, "QUEUED", "ready");
  const planNote = getPlaybook(pb).steps.some((s) => s.name === "plan_gate") && needsApproval("plan", { id: t.id, project_id: t.project_id, size, owner: "me" }, { settings, project }).ask ? " I'll send you the plan here for approval before writing any code." : "";
  const rules = describeInForce(t);
  await notify({ kind: "picked_up", taskId: t.id, taskRef: ref, title: `👍 ${ref} picked up`, body: `${t.title}\nSize ${size}, playbook: ${getPlaybook(pb).title}${others}.${planNote}${rules ? `\nRules in force: ${rules}` : ""}`, url: t.data.ticket?.url });
  return t;
}

// ------------------------------------------------------------------ scheduler

let ticking = false;
let tickHold = 0;
let tickWanted = false;

/**
 * Run `fn` (e.g. handling a Teams message) without starting background work until `releaseTicks()`.
 * So the chat reply ("✅ Approved – building now") is always posted BEFORE the work it starts sends its own messages.
 */
export async function holdTicks<T>(fn: () => Promise<T>): Promise<T> {
  tickHold++;
  try { return await fn(); } finally { tickHold--; }
}
export async function releaseTicks(): Promise<void> {
  if (tickHold === 0 && tickWanted) { tickWanted = false; await tick(); }
}

/** One scheduler pass: expire approvals, triage new tasks, start queued tasks within concurrency limits. */
export async function tick(): Promise<void> {
  if (role !== "daemon") return;
  if (tickHold > 0) { tickWanted = true; return; }
  if (ticking) { tickWanted = true; return; }          // run again right after the current pass
  ticking = true;
  try {
    for (const a of expireApprovals()) {
      const t = getTask(a.task_id);
      if (t && canTransition(t, "STALE") && t.state === "AWAITING_APPROVAL") {
        transition(t.id, "STALE", "approval expired");
        await notify({ kind: "stale", taskId: t.id, taskRef: t.source_ref ?? undefined, dedupeKey: a.id, title: `${t.source_ref}: approval expired`, body: `Say "refresh ${t.source_ref}" here (or click Refresh on the dashboard): I check it again and ask you once more.` });
      }
    }
    // J7: tickets you paused "until Monday" come back by themselves at that time
    for (const t of listTasks({ states: ["PAUSED"] }).filter((x) => x.data.pausedUntil && new Date(x.data.pausedUntil).getTime() <= Date.now())) {
      mergeData(t.id, { pausedByUser: null, pausedWith: null, pausedUntil: null });
      if (resumeTask(t.id)) audit("service", "task.resumed_on_time", t.id, {});
    }
    // Paused = no AI work at all: new tickets are only recorded (DETECTED) and triaged after resume.
    if (isPaused()) return;
    for (const t of listTasks({ states: ["DETECTED"], limit: 10 })) {
      if (t.data.takenOver && !t.data.handedBack) continue;             // you took it over
      try { await triageTask(t); } catch (e: any) { logger.error("triage failed", { task: t.id, error: e.message }); }
    }
    wakeLeads();
    const s = loadSettings();
    if (engineVersion(s) === "v2") {
      // W8: scopes waiting on their children wake when a child moved (code only, no model)
      try { wakeScopes(); } catch (e: any) { logger.error("wakeScopes failed", { error: e.message }); }
      // engine v2: events → jobs, one job per item, the kernel scheduler and runner (v1 holds still apply)
      await kernelTick({ settings: s, eligible: (t) => !blockedBySibling(t) && !blockedByLead(t),
        onRunEnd: () => setImmediate(() => { tick().catch(() => {}); }) });
      return;
    }
    // connectors that are down (intake/health.ts): work that needs one waits; everything else runs (v1 never sets BLOCKED)
    let down: ReturnType<typeof unavailableConnectors> | undefined;
    try { down = unavailableConnectors(); } catch { down = undefined; }
    const queued = listTasks({ states: ["QUEUED"] }).filter((t) => (!t.data.retryAt || new Date(t.data.retryAt).getTime() <= Date.now()) && !blockedBySibling(t) && !blockedByLead(t)
      && !(t.data.takenOver && !t.data.handedBack) && !(down?.size && isBlockedByConnector(t, undefined, down)));
    for (const t of queued) {
      if (running.size >= s.limits.maxParallel) break;
      if (running.has(t.id)) continue;
      // several tickets at once: planning only reads code, so it never waits for the repository; building (tests,
      // builds, screenshots) is limited per repository (limits.maxPerProject)
      if (BUILD_STEPS.has(stepOf(t) ?? "") && buildingIn(t.project_id) >= s.limits.maxPerProject) continue;
      running.add(t.id);
      // when a run ends, look again at once: a finished part may let the next part (or its lead) continue
      runTask(t.id).catch((e) => logger.error("runTask crashed", { task: t.id, error: e.message })).finally(() => { running.delete(t.id); try { clearActivity(t.id); } catch { /* live view only */ } setImmediate(() => { tick().catch(() => {}); }); });
    }
  } finally {
    ticking = false;
    if (tickWanted && tickHold === 0) { tickWanted = false; setImmediate(() => { tick().catch(() => {}); }); }
  }
}

/** Steps that build and run things on this computer (tests, builds, the app for screenshots). Everything else only reads. */
export const BUILD_STEPS = new Set(["implement_test", "reviews", "design_check", "prepublish", "report"]);

function stepOf(t: Task): string | undefined {
  try { return getPlaybook(t.playbook ?? "").steps[t.step_index]?.name; } catch { return undefined; }
}

/** How many running tasks are building in this repository right now. */
function buildingIn(projectId: string, except?: string): number {
  return [...running].filter((id) => id !== except).map((id) => getTask(id)).filter((x) => x && x.project_id === projectId && x.state === "RUNNING" && BUILD_STEPS.has(stepOf(x) ?? "")).length;
}

/** A sibling task (e.g. the frontend half) starts once the first half has a plan awaiting approval or has finished. */
function blockedBySibling(t: Task): boolean {
  if (!t.data.waitFor) return false;
  const lead = getTask(t.data.waitFor);
  if (!lead) return false;
  return !["DONE", "CANCELLED", "FAILED", "AWAITING_APPROVAL", "NEEDS_INFO"].includes(lead.state);
}

/** Parts built one after the other: a part starts once every repository before it in the build order is ready. */
function blockedByLead(t: Task): boolean {
  if (t.kind !== "part" || !t.data.leadId) return false;
  const lead = getTask(t.data.leadId);
  if (!lead || lead.data.order === "parallel") return false;
  const targets: string[] = lead.data.targets ?? [];
  const before = targets.slice(0, Math.max(0, targets.indexOf(t.project_id)));
  const parts = partsOf(lead.id);
  return before.some((repo) => { const p = parts.find((x) => x.project_id === repo); return !!p && !["PART_READY", "DONE"].includes(p.state); });
}

/** A lead waiting for its parts continues when they are all ready, or when one asked something, failed or paused. */
function wakeLeads(): void {
  for (const lead of listTasks({ states: ["WAITING_PARTS"] })) {
    const parts = partsOf(lead.id);
    const wake = !parts.length || parts.every((p) => ["PART_READY", "DONE"].includes(p.state)) || parts.some((p) => ["ASKING_LEAD", "FAILED", "PAUSED"].includes(p.state));
    if (wake) transition(lead.id, "QUEUED", "parts need the lead");
  }
}

// ------------------------------------------------------------------ run

export async function runTask(taskId: string): Promise<Task> {
  let task = getTask(taskId)!;
  const project = getProject(task.project_id);
  if (!project) return transition(task.id, "FAILED", "project removed", { error: "Project is no longer configured" });
  const pb = getPlaybook(task.playbook ?? "dev-feature");
  const prepIdx = stepIndex(pb, "prepare_workspace");
  if (prepIdx >= 0 && task.step_index > prepIdx && (!task.worktree || !fs.existsSync(task.worktree))) {
    updateTask(task.id, { step_index: prepIdx, worktree: null });          // workspace lost (cleanup, crash, manual delete)
    task = getTask(task.id)!;
  }
  task = transition(task.id, "RUNNING", `run ${task.run_no} from step ${task.step_index}`);
  const settings = loadSettings();
  const runner = getRunner();

  while (task.step_index < pb.steps.length) {
    task = getTask(task.id)!;
    if (task.state !== "RUNNING") return task;                       // cancelled or changed elsewhere
    if (task.step_index >= pb.steps.length) break;
    task = applyTicketChange(task, pb);
    const spec = pb.steps[task.step_index];
    const fn = STEPS[spec.name];
    if (!fn) return fail(task, `Unknown step ${spec.name}`);
    // planning went straight on into building, but the repository already has its builders: wait in the queue
    if (BUILD_STEPS.has(spec.name) && buildingIn(project.id, task.id) >= settings.limits.maxPerProject) {
      return transition(task.id, "QUEUED", `waiting for a free build slot in ${project.id}`);
    }
    const sid = startStep(task.id, task.run_no, task.step_index, spec.name);
    liveStep(task, spec.name, pb.steps.length, "start");
    const ctx = buildStepCtx({ task, project, settings, runner, params: spec.params });
    let result: StepResult;
    try {
      result = await runWithAskDesk(fn, ctx);
    } catch (e: any) {
      flushUsage(ctx, sid, e instanceof BudgetPause ? "paused" : "error", e.message);
      keepWorkspace(task, ctx);
      noteConnectorError(e);
      if (e instanceof BudgetPause) return pause(getTask(task.id)!, `Budget: ${e.message}. Reply \`/aiw resume ${task.source_ref ?? task.id}\` to continue or \`/aiw cancel\` to stop.`);
      return retryOrFail(getTask(task.id)!, `${spec.name}: ${e.message}`);
    }
    flushUsage(ctx, sid, result.status === "ok" || result.status === "done" ? "ok" : result.status, "reason" in result ? result.reason : undefined, (result as any).note);
    liveStep(task, spec.name, pb.steps.length, "end");
    keepWorkspace(task, ctx);
    task = getTask(task.id)!;
    switch (result.status) {
      case "ok":
        updateTask(task.id, { step_index: task.step_index + 1 });
        if (task.data.errorCount) mergeData(task.id, { errorCount: 0 });
        continue;
      case "done":
        return finish(task);
      case "await_approval":
        updateTask(task.id, { step_index: task.step_index });
        return transition(task.id, "AWAITING_APPROVAL", `approval ${result.approvalId}`);
      case "wait":
        return transition(task.id, result.state, result.note ?? "waiting");
      case "need_info": {
        const qs = normaliseQuestions(result.questions, 4);
        if (task.kind === "part") {
          // A part never asks the user: its lead answers from the code / contract, or asks the user itself.
          mergeData(task.id, { questions: qs, askedWhile: result.context ?? spec.name.replace(/_/g, " ") });
          return transition(task.id, "ASKING_LEAD", "question for the lead");
        }
        transition(task.id, "NEEDS_INFO", "step needs information");
        mergeData(task.id, { questions: qs, needInfoFrom: "step" });
        await askUser(getTask(task.id)!, qs, result.context ?? `While working on ${spec.name.replace(/_/g, " ")}`, `${task.run_no}:${task.step_index}:${(task.data.clarifications ?? []).length}`);
        return getTask(task.id)!;
      }
      case "retriage": {
        // A confirmed request continues exactly like a Jira ticket: triage (size, repos), plan, plan approval, build, PR approval.
        mergeData(task.id, { interview: task.data.clarifications ?? [], clarifications: [], questions: null, request: { ...(task.data.request ?? {}), confirmedAt: new Date().toISOString() } });
        updateTask(task.id, { kind: "assigned", playbook: null, size: null, step_index: 0, run_no: task.run_no + 1 });
        return transition(task.id, "DETECTED", result.note ?? "re-triage");
      }
      case "pause":
        return pause(task, result.reason);
      case "fail":
        return fail(task, result.reason);
      case "later":
        mergeData(task.id, { retryAt: result.retryAt, waitingFor: result.reason });
        return transition(task.id, "QUEUED", result.reason);
    }
  }
  return finish(task);
}

// ------------------------------------------------------------------ human actions

/** Teams-only decisions: refuse approvals and answers that come from anywhere else. */
export function decisionRefused(channel: string): string | undefined {
  const only = requiredDecisionChannel();
  if (!only || channel === only || channel === "policy") return undefined;
  return "Approvals and answers for AI Workforce happen in Teams – reply in the AI Workforce chat there. (Status and reports are available here.)";
}

/**
 * The user answers a clarification question (Teams, Claude Code or MCP). The answer is stored on the task and the task
 * continues: a triage question re-runs triage; a step question re-runs that step with the answer in its context.
 * `ref` may be omitted when exactly one task is waiting for information.
 */
/** What a "you decide" answer tells the agent. */
export const DELEGATED_ANSWER = "The user left this decision to you: investigate the code, the ticket and the linked documents, choose the best option, and state your choice and why (it is shown to the user with the plan). Do not ask this again.";

export async function answerTask(ref: string | undefined, answer: string, by: string, channel = "claude-code", opts: { delegated?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  const refused = decisionRefused(channel);
  if (refused) return { ok: false, message: refused };
  const waiting = listTasks({ states: ["NEEDS_INFO"] });
  // engine v2: a job beside an item (a comment fix on a ticket's open PR…) asks without moving the item to NEEDS_INFO
  const jobAsking = waitingJobQuestions();
  let t = ref ? getTask(ref) : waiting.length === 1 && !jobAsking.length ? waiting[0] : undefined;
  if (!ref && !t && !waiting.length && jobAsking.length === 1) t = getTask(jobAsking[0]);
  if (!t) {
    const all = [...waiting.map((x) => x.source_ref ?? x.id), ...jobAsking.map((id) => getTask(id)?.source_ref ?? id)];
    return { ok: false, message: ref ? `No task ${ref}.` : all.length ? `Several tasks need information: ${all.join(", ")}. Say which one: answer <task> "…"` : "No task is waiting for information." };
  }
  if (!answer.trim() && !opts.delegated) return { ok: false, message: "Please include your answer." };
  if (t.state !== "NEEDS_INFO") {
    const { answerJob } = await import("./prFix.js");
    const r = await answerJob(t.id, answer, by, opts.delegated ? { delegated: DELEGATED_ANSWER } : {});
    if (r) {
      if (r.ok) { markInboxRead(t.id, "needs_info"); await tick(); }
      return r.ok && opts.delegated ? { ok: true, message: `👍 OK – I'll check the code and decide for ${t.source_ref ?? t.id}.` } : r;
    }
    return { ok: false, message: `${t.source_ref} is not waiting for information (state: ${t.state}).` };
  }
  if (!answer.trim()) return { ok: false, message: "Please include your answer." };
  const asked = normaliseQuestions(t.data.questions, 10);
  const resolved = opts.delegated ? { ok: true as const, answer: DELEGATED_ANSWER } : resolveReply(asked, answer);
  if (!resolved.ok) return { ok: false, message: `${t.source_ref}: ${resolved.message}` };
  const clarifications = [...(t.data.clarifications ?? []), { questions: questionTexts(asked), answer: resolved.answer, reply: answer.trim(), by, at: new Date().toISOString(), ...(opts.delegated ? { delegated: true } : {}) }];
  mergeData(t.id, { clarifications, questions: null });
  // O4: the answer goes into the decision log (and the design document) – never asked again in this item, batch, epic or sprint;
  // "you decide" records the recommended option (C4)
  try {
    const { recordAnswers } = await import("../knowledge/askDesk.js");
    recordAnswers(t.id, asked, opts.delegated ? "you decide" : answer, await answerScopeOf(t.id));
  } catch (e: any) { logger.error("decision log write failed", { task: t.id, error: e.message }); }
  audit(`user:${by}`, "task.clarified", t.id, { chars: answer.length });
  if (t.data.needInfoFrom === "triage" || !t.playbook) transition(t.id, "DETECTED", "answered – re-triage");
  else transition(t.id, "QUEUED", "answered – continue");               // step_index unchanged: the asking step runs again
  markInboxRead(t.id, "needs_info");
  await tick();
  return { ok: true, message: opts.delegated
    ? `👍 OK – I'll check the code and decide for ${t.source_ref}. You'll see my choice in the plan before anything is built.`
    : `👍 Thanks – ${t.source_ref} continues with your answer.` };
}

/** Items with a waiting job that asked a question (engine v2; none on v1). */
function waitingJobQuestions(): string[] {
  try {
    const rows = db().prepare("SELECT DISTINCT j.item_id FROM jobs j JOIN tasks t ON t.id=j.item_id WHERE j.state='waiting' AND json_extract(j.data,'$.questions') IS NOT NULL AND t.state<>'NEEDS_INFO'").all() as any[];
    return rows.map((r) => r.item_id);
  } catch { return []; }
}

/** Apply a human decision coming from Claude Code, the dashboard or Slack. */
export async function decideAndApply(ref: string, decision: "approved" | "rejected", approver: string, channel: string, reason?: string): Promise<{ ok: boolean; message: string }> {
  const refused = decisionRefused(channel);
  if (refused) return { ok: false, message: refused };
  const d = decide(ref, decision, approver, channel, reason);
  if (!d.ok) return { ok: false, message: d.message };
  await applyDecision(d.approval);
  const t = getTask(d.approval.task_id)!;
  markInboxRead(t.id, "approval_needed");
  const r = t.source_ref ?? t.id;
  const approvedText: Record<string, string> = {
    implement_plan: `✅ Approved the plan for ${r} – building and testing now. I'll message you here if I have a question, and when it's ready for the PR.`,
    create_pr: `✅ Approved ${r} – raising the PR now.`,
    confirm_requirements: `✅ Requirements for ${r} confirmed – planning it now. The plan comes here for your approval.`,
    post_review: `✅ Posting the review on ${t.data.review ? `${t.data.review.repo}#${t.data.review.num}` : r}${t.data.reviewSelection?.length ? ` (comments ${t.data.reviewSelection.join(", ")} only)` : ""} – as comments only, not an approval.`,
    push_fixes: `✅ Pushing the fixes to ${t.data.fix ? `${t.data.fix.repo}#${t.data.fix.num}` : r} and replying to the comments – QA starts after that.`,
    create_issues: `✅ Posting the QA results on ${t.data.qa ? `${t.data.qa.repo}#${t.data.qa.num}` : r}${Array.isArray(t.data.qaSelection) ? (t.data.qaSelection.length ? ` with issues for ${t.data.qaSelection.join(", ")}` : " (report only, no issues)") : ""}.`,
    push_rebase: `✅ Pushing the updated branch for ${r} (a normal push, nothing forced) – I'll tell you when CI has run.`,
    post_jira_comment: `✅ Posting it to Jira for ${r}.`,
  };
  const rejectedText: Record<string, string> = {
    implement_plan: `✏️ Got it – re-planning ${r} with your feedback. The new plan comes here.`,
    create_pr: `✏️ Got it – reworking ${r} with your feedback.`,
    confirm_requirements: `✏️ Got it – updating the requirements for ${r}.`,
    post_review: `✏️ Got it – redoing the review of ${r} with your feedback. The new comments come here first.`,
    push_fixes: `✏️ Got it – reworking the fixes for ${r} with your feedback. They come here again before anything is pushed.`,
    create_issues: `✏️ Got it – redoing the QA of ${r} with your feedback.`,
    push_rebase: `✏️ Got it – nothing pushed for ${r}. I'll redo the conflict fix with your feedback and show you again.`,
  };
  const action = d.approval.action;
  return { ok: true, message: decision === "approved" ? approvedText[action] ?? `Approved ${r} – publishing now.` : rejectedText[action] ?? `Rejected ${r} – will re-run with your feedback.` };
}

export async function applyDecision(a: Approval): Promise<void> {
  let t = getTask(a.task_id);
  if (t && t.state !== "AWAITING_APPROVAL") {
    // engine v2: work on an open PR (a fix) asks for approval without changing the item's state
    const job = jobForApproval(a.id);
    if (!job) return;
    if (a.state === "approved") resumeJob(job.id, { approvalId: null });
    else {
      let at = 0;
      try { const r = getRecipe(job.recipe); at = Math.max(0, ["plan", "implement_test", "fix_plan", "qa_plan", "review_pr"].map((n) => r.steps.findIndex((x) => x.name === n)).find((i) => i >= 0) ?? 0); } catch { /* unknown recipe: from the start */ }
      const ctxData = job.data.ctx ?? {};
      resumeJob(job.id, { approvalId: null, stepIndex: at, ctx: { ...ctxData, feedback: [...(ctxData.feedback ?? t.data.feedback ?? []), a.reason ?? "Rejected without a reason"] } });
    }
    await tick();
    return;
  }
  if (!t) return;
  if (a.state === "approved") {
    transition(t.id, "QUEUED", `approved by ${a.approver} via ${a.channel}`);
    await tick();
    return;
  }
  // Rejected: feedback becomes input to a re-run from Plan (or Implement for the fast lane) and a candidate Brain rule.
  t = transition(t.id, "REJECTED", a.reason ?? "rejected");
  // a goldfish / plan reviewer's view of the rejection: the feedback goes into the design document before re-planning (D4)
  if (a.action === "implement_plan") {
    try { const { applyFeedbackToDoc } = await import("../knowledge/goldfish.js"); if (readDocSafe(t.id)) applyFeedbackToDoc(t, { text: a.reason ?? "Rejected without a reason", by: a.approver ?? "you", kind: "reject" }); } catch { /* the document is optional */ }
  }
  // recipe-only flows (W8 scopes, W15 audit, W16 adopt) restart from their recipe, not a playbook
  if (t.playbook && RECIPE_ONLY.has(t.playbook)) {
    const feedback = [...(t.data.feedback ?? []), a.reason ?? "Rejected without a reason"];
    mergeData(t.id, { feedback });
    if (a.action === "start") { transition(t.id, "CANCELLED", "you said no to starting it"); return; }
    let at = 0;
    try {
      const r = getRecipe(t.playbook);
      const find = (n: string) => r.steps.findIndex((x) => x.name === n);
      at = a.action === "implement_plan" ? Math.max(0, find("scope_plan"), find("plan"))
        : a.action === "create_tickets" ? Math.max(0, find("epic_check"))
        : Math.max(0, find("plan"), find("implement_test"));
    } catch { at = 0; }
    updateTask(t.id, { step_index: at, run_no: t.run_no + 1 });
    transition(t.id, "QUEUED", "re-run with feedback");
    return;
  }
  const pb = getPlaybook(t.playbook ?? "dev-feature");
  if (t.playbook === "dev-lead") {
    // plan feedback may change which repositories change → understand again; PR feedback goes to every part
    const at = a.action === "implement_plan" ? stepIndex(pb, "understand") : stepIndex(pb, "run_parts");
    const feedback = [...(t.data.feedback ?? []), a.reason ?? "Rejected without a reason"];
    mergeData(t.id, { feedback, ...(a.action === "create_pr" ? { rework: { feedback: a.reason ?? "Rejected without a reason", sent: false } } : {}) });
    updateTask(t.id, { step_index: Math.max(0, at), run_no: t.run_no + 1 });
    transition(t.id, "QUEUED", "re-run with feedback");
    return;
  }
  const restartAt = a.action === "implement_plan" ? stepIndex(pb, "plan")
    : a.action === "confirm_requirements" ? stepIndex(pb, "requirements_interview")
    : [stepIndex(pb, "plan"), stepIndex(pb, "implement_test"), stepIndex(pb, "artefact"), stepIndex(pb, "review_pr"), stepIndex(pb, "fix_plan"), stepIndex(pb, "qa_plan")].find((i) => i >= 0) ?? 0;
  const feedback = [...(t.data.feedback ?? []), a.reason ?? "Rejected without a reason"];
  mergeData(t.id, { feedback });
  updateTask(t.id, { step_index: Math.max(0, restartAt), run_no: t.run_no + 1 });
  transition(t.id, "QUEUED", "re-run with feedback");
}

export function startAwaiting(ref: string | "all"): number {
  const list = ref === "all" ? listTasks({ states: ["AWAITING_START"] }) : [getTask(ref)].filter((t): t is Task => !!t && t.state === "AWAITING_START");
  for (const t of list) transition(t.id, "QUEUED", "started by user");
  return list.length;
}

export async function cancelTask(ref: string, reason = "cancelled by user"): Promise<Task | undefined> {
  const t = getTask(ref);
  if (!t || !canTransition(t, "CANCELLED")) return t;
  const c = transition(t.id, "CANCELLED", reason);
  stopItemJobs(t.id, reason);                          // engine v2: its jobs stop too (none on v1)
  mergeData(t.id, { cleanupAfter: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  markInboxRead(t.id);
  for (const p of partsOf(t.id)) {                   // a lead's parts stop with it
    if (!canTransition(p, "CANCELLED")) continue;
    transition(p.id, "CANCELLED", `lead ${t.source_ref ?? t.id} cancelled`);
    stopItemJobs(p.id, "lead cancelled");
    mergeData(p.id, { cleanupAfter: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  }
  return c;
}

/** Resume PAUSED / FAILED / STALE / FAILED_PUBLISH / NEEDS_INFO tasks. Budget pauses get one more budget unit. */
export function resumeTask(ref: string): Task | undefined {
  const t = getTask(ref);
  if (!t) return undefined;
  if (t.state === "STALE" || t.state === "FAILED_PUBLISH") return refreshTask(ref);
  // D6: paused because the code changed after your approval – re-check and ask again (resuming at publish would only
  // fail the same check and pause again)
  if (t.state === "PAUSED" && /^STALE\b/.test(t.error ?? "")) { mergeData(t.id, { retryAt: null, errorCount: 0 }); return refreshTask(ref); }
  if (t.state === "PR_OPEN") {
    // engine v2: a paused job on an open PR (its own build's tail, a fix, a rebase) leaves the item in PR_OPEN;
    // the kernel tick puts those jobs back in the queue (kernel/runner.ts requeuePausedJobs)
    mergeData(t.id, { resumeJobs: new Date().toISOString(), stuck: null, pushRefused: null, takenOver: null });
    return getTask(t.id);
  }
  if (!["PAUSED", "FAILED", "NEEDS_INFO"].includes(t.state)) return t;
  const patch: Record<string, any> = { retryAt: null, errorCount: 0, stuck: null, pushRefused: null };
  if (/budget/i.test(t.error ?? "")) patch.budgetExtensions = (t.data.budgetExtensions ?? 1) + 1;
  mergeData(t.id, patch);
  // resuming a lead resumes the part that stopped it
  for (const p of partsOf(t.id).filter((x) => ["PAUSED", "FAILED"].includes(x.state))) {
    const pp: Record<string, any> = { retryAt: null, errorCount: 0 };
    if (/budget/i.test(p.error ?? "")) pp.budgetExtensions = (p.data.budgetExtensions ?? 1) + 1;
    mergeData(p.id, pp);
    transition(p.id, "QUEUED", "resumed with its lead");
  }
  return transition(t.id, "QUEUED", "resumed by user");
}

/** STALE approval: rebase + re-test + new approval request, starting from prepublish. */
export function refreshTask(ref: string): Task | undefined {
  const t = getTask(ref);
  if (!t) return undefined;
  if (t.playbook === "dev-lead") {
    // every part rebases, re-tests and waits again; the lead re-checks them and asks for one new approval
    for (const p of partsOf(t.id).filter((x) => x.state === "PART_READY")) {
      updateTask(p.id, { step_index: Math.max(0, stepIndex(getPlaybook("dev-part"), "prepublish")) });
      transition(p.id, "QUEUED", "refresh with its lead");
    }
    updateTask(t.id, { step_index: Math.max(0, stepIndex(getPlaybook("dev-lead"), "run_parts")) });
    return transition(t.id, "QUEUED", "refresh after stale approval");
  }
  const pb = getPlaybook(t.playbook ?? "dev-feature");
  // only a stale PR / push approval goes back to prepublish (rebase, re-test, ask again). A stale PLAN or requirements
  // approval re-runs its own step (it asks again) – jumping to prepublish would publish without building.
  const last = latestApproval(t.id);
  const prLike = !last || /^(create_pr|push_|publish)/.test(last.action);
  const at = prLike ? stepIndex(pb, "prepublish") : -1;
  if (at >= 0) updateTask(t.id, { step_index: at });
  return transition(t.id, "QUEUED", "refresh after stale approval");
}

/**
 * One-time upgrade (0.3.0): tickets of a multi-repository product that were split into per-repository halves but not
 * started yet become ONE lead task again, so the lead reads every repository and decides. Started work is left alone.
 */
export function migrateToLeadTasks(): number {
  if (getMeta("migrate.lead.v1")) return 0;
  let n = 0;
  const waiting = listTasks({ states: ["AWAITING_START"] }).filter((t) => t.kind === "assigned");
  const done = new Set<string>();
  for (const t of waiting) {
    if (done.has(t.id)) continue;
    const project = getProject(t.project_id);
    if (!project || groupMembers(project).length < 2) continue;
    const key = jiraKey(t);
    const halves = waiting.filter((x) => jiraKey(x) === key);
    const leadHalf = halves.find((x) => !x.data.siblingOf) ?? halves[0];
    // an unstarted half whose other half already started stays as it is
    const others = listTasks({ states: ["NEEDS_INFO", "QUEUED", "RUNNING", "PAUSED", "AWAITING_APPROVAL", "STALE"] }).filter((x) => x.kind === "assigned" && jiraKey(x) === key);
    if (others.length) continue;
    for (const h of halves) {
      done.add(h.id);
      if (h.id === leadHalf.id) continue;
      transition(h.id, "CANCELLED", `merged into ${key}`);
      markInboxRead(h.id);
    }
    const members = groupMembers(project);
    updateTask(leadHalf.id, { project_id: members[0].id, source_ref: key, playbook: "dev-lead", step_index: 0 });
    mergeData(leadHalf.id, { group: members.map((m) => m.id), targets: null, siblingOf: null, waitFor: null });
    markInboxRead(leadHalf.id);
    n++;
  }
  setMeta("migrate.lead.v1", new Date().toISOString());
  if (n) audit("service", "migrate.lead_tasks", undefined, { tickets: n });
  return n;
}

/** Remove finished task worktrees after the retention window (default 7 days). */
export function housekeeping(): number {
  let n = 0;
  for (const t of listTasks({ states: ["DONE", "CANCELLED", "FAILED"] })) {
    if (!t.worktree || !t.data.cleanupAfter || new Date(t.data.cleanupAfter).getTime() > Date.now()) continue;
    const p = getProject(t.project_id);
    if (p && fs.existsSync(t.worktree)) removeWorktree(p.local.path, t.worktree);
    updateTask(t.id, { worktree: null });
    n++;
  }
  return n;
}

export { latestApproval };
