import { requiredDecisionChannel, type ProjectConfig, type Settings } from "../core/config.js";
import type { Question } from "../core/questions.js";
import { logger } from "../core/log.js";
import { truncate, backoff } from "../core/util.js";
import type { Runner } from "../agents/runner.js";
import { makeAgentCaller, type StepCtx } from "./steps.js";
import { getTask, transition, mergeData, updateTask, addUsage, endStep, type Task } from "./tasks.js";
import { notify, markInboxRead } from "../notify/router.js";
import { publish } from "../live/bus.js";
import { recordActivity, progressFrom } from "../live/activity.js";

/**
 * What engine v1 (engine.ts runTask) and engine v2 (kernel/runner.ts runJob) share around one step: building the
 * StepCtx, writing the step's usage, and the outcomes that change a task and tell the user (pause, fail, retry, finish,
 * ask). Kept in one place so both engines behave the same.
 */

/** The StepCtx a step function gets. `save` defaults to merging into the task's data (v1 checkpoint context). */
export function buildStepCtx(o: {
  task: Task; project: ProjectConfig; settings: Settings; runner: Runner; params?: Record<string, any>;
  save?: (ctx: StepCtx, patch: Record<string, any>) => Task;
}): StepCtx {
  const ctx: StepCtx = {
    task: o.task, project: o.project, settings: o.settings, runner: o.runner, params: o.params ?? {},
    usage: { tokensIn: 0, tokensOut: 0, cost: 0, agents: [] },
    agent: undefined as any,
    save: (patch) => {
      if (o.save) { ctx.task = o.save(ctx, patch); return ctx.task; }
      const t = mergeData(ctx.task.id, patch);
      ctx.task = { ...ctx.task, data: t.data };
      return ctx.task;
    },
  };
  ctx.agent = makeAgentCaller(() => ctx);
  return ctx;
}

/** Write a finished step's usage (totals, fresh / cache split and effort) and add it to the task. */
export function flushUsage(ctx: StepCtx, sid: number, status: string, error?: string, note?: string): void {
  const u = ctx.usage;
  endStep(sid, status, {
    agent: u.agents.join(",") || undefined, model: u.model, tokensIn: u.tokensIn, tokensOut: u.tokensOut, cost: u.cost,
    freshIn: u.freshIn, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, effort: u.effort,
    output: note ? { note } : undefined, error,
  });
  addUsage(ctx.task.id, u.tokensIn + u.tokensOut, u.cost);
}

/** A step moved the task to another worktree / branch: store it on the task row. */
export function keepWorkspace(task: Task, ctx: StepCtx): void {
  if (ctx.task.worktree !== task.worktree || ctx.task.branch !== task.branch) updateTask(task.id, { worktree: ctx.task.worktree, branch: ctx.task.branch });
}

/** The ticket changed while the task was running: take the new text; a major change restarts from context_pack. */
export function applyTicketChange(task: Task, pb: { steps: { name: string }[] }): Task {
  const change = task.data.ticketChange;
  if (!change) return task;
  const patch: Record<string, any> = { ticket: task.data.pendingTicket ?? task.data.ticket, ticketChange: null, pendingTicket: null };
  if (change === "major") {
    const restart = Math.max(0, pb.steps.findIndex((s) => s.name === "context_pack"));
    if (task.step_index > restart) updateTask(task.id, { step_index: restart });
    patch.planIssues = null;
    patch.findings = null;                 // the ticket changed a lot: look at the code again
    notify({ kind: "info", taskId: task.id, taskRef: task.source_ref ?? undefined, dedupeKey: `change:${Date.now()}`, title: `${task.source_ref}: ticket changed`, body: "The description changed significantly – re-analysing from the updated ticket." }).catch(() => {});
  }
  mergeData(task.id, patch);
  return getTask(task.id)!;
}

export async function pause(task: Task, reason: string): Promise<Task> {
  const t = transition(task.id, "PAUSED", reason, { error: reason });
  if (t.kind === "part") return t;              // the lead reports it (one message per ticket)
  // E13 "Stuck: …" and F9 "Can't push to …" say what happened in the title; everything else is "paused"
  const ref = t.source_ref ?? t.id;
  const title = /^Stuck:/.test(reason) ? `🛑 ${ref} is stuck` : /^Can't push to /.test(reason) ? `⚠️ ${ref}: can't push` : `${ref} paused`;
  const body = /^Stuck:/.test(reason) ? reason.replace(/^Stuck:\s*/, "Failed: ") : reason;
  await notify({ kind: "paused", taskId: t.id, taskRef: t.source_ref ?? undefined, dedupeKey: `${t.run_no}:${t.step_index}:${reason.slice(0, 40)}`, title, body, url: t.data.ticket?.url });
  return t;
}

export async function fail(task: Task, reason: string): Promise<Task> {
  const t = transition(task.id, "FAILED", reason, { error: truncate(reason, 4000) });
  if (t.kind === "part") return t;              // the lead reports it
  await notify({ kind: "failed", taskId: t.id, taskRef: t.source_ref ?? undefined, dedupeKey: `${t.run_no}:${t.step_index}`, title: `${t.source_ref ?? t.id} failed`, body: truncate(reason, 700), url: t.data.ticket?.url });
  return t;
}

/**
 * A step hit a sign-in error (401) from Jira, GitHub or Figma mid-task: mark that connector down at once (one reconnect
 * message; work that needs it waits) instead of waiting up to 5 minutes for the health loop. Best effort, never throws.
 */
export function noteConnectorError(e: any): void {
  const status = typeof e?.status === "number" ? e.status : /\b401\b/.test(String(e?.message ?? "")) ? 401 : undefined;
  if (status !== 401) return;
  const m = String(e?.message ?? "");
  const p = /api\.github\.com|github\.com/i.test(m) ? "github" : /atlassian|\/rest\/api\/|jira/i.test(m) ? "jira" : /figma\.com/i.test(m) ? "figma" : undefined;
  if (!p) return;
  void import("../intake/health.js").then((H) => H.reportConnectorError(p, e)).catch(() => {});
}

/** Transient errors (API outage, network) retry with back-off; after 3 attempts the task pauses for a human. */
export async function retryOrFail(task: Task, reason: string): Promise<Task> {
  const n = (task.data.errorCount ?? 0) + 1;
  logger.warn("step error", { task: task.id, attempt: n, reason });
  if (n < 3) {
    mergeData(task.id, { errorCount: n, retryAt: new Date(Date.now() + backoff(n + 4)).toISOString(), lastError: reason });
    return transition(task.id, "QUEUED", `retry ${n} after error`);
  }
  mergeData(task.id, { errorCount: 0, stuck: { step: reason.split(":")[0], failed: truncate(reason, 200), tried: "3 attempts with back-off", at: new Date().toISOString() } });
  return pause(task, `Stopped after repeated errors: ${truncate(reason, 500)}. Run \`/aiw resume ${task.source_ref ?? task.id}\` to retry.`);
}

export async function finish(task: Task): Promise<Task> {
  const t = transition(task.id, "DONE", "playbook complete");
  markInboxRead(t.id);
  mergeData(t.id, { cleanupAfter: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  return t;
}

export function answerHint(ref: string): string {
  return requiredDecisionChannel()
    ? `Reply here in this chat. If several tasks are waiting, start your reply with ${ref}.`
    : `Reply in the Teams bot chat:  answer ${ref} "your answer"   (or in Claude Code: aiw answer ${ref} "your answer"). You can also update the Jira description.`;
}

/** Ask the user a question (with numbered options) in the notification channel. */
export async function askUser(t: Task, questions: Question[], context: string, dedupeKey: string): Promise<void> {
  const ref = t.source_ref ?? t.id;
  // Teams shows the questions with numbered options under the text; other channels (desktop, inbox) get them as text.
  const teams = !!requiredDecisionChannel();
  const plain = teams ? "" : `\n${questions.map((q) => `• ${q.question}${q.options.length ? ` (options: ${q.options.join(" / ")})` : ""}`).join("\n")}\n\n${answerHint(ref)}`;
  await notify({
    kind: "needs_info", taskId: t.id, taskRef: ref, dedupeKey, questions: teams ? questions : undefined,
    title: `🤔 ${ref} · question${questions.length > 1 ? "s" : ""}`,
    body: `${context}${t.title ? ` – ${t.title}` : ""}.${plain}`,
    url: t.data.ticket?.url,
  });
}

/** Live dashboard: which step a job is on (activity line + "job" event). Best effort, never stops the work. */
export function liveStep(task: Task, step: string, total: number, phase: "start" | "end", stepIndex = task.step_index): void {
  try {
    if (phase === "start") {
      recordActivity(task.id, null, step, step.replace(/_/g, " "), progressFrom(stepIndex, total), task.tokens_used ?? null,
        { force: true, ref: task.source_ref ?? undefined });
    }
    publish("job", { taskId: task.id, ref: task.source_ref, step, phase });
  } catch { /* live view only */ }
}

// ------------------------------------------------------------------ ask-desk before asking you (§9.1, O4)

/**
 * A step asks: before the question reaches you, the decision log is checked (an answer given earlier for this item,
 * its batch / epic / sprint or globally is used, 0 tokens), and the questions agents queued through the knowledge
 * broker's `ask` tool are added – so every question of the item goes out as ONE message, recommended option first.
 * When every question was answered earlier, the step simply runs again with those answers (at most twice).
 */
export async function runWithAskDesk(fn: (ctx: StepCtx) => Promise<import("./steps.js").StepResult>, ctx: StepCtx): Promise<import("./steps.js").StepResult> {
  let r = await fn(ctx);
  for (let round = 0; round < 2; round++) {
    if (r.status !== "need_info") break;
    const need = r;
    const { findDecision } = await import("../knowledge/decisions.js");
    const { takeQuestions } = await import("../knowledge/askDesk.js");
    const queued = takeQuestions(ctx.task.id).map((q) => ({ question: q.question, options: q.options ?? [] }));
    const all: Question[] = [...need.questions, ...queued.filter((q) => !need.questions.some((x) => x.question.trim() === q.question.trim()))];
    const answered: { question: string; answer: string }[] = [];
    const kept: Question[] = [];
    for (const q of all) {
      const d = findDecision(ctx.task.id, q.question);
      if (d && d.confidence !== "low") answered.push({ question: q.question, answer: d.answer });
      else kept.push(q);
    }
    if (answered.length) {
      ctx.save({ decided: [...(ctx.task.data.decided ?? []), ...answered.map((a) => ({ ...a, at: new Date().toISOString() }))] });
      logger.info("ask-desk: answered from earlier decisions", { task: ctx.task.id, n: answered.length });
    }
    if (kept.length) return { ...need, questions: kept };
    r = await fn(ctx);
  }
  return r;
}

/** The scope a reply to an item's questions is stored under: the nearest batch / epic / sprint it belongs to, else the item. */
export async function answerScopeOf(itemId: string): Promise<import("../knowledge/decisions.js").DecisionScope> {
  const { scopesOf } = await import("../knowledge/decisions.js");
  const s = scopesOf(itemId).find((x) => ["batch", "epic", "sprint"].includes(x.scope) && x.id);
  return s ? s.scope : "item";
}
