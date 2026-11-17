/**
 * Kernel (engine v2) contract: the shapes every kernel module shares and the function each module exports.
 * Storage is the existing SQLite database (core/db.ts, schema from the "kernel" migration). Type-only file.
 *
 * Ground rules (IMPLEMENTATION-PLAN §2):
 * - An Item IS a `tasks` row (same id). v1 code keeps reading it as a Task; kernel code reads it as an Item.
 * - Step functions are the unchanged `STEPS[name]` (engine/steps.ts): same StepCtx in, same StepResult out.
 * - Code drives: no model calls in events, reactions, mailbox, scheduler or recipe branching.
 * - Only active when settings.engine.version === "v2" (core/config.ts engineVersion()).
 */
import type { State, Task } from "../engine/tasks.js";
import type { StepResult } from "../engine/steps.js";
import type { Playbook } from "../engine/playbooks.js";
import type { Settings } from "../core/config.js";

// ------------------------------------------------------------------ items (tasks rows)

/** Item levels: containers (sprint, epic, batch) hold children; pr/branch/audit are light items for outside work. */
export type Level = "sprint" | "epic" | "batch" | "ticket" | "part" | "request" | "pr" | "branch" | "audit";
export const LEVELS: readonly Level[] = ["sprint", "epic", "batch", "ticket", "part", "request", "pr", "branch", "audit"];
/** Levels that plan and then wait for children (PLANNING / WAITING_CHILDREN). */
export const CONTAINER_LEVELS: readonly Level[] = ["sprint", "epic", "batch"];

/** A work item: a tasks row plus the kernel columns. `areas` is stored as JSON text, parsed here. */
export interface Item extends Task {
  level: Level;
  parent_id: string | null;
  /** Top of the tree (the item itself when it has no parent). */
  root_id: string | null;
  /** Path globs this item will change (area locks); [] when not known yet. */
  areas: string[];
  /** "me", or the teammate's GitHub login (reviews of others' PRs). */
  owner: string;
  /** ISO date, or null. Lower `priority` number = more urgent (same as tasks.priority, default 3). */
  due: string | null;
}

/** Fields for creating an item; everything not given uses the tasks defaults (level "ticket", owner "me", state DETECTED). */
export interface NewItem {
  projectId: string; source: string; sourceId?: string; sourceRef?: string; title?: string; kind: string; role?: string;
  level?: Level; parentId?: string; areas?: string[]; owner?: string; priority?: number; due?: string;
  playbook?: string; state?: State; data?: Record<string, any>;
}

// ------------------------------------------------------------------ edges

/** depends_on: from waits for to (merged/done); stacks_on: from's branch is built on to's branch; same_area: overlap; duplicates: same work. */
export type EdgeType = "depends_on" | "stacks_on" | "same_area" | "duplicates";
/** A row of `edges` (PRIMARY KEY from, to, type). */
export interface Edge { from: string; to: string; type: EdgeType; created_at: string }

// ------------------------------------------------------------------ events

/** Event types producers emit (intake, GitHub, Jira, Teams, health, timers). Free text is allowed for new producers. */
export type EventType =
  | "ticket_assigned" | "ticket_changed" | "ticket_reassigned" | "ticket_cancelled" | "start"
  | "ci_failed" | "ci_passed" | "comment_added" | "changes_requested" | "review_requested" | "teammate_pr_opened"
  | "new_commits" | "pr_conflict" | "pr_approved" | "pr_merged" | "pr_closed" | "design_changed"
  | "contract_change" | "connector_down" | "connector_up" | "children_done" | "user_command"
  | (string & {});

/** A row of `events`. `handled_by` is the job id that took it, "ignored", or null while pending. */
export interface KernelEvent {
  id: string;
  type: EventType;
  /** Dedupe key (UNIQUE): emitting the same key twice is a no-op. */
  idem_key: string;
  item_id: string | null;
  project_id: string | null;
  source_ref: string | null;
  payload: Record<string, any>;
  handled_by: string | null;
  received_at: string;
  processed_at: string | null;
}

/** Input to emit(). */
export interface NewEvent { type: EventType; idemKey: string; itemId?: string; projectId?: string; sourceRef?: string; payload?: Record<string, any> }

// ------------------------------------------------------------------ jobs

export type JobType =
  | "build" | "ci_fix" | "comment_fix" | "review" | "qa" | "audit" | "adopt" | "rebase" | "replan" | "close"
  | "plan_scope" | "ci_watch";
export const JOB_TYPES: readonly JobType[] = ["build", "ci_fix", "comment_fix", "review", "qa", "audit", "adopt", "rebase", "replan", "close", "plan_scope", "ci_watch"];

/** queued (in the item's mailbox) → running → done | failed | cancelled; waiting = paused on a person, approval, CI or children. */
export type JobState = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
/** Job states that occupy the item (at most ONE such job per item at any time). */
export const ACTIVE_JOB_STATES: readonly JobState[] = ["running", "waiting"];

/** A row of `jobs`: one recipe run on one item. `data` is the job's checkpoint context (JSON). */
export interface Job {
  id: string;
  item_id: string;
  type: JobType;
  recipe: string;
  state: JobState;
  /** Index into the recipe's steps of the step to run next (or now running). */
  step_index: number;
  /** Retries of the current step (reset when a step finishes ok). */
  attempts: number;
  /** Lower = more urgent within the item's mailbox and the scheduler (default 3). */
  priority: number;
  /** The event id that created this job, or null when started by a command. */
  trigger_event: string | null;
  data: Record<string, any>;
  error: string | null;
  /** Dashboard: the agent running now, its last plain-English line, 0–100, and when the line was written. */
  agent: string | null;
  activity: string | null;
  progress: number | null;
  activity_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Input to createJob(). */
export interface NewJob { itemId: string; type: JobType; recipe: string; priority?: number; triggerEvent?: string; data?: Record<string, any> }

// ------------------------------------------------------------------ reactions (event → job table)

/**
 * What arriving `on` an item does. Guards are pure code (no model, no I/O beyond reading the item/settings).
 * merge: what happens when the item already has a queued job of the same type – "merge" folds the event into it
 * (payload appended to job.data.events), "queue" adds another job, "drop" ignores the event.
 */
export interface Reaction {
  on: EventType;
  job: JobType | "none";
  recipe: string;
  guard?: (ev: KernelEvent, item: Item | undefined, settings: Settings) => boolean;
  priority?: number;
  merge?: "merge" | "queue" | "drop";
  /** Item state to set when the job is created (e.g. pr_merged → MERGED). */
  setState?: State;
  /** One plain line for logs / the dashboard ("CI failed → fix"). */
  note?: string;
}

// ------------------------------------------------------------------ recipes

/**
 * A recipe step. `when` is a guard name (recipes.ts exports the guard table) – the step is skipped when it is false.
 * `goto` jumps to another step by name after this one returns ok (loops are bounded by `max`).
 * `spawn_children` creates one child item per entry in job.data[spawn_children] and the job waits for them.
 */
export interface RecipeStep {
  name: string;
  params?: Record<string, any>;
  when?: string;
  goto?: string;
  max?: number;
  spawn_children?: string;
}
/** A recipe: an ordered list of steps run by kernel/runner.ts. Today's playbooks load as recipes of the same name. */
export interface Recipe { name: string; title?: string; job: JobType; steps: RecipeStep[] }

// ------------------------------------------------------------------ mailbox and scheduler

/** One queued job waiting for its item to be free (the mailbox is the queued rows of `jobs` for that item). */
export interface MailboxEntry { job_id: string; item_id: string; type: JobType; priority: number; trigger_event: string | null; queued_at: string }

/** Scheduler limits (defaults from settings.limits where they exist). */
export interface SchedulerLimits {
  /** Jobs running at once across everything (default 5). */
  slots: number;
  /** Build-type steps (implement_test, reviews, prepublish, report) running at once in one repository (default 2). */
  buildsPerRepo: number;
  /** Respect `depends_on` edges: an item starts only when every item it depends on is MERGED/DONE (or stacked). */
  honourEdges: boolean;
  /** Two items whose `areas` overlap never build at once. */
  areaLocks: boolean;
}
export const DEFAULT_LIMITS: SchedulerLimits = { slots: 5, buildsPerRepo: 2, honourEdges: true, areaLocks: true };

/** Why a queued job is not started now (for status and the dashboard). */
export type HoldReason = "slots" | "repo_busy" | "area_lock" | "depends_on" | "connector" | "paused" | "budget" | "retry_later";

// ------------------------------------------------------------------ runner

/** What the runner did with one step's result. */
export type StepOutcome =
  | { next: "continue"; stepIndex: number }                           // ok → next (or goto) step
  | { next: "wait"; jobState: "waiting"; itemState?: State; reason: string }   // approval, question, pause, wait for parts/children/CI
  | { next: "end"; jobState: "done" | "failed" | "cancelled"; itemState?: State; reason?: string };

// ------------------------------------------------------------------ module signatures

// items.ts – create/get/tree/levels, edges, area claims, merge order (built on engine/tasks.ts)
/** Create an item (dedupes like createTask: an active item with the same sourceId+kind is returned instead). */
export type CreateItem = (n: NewItem) => Item;
/** Read one item by id or source_ref; undefined when missing. */
export type GetItem = (idOrRef: string) => Item | undefined;
/** Direct children of an item, in creation order (cancelled excluded unless asked). */
export type ChildrenOf = (parentId: string, opts?: { includeCancelled?: boolean }) => Item[];
/** The whole tree under a root (root first, then depth-first). */
export type TreeOf = (rootId: string) => Item[];
/** Change an item's state through engine/tasks.ts transition() (legal transitions only; audited). */
export type SetItemState = (id: string, to: State, note?: string) => Item;
/** Update kernel columns (level, parent_id, root_id, areas, owner, due, priority). */
export type UpdateItem = (id: string, patch: Partial<Pick<Item, "level" | "parent_id" | "root_id" | "areas" | "owner" | "due" | "priority">>) => Item;
/** Add an edge (idempotent). */
export type AddEdge = (from: string, to: string, type: EdgeType) => void;
/** Remove an edge (no-op when missing). */
export type RemoveEdge = (from: string, to: string, type: EdgeType) => void;
/** Edges touching an item: "out" = from it, "in" = to it, "both" (default). */
export type EdgesOf = (id: string, dir?: "out" | "in" | "both") => Edge[];
/** Items this item depends_on that are not MERGED/DONE yet (empty = free to start). */
export type OpenDependencies = (id: string) => Item[];
/** Active items (not DONE/CANCELLED/FAILED/MERGED) whose areas overlap `areas` (glob prefix match), excluding `exceptId`. */
export type AreaConflicts = (areas: string[], exceptId?: string) => Item[];
/** Merge order by topological sort of depends_on + stacks_on edges among `ids` (ties by priority, then created_at); cycle = the ids in a cycle. */
export type MergeOrder = (ids: string[]) => { order: string[]; cycle?: string[] };

// events.ts – the event log on the `events` table (same table intake.ts already uses for idempotency)
/** Record an event; returns undefined when idem_key was already seen (duplicate). */
export type Emit = (e: NewEvent) => KernelEvent | undefined;
/** Unhandled events (handled_by IS NULL), oldest first. */
export type PendingEvents = (limit?: number) => KernelEvent[];
/** Mark an event handled by a job id or "ignored" (sets processed_at). */
export type MarkHandled = (eventId: string, by: string) => void;
/** Events of one item, newest first. */
export type EventsFor = (itemId: string, limit?: number) => KernelEvent[];

// reactions.ts – the event → job table, as data (REACTIONS: Reaction[])
/** The reaction for an event on an item, or undefined (event ignored). First matching row whose guard passes wins. */
export type ReactionFor = (ev: KernelEvent, item: Item | undefined, settings: Settings) => Reaction | undefined;
/** Route every pending event: reaction → mailbox.enqueue → markHandled. Returns how many jobs were created or merged. */
export type RouteEvents = (settings: Settings) => number;

// recipes.ts – recipes from service/recipes/*.yaml plus today's playbooks (playbook id = recipe name)
/** All recipes by name (cached; force reloads). */
export type LoadRecipes = (force?: boolean) => Map<string, Recipe>;
/** One recipe by name; throws "Unknown recipe" when missing. */
export type GetRecipe = (name: string) => Recipe;
/** A v1 playbook as a recipe (steps and params unchanged; job "build" unless the playbook says otherwise). */
export type RecipeFromPlaybook = (pb: Playbook, job?: JobType) => Recipe;
/** The index of the step to run after `index` returned ok: skips steps whose `when` is false, follows `goto`; -1 = end. */
export type NextStepIndex = (recipe: Recipe, index: number, job: Job, item: Item) => number;

// mailbox.ts – one active job per item; new work waits as queued jobs on the item
/** Put a job for this event on the item: merge into a queued job of the same type, queue a new one, or drop. */
export type Enqueue = (itemId: string, reaction: Reaction, ev?: KernelEvent) => { job: Job; merged: boolean } | undefined;
/** The item's active job (running or waiting), if any. */
export type ActiveJob = (itemId: string) => Job | undefined;
/** The item's queued jobs, by priority then age. */
export type MailboxOf = (itemId: string) => MailboxEntry[];
/** The next queued job of an item that may start now (undefined when the item already has an active job). */
export type NextForItem = (itemId: string) => Job | undefined;
/** Cancel queued (and optionally the active) jobs of an item. Returns how many. */
export type ClearMailbox = (itemId: string, opts?: { includeActive?: boolean; reason?: string }) => number;

// scheduler.ts – which queued jobs start now (pure decision; runner.ts starts them)
/** Jobs to start now within the limits, plus why each other queued job is held. */
export type PickRunnable = (limits: SchedulerLimits, running: Job[]) => { start: Job[]; held: { job: Job; reason: HoldReason }[] };
/** Limits from settings: slots = limits.maxParallel, buildsPerRepo = limits.maxPerProject, the rest DEFAULT_LIMITS. */
export type LimitsFrom = (settings: Settings) => SchedulerLimits;

// runner.ts – run a job step by step with STEPS, checkpointing in jobs + steps (job_id, input_hash)
/** Run a job until it waits, ends or yields; resumes from job.step_index. Exactly one job per item runs (mailbox). */
export type RunJob = (jobId: string) => Promise<Job>;
/** Turn one StepResult into the job/item outcome (the v2 version of engine.ts runTask's switch). Pure. */
export type ApplyStepResult = (job: Job, item: Item, recipe: Recipe, result: StepResult) => StepOutcome;
/** At start-up: jobs left "running" by a crash go back to queued at the same step_index (finished steps are not re-run). Returns how many. */
export type RecoverJobs = () => number;
/** Continue a waiting job after an answer, approval or event (e.g. children done). */
export type ResumeJob = (jobId: string, input?: Record<string, any>) => Job;
/** One kernel pass (called by engine.ts tick when engine.version is v2): route events, pick runnable, start them. */
export type KernelTick = () => Promise<void>;
