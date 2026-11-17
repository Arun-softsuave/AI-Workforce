/**
 * Kernel runner (engine v2, IMPLEMENTATION-PLAN 5.7): runs one job's recipe step by step with the unchanged STEPS
 * functions and StepCtx (built by engine/stepRun.ts, the same helper engine.ts runTask uses).
 *
 * - A job that OWNS its item (job.recipe === item.playbook: the build of a ticket, a fix / QA / review task) drives the
 *   item's state exactly like v1 runTask, and the item's step_index is the checkpoint. Publishing a PR moves the item to
 *   PR_OPEN (v2 only) instead of finishing it.
 * - Any other job (ci_fix, comment_fix, rebase… on a PR_OPEN item) leaves the item's state alone: its step_index and its
 *   own context (job.data.ctx, worktree, branch) live on the job, so the item's checkpoint data is never overwritten.
 * - Effector steps (prepublish, publish, publish_parts) are checkpointed on the job before they run.
 * - After a restart only the in-flight step runs again; inside it, finished no-tool model calls come from agent_cache.
 */
import { loadSettings, getProject, type Settings } from "../core/config.js";
import { db, audit } from "../core/db.js";
import { logger } from "../core/log.js";
import { nowIso, sha256, truncate, backoff } from "../core/util.js";
import { normaliseQuestions } from "../core/questions.js";
import { getRunner, type Runner, type AgentRequest, type AgentResult } from "../agents/runner.js";
import { STEPS, BudgetPause, type StepResult, type StepCtx } from "../engine/steps.js";
import { getTask, transition, mergeData, updateTask, startStep, canTransition, type Task, type State } from "../engine/tasks.js";
import {
  buildStepCtx, flushUsage, keepWorkspace, applyTicketChange, pause, fail, retryOrFail, finish, askUser, liveStep, noteConnectorError, runWithAskDesk,
} from "../engine/stepRun.js";
import { notify, markInboxRead } from "../notify/router.js";
import { clearActivity, progressFrom } from "../live/activity.js";
import { getItem, setItemState } from "./items.js";
import { pendingEvents, markHandled } from "./events.js";
import { useRouteDeps, routeEvents } from "./reactions.js";
import { getRecipe, advance, firstStepIndex } from "./recipes.js";
import { enqueue, getJob, startJob, onJobEnd, activeJob, clearMailbox, createJob, queuedJobs, rowToJob } from "./mailbox.js";
import { pickRunnable, limitsFrom } from "./scheduler.js";
import { linkParts, migrateToKernel } from "./migrate.js";
import type { Item, Job, Recipe, StepOutcome, ApplyStepResult, RecoverJobs, ResumeJob, RunJob } from "./types.js";

/** Steps a recipe names that STEPS does not have yet ([] = it can run). */
export function missingSteps(recipeName: string): string[] {
  try { return [...new Set(getRecipe(recipeName).steps.map((s) => s.name).filter((n) => !STEPS[n]))]; } catch { return [recipeName]; }
}

/**
 * mailbox.enqueue, guarded: a recipe that names a step STEPS does not have (a newer recipe file on an older build)
 * becomes one short message instead of a job that would fail at once. Wave 3 built every after-PR recipe, so this
 * only fires for a broken install.
 */
function enqueueRunnable(itemId: string, reaction: Parameters<typeof enqueue>[1], ev?: Parameters<typeof enqueue>[2]) {
  if (reaction.job !== "none") {
    const missing = missingSteps(reaction.recipe);
    if (missing.length) {
      const ref = getItem(itemId)?.source_ref ?? itemId;
      notify({ kind: "failed", taskId: itemId, taskRef: ref, dedupeKey: `ev:${ev?.id ?? reaction.recipe}`, title: `${ref}: can't run ${reaction.recipe.replace(/_/g, " ")}`,
        body: `This install is missing steps (${missing.join(", ")}). Update AI Workforce, then try again.` }).catch(() => {});
      return undefined;
    }
  }
  return enqueue(itemId, reaction, ev);
}

// the real modules behind routeEvents (wired once, here)
useRouteDeps({ pendingEvents, markHandled, getItem, enqueue: enqueueRunnable, setItemState });

/** Steps that change things outside this computer (or prepare exactly what will be published). */
export const EFFECTOR_STEPS = new Set(["prepublish", "publish", "publish_parts"]);
/** Steps after which the item has a PR (v2: the item moves to PR_OPEN). */
const PR_STEPS = new Set(["publish", "publish_parts"]);
/** Item states in which no job may run on it any more. */
const ENDED: State[] = ["DONE", "CANCELLED", "MERGED"];

/** Jobs running in this process (a restart forgets them: recoverJobs puts them back in the queue). */
const live = new Set<string>();
export const liveJobs = (): string[] => [...live];
export const isJobLive = (id: string) => live.has(id);
/** Is a job of this item running in this process? */
export function itemRunning(itemId: string): boolean {
  for (const id of live) { const j = getJob(id); if (j?.item_id === itemId) return true; }
  return false;
}
/** Tests: forget the in-process runs, as a restart of the service would. */
export function resetKernelRuntime(): void { live.clear(); }

// ------------------------------------------------------------------ job rows

function patchJob(id: string, p: Partial<Pick<Job, "state" | "step_index" | "attempts" | "error" | "agent" | "activity" | "progress" | "activity_at">> & { data?: Record<string, any> }): Job {
  const sets: string[] = [], args: any[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    sets.push(`${k}=?`);
    args.push(k === "data" ? JSON.stringify(v) : v);
  }
  sets.push("updated_at=?"); args.push(nowIso());
  db().prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id=?`).run(...args, id);
  return getJob(id)!;
}

function mergeJobData(id: string, patch: Record<string, any>): Job {
  const j = getJob(id)!;
  return patchJob(id, { data: { ...j.data, ...patch } });
}

/** Does this job own its item's lifecycle (the item's own playbook) or run beside it (work on an open PR)? */
export const ownsItem = (job: Pick<Job, "recipe">, item: Pick<Item, "playbook">): boolean => !!item.playbook && job.recipe === item.playbook;

// ------------------------------------------------------------------ agent cache

/** Cache key of one model call: agent, system prompt, prompt and schema. */
export function agentCacheKey(req: Pick<AgentRequest, "agent" | "system" | "prompt" | "schema">): string {
  return sha256(JSON.stringify([req.agent, req.system, req.prompt, req.schema ?? null]));
}

/** A call that uses no tools (no workspace, no tools, no lookup tools): its answer depends only on the prompt. */
export const cacheableCall = (req: AgentRequest): boolean =>
  !req.cwd && !(req.tools?.length) && !(req.allow?.length) && !req.lookup && !(req.additionalDirectories?.length);

/**
 * Wrap the model runner for one step: every successful no-tool answer is stored in agent_cache; when the step is being
 * resumed (after a restart) or retried, the same call is answered from the cache instead of the model. Tool calls
 * (implementer, explorer…) are never cached.
 */
export function cachingRunner(base: Runner, resuming: boolean): Runner {
  return {
    async run(req: AgentRequest): Promise<AgentResult> {
      if (!cacheableCall(req)) return base.run(req);
      const key = agentCacheKey(req);
      if (resuming) {
        const row = db().prepare("SELECT result FROM agent_cache WHERE key=?").get(key) as { result: string } | undefined;
        if (row) {
          try {
            const r = JSON.parse(row.result) as AgentResult;
            audit("service", "agent_cache.hit", undefined, { agent: req.agent });
            return { ...r, tokensIn: 0, tokensOut: 0, freshIn: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
          } catch { /* unreadable: ask the model */ }
        }
      }
      const r = await base.run(req);
      if (r.ok) {
        try {
          db().prepare("INSERT OR REPLACE INTO agent_cache (key, agent, result, created_at) VALUES (?,?,?,?)").run(key, req.agent, JSON.stringify(r), nowIso());
        } catch { /* cache is best effort */ }
      }
      return r;
    },
  };
}

// ------------------------------------------------------------------ pure: StepResult → outcome

/** The v2 version of runTask's switch: what one step's result does to the job and (when the job owns it) the item. */
export const applyStepResult: ApplyStepResult = (job, item, recipe, result): StepOutcome => {
  const owned = ownsItem(job, item);
  switch (result.status) {
    case "ok": {
      const next = advance(recipe, job.step_index, job, item).next;
      if (next >= 0) return { next: "continue", stepIndex: next };
      return { next: "end", jobState: "done", itemState: owned && item.state !== "PR_OPEN" ? "DONE" : undefined };
    }
    case "done":
      return { next: "end", jobState: "done", itemState: owned && item.state !== "PR_OPEN" ? "DONE" : undefined, reason: result.note };
    case "await_approval":
      return { next: "wait", jobState: "waiting", itemState: owned ? "AWAITING_APPROVAL" : undefined, reason: `approval ${result.approvalId}` };
    case "wait":
      return { next: "wait", jobState: "waiting", itemState: owned ? result.state : undefined, reason: result.note ?? "waiting" };
    case "need_info":
      return { next: "wait", jobState: "waiting", itemState: owned ? (item.kind === "part" ? "ASKING_LEAD" : "NEEDS_INFO") : undefined, reason: "question" };
    case "retriage":
      return { next: "end", jobState: "done", itemState: owned ? "DETECTED" : undefined, reason: result.note ?? "re-triage" };
    case "pause":
      return { next: "wait", jobState: "waiting", itemState: owned ? "PAUSED" : undefined, reason: result.reason };
    case "fail":
      return { next: "end", jobState: "failed", itemState: owned ? "FAILED" : undefined, reason: result.reason };
  }
};

// ------------------------------------------------------------------ the job's view of its item

/** A PR job's starting context: what the fix steps read from task.data.fix (repo, number, mode, CI round). */
function seedContext(job: Job, item: Item, project: ReturnType<typeof getProject>): Record<string, any> {
  if (job.type !== "ci_fix" && job.type !== "comment_fix") return {};
  const ev = (job.data.events ?? [])[job.data.events?.length - 1]?.payload ?? {};
  const pr = item.data.pr ?? item.data.prRef ?? (item.data.prs ?? [])[0] ?? {};
  const repo = ev.repo ?? pr.repo ?? project?.github?.repo;
  const num = Number(ev.num ?? ev.number ?? pr.number ?? pr.num);
  if (!repo || !num) return {};
  return { fix: { repo, num, by: ev.by ?? "you", via: ev.via ?? "teams-personal", mode: job.type === "ci_fix" ? "ci" : "comments",
    issues: [], requests: [], ciRound: Number(ev.round ?? 1), requestedAt: nowIso() } };
}

/** The Task a non-owning job's steps see: the item with the job's own context, worktree and branch on top. */
function jobView(item: Item, job: Job): Task {
  const c = job.data.ctx ?? {};
  return { ...item, data: { ...item.data, ...c }, worktree: job.data.worktree ?? null, branch: job.data.branch ?? null };
}

/** ctx.save for a non-owning job: writes into job.data.ctx, never the item's checkpoint data. */
const jobSave = (jobId: string) => (ctx: StepCtx, patch: Record<string, any>): Task => {
  const j = getJob(jobId)!;
  mergeJobData(jobId, { ctx: { ...(j.data.ctx ?? {}), ...patch } });
  return { ...ctx.task, data: { ...ctx.task.data, ...patch } };
};

// ------------------------------------------------------------------ run

/**
 * Run a job until it waits, ends or is cancelled. Claims it first (queued → running) when needed; returns the job as it
 * is afterwards. Exactly one job per item runs (mailbox.startJob refuses a second).
 */
export const runJob: RunJob = async (jobId: string): Promise<Job> => {
  let job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.state !== "running") {
    const claimed = startJob(jobId);
    if (!claimed) return job;
    job = claimed;
  }
  if (live.has(job.id)) return job;
  live.add(job.id);
  try {
    return await runLoop(job);
  } catch (e: any) {
    logger.error("job crashed", { job: job.id, error: e.message });
    onJobEnd(job.id, "failed", truncate(e.message ?? String(e), 2000));
    return getJob(job.id)!;
  } finally {
    live.delete(job.id);
    try { clearActivity(job.item_id); } catch { /* live view only */ }
  }
};

/** Put the job aside until its item can go on (approval, answer, pause, parts, retry). */
function toWaiting(job: Job, reason: string, data: Record<string, any> = {}): Job {
  return patchJob(job.id, { state: "waiting", activity: truncate(reason, 200), activity_at: nowIso(), data: { ...getJob(job.id)!.data, ...data } });
}

/** Has this step (same job or same item run) been started before and not finished? Then it is being resumed. */
function resumingStep(job: Job, owned: boolean, item: Item, idx: number, name: string): boolean {
  const q = owned
    ? db().prepare("SELECT 1 FROM steps WHERE task_id=? AND run_no=? AND idx=? AND name=? AND status IN ('running','interrupted','error','paused') LIMIT 1").get(item.id, item.run_no, idx, name)
    : db().prepare("SELECT 1 FROM steps WHERE job_id=? AND idx=? AND name=? AND status IN ('running','interrupted','error','paused') LIMIT 1").get(job.id, idx, name);
  return !!q || job.attempts > 0;
}

async function runLoop(start: Job): Promise<Job> {
  let job = start;
  let item = getItem(job.item_id);
  if (!item) { onJobEnd(job.id, "cancelled", "item not found"); return getJob(job.id)!; }
  const project = getProject(item.project_id);
  const owned = ownsItem(job, item);
  if (!project) {
    if (owned && canTransition(item, "FAILED")) transition(item.id, "FAILED", "project removed", { error: "Project is no longer configured" });
    onJobEnd(job.id, "failed", "Project is no longer configured");
    return getJob(job.id)!;
  }
  let recipe: Recipe;
  try { recipe = getRecipe(job.recipe); } catch (e: any) { return endFailed(job, item, owned, e.message); }
  const missing = missingSteps(recipe.name);
  if (missing.length) {
    return endFailed(job, item, owned, `"${recipe.name}" is not available yet (missing steps: ${missing.join(", ")})`);
  }

  if (owned) {
    // workspace lost (cleanup, crash, manual delete): go back to preparing it, like v1
    const prepIdx = recipe.steps.findIndex((s) => s.name === "prepare_workspace");
    const fs = await import("node:fs");
    if (prepIdx >= 0 && item.step_index > prepIdx && (!item.worktree || !fs.existsSync(item.worktree))) {
      updateTask(item.id, { step_index: prepIdx, worktree: null });
      item = getItem(item.id)!;
    }
    if (item.state === "QUEUED") { transition(item.id, "RUNNING", `run ${item.run_no} from step ${item.step_index} (job ${job.id})`); item = getItem(item.id)!; }
    else if (!["RUNNING", "PR_OPEN"].includes(item.state)) return toWaiting(job, `item is ${item.state}`);
    job = patchJob(job.id, { step_index: item.step_index });
  } else {
    if (ENDED.includes(item.state)) { onJobEnd(job.id, "cancelled", `item is ${item.state}`); return getJob(job.id)!; }
    if (!job.data.started) {
      const first = firstStepIndex(recipe, job, item);
      job = patchJob(job.id, { step_index: first, data: { ...job.data, started: nowIso(), ctx: { ...seedContext(job, item, project), ...(job.data.ctx ?? {}) } } });
      if (first < 0) { onJobEnd(job.id, "done"); return getJob(job.id)!; }
    }
  }
  const settings = loadSettings();

  for (;;) {
    const fresh = getItem(item.id);
    job = getJob(job.id)!;
    if (!fresh) { onJobEnd(job.id, "cancelled", "item not found"); return getJob(job.id)!; }
    item = fresh;
    if (job.state !== "running") return job;                                  // cancelled elsewhere
    if (owned) {
      if (["CANCELLED", "DONE"].includes(item.state)) { onJobEnd(job.id, "cancelled", `item is ${item.state}`); return getJob(job.id)!; }
      if (!["RUNNING", "PR_OPEN"].includes(item.state)) return toWaiting(job, `item is ${item.state}`);   // changed elsewhere
      if (item.state === "RUNNING" && item.data.ticketChange) { applyTicketChange(item, recipe); item = getItem(item.id)!; }
    } else if (ENDED.includes(item.state)) { onJobEnd(job.id, "cancelled", `item is ${item.state}`); return getJob(job.id)!; }

    const idx = owned ? item.step_index : job.step_index;
    if (idx < 0 || idx >= recipe.steps.length) return complete(job, item, owned);
    if (owned && job.step_index !== idx) job = patchJob(job.id, { step_index: idx });
    const spec = recipe.steps[idx];
    const fn = STEPS[spec.name];
    const resuming = resumingStep(job, owned, item, idx, spec.name);
    if (EFFECTOR_STEPS.has(spec.name)) {
      job = mergeJobData(job.id, { checkpoint: { step: spec.name, index: idx, at: nowIso(), resumed: resuming } });
      audit("service", "kernel.effector", item.id, { job: job.id, step: spec.name, resumed: resuming });
    }
    const sid = startStep(item.id, item.run_no, idx, spec.name);
    db().prepare("UPDATE steps SET job_id=?, input_hash=? WHERE id=?").run(job.id, sha256(JSON.stringify([job.recipe, spec.name, spec.params ?? {}, item.run_no, idx])), sid);
    patchJob(job.id, { activity: spec.name.replace(/_/g, " "), progress: progressFrom(idx, recipe.steps.length), activity_at: nowIso() });
    liveStep(item, spec.name, recipe.steps.length, "start", idx);

    const viewTask: Task = owned ? item : jobView(item, job);
    const ctx = buildStepCtx({ task: viewTask, project, settings, runner: cachingRunner(getRunner(), resuming), params: spec.params ?? {},
      save: owned ? undefined : jobSave(job.id) });
    let result: StepResult;
    try {
      result = await runWithAskDesk(fn, ctx);
    } catch (e: any) {
      flushUsage(ctx, sid, e instanceof BudgetPause ? "paused" : "error", e.message);
      keepJobWorkspace(job, owned, viewTask, ctx);
      noteConnectorError(e);
      const now = getItem(item.id)!;
      return onStepError(getJob(job.id)!, now, owned && now.state !== "PR_OPEN", spec.name, e);
    }
    flushUsage(ctx, sid, result.status === "ok" || result.status === "done" ? "ok" : result.status, "reason" in result ? result.reason : undefined, (result as any).note);
    liveStep(item, spec.name, recipe.steps.length, "end", idx);
    keepJobWorkspace(job, owned, viewTask, ctx);
    if (EFFECTOR_STEPS.has(spec.name)) job = mergeJobData(job.id, { checkpoint: null });
    item = getItem(item.id)!;
    job = getJob(job.id)!;
    if (job.state !== "running") return job;                                  // cancelled while the step ran

    // publish → PR_OPEN (v2): the build goes on (ticket report, memory) while the item is looked after as an open PR
    if (result.status === "ok" && owned && PR_STEPS.has(spec.name) && item.level !== "part" && (item.data.pr || (item.data.prs ?? []).length)
      && item.state === "RUNNING") {
      transition(item.id, "PR_OPEN", `PR raised (${spec.name})`);
      item = getItem(item.id)!;
    }

    const outcome = applyStepResult({ ...job, step_index: idx }, item, recipe, result);
    if (outcome.next === "continue") {
      const adv = advance(recipe, idx, job, item);
      if (adv.data) mergeJobData(job.id, adv.data);
      if (owned) {
        updateTask(item.id, { step_index: outcome.stepIndex });
        if (item.data.errorCount) mergeData(item.id, { errorCount: 0 });
      }
      patchJob(job.id, { step_index: outcome.stepIndex, attempts: 0 });
      continue;
    }
    return applyOutcome(job, item, owned, owned && item.state !== "PR_OPEN", spec.name, idx, result, outcome);
  }
}

function keepJobWorkspace(job: Job, owned: boolean, before: Task, ctx: StepCtx): void {
  if (owned) { keepWorkspace(before, ctx); return; }
  if (ctx.task.worktree !== before.worktree || ctx.task.branch !== before.branch) mergeJobData(job.id, { worktree: ctx.task.worktree, branch: ctx.task.branch });
}

/** The recipe ran to its end. */
async function complete(job: Job, item: Item, owned: boolean): Promise<Job> {
  if (owned) {
    if (item.state === "PR_OPEN") markInboxRead(item.id);             // looked after as an open PR from now on
    else if (canTransition(item, "DONE")) await finish(item);
  }
  onJobEnd(job.id, "done");
  return getJob(job.id)!;
}

async function endFailed(job: Job, item: Item, owned: boolean, reason: string): Promise<Job> {
  if (owned && canTransition(item, "FAILED")) await fail(item, reason);
  else await notify({ kind: "failed", taskId: item.id, taskRef: item.source_ref ?? undefined, dedupeKey: `job:${job.id}`, title: `${item.source_ref ?? item.id}: ${job.type.replace(/_/g, " ")} failed`, body: truncate(reason, 700) }).catch(() => {});
  onJobEnd(job.id, "failed", truncate(reason, 2000));
  return getJob(job.id)!;
}

/** A step threw: budget → pause; otherwise retry with back-off, then pause for a person (v1 rules). */
async function onStepError(job: Job, item: Item, owned: boolean, step: string, e: any): Promise<Job> {
  const ref = item.source_ref ?? item.id;
  if (owned) {
    const t = e instanceof BudgetPause
      ? await pause(item, `Budget: ${e.message}. Reply \`/aiw resume ${ref}\` to continue or \`/aiw cancel\` to stop.`)
      : await retryOrFail(item, `${step}: ${e.message}`);
    return toWaiting(job, `${step}: ${truncate(e.message, 150)}`, { retryAt: t.data.retryAt ?? null });
  }
  if (e instanceof BudgetPause) {
    await notify({ kind: "paused", taskId: item.id, taskRef: ref, dedupeKey: `job:${job.id}:budget`, title: `${ref} paused`, body: `Budget: ${e.message}` }).catch(() => {});
    return toWaiting(job, `budget: ${e.message}`);
  }
  const n = job.attempts + 1;
  if (n < 3) {
    return patchJob(job.id, { state: "queued", attempts: n, error: truncate(`${step}: ${e.message}`, 2000), data: { ...job.data, retryAt: new Date(Date.now() + backoff(n + 4)).toISOString() } });
  }
  return endFailed(job, item, owned, `Stopped after repeated errors in ${step}: ${truncate(e.message, 500)}`);
}

/** Do what a waiting / ending result means (the side effects of runTask's switch). */
async function applyOutcome(job: Job, item: Item, owned: boolean, drives: boolean, step: string, idx: number, result: StepResult, outcome: StepOutcome): Promise<Job> {
  const ref = item.source_ref ?? item.id;
  switch (result.status) {
    case "ok":
    case "done":
      return complete(job, item, owned);
    case "await_approval":
      if (drives) {
        updateTask(item.id, { step_index: idx });
        transition(item.id, "AWAITING_APPROVAL", `approval ${result.approvalId}`);
      }
      return toWaiting(job, "waiting for your approval", { approvalId: result.approvalId });
    case "wait":
      if (drives) transition(item.id, result.state, result.note ?? "waiting");
      return toWaiting(job, result.note ?? "waiting");
    case "need_info": {
      const qs = normaliseQuestions(result.questions, 4);
      if (drives && item.kind === "part") {
        mergeData(item.id, { questions: qs, askedWhile: result.context ?? step.replace(/_/g, " ") });
        transition(item.id, "ASKING_LEAD", "question for the lead");
        return toWaiting(job, "question for the lead");
      }
      if (drives) {
        transition(item.id, "NEEDS_INFO", "step needs information");
        mergeData(item.id, { questions: qs, needInfoFrom: "step" });
      } else {
        mergeJobData(job.id, { questions: qs });
      }
      const t = getTask(item.id)!;
      await askUser(t, qs, result.context ?? `While working on ${step.replace(/_/g, " ")}`, `${t.run_no}:${idx}:${(t.data.clarifications ?? []).length}${drives ? "" : `:${job.id}`}`);
      return toWaiting(job, "waiting for your answer");
    }
    case "retriage": {
      if (drives) {
        mergeData(item.id, { interview: item.data.clarifications ?? [], clarifications: [], questions: null, request: { ...(item.data.request ?? {}), confirmedAt: nowIso() } });
        updateTask(item.id, { kind: "assigned", playbook: null, size: null, step_index: 0, run_no: item.run_no + 1 });
        transition(item.id, "DETECTED", result.note ?? "re-triage");
      }
      onJobEnd(job.id, "done");
      return getJob(job.id)!;
    }
    case "pause":
      if (drives) await pause(item, result.reason);
      else await notify({ kind: "paused", taskId: item.id, taskRef: ref, dedupeKey: `job:${job.id}:${idx}`, title: `${ref} paused`, body: result.reason }).catch(() => {});
      return toWaiting(job, result.reason);
    case "fail":
      return endFailed(job, item, drives, result.reason);
  }
  void outcome;
  return getJob(job.id)!;
}

// ------------------------------------------------------------------ restart, resume, tick

/** At start-up: jobs left running by a crash go back to the queue at the same step (finished steps are not re-run). */
export const recoverJobs: RecoverJobs = () => {
  const rows = (db().prepare("SELECT * FROM jobs WHERE state='running'").all() as any[]).map(rowToJob).filter((j) => !live.has(j.id));
  for (const j of rows) {
    db().prepare("UPDATE steps SET status='interrupted', ended_at=COALESCE(ended_at, ?) WHERE job_id=? AND status='running'").run(nowIso(), j.id);
    patchJob(j.id, { state: "queued", activity: "resuming after a restart", activity_at: nowIso() });
  }
  try { db().prepare("DELETE FROM agent_cache WHERE created_at < ?").run(new Date(Date.now() - 14 * 86_400_000).toISOString()); } catch { /* best effort */ }
  if (rows.length) audit("service", "kernel.recovered", undefined, { jobs: rows.length });
  return rows.length;
};

/** Continue a waiting job (after an answer, an approval or an event). input.stepIndex moves it to another step. */
export const resumeJob: ResumeJob = (jobId, input = {}) => {
  const j = getJob(jobId);
  if (!j) throw new Error(`Job ${jobId} not found`);
  if (j.state !== "waiting") return j;
  const { stepIndex, ...rest } = input;
  return patchJob(jobId, { state: "queued", step_index: typeof stepIndex === "number" ? stepIndex : undefined, data: { ...j.data, ...rest }, activity: "continuing", activity_at: nowIso() });
};

/** The waiting job that asked for this approval (v2: a fix on a PR_OPEN item asks without changing the item). */
export function jobForApproval(approvalId: string): Job | undefined {
  const r = db().prepare("SELECT * FROM jobs WHERE state='waiting' AND json_extract(data,'$.approvalId')=? LIMIT 1").get(approvalId);
  return r ? rowToJob(r) : undefined;
}

/**
 * Items that are QUEUED with a playbook get their job: a waiting job of the item's own recipe is put back in the queue,
 * otherwise a new one is created (type from the recipe: build, comment_fix, qa, review…). `eligible` lets the engine
 * keep v1's holds (a sibling or lead that must go first).
 */
export function ensureJobs(eligible: (t: Task) => boolean = () => true): number {
  let n = 0;
  const rows = (db().prepare("SELECT * FROM tasks WHERE state='QUEUED' AND playbook IS NOT NULL ORDER BY priority, created_at").all() as any[]);
  for (const r of rows) {
    const item = getItem(r.id);
    if (!item || !item.playbook || !eligible(item)) continue;
    if (item.data.takenOver && !item.data.handedBack) continue;          // you took it over: nothing runs until "continue"
    const retryAt = item.data.retryAt ?? null;
    const active = activeJob(item.id);
    if (active) {
      if (active.state === "waiting" && ownsItem(active, item)) { resumeJob(active.id, { retryAt, approvalId: null }); n++; }
      continue;
    }
    const queued = queuedJobs(item.id).find((j) => ownsItem(j, item));
    if (queued) {
      if ((queued.data.retryAt ?? null) !== retryAt) mergeJobData(queued.id, { retryAt });
      continue;
    }
    let type: Job["type"] = "build";
    try { type = getRecipe(item.playbook).job; } catch { /* unknown recipe: the job fails with a clear reason */ }
    if (["pr_fix", "pr_qa", "pr_review"].includes(item.kind) && item.level === "ticket") db().prepare("UPDATE tasks SET level='pr' WHERE id=?").run(item.id);
    createJob({ itemId: item.id, type, recipe: item.playbook, priority: item.priority, data: { retryAt } });
    n++;
  }
  return n;
}

/** Jobs whose item ended (done, cancelled, merged into DONE) stop; queued jobs of a failed item wait for its resume. */
export function sweepJobs(): number {
  const r = db().prepare(`SELECT j.id, j.state, t.state AS item_state FROM jobs j JOIN tasks t ON t.id = j.item_id
    WHERE j.state IN ('queued','waiting','running') AND t.state IN ('DONE','CANCELLED')`).all() as any[];
  let n = 0;
  for (const x of r) {
    if (live.has(x.id)) continue;                                      // the running loop notices it itself
    onJobEnd(x.id, x.item_state === "DONE" ? "done" : "cancelled", `item is ${x.item_state}`);
    n++;
  }
  return n;
}

export interface KernelTickOpts {
  /** Engine holds for items (v1 blockedBySibling / blockedByLead). */
  eligible?: (t: Task) => boolean;
  /** Called after each job run ends (the engine ticks again). */
  onRunEnd?: () => void;
  settings?: Settings;
}

/** One kernel pass (engine.ts tick when engine.version is v2): migrate once, route events, keep jobs, start what may run. */
export async function kernelTick(opts: KernelTickOpts = {}): Promise<void> {
  const settings = opts.settings ?? loadSettings();
  try { migrateToKernel(); } catch (e: any) { logger.error("v2 data migration failed", { error: e.message }); }
  linkParts();
  try { routeEvents(settings); } catch (e: any) { logger.error("event routing failed", { error: e.message }); }
  sweepJobs();
  requeuePausedJobs();
  ensureJobs(opts.eligible);
  const d = pickRunnable(limitsFrom(settings), []);
  for (const j of d.start) {
    if (live.has(j.id)) continue;
    const claimed = startJob(j.id);
    if (!claimed) continue;
    budgetWarnings(claimed.item_id);
    runJob(claimed.id)
      .catch((e) => logger.error("runJob crashed", { job: j.id, error: e.message }))
      .finally(() => { try { opts.onRunEnd?.(); } catch { /* ignore */ } });
  }
}

/**
 * A job that owns a PR_OPEN item and paused (budget, repeated errors after the PR, a step's own pause) leaves the item
 * in PR_OPEN, so "resume" has no item state to move. resumeTask() sets data.resumeJobs on the item; this puts those
 * waiting jobs back in the queue at the same step (wave-2 gap: paused owned jobs on PR_OPEN items were never requeued).
 */
export function requeuePausedJobs(): number {
  const rows = db().prepare(`SELECT j.* FROM jobs j JOIN tasks t ON t.id = j.item_id
    WHERE j.state='waiting' AND t.state='PR_OPEN' AND json_extract(t.data,'$.resumeJobs') IS NOT NULL
      AND json_extract(j.data,'$.approvalId') IS NULL AND json_extract(j.data,'$.questions') IS NULL AND j.type<>'ci_watch'`).all() as any[];
  let n = 0;
  for (const r of rows) {
    const j = rowToJob(r);
    if (live.has(j.id)) continue;
    resumeJob(j.id, { retryAt: null, paused: null });
    n++;
  }
  for (const id of new Set(rows.map((r) => r.item_id))) mergeData(id, { resumeJobs: null });
  return n;
}

/** Budget warnings at 80 % (item / batch / epic / sprint / day): each sent once, when the item's next job starts. */
function budgetWarnings(itemId: string): void {
  void (async () => {
    try {
      const item = getItem(itemId);
      const project = item && getProject(item.project_id);
      if (!item || !project) return;
      const { checkScopeBudget, markBudgetWarned } = await import("../engine/budget.js");
      const c = checkScopeBudget(project, item);
      if (!c.warnings.length) return;
      markBudgetWarned(item.id, c.warnings);
      await notify({ kind: "info", taskId: item.id, taskRef: item.source_ref ?? undefined, dedupeKey: `budget:${c.warnings.map((w) => w.id + w.scope).join(",")}`,
        title: `${item.source_ref ?? item.id}: budget at 80%`, body: c.warnings.map((w) => w.text).join("\n") });
    } catch (e: any) { logger.warn("budget warning failed", { error: e.message }); }
  })();
}

/** Is this item busy in the kernel (a job of it running in this process)? Used by isRunning() in v2. */
export const kernelBusy = itemRunning;

/** Stop every job of an item (cancel). */
export function stopItemJobs(itemId: string, reason = "cancelled"): number {
  return clearMailbox(itemId, { includeActive: true, reason });
}
