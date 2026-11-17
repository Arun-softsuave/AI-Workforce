import { db, audit, tx } from "../core/db.js";
import { newId, nowIso, safeJson } from "../core/util.js";
import { publish } from "../live/bus.js";

/** Task lifecycle (PRD §7). Every transition is validated and audited. */
export const STATES = [
  "DETECTED", "TRIAGED", "NEEDS_INFO", "AWAITING_START", "QUEUED", "RUNNING", "PAUSED",
  "AWAITING_APPROVAL", "PUBLISHING", "DONE", "CANCELLED", "FAILED", "REJECTED", "STALE", "FAILED_PUBLISH",
  // multi-repository work: the lead waits for its parts; a part waits for the lead (finished, or asked the lead something)
  "WAITING_PARTS", "PART_READY", "ASKING_LEAD",
] as const;
export type State = (typeof STATES)[number];

const T: Record<State, State[]> = {
  DETECTED: ["TRIAGED", "QUEUED", "NEEDS_INFO", "CANCELLED", "FAILED"],
  TRIAGED: ["QUEUED", "AWAITING_START", "NEEDS_INFO", "CANCELLED"],
  NEEDS_INFO: ["QUEUED", "CANCELLED", "DETECTED"],
  AWAITING_START: ["QUEUED", "CANCELLED"],
  QUEUED: ["RUNNING", "CANCELLED", "PAUSED"],
  RUNNING: ["RUNNING", "QUEUED", "PAUSED", "NEEDS_INFO", "AWAITING_APPROVAL", "DONE", "FAILED", "CANCELLED", "DETECTED", "WAITING_PARTS", "PART_READY", "ASKING_LEAD"],   // DETECTED: a confirmed request is triaged like a ticket
  PAUSED: ["QUEUED", "CANCELLED", "FAILED"],
  AWAITING_APPROVAL: ["PUBLISHING", "REJECTED", "STALE", "CANCELLED", "QUEUED"],
  PUBLISHING: ["DONE", "FAILED_PUBLISH", "STALE", "RUNNING"],
  REJECTED: ["QUEUED", "CANCELLED"],
  STALE: ["QUEUED", "CANCELLED", "AWAITING_APPROVAL"],
  FAILED_PUBLISH: ["PUBLISHING", "QUEUED", "CANCELLED", "AWAITING_APPROVAL"],
  FAILED: ["QUEUED", "CANCELLED"],
  WAITING_PARTS: ["QUEUED", "CANCELLED", "PAUSED", "FAILED"],
  PART_READY: ["QUEUED", "DONE", "CANCELLED"],
  ASKING_LEAD: ["QUEUED", "CANCELLED", "PAUSED", "FAILED"],
  DONE: [],
  CANCELLED: [],
};
export const TERMINAL: State[] = ["DONE", "CANCELLED"];
export const ACTIVE: State[] = STATES.filter((s) => !TERMINAL.includes(s) && s !== "FAILED");

export interface Task {
  id: string; project_id: string; source: string; source_id: string | null; source_ref: string | null;
  title: string | null; kind: string; role: string | null; size: string | null; playbook: string | null;
  state: State; priority: number; step_index: number; run_no: number; tokens_used: number; cost_usd: number;
  worktree: string | null; branch: string | null; data: Record<string, any>; error: string | null;
  created_at: string; updated_at: string;
}

const row2task = (r: any): Task => ({ ...r, data: safeJson(r.data, {}) });

export function getTask(id: string): Task | undefined {
  const r = db().prepare("SELECT * FROM tasks WHERE id=? OR source_ref=? ORDER BY created_at DESC LIMIT 1").get(id, id);
  if (r) return row2task(r);
  // "KAN-42" for a multi-repo ticket ("KAN-42@nue-backend" + "KAN-42@nue-frontend"): resolve when it is unambiguous,
  // preferring the one that is waiting for the user.
  const rows = (db().prepare("SELECT * FROM tasks WHERE source_ref LIKE ? AND kind != 'part' AND state NOT IN ('DONE','CANCELLED','FAILED') ORDER BY created_at")
    .all(`${id}@%`) as any[]).map(row2task);
  const waiting = rows.filter((t) => ["AWAITING_APPROVAL", "NEEDS_INFO", "AWAITING_START", "PAUSED", "STALE"].includes(t.state));
  if (waiting.length === 1) return waiting[0];
  return rows.length === 1 ? rows[0] : undefined;
}

/** The Jira issue key behind a task (source_ref may carry a repo suffix like "KAN-42@nue-frontend"). */
export function jiraKey(t: Task): string {
  return t.data.ticket?.key ?? (t.source_ref ?? "").split("@")[0];
}

/** The per-repository part tasks of a lead task (not cancelled), in creation order. */
export function partsOf(leadId: string): Task[] {
  return (db().prepare("SELECT * FROM tasks WHERE kind='part' AND json_extract(data,'$.leadId')=? AND state != 'CANCELLED' ORDER BY created_at")
    .all(leadId) as any[]).map(row2task);
}

/** All active tasks for one tracker issue, including the per-repo halves of a multi-repo ticket. */
export function activeTasksForIssue(issueId: string): Task[] {
  return (db().prepare("SELECT * FROM tasks WHERE (source_id=? OR source_id LIKE ?) AND state NOT IN ('DONE','CANCELLED','FAILED')")
    .all(issueId, `${issueId}#%`) as any[]).map(row2task);
}

export function listTasks(f: { states?: State[]; projectId?: string; limit?: number } = {}): Task[] {
  const where: string[] = [], args: any[] = [];
  if (f.states?.length) { where.push(`state IN (${f.states.map(() => "?").join(",")})`); args.push(...f.states); }
  if (f.projectId) { where.push("project_id=?"); args.push(f.projectId); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY priority ASC, created_at ASC LIMIT ?`;
  return (db().prepare(sql).all(...args, f.limit ?? 500) as any[]).map(row2task);
}

/** Active (non-terminal) task for the same source item and trigger – used to avoid duplicate work. */
export function activeTaskFor(sourceId: string, kind?: string): Task | undefined {
  const r = db().prepare(
    `SELECT * FROM tasks WHERE source_id=? ${kind ? "AND kind=?" : ""} AND state NOT IN ('DONE','CANCELLED','FAILED') ORDER BY created_at DESC LIMIT 1`,
  ).get(...(kind ? [sourceId, kind] : [sourceId]));
  return r ? row2task(r) : undefined;
}

export function createTask(t: { projectId: string; source: string; sourceId?: string; sourceRef?: string; title?: string; kind: string; role?: string; priority?: number; data?: Record<string, any>; state?: State }): Task {
  if (t.sourceId) {
    const existing = activeTaskFor(t.sourceId, t.kind);
    if (existing) return existing;
  }
  const id = newId("t");
  const now = nowIso();
  db().prepare(`INSERT INTO tasks (id, project_id, source, source_id, source_ref, title, kind, role, state, priority, data, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, t.projectId, t.source, t.sourceId ?? null, t.sourceRef ?? null, t.title ?? null, t.kind,
    t.role ?? null, t.state ?? "DETECTED", t.priority ?? 3, JSON.stringify(t.data ?? {}), now, now);
  audit("service", "task.created", id, { source: t.sourceRef, kind: t.kind });
  return getTask(id)!;
}

export class TransitionError extends Error {}

export function transition(id: string, to: State, note?: string, patch: Partial<Pick<Task, "error" | "step_index" | "playbook" | "size">> = {}): Task {
  return tx(() => {
    const t = getTask(id);
    if (!t) throw new TransitionError(`Task ${id} not found`);
    if (t.state !== to && !T[t.state].includes(to)) throw new TransitionError(`Illegal transition ${t.state} -> ${to} for ${t.source_ref ?? id}`);
    const sets = ["state=?", "updated_at=?"], args: any[] = [to, nowIso()];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${k}=?`); args.push(v ?? null); }
    db().prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id=?`).run(...args, t.id);
    audit("service", "task.transition", t.id, { from: t.state, to, note });
    // the dashboard re-reads the board and "Needs you" when an item changes state
    if (t.state !== to) { try { publish("item", { taskId: t.id, ref: t.source_ref, from: t.state, to }); } catch { /* live view only */ } }
    return getTask(t.id)!;
  });
}

export function canTransition(t: Task, to: State): boolean { return t.state === to || T[t.state].includes(to); }

export function updateTask(id: string, patch: Partial<Omit<Task, "id" | "data" | "state">>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db().prepare(`UPDATE tasks SET ${keys.map((k) => `${k}=?`).join(", ")}, updated_at=? WHERE id=?`)
    .run(...keys.map((k) => (patch as any)[k] ?? null), nowIso(), id);
}

/** Shallow-merge into the task's JSON data (the playbook checkpoint context). */
export function mergeData(id: string, patch: Record<string, any>): Task {
  const t = getTask(id)!;
  const data = { ...t.data, ...patch };
  db().prepare("UPDATE tasks SET data=?, updated_at=? WHERE id=?").run(JSON.stringify(data), nowIso(), t.id);
  return { ...t, data };
}

export function addUsage(id: string, tokens: number, cost: number): void {
  db().prepare("UPDATE tasks SET tokens_used = tokens_used + ?, cost_usd = cost_usd + ?, updated_at=? WHERE id=?").run(tokens, cost, nowIso(), id);
}

export interface StepRow { id: number; name: string; status: string; agent: string | null; model: string | null; tokens_in: number; tokens_out: number; cost_usd: number; started_at: string; ended_at: string | null; error: string | null; output: string | null; fresh_in?: number; cache_read?: number; cache_write?: number; effort?: string | null }

/** Token counts of one or more agent calls. tokensIn = freshIn + cacheRead + cacheWrite. */
export interface StepUsage { agent?: string; model?: string; tokensIn?: number; tokensOut?: number; freshIn?: number; cacheRead?: number; cacheWrite?: number; effort?: string; cost?: number; output?: unknown; error?: string }

export function startStep(taskId: string, runNo: number, idx: number, name: string): number {
  const r = db().prepare("INSERT INTO steps (task_id, run_no, idx, name, status, started_at) VALUES (?,?,?,?,?,?)").run(taskId, runNo, idx, name, "running", nowIso());
  return Number(r.lastInsertRowid);
}

export function endStep(stepId: number, status: string, u: StepUsage = {}): void {
  db().prepare("UPDATE steps SET status=?, agent=?, model=?, tokens_in=?, tokens_out=?, cost_usd=?, ended_at=?, output=?, error=? WHERE id=?")
    .run(status, u.agent ?? null, u.model ?? null, u.tokensIn ?? 0, u.tokensOut ?? 0, u.cost ?? 0, nowIso(),
      u.output === undefined ? null : JSON.stringify(u.output).slice(0, 20_000), u.error ?? null, stepId);
  const split = u.freshIn !== undefined || u.cacheRead !== undefined || u.cacheWrite !== undefined;
  if (split) {
    db().prepare("UPDATE steps SET fresh_in=?, cache_read=?, cache_write=?, effort=COALESCE(?, effort) WHERE id=?")
      .run(u.freshIn ?? 0, u.cacheRead ?? 0, u.cacheWrite ?? 0, u.effort ?? null, stepId);
  } else {
    // the split was added call by call (addStepUsage) or is unknown: then all input counts as fresh
    db().prepare("UPDATE steps SET fresh_in = CASE WHEN COALESCE(fresh_in,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0) > 0 THEN fresh_in ELSE ? END, effort=COALESCE(?, effort) WHERE id=?")
      .run(u.tokensIn ?? 0, u.effort ?? null, stepId);
  }
}

/**
 * Add one agent call's fresh / cache-read / cache-write split to the task's running step (the step's totals are
 * written by endStep when it finishes). Effort keeps the highest seen in the step.
 */
export function addStepUsage(taskId: string, u: { freshIn?: number; cacheRead?: number; cacheWrite?: number; effort?: string }): void {
  try {
    const row = db().prepare("SELECT id, effort FROM steps WHERE task_id=? AND status='running' ORDER BY id DESC LIMIT 1").get(taskId) as { id: number; effort: string | null } | undefined;
    if (!row) return;
    const rank = (e?: string | null) => ["low", "medium", "high", "xhigh", "max"].indexOf(e ?? "");
    const effort = rank(u.effort) > rank(row.effort) ? u.effort! : row.effort;
    db().prepare("UPDATE steps SET fresh_in=COALESCE(fresh_in,0)+?, cache_read=COALESCE(cache_read,0)+?, cache_write=COALESCE(cache_write,0)+?, effort=? WHERE id=?")
      .run(u.freshIn ?? 0, u.cacheRead ?? 0, u.cacheWrite ?? 0, effort ?? null, row.id);
  } catch { /* best effort */ }
}

/** The usage fields of an agent result, ready for endStep / recordUsage. */
export function usageOf(r: { agent?: string; model?: string; tokensIn: number; tokensOut: number; freshIn?: number; cacheRead?: number; cacheWrite?: number; effort?: string; costUsd: number; error?: string }, agent?: string): StepUsage {
  return { agent: agent ?? r.agent, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, freshIn: r.freshIn, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, effort: r.effort, cost: r.costUsd, error: r.error };
}

/**
 * Usage of an agent call made outside a task step (Brain onboarding, document reading, rules card, Teams intent…).
 * It is stored as a finished steps row so the cost view and `aiw bench` see it: task_id is the task when there is one,
 * otherwise "system:<scope>". It never throws – cost recording must not break the work.
 */
export function recordUsage(scope: string, r: Parameters<typeof usageOf>[0], opts: { taskId?: string; agent?: string } = {}): void {
  try {
    if (!r || (!r.tokensIn && !r.tokensOut && !r.costUsd)) return;
    const sid = startStep(opts.taskId ?? `system:${scope}`, 0, -1, scope);
    endStep(sid, r.error ? "failed" : "ok", usageOf(r, opts.agent));
    if (opts.taskId) addUsage(opts.taskId, r.tokensIn + r.tokensOut, r.costUsd);
  } catch { /* best effort */ }
}

export function stepsFor(taskId: string): StepRow[] {
  return db().prepare("SELECT * FROM steps WHERE task_id=? ORDER BY id").all(taskId) as unknown as StepRow[];
}
