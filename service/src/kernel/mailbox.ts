/**
 * Kernel mailbox (IMPLEMENTATION-PLAN 5.4): one active job per item; new work waits on the item as queued jobs.
 *
 * - The mailbox is not a table: it is the `queued` rows of `jobs` for an item.
 * - At most ONE job per item is active (running or waiting) – startJob() refuses a second one.
 * - enqueue() folds a new event into a queued job of the same type for the same item (newest trigger kept),
 *   so ten "CI failed" events before the fix starts give one fix job, not ten.
 * - Code only: no model calls.
 */
import { db, tx } from "../core/db.js";
import { newId, nowIso, safeJson } from "../core/util.js";
import {
  ACTIVE_JOB_STATES,
  type ActiveJob, type ClearMailbox, type Enqueue, type Job, type JobState, type JobType, type KernelEvent,
  type MailboxEntry, type MailboxOf, type NewJob, type NextForItem, type Reaction,
} from "./types.js";

/** A jobs row as a Job (data parsed). */
export function rowToJob(r: any): Job {
  return { ...r, data: safeJson(r.data, {}) } as Job;
}

/** Run `fn` in a transaction, or inside the caller's one when there already is one (tx() does not nest). */
function atomic<T>(fn: () => T): T {
  return (db() as any).isTransaction === true ? fn() : tx(fn);
}

const ACTIVE_SQL = `(${ACTIVE_JOB_STATES.map((s) => `'${s}'`).join(",")})`;
/** Job types that only watch (no recipe runs): they never occupy their item, so they are left out of "active". */
export const PASSIVE_JOB_TYPES: readonly JobType[] = ["ci_watch"];
const NOT_PASSIVE = `type NOT IN (${PASSIVE_JOB_TYPES.map((t) => `'${t}'`).join(",")})`;

export function getJob(id: string): Job | undefined {
  const r = db().prepare("SELECT * FROM jobs WHERE id=?").get(id);
  return r ? rowToJob(r) : undefined;
}

/** What a merged job remembers of each event folded into it (job.data.events). */
function eventNote(ev: KernelEvent): Record<string, any> {
  return { id: ev.id, type: ev.type, at: ev.received_at, payload: ev.payload ?? {} };
}

/** Insert a queued job (no merging). */
export function createJob(n: NewJob): Job {
  const now = nowIso();
  const id = newId("job");
  db().prepare(`INSERT INTO jobs (id, item_id, type, recipe, state, priority, trigger_event, data, created_at, updated_at)
    VALUES (?,?,?,?,'queued',?,?,?,?,?)`)
    .run(id, n.itemId, n.type, n.recipe, n.priority ?? 3, n.triggerEvent ?? null, JSON.stringify(n.data ?? {}), now, now);
  return getJob(id)!;
}

/** The item's oldest queued job of this type (the one new events of that type merge into). */
function queuedOfType(itemId: string, type: JobType): Job | undefined {
  const r = db().prepare("SELECT * FROM jobs WHERE item_id=? AND type=? AND state='queued' ORDER BY created_at, rowid LIMIT 1").get(itemId, type);
  return r ? rowToJob(r) : undefined;
}

/**
 * Add a job to an item's mailbox.
 * mode "merge" (default): an already queued job of the same type takes the new trigger (newest wins), the more
 * urgent priority and the event appended to data.events. "queue": always a new job. "drop": nothing when one is queued.
 * Returns undefined when nothing was added (dropped).
 */
export function enqueueJob(n: NewJob, mode: "merge" | "queue" | "drop" = "merge", ev?: KernelEvent): { job: Job; merged: boolean } | undefined {
  return atomic(() => {
    const existing = mode === "queue" ? undefined : queuedOfType(n.itemId, n.type);
    if (existing && mode === "drop") return undefined;
    if (existing) {
      const data = { ...existing.data, ...(n.data ?? {}) };
      const events = Array.isArray(existing.data.events) ? [...existing.data.events] : [];
      if (ev && !events.some((e: any) => e?.id === ev.id)) events.push(eventNote(ev));
      if (events.length) data.events = events;
      const trigger = n.triggerEvent ?? ev?.id ?? existing.trigger_event;
      const priority = Math.min(existing.priority, n.priority ?? existing.priority);
      db().prepare("UPDATE jobs SET trigger_event=?, priority=?, data=?, updated_at=? WHERE id=?")
        .run(trigger, priority, JSON.stringify(data), nowIso(), existing.id);
      return { job: getJob(existing.id)!, merged: true };
    }
    const data = { ...(n.data ?? {}) };
    if (ev) data.events = [eventNote(ev)];
    return { job: createJob({ ...n, triggerEvent: n.triggerEvent ?? ev?.id, data }), merged: false };
  });
}

/** Put a job for this event on the item (the reaction says which job, recipe, priority and merge mode). */
export const enqueue: Enqueue = (itemId: string, reaction: Reaction, ev?: KernelEvent) => {
  if (reaction.job === "none") return undefined;
  return enqueueJob({ itemId, type: reaction.job, recipe: reaction.recipe, priority: reaction.priority }, reaction.merge ?? "merge", ev);
};

/** The item's active job (running or waiting), if any. */
export const activeJob: ActiveJob = (itemId: string) => {
  const r = db().prepare(`SELECT * FROM jobs WHERE item_id=? AND state IN ${ACTIVE_SQL} AND ${NOT_PASSIVE} ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(itemId);
  return r ? rowToJob(r) : undefined;
};

/** The item's queued jobs as Job rows, most urgent first, then oldest. */
export function queuedJobs(itemId: string): Job[] {
  return (db().prepare(`SELECT * FROM jobs WHERE item_id=? AND state='queued' AND ${NOT_PASSIVE} ORDER BY priority, created_at, rowid`).all(itemId) as any[]).map(rowToJob);
}

/** The item's queued jobs, by priority then age. */
export const mailboxOf: MailboxOf = (itemId: string) =>
  queuedJobs(itemId).map((j): MailboxEntry => ({ job_id: j.id, item_id: j.item_id, type: j.type, priority: j.priority, trigger_event: j.trigger_event, queued_at: j.created_at }));

/** The next queued job of an item that may start now (undefined when the item already has an active job). */
export const nextForItem: NextForItem = (itemId: string) => {
  if (activeJob(itemId)) return undefined;
  return queuedJobs(itemId)[0];
};

/**
 * Claim a queued job: queued → running, only when its item has no other active job.
 * Returns the running job, or undefined when the job is not queued or the item is busy.
 */
export function startJob(jobId: string): Job | undefined {
  return atomic(() => {
    const j = getJob(jobId);
    if (!j || j.state !== "queued") return undefined;
    const busy = db().prepare(`SELECT id FROM jobs WHERE item_id=? AND id<>? AND state IN ${ACTIVE_SQL} AND ${NOT_PASSIVE} LIMIT 1`).get(j.item_id, j.id);
    if (busy) return undefined;
    db().prepare("UPDATE jobs SET state='running', updated_at=? WHERE id=?").run(nowIso(), j.id);
    return getJob(j.id);
  });
}

/**
 * A job ended (done, failed or cancelled): record it and return the item's next queued job, if any,
 * so the caller (runner / tick) can start it.
 */
export function onJobEnd(jobId: string, state: Extract<JobState, "done" | "failed" | "cancelled">, error?: string): Job | undefined {
  return atomic(() => {
    const j = getJob(jobId);
    if (!j) return undefined;
    db().prepare("UPDATE jobs SET state=?, error=?, updated_at=? WHERE id=?").run(state, error ?? (state === "done" ? null : j.error), nowIso(), j.id);
    return nextForItem(j.item_id);
  });
}

/** Cancel queued (and optionally the active) jobs of an item. Returns how many. */
export const clearMailbox: ClearMailbox = (itemId: string, opts?: { includeActive?: boolean; reason?: string }) => {
  const states = opts?.includeActive ? ["queued", ...ACTIVE_JOB_STATES] : ["queued"];
  const r = db().prepare(`UPDATE jobs SET state='cancelled', error=?, updated_at=? WHERE item_id=? AND state IN (${states.map(() => "?").join(",")})`)
    .run(opts?.reason ?? "cancelled", nowIso(), itemId, ...states);
  return Number(r.changes);
};
