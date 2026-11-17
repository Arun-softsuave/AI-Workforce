/**
 * Kernel reactions (engine v2): the event → job table, as DATA (IMPLEMENTATION-PLAN §3 W3, W9–W14).
 * Each row says what an event on an item starts. The first row whose `on` matches and whose guard passes wins.
 * Guards are pure code: they read only the event, the item and the settings (no model, no network, no database).
 *
 * job "none" rows start no job; their `recipe` names what the router/messenger does instead:
 *   "notify" – tell the developer · "ask" – ask the developer · "design_note" – design document updated before building ·
 *   "block" / "resume" – connector health (W3). routeEvents hands these to RouteDeps.tell (engine/steps/notices.ts).
 */
import { effective } from "../policy/directives.js";
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
  // on comment / review / approval / mention events payload.author is the person who wrote it, not the PR's author
  if (p.author && me(s) && !ACTOR_EVENTS.has(ev.type)) return same(p.author, me(s));
  return !!(item.data?.pr || (item.data?.prs ?? []).length || item.level === "pr");
}

/** Events whose payload.author is the commenter / reviewer (intake/github.ts), not the PR's author. */
const ACTOR_EVENTS = new Set(["comment_added", "review_comment", "changes_requested", "pr_approved", "mention"]);

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
  // your rule (item > batch > epic > sprint > global), then settings – the policy store (policy/directives.ts)
  try { if (item) return effective(item.id, "auto_resolve", { settings: s }).value === true; } catch { /* no directives table yet */ }
  return (s.pr as any)?.autoResolveComments === true;
}

/** Someone else pushed to the branch (not this plugin's own push). */
export function pushedByOther(ev: KernelEvent, _item: Item | undefined, s: Settings): boolean {
  const by = ev.payload?.by ?? ev.payload?.author;
  if (ev.payload?.ours === true) return false;
  return !by || !me(s) || !same(by, me(s));
}

/** The item has been built (an implementation or a PR): changes are asked about ("adapt?"), not re-planned silently. */
export function built(_ev: KernelEvent, item: Item | undefined): boolean {
  return !!item && !!(item.data?.implementation || item.data?.pr || (item.data?.prs ?? []).length || item.state === "PR_OPEN");
}

/**
 * K6: a Jira change that does not change the requirements (a PM's comment, a typo) is information only. The producer
 * says so with payload.major === false; anything else (major, or unknown) is treated as a requirement change.
 */
export function minorTicketChange(ev: KernelEvent): boolean {
  return ev.payload?.major === false;
}

/** A command the developer typed (Conductor / Teams) for this item: "resolve", "fix_ci", "rebase", "adapt". */
const command = (name: string) => (ev: KernelEvent) => ev.payload?.command === name;

// ------------------------------------------------------------------ the table

const and = (...gs: NonNullable<Reaction["guard"]>[]): NonNullable<Reaction["guard"]> => (ev, item, s) => gs.every((g) => g(ev, item, s));
const not = (g: NonNullable<Reaction["guard"]>): NonNullable<Reaction["guard"]> => (ev, item, s) => !g(ev, item, s);

/**
 * The event → job table. Order matters: the first matching row whose guard passes wins.
 * Event names are the ones the GitHub, Jira, Figma and health producers emit (IMPLEMENTATION-PLAN 5.19, 5.11a, 5.18).
 */
export const REACTIONS: Reaction[] = [
  // W9 – CI watch and auto-fix (pushing without asking is decided by the gate step: settings.pr.autoFixCi)
  { on: "ci_failed", job: "ci_fix", recipe: "ci_fix", priority: 1, merge: "merge",
    guard: and(ourPr, itemOpen, (ev, item) => ciRound(ev, item) <= CI_MAX_ROUNDS), note: "CI failed → fix" },
  { on: "ci_failed", job: "none", recipe: "notify", guard: ourPr, note: `CI still failing after ${CI_MAX_ROUNDS} rounds → tell you` },
  { on: "ci_passed", job: "none", recipe: "notify", guard: ourPr, note: "CI green → tell you" },

  // W10 – comments and reviews on our PR (the author is told; the reviewer's own plugin confirms to them)
  { on: "changes_requested", job: "comment_fix", recipe: "comment_fix", priority: 2, merge: "merge", guard: and(ourPr, itemOpen), note: "changes requested → fix the comments" },
  { on: "comment_added", job: "comment_fix", recipe: "comment_fix", priority: 2, merge: "merge", guard: and(ourPr, itemOpen, autoResolve), note: "new comments → fix them" },
  { on: "comment_added", job: "none", recipe: "notify", guard: ourPr, note: "new comments → summary to you" },
  { on: "review_comment", job: "comment_fix", recipe: "comment_fix", priority: 2, merge: "merge", guard: and(ourPr, itemOpen, autoResolve), note: "new comments → fix them" },
  { on: "review_comment", job: "none", recipe: "notify", guard: ourPr, note: "new comments → summary to you" },
  { on: "mention", job: "none", recipe: "notify", note: "you were mentioned → one line with the link" },

  // W10 – a teammate's PR
  { on: "teammate_pr_opened", job: "none", recipe: "notify", note: "teammate raised a PR → tell you" },
  { on: "review_requested", job: "review", recipe: "pr-review", priority: 2, merge: "drop", guard: (_e, _i, s) => s.pr?.autoReview === true, note: "review asked → review it" },
  { on: "review_requested", job: "none", recipe: "notify", note: "review asked → tell you" },
  { on: "new_commits", job: "none", recipe: "notify", guard: teammatePr, note: "new commits on a PR you reviewed → re-review?" },

  // W13 – keeping our PR healthy
  { on: "pr_conflict", job: "rebase", recipe: "rebase", priority: 2, merge: "merge", guard: and(ourPr, itemOpen), note: "PR has conflicts → rebase" },
  { on: "new_base", job: "rebase", recipe: "rebase", priority: 2, merge: "merge", guard: and(ourPr, itemOpen), note: "the PR it was stacked on merged → bring the base in" },
  { on: "new_commits", job: "rebase", recipe: "rebase", priority: 2, merge: "merge", guard: and(ourPr, itemOpen, pushedByOther), note: "someone pushed to your branch → put local work on top" },
  { on: "ticket_changed", job: "none", recipe: "notify", guard: and(itemOpen, minorTicketChange), note: "ticket text changed, requirements did not → noted" },
  { on: "ticket_changed", job: "replan", recipe: "replan", priority: 2, merge: "merge", guard: itemOpen, note: "ticket changed → re-plan" },
  { on: "design_changed", job: "replan", recipe: "replan", priority: 2, merge: "merge", guard: and(itemOpen, built), note: "design changed after building → adapt?" },
  { on: "design_changed", job: "none", recipe: "design_note", guard: and(itemOpen, not(built)), note: "design changed before building → design document updated, re-plan" },
  { on: "pr_approved", job: "none", recipe: "notify", guard: ourPr, note: "PR approved → ready to merge" },

  // the developer's own commands for an item (Conductor / Teams) – orders only from the owner's channels (§11a)
  { on: "user_command", job: "comment_fix", recipe: "comment_fix", priority: 1, merge: "merge", guard: and(itemOpen, (ev) => command("resolve")(ev) || command("adapt")(ev)), note: "you asked → fix the comments / adapt" },
  { on: "user_command", job: "ci_fix", recipe: "ci_fix", priority: 1, merge: "merge", guard: and(itemOpen, command("fix_ci")), note: "you asked → fix the CI" },
  { on: "user_command", job: "rebase", recipe: "rebase", priority: 1, merge: "merge", guard: and(itemOpen, command("rebase")), note: "you asked → update from the base" },

  // W14 – close-out (close_item moves the item MERGED → DONE as its LAST step, so the job can run on the open item)
  { on: "pr_merged", job: "close", recipe: "close", priority: 1, merge: "drop", guard: (_e, item) => !!item && !["DONE", "CANCELLED", "MERGED"].includes(item.state), note: "PR merged → close the item" },
  { on: "pr_closed", job: "none", recipe: "ask", setState: "CLOSED", guard: itemOpen, note: "PR closed without merge → drop or reopen?" },
  { on: "pr_reopened", job: "none", recipe: "notify", setState: "PR_OPEN", guard: (_e, item) => item?.state === "CLOSED", note: "PR reopened → looked after again" },

  // W3 – connector health (no item: the scheduler holds the jobs that need the connector)
  { on: "connector_down", job: "none", recipe: "block", note: "connector down → jobs that need it wait" },
  { on: "connector_up", job: "none", recipe: "resume", note: "connector back → blocked jobs resume" },
];

/** Every event type the table reacts to (for producers and the dashboard). */
export const REACTED_EVENTS: readonly string[] = [...new Set(REACTIONS.map((r) => r.on))];

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
  /** What a "none" row does (a message, the drop-or-reopen question, a design note). Defaults to engine/steps/notices.ts. */
  tell?(ev: KernelEvent, item: Item | undefined, r: Reaction, settings: Settings): unknown;
  /** A ticket the old engine ended at DONE while its PR is still open: look after it again (kernel/prs.ts reopenForOpenPr). */
  reopenForOpenPr?(id: string): Item | undefined;
}

/** Events that only happen on an OPEN pull request (the producers check the PR state before emitting them). */
export const OPEN_PR_EVENTS: ReadonlySet<string> = new Set(["pr_conflict", "ci_failed", "changes_requested", "review_comment", "comment_added", "new_commits", "new_base"]);

/** Events about our own PR that must never be dropped silently: when no job can start, you get one line. */
const TELL_IF_IGNORED: ReadonlySet<string> = new Set(["pr_conflict", "ci_failed", "changes_requested"]);

let wired: RouteDeps | undefined;
/** Wire the real modules once (kernel/runner.ts at start-up): useRouteDeps({ pendingEvents, markHandled, getItem, enqueue, setItemState }). */
export function useRouteDeps(d: RouteDeps): void { wired = d; }

/** Messages started by routeEvents that have not finished yet (tests await them with settleTells()). */
const telling = new Set<Promise<unknown>>();
/** Wait until every message routeEvents started has been handed to the notifier. */
export async function settleTells(): Promise<void> { while (telling.size) await Promise.allSettled([...telling]); }

/** The default "none" handler: engine/steps/notices.ts (loaded on first use – it sends through the notify router). */
function defaultTell(ev: KernelEvent, item: Item | undefined, r: Reaction, settings: Settings): void {
  const p = import("../engine/steps/notices.js").then((m) => m.handleNone(ev, item, r, settings)).catch(() => {});
  telling.add(p);
  void p.finally(() => telling.delete(p));
}

/**
 * Route every pending event: reaction → mailbox.enqueue → markHandled. Returns how many jobs were created or merged.
 * handled_by: the job id; "ignored" when no row matched, the item is missing or the mailbox dropped it;
 * "none:<recipe>" for message-only rows (notify / ask / block / resume) so the messenger can pick them up.
 * setState is applied (legal moves only; an illegal one is skipped) when a new job is created or a none-row matched.
 */
export const routeEvents: RouteEvents & ((settings: Settings, deps?: RouteDeps) => number) = (settings: Settings, deps?: RouteDeps) => {
  const d = deps ?? wired;
  if (!d) throw new Error("reactions: routeEvents needs its modules – call useRouteDeps() first");
  // fakes in tests pass their own tell (or none); the wired modules use the real messages
  const tell = d.tell ?? (deps ? undefined : defaultTell);
  let n = 0;
  for (const ev of d.pendingEvents()) {
    let item = ev.item_id ? d.getItem(ev.item_id) : undefined;
    // the PR is still open, but the old engine ended the ticket at DONE when the PR was raised: look after it again
    if (item && item.state === "DONE" && OPEN_PR_EVENTS.has(ev.type) && ev.payload?.ours !== false && d.reopenForOpenPr) {
      try { item = d.reopenForOpenPr(item.id) ?? item; } catch { /* keep the item as it is */ }
    }
    const r = reactionFor(ev, item, settings);
    if (!r) {
      // never silent about our own PR: a conflict / failing check / change request no job can take gets one line
      if (item && TELL_IF_IGNORED.has(ev.type) && ourPr(ev, item, settings) && tell) {
        d.markHandled(ev.id, "none:notify");
        try { tell(ev, item, { on: ev.type, job: "none", recipe: "notify", note: `${ev.type} – no job can start (item ${item.state})` }, settings); } catch { /* never stops routing */ }
        continue;
      }
      d.markHandled(ev.id, "ignored");
      continue;
    }
    const setState = () => {
      if (!r.setState || !item || item.state === r.setState || !d.setItemState) return;
      try { d.setItemState(item.id, r.setState, r.note ?? ev.type); } catch { /* not a legal move from this state: leave it */ }
    };
    if (r.job === "none") {
      setState();
      d.markHandled(ev.id, `none:${r.recipe}`);
      try { tell?.(ev, item ? d.getItem(item.id) ?? item : item, r, settings); } catch { /* a message never stops routing */ }
      continue;
    }
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
