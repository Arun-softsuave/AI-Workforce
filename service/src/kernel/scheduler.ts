/**
 * Kernel scheduler (IMPLEMENTATION-PLAN 5.5): which queued jobs start now.
 *
 * decide() is pure: it takes a snapshot (queued and active jobs, their items, edges) and returns the jobs to start
 * plus a plain reason for every job that waits. pickRunnable() is the contract entry point: given only the limits and
 * the running jobs it loads the snapshot from the database (thin loader) and calls decide().
 *
 * Rules, in the order a held job's reason is chosen:
 *  1. everything paused (aiw pause)                         → "paused"
 *  2. the item's state: BLOCKED, AWAITING_START, NEEDS_INFO, PAUSED, closed → "blocked…", "needs your start", …
 *     the item was taken over by you (data.takenOver)      → "you took it over"
 *  2b. a connector the job's next step needs is down / rate limited (intake/healthGate) → "blocked: GitHub disconnected"
 *  2c. a budget is used up and stopForBudget is on (engine/budget checkScopeBudget)   → "budget: …"
 *  3. job.data.retryAt in the future                       → "retrying later"
 *  4. the item already has an active job (one per item)    → "waiting for its current job"
 *  5. waves: a depends_on edge to an item not MERGED/DONE (a stacks_on edge to a PR_OPEN item is enough)
 *                                                          → "waiting for KAN-50 (needs it first)"
 *  6. area lock: another item's build job with overlapping areas is running or starts in this pass
 *                                                          → "waiting for KAN-52 (same area)"
 *  7. at most `buildsPerRepo` build jobs per repository     → "repo limit (2 builds in nue-backend)"
 *  8. at most `slots` running jobs in total                 → "all slots busy (5 of 5)"
 * Order of start: job priority, item priority (lower = more urgent), item due date (none last), then age.
 */
import { db, getMeta } from "../core/db.js";
import { safeJson } from "../core/util.js";
import { loadSettings, getProject, type Settings } from "../core/config.js";
import { checkScopeBudget } from "../engine/budget.js";
import type { State } from "../engine/tasks.js";
import { rowToJob } from "./mailbox.js";
import { blockingConnector, unavailableConnectors, type HealthProvider, type HealthRow } from "../intake/healthGate.js";
import {
  DEFAULT_LIMITS,
  type Edge, type HoldReason, type Item, type Job, type JobType, type LimitsFrom, type PickRunnable, type SchedulerLimits,
} from "./types.js";

/** Job types that build and run code on this computer (tests, builds); they count toward the repo limit and area locks. */
export const BUILD_JOB_TYPES: readonly JobType[] = ["build", "ci_fix", "comment_fix", "qa", "rebase"];
export const isBuildJob = (j: Pick<Job, "type">): boolean => BUILD_JOB_TYPES.includes(j.type);

/** The fields of an item the scheduler reads (an Item satisfies it; tests may pass plain objects). */
export type SchedItem = Pick<Item, "id" | "project_id" | "state" | "priority" | "due" | "areas"> &
  Partial<Pick<Item, "source_ref" | "title" | "error" | "created_at" | "source" | "data">>;

/** Everything decide() needs, read once. */
export interface SchedulerSnapshot {
  /** Jobs in state queued (any order). */
  queued: Job[];
  /** Jobs in state running or waiting. Only running ones use slots, repo builds and area locks; both occupy their item. */
  active: Job[];
  /** Every item referenced by the jobs and by their edges, by id. */
  items: Record<string, SchedItem>;
  /** depends_on / stacks_on / same_area edges touching those items. */
  edges: Edge[];
  /** True while AI Workforce is paused. */
  paused?: boolean;
  /** Connectors that are down or rate limited now (connector_health); none when absent. */
  down?: Map<HealthProvider, HealthRow>;
  /** Items whose budget is used up while settings.workflow.stopForBudget is on: item id → plain reason. */
  overBudget?: Record<string, string>;
  now?: Date;
}

/** Why a job waits (finer than the contract's HoldReason). */
export type WaitCode =
  | "paused" | "blocked" | "budget" | "taken_over" | "needs_start" | "needs_answer" | "item_paused" | "item_closed" | "retry_later"
  | "item_busy" | "depends_on" | "area_lock" | "repo_busy" | "slots";

export interface WaitingJob { jobId: string; itemId: string; code: WaitCode; reason: string }

export interface Decision {
  start: Job[];
  /** Contract shape (HoldReason codes). */
  held: { job: Job; reason: HoldReason }[];
  /** Plain reasons for status and the dashboard, one per held job, same order as `held`. */
  waiting: WaitingJob[];
}

/** WaitCode → the contract's HoldReason (types.ts has no code for the item-state holds; they show as paused). */
const HOLD: Record<WaitCode, HoldReason> = {
  paused: "paused", blocked: "connector", budget: "budget", taken_over: "paused", needs_start: "paused", needs_answer: "paused", item_paused: "paused",
  item_closed: "paused", retry_later: "retry_later", item_busy: "slots", depends_on: "depends_on",
  area_lock: "area_lock", repo_busy: "repo_busy", slots: "slots",
};

/** Item states whose dependants may start (a depends_on edge is met). */
const DEP_MET: State[] = ["MERGED", "DONE"];
const CLOSED: State[] = ["DONE", "CANCELLED", "FAILED"];

/** How an item is named in a reason: its ticket key ("KAN-52"), else its title, else its id. */
export function itemLabel(it: SchedItem | undefined, fallbackId: string): string {
  return it?.source_ref || it?.title || fallbackId;
}

/** Strip glob tails and slashes: "src/pay/**" → "src/pay", "./src/a.ts" → "src/a.ts". */
function areaRoot(a: string): string {
  let s = a.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const star = s.search(/[*?[{]/);
  if (star >= 0) s = s.slice(0, star);
  return s.replace(/\/+$/, "");
}

/** Two area globs overlap when one's fixed part is a path prefix of the other's ("" = the whole repo). */
export function areasOverlap(a: string[], b: string[]): boolean {
  for (const x of a) for (const y of b) {
    const p = areaRoot(x), q = areaRoot(y);
    if (p === q || p === "" || q === "") return true;
    if (q.startsWith(p + "/") || p.startsWith(q + "/")) return true;
  }
  return false;
}

/** Start order: job priority, item priority, due date (none last), then the oldest job. */
function compareJobs(items: Record<string, SchedItem>) {
  return (a: Job, b: Job): number => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const ia = items[a.item_id], ib = items[b.item_id];
    const pa = ia?.priority ?? 3, pb = ib?.priority ?? 3;
    if (pa !== pb) return pa - pb;
    const da = ia?.due ?? "", dbb = ib?.due ?? "";
    if (da !== dbb) return !da ? 1 : !dbb ? -1 : da < dbb ? -1 : 1;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  };
}

/** Jobs that keep an open PR healthy; they may run while another job of the item waits for a person. */
export const REPAIR_JOBS: readonly string[] = ["rebase", "ci_fix"];

/** The pure decision: jobs to start now and a plain reason for each one that waits. */
export function decide(limits: SchedulerLimits, snap: SchedulerSnapshot): Decision {
  const now = (snap.now ?? new Date()).getTime();
  const items = snap.items;
  const running = snap.active.filter((j) => j.state === "running");
  const busyItems = new Set(snap.active.filter((j) => j.state === "running").map((j) => j.item_id));
  /** Items with a job waiting for a person (approval, answer): other jobs wait, but repair jobs may run beside it. */
  const waitingOn = new Map(snap.active.filter((j) => j.state === "waiting").map((j) => [j.item_id, j] as const));
  /** Build jobs taking a repo slot / an area: the running ones plus those started in this pass. */
  const building: Job[] = running.filter(isBuildJob);
  let used = running.length;

  const start: Job[] = [];
  const held: Decision["held"] = [];
  const waiting: WaitingJob[] = [];
  const hold = (job: Job, code: WaitCode, reason: string) => {
    held.push({ job, reason: HOLD[code] });
    waiting.push({ jobId: job.id, itemId: job.item_id, code, reason });
  };

  const edgesFrom = (id: string, type: Edge["type"]) => snap.edges.filter((e) => e.from === id && e.type === type);
  const sameAreaEdge = (a: string, b: string) => snap.edges.some((e) => e.type === "same_area" && ((e.from === a && e.to === b) || (e.from === b && e.to === a)));

  for (const job of [...snap.queued].sort(compareJobs(items))) {
    const it = items[job.item_id];
    if (snap.paused) { hold(job, "paused", "paused"); continue; }
    if (!it) { hold(job, "item_closed", "item not found"); continue; }

    // 2. the item's own state
    if (it.state === "BLOCKED") { hold(job, "blocked", it.error ? `blocked: ${it.error}` : "blocked"); continue; }
    if (it.state === "AWAITING_START") { hold(job, "needs_start", "needs your start"); continue; }
    if (it.state === "NEEDS_INFO") { hold(job, "needs_answer", "waiting for your answer"); continue; }
    if (it.state === "PAUSED") { hold(job, "item_paused", "paused"); continue; }
    if (CLOSED.includes(it.state)) { hold(job, "item_closed", "item is closed"); continue; }
    if (it.data?.takenOver && !it.data?.handedBack) { hold(job, "taken_over", "you took it over"); continue; }

    // 2b. a connector this job's next step needs is down or rate limited (work that doesn't need it keeps running)
    const cb = snap.down?.size ? blockingConnector(it, job, snap.down) : undefined;
    if (cb) { hold(job, "blocked", `blocked: ${cb.reason}`); continue; }
    // 2c. budget used up (only when stopForBudget is on; otherwise budgets are reported, never stop work)
    const ob = snap.overBudget?.[it.id];
    if (ob) { hold(job, "budget", `budget: ${ob}`); continue; }

    // 3. retry later
    const retryAt = job.data?.retryAt ? new Date(job.data.retryAt).getTime() : 0;
    if (retryAt && retryAt > now) { hold(job, "retry_later", `retrying at ${new Date(retryAt).toISOString().slice(11, 16)}`); continue; }

    // 4. one active job per item
    if (busyItems.has(job.item_id)) { hold(job, "item_busy", "waiting for its current job"); continue; }
    // a job waiting for you never silently blocks keeping the PR healthy: rebase / CI fixes run in their own folder
    const w = waitingOn.get(job.item_id);
    if (w && !REPAIR_JOBS.includes(job.type)) { hold(job, "item_busy", `waiting behind ${w.type.replace(/_/g, " ")} (it waits for you)`); continue; }

    // 5. waves: unmet depends_on (stacked on a PR that is open is enough)
    if (limits.honourEdges) {
      const unmet = edgesFrom(it.id, "depends_on").filter((e) => {
        const dep = items[e.to];
        if (!dep) return false;                         // dangling edge (item gone): ignore it
        if (DEP_MET.includes(dep.state)) return false;
        return !(dep.state === "PR_OPEN" && edgesFrom(it.id, "stacks_on").some((s) => s.to === e.to));
      });
      if (unmet.length) {
        hold(job, "depends_on", `waiting for ${unmet.map((e) => itemLabel(items[e.to], e.to)).join(", ")} (needs it first)`);
        continue;
      }
    }

    const build = isBuildJob(job);
    // 6. area lock: two items whose areas overlap never build at once
    if (limits.areaLocks && build) {
      const other = building.find((b) => b.item_id !== it.id && (
        sameAreaEdge(it.id, b.item_id) ||
        (it.areas?.length && items[b.item_id]?.areas?.length && areasOverlap(it.areas, items[b.item_id].areas))));
      if (other) { hold(job, "area_lock", `waiting for ${itemLabel(items[other.item_id], other.item_id)} (same area)`); continue; }
    }

    // 7. repo limit for build jobs
    if (build) {
      const inRepo = building.filter((b) => items[b.item_id]?.project_id === it.project_id).length;
      if (inRepo >= limits.buildsPerRepo) { hold(job, "repo_busy", `repo limit (${limits.buildsPerRepo} build${limits.buildsPerRepo === 1 ? "" : "s"} in ${it.project_id})`); continue; }
    }

    // 8. slots
    if (used >= limits.slots) { hold(job, "slots", `all slots busy (${used} of ${limits.slots})`); continue; }

    start.push(job);
    used++;
    busyItems.add(job.item_id);
    if (build) building.push(job);
  }
  return { start, held, waiting };
}

// ------------------------------------------------------------------ thin DB loaders

/** A tasks row as the scheduler's item (areas parsed from JSON). */
function rowToItem(r: any): SchedItem {
  const areas = safeJson<unknown>(r.areas, []);
  return { ...r, areas: Array.isArray(areas) ? areas.map(String) : [], data: safeJson(r.data, {}) } as SchedItem;
}

/** Same rule as engine.ts isPaused(), read-only (the engine clears an expired pause). */
function pausedNow(now: Date): boolean {
  const until = getMeta("paused_until");
  if (!until) return false;
  return until === "indefinite" || new Date(until).getTime() >= now.getTime();
}

/** Read the snapshot from the database: queued and active jobs, their items, and the edges between them. */
export function loadSnapshot(now: Date = new Date()): SchedulerSnapshot {
  const d = db();
  const queued = (d.prepare("SELECT * FROM jobs WHERE state='queued' AND type<>'ci_watch'").all() as any[]).map(rowToJob);
  const active = (d.prepare("SELECT * FROM jobs WHERE state IN ('running','waiting') AND type<>'ci_watch'").all() as any[]).map(rowToJob);
  const ids = new Set<string>([...queued, ...active].map((j) => j.item_id));
  const edges: Edge[] = [];
  if (ids.size) {
    const list = [...ids];
    const marks = list.map(() => "?").join(",");
    const rows = d.prepare(`SELECT from_id, to_id, type, created_at FROM edges WHERE type IN ('depends_on','stacks_on','same_area')
      AND (from_id IN (${marks}) OR to_id IN (${marks}))`).all(...list, ...list) as any[];
    for (const r of rows) { edges.push({ from: r.from_id, to: r.to_id, type: r.type, created_at: r.created_at }); ids.add(r.from_id); ids.add(r.to_id); }
  }
  const items: Record<string, SchedItem> = {};
  if (ids.size) {
    const list = [...ids];
    const rows = d.prepare(`SELECT * FROM tasks WHERE id IN (${list.map(() => "?").join(",")})`).all(...list) as any[];
    for (const r of rows) items[r.id] = rowToItem(r);
  }
  let down: SchedulerSnapshot["down"];
  try { down = unavailableConnectors(); } catch { down = undefined; }       // connector_health missing: nothing is down
  return { queued, active, items, edges, paused: pausedNow(now), now, down, overBudget: overBudgetOf(queued, items) };
}

/** Items whose queued job may not start because a budget is used up (stopForBudget on). One cheap check per item. */
function overBudgetOf(queued: Job[], items: Record<string, SchedItem>): Record<string, string> | undefined {
  let stops = false;
  try { stops = !!loadSettings().workflow?.stopForBudget; } catch { stops = false; }
  if (!stops || !queued.length) return undefined;
  const out: Record<string, string> = {};
  for (const id of new Set(queued.map((j) => j.item_id))) {
    const it = items[id] as any;
    const project = it && getProject(it.project_id);
    if (!project) continue;
    try {
      const c = checkScopeBudget(project, { id: it.id, size: it.size ?? null, tokens_used: it.tokens_used ?? 0, data: it.data ?? {} });
      if (!c.ok) out[id] = c.over?.text ?? c.text ?? "used up";
    } catch { /* a budget that can't be read never holds work */ }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Contract entry point. With a snapshot it is pure; without one it reads the database.
 * `running` replaces the snapshot's active list when given non-empty (callers that track running jobs in memory).
 */
export function pickRunnable(limits: SchedulerLimits, running: Job[], snapshot?: SchedulerSnapshot): Decision {
  const snap = snapshot ?? loadSnapshot();
  if (!running.length) return decide(limits, snap);
  const ids = new Set(running.map((j) => j.id));
  return decide(limits, { ...snap, queued: snap.queued.filter((j) => !ids.has(j.id)), active: [...running, ...snap.active.filter((j) => !ids.has(j.id))] });
}
const _pickRunnableMatchesContract: PickRunnable = pickRunnable;
void _pickRunnableMatchesContract;

/** Limits from settings: slots = limits.maxParallel, buildsPerRepo = limits.maxPerProject, the rest DEFAULT_LIMITS. */
export const limitsFrom: LimitsFrom = (settings: Settings) => ({
  ...DEFAULT_LIMITS,
  slots: Math.max(1, Number(settings?.limits?.maxParallel) || DEFAULT_LIMITS.slots),
  buildsPerRepo: Math.max(1, Number(settings?.limits?.maxPerProject) || DEFAULT_LIMITS.buildsPerRepo),
});
