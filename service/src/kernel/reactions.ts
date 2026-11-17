/**
 * Kernel reactions (engine v2): the event → job table, as DATA (IMPLEMENTATION-PLAN §3 W3, W9–W14).
 * Each row says what an event on an item starts. The first row whose `on` matches and whose guard passes wins.
 * Guards are pure code: they read only the event, the item and the settings (no model, no network, no database).
 *
 * job "none" rows start no job; their `recipe` names what the router/messenger does instead:
 *   "notify" – tell the developer · "ask" – ask the developer · "block" / "resume" – connector health (W3).
 */
import type { Settings } from "../core/config.js";
import type { State } from "../engine/tasks.js";
import type { Item, Job, JobType, KernelEvent, Reaction, ReactionFor, RouteEvents } from "./types.js";

/** CI fix rounds for one PR before the developer is asked to look (same number as engine/prFix.ts MAX_CI_ROUNDS). */
export const CI_MAX_ROUNDS = 3;

/** Item states in which no new work starts on it. */
const FINISHED: State[] = ["DONE", "CANCELLED", "FAILED", "MERGED"];

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const me = (s: Settings) => s.team?.me?.github;

// ------------------------------------------------------------------ guards (pure)

/** The item is ours and still open for work. */
export function itemOpen(_ev: KernelEvent, item: Item | undefined): boolean {
  return !!item && !FINISHED.includes(item.state);
}

/**
 * The PR the event is about is OUR work: the item is owned by "me" and the PR was raised (or adopted) here,
 * or the event says so (payload.ours), or its author is my GitHub login.
 */
export function ourPr(ev: KernelEvent, item: Item | undefined, s: Settings): boolean {
  if (!item || item.owner !== "me") return false;
  const p = ev.payload ?? {};
  if (p.ours === true) return true;
  if (p.ours === false) return false;
  if (p.author && me(s)) return same(p.author, me(s));
  return !!(item.data?.pr || (item.data?.prs ?? []).length || item.level === "pr");
}

/** A teammate's PR (one we review): the item is owned by someone else, or the event names another author. */
export function teammatePr(ev: KernelEvent, item: Item | undefined, s: Settings): boolean {
  const p = ev.payload ?? {};
  if (p.ours === true) return false;
  if (item) return item.owner !== "me";
  return !!p.author && !same(p.author, me(s));
}

/** The CI fix round this failure would start (event payload, else the item's last round + 1, else 1). */
export function ciRound(ev: KernelEvent, item: Item | undefined): number {
  const r = ev.payload?.round ?? (item?.data?.fix?.ciRound !== undefined ? Number(item.data.fix.ciRound) : undefined);
  return Number.isFinite(Number(r)) && Number(r) >= 1 ? Number(r) : 1;
}

/**
 * Review comments are fixed straight away only when asked: the event carries the user's command ("resolve the
 * comments" → payload.command = "resolve"), the item has the auto_resolve directive, or settings.pr.autoResolveComments.
 * Otherwise the developer gets a summary (W10).
 */
export function autoResolve(ev: KernelEvent, item: Item | undefined, s: Settings): boolean {
  if (ev.payload?.command === "resolve") return true;
  if (item?.data?.directives?.auto_resolve) return true;
  return (s.pr as any)?.autoResolveComments === true;
}

/** Someone else pushed to the branch (not this plugin's own push). */
export function pushedByOther(ev: KernelEvent, _item: Item | undefined, s: Settings): boolean {
  const by = ev.payload?.by ?? ev.payload?.author;
  if (ev.payload?.ours === true) return false;
  return !by || !me(s) || !same(by, me(s));
}

// ------------------------------------------------------------------ the table

const and = (...gs: NonNullable<Reaction["guard"]>[]): NonNullable<Reaction["guard"]> => (ev, item, s) => gs.every((g) => g(ev, item, s));

/** The event → job table. Order matters: the first matching row whose guard passes wins. */
export const REACTIONS: Reaction[] = [
  // W9 – CI watch and auto-fix (pushing without asking is decided by the gate step: settings.pr.autoFixCi)
  { on: "ci_failed", job: "ci_fix", recipe: "ci_fix", priority: 1, merge: "merge",
    guard: and(ourPr, itemOpen, (ev, item) => ciRound(ev, item) <= CI_MAX_ROUNDS), note: "CI failed → fix" },
  { on: "ci_failed", job: "none", recipe: "notify", guard: ourPr, note: `CI still failing after ${CI_MAX_ROUNDS} rounds → tell you` },
  { on: "ci_passed", job: "none", recipe: "notify", guard: ourPr, note: "CI green → tell you" },

  // W10 – comments and reviews on our PR
  { on: "changes_requested", job: "comment_fix", recipe: "comment_fix", priority: 2, merge: "merge", guard: and(ourPr, itemOpen), note: "changes requested → fix the comments" },
  { on: "comment_added", job: "comment_fix", recipe: "comment_fix", priority: 2, merge: "merge", guard: and(ourPr, itemOpen, autoResolve), note: "new comments → fix them" },
  { on: "comment_added", job: "none", recipe: "notify", guard: ourPr, note: "new comments → summary to you" },
  { on: "review_comment", job: "comment_fix", recipe: "comment_fix", priority: 2, merge: "merge", guard: and(ourPr, itemOpen, autoResolve), note: "new comments → fix them" },
  { on: "review_comment", job: "none", recipe: "notify", guard: ourPr, note: "new comments → summary to you" },

  // W10 – a teammate's PR
  { on: "teammate_pr_opened", job: "none", recipe: "notify", note: "teammate raised a PR → tell you" },
  { on: "review_requested", job: "review", recipe: "pr-review", priority: 2, merge: "drop", guard: (_e, _i, s) => s.pr?.autoReview === true, note: "review asked → review it" },
  { on: "review_requested", job: "none", recipe: "notify", note: "review asked → tell you" },
  { on: "new_commits", job: "none", recipe: "notify", guard: teammatePr, note: "new commits on a PR you reviewed → re-review?" },

  // W13 – keeping our PR healthy
  { on: "pr_conflict", job: "rebase", recipe: "rebase", priority: 2, merge: "merge", guard: and(ourPr, itemOpen), note: "PR has conflicts → rebase" },
  { on: "new_commits", job: "rebase", recipe: "rebase", priority: 2, merge: "merge", guard: and(ourPr, itemOpen, pushedByOther), note: "someone pushed to your branch → put local work on top" },
  { on: "ticket_changed", job: "replan", recipe: "replan", priority: 2, merge: "merge", guard: itemOpen, note: "ticket changed → re-plan" },
  { on: "design_changed", job: "replan", recipe: "replan", priority: 2, merge: "merge", guard: itemOpen, note: "design changed → re-plan" },
  { on: "pr_approved", job: "none", recipe: "notify", guard: ourPr, note: "PR approved → ready to merge" },

  // W14 – close-out
  { on: "pr_merged", job: "close", recipe: "close", priority: 1, merge: "drop", setState: "MERGED", guard: (_e, item) => !!item && !["DONE", "CANCELLED", "MERGED"].includes(item.state), note: "PR merged → close the item" },
  { on: "pr_closed", job: "none", recipe: "ask", setState: "CLOSED", guard: itemOpen, note: "PR closed without merge → drop or reopen?" },

  // W3 – connector health (no item: the scheduler holds the jobs that need the connector)
  { on: "connector_down", job: "none", recipe: "block", note: "connector down → jobs that need it wait" },
  { on: "connector_up", job: "none", recipe: "resume", note: "connector back → blocked jobs resume" },
];

export const reactionFor: ReactionFor = (ev, item, settings) =>
  REACTIONS.find((r) => r.on === ev.type && (!r.guard || r.guard(ev, item, settings)));

/** What an event on an item starts: [] = nothing (ignored); job "none" = a message or a state change only. */
export interface JobSpec {
  job: JobType | "none";
  recipe: string;
  priority: number;
  merge: "merge" | "queue" | "drop";
  setState?: State;
  note?: string;
  itemId?: string;
  triggerEvent: string;
}

/** The job specs for one event (the winning reaction, or none). */
export function match(ev: KernelEvent, item: Item | undefined, settings: Settings): JobSpec[] {
  const r = reactionFor(ev, item, settings);
  if (!r) return [];
  return [{ job: r.job, recipe: r.recipe, priority: r.priority ?? 3, merge: r.merge ?? "merge", setState: r.setState, note: r.note,
    itemId: item?.id ?? ev.item_id ?? undefined, triggerEvent: ev.id }];
}

// ------------------------------------------------------------------ routing

/** What routeEvents needs from events.ts, items.ts and mailbox.ts (wired by the runner; tests pass fakes). */
export interface RouteDeps {
  pendingEvents(limit?: number): KernelEvent[];
  markHandled(eventId: string, by: string): void;
  getItem(id: string): Item | undefined;
  enqueue(itemId: string, reaction: Reaction, ev?: KernelEvent): { job: Job; merged: boolean } | undefined;
  setItemState?(id: string, to: State, note?: string): unknown;
}

let wired: RouteDeps | undefined;
/** Wire the real modules once (kernel/runner.ts at start-up): useRouteDeps({ pendingEvents, markHandled, getItem, enqueue, setItemState }). */
export function useRouteDeps(d: RouteDeps): void { wired = d; }

/**
 * Route every pending event: reaction → mailbox.enqueue → markHandled. Returns how many jobs were created or merged.
 * handled_by: the job id; "ignored" when no row matched, the item is missing or the mailbox dropped it;
 * "none:<recipe>" for message-only rows (notify / ask / block / resume) so the messenger can pick them up.
 * setState is applied (legal moves only; an illegal one is skipped) when a new job is created or a none-row matched.
 */
export const routeEvents: RouteEvents & ((settings: Settings, deps?: RouteDeps) => number) = (settings: Settings, deps?: RouteDeps) => {
  const d = deps ?? wired;
  if (!d) throw new Error("reactions: routeEvents needs its modules – call useRouteDeps() first");
  let n = 0;
  for (const ev of d.pendingEvents()) {
    const item = ev.item_id ? d.getItem(ev.item_id) : undefined;
    const r = reactionFor(ev, item, settings);
    if (!r) { d.markHandled(ev.id, "ignored"); continue; }
    const setState = () => {
      if (!r.setState || !item || item.state === r.setState || !d.setItemState) return;
      try { d.setItemState(item.id, r.setState, r.note ?? ev.type); } catch { /* not a legal move from this state: leave it */ }
    };
    if (r.job === "none") { setState(); d.markHandled(ev.id, `none:${r.recipe}`); continue; }
    if (!item) { d.markHandled(ev.id, "ignored"); continue; }
    const res = d.enqueue(item.id, r, ev);
    if (!res) { d.markHandled(ev.id, "ignored"); continue; }
    if (!res.merged) setState();
    d.markHandled(ev.id, res.job.id);
    n++;
  }
  return n;
};

/** Reactions whose recipe is missing from `recipeNames` (job rows only). */
export function validateReactions(recipeNames: Iterable<string>): string[] {
  const names = new Set(recipeNames);
  return REACTIONS.filter((r) => r.job !== "none" && !names.has(r.recipe)).map((r) => `${r.on} → ${r.job}: unknown recipe "${r.recipe}"`);
}
