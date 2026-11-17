import type { Notice } from "../notify/channels.js";

/**
 * Short message templates (IMPLEMENTATION-PLAN W17, §5 5.17). Code only, no model calls.
 *
 * Every notice kind sent today has an entry: whether it is routine (may be merged with others for the same item
 * within 60 s, and summed up in the quiet-hours catch-up), and how many body lines a chat message may have before
 * the rest moves behind "details KAN-x". Questions may be longer; they are never shortened.
 */
export interface KindTemplate {
  /** Routine updates: merged within 60 s per item; never carry choices. */
  routine: boolean;
  /** Most body lines in a chat message; 0 = never shortened (questions, details, digests). */
  maxLines: number;
  /** One plain line for the kind, used when merging or catching up and as the fallback title. */
  label: string;
}

export const TEMPLATES: Record<string, KindTemplate> = {
  info:                 { routine: true,  maxLines: 10, label: "update" },
  picked_up:            { routine: true,  maxLines: 6,  label: "picked up" },
  pr_comment:           { routine: true,  maxLines: 6,  label: "new PR comment" },
  pr_created:           { routine: false, maxLines: 10, label: "PR raised" },
  report_ready:         { routine: false, maxLines: 6,  label: "report ready" },
  approval_needed:      { routine: false, maxLines: 10, label: "waiting for your OK" },
  needs_info:           { routine: false, maxLines: 0,  label: "question" },
  burst:                { routine: false, maxLines: 10, label: "start?" },
  failed:               { routine: false, maxLines: 8,  label: "failed" },
  paused:               { routine: false, maxLines: 8,  label: "paused" },
  stale:                { routine: false, maxLines: 6,  label: "approval out of date" },
  pr_changes_requested: { routine: false, maxLines: 8,  label: "changes requested" },
  connector_problem:    { routine: false, maxLines: 4,  label: "connection problem" },
  checkup:              { routine: false, maxLines: 0,  label: "daily check-up" },
  digest:               { routine: false, maxLines: 0,  label: "morning digest" },
  daily_digest:         { routine: false, maxLines: 0,  label: "daily digest" },
  details:              { routine: false, maxLines: 0,  label: "details" },
  merged:               { routine: false, maxLines: 0,  label: "updates" },
  catch_up:             { routine: false, maxLines: 0,  label: "while you were away" },
};
const DEFAULT_TEMPLATE: KindTemplate = { routine: false, maxLines: 10, label: "update" };

export const templateFor = (kind: string): KindTemplate => TEMPLATES[kind] ?? DEFAULT_TEMPLATE;

/** The item a notice is about, as people type it ("KAN-45"); task id when there is no ref. */
export const refOf = (n: Notice): string | undefined => n.taskRef ?? n.taskId ?? undefined;

/** A notice asks something: numbered choices for an approval or questions. Never merged or held into a summary. */
export const isInteractive = (n: Notice): boolean => !!(n.approvalId || n.questions?.length || n.kind === "needs_info");

const nonBlank = (s: string) => s.split("\n").filter((l) => l.trim()).length;

/** A routine notice: a short update about one item, safe to merge with the next ones for the same item. */
export function isRoutine(n: Notice): boolean {
  if (!templateFor(n.kind).routine || n.urgent || isInteractive(n) || !refOf(n)) return false;
  if (BAD_NEWS.test(n.title ?? "")) return false;          // a failure ("❌ CI failed…") goes at once, never held to merge
  return nonBlank(n.body ?? "") <= 3;                      // a long body (e.g. a plan) is sent on its own
}

/** Titles that report a problem: sent on their own at once. */
const BAD_NEWS = /^\s*(?:❌|⚠️|🛑|🔴)|\b(?:failed|failing|stuck|can't push|cannot push)\b/i;

/**
 * Approvals whose numbered findings the reply picks from ("create 1, 3", "post 2"): the list IS the decision, so the
 * message keeps every finding (like a question, it may be longer). Plans and "raise the PR?" are still shortened.
 */
export const SELECTION_ACTIONS: ReadonlySet<string> = new Set(["post_review", "create_issues", "push_fixes", "push_rebase"]);

const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const HEADING = /^\*\*(.+?)\*\*\s*(.*)$/;
const FACT = /^\s*[-•]\s*\*\*[^*]+:\*\*/;
const ITEM = /^\s*(?:[-•]|\d+\.)\s+/;
const DETAILS_LINE = (ref: string) => `Reply "details ${ref}" for the full text.`;

/** Sections that matter most in a plan or a result: shown as a list, the others as one line each. */
const KEY_SECTIONS = [/steps/i, /done when/i, /changed files/i, /open review findings/i, /questions/i];

type Sec = { kind: "text"; line: string } | { kind: "facts"; line: string } | { kind: "list"; head: string; items: string[] };

function parseSections(text: string): Sec[] {
  const out: Sec[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    const h = HEADING.exec(lines[0]);
    const rest = lines.slice(1);
    if (lines.every((l) => FACT.test(l))) { out.push({ kind: "facts", line: lines.map((l) => l.replace(/^\s*[-•]\s*/, "")).join(" · ") }); continue; }
    if (h && rest.length && rest.every((l) => FACT.test(l))) {
      out.push({ kind: "facts", line: `**${h[1]}** ${rest.map((l) => l.replace(/^\s*[-•]\s*/, "")).join(" · ")}` });
      continue;
    }
    if (h && rest.length) { out.push({ kind: "list", head: lines[0], items: rest }); continue; }
    out.push({ kind: "text", line: lines.join(" ") });
  }
  return out;
}

/**
 * Shorten a long chat body to at most `maxLines` non-blank lines (the last one says "details REF"). Lists become one
 * line ("**Files** (12): a, b, …"), except the key list (steps, done when, changed files) which keeps its first items.
 * Returns the body unchanged when it already fits.
 */
export function shortBody(body: string, ref: string, maxLines = 10): { body: string; shortened: boolean } {
  const text = (body ?? "").trim();
  if (!maxLines || nonBlank(text) <= maxLines) return { body: text, shortened: false };
  const secs = parseSections(text);
  const budget = Math.max(2, maxLines - 1);                  // one line for "details"
  const oneLine = (s: Sec): string => {
    if (s.kind !== "list") return cut(s.line, 200);
    const names = s.items.map((i) => i.replace(ITEM, "").trim());
    return cut(`${s.head} (${names.length}): ${names.slice(0, 3).join("; ")}${names.length > 3 ? "; …" : ""}`, 200);
  };
  const lines: string[][] = secs.map((s) => [oneLine(s)]);
  let used = lines.length;
  if (used > budget) {
    // too many sections even as one line each: keep the first ones, the rest is in "details"
    const kept = lines.slice(0, budget).map((l) => l[0]);
    return { body: [...kept, DETAILS_LINE(ref)].join("\n"), shortened: true };
  }
  // expand the most useful list with as many items as fit
  let keyIdx = -1;
  for (const k of KEY_SECTIONS) { keyIdx = secs.findIndex((s) => s.kind === "list" && k.test(s.head)); if (keyIdx >= 0) break; }
  if (keyIdx >= 0) {
    const s = secs[keyIdx] as Extract<Sec, { kind: "list" }>;
    const room = budget - used;                              // extra lines available (heading replaces the one line)
    if (room >= 1) {
      const show = Math.min(s.items.length, room);
      const items = s.items.slice(0, show).map((i) => cut(i, 160));
      if (show < s.items.length) items[items.length - 1] = `${items[items.length - 1]} (+${s.items.length - show} more)`;
      lines[keyIdx] = [s.head, ...items];
      used += show;
    }
  }
  const out: string[] = [];
  lines.forEach((l, i) => out.push(i && (lines[i].length > 1 || lines[i - 1].length > 1) ? `\n${l.join("\n")}` : l.join("\n")));
  return { body: `${out.join("\n")}\n\n${DETAILS_LINE(ref)}`, shortened: true };
}

/** The chat version of a notice: short body, the full text kept in `details` for "details REF". */
export function shortNotice(n: Notice, override?: { body?: string; details?: string }): { notice: Notice; details?: string } {
  const ref = refOf(n);
  const t = templateFor(n.kind);
  if (!ref || !t.maxLines) return { notice: n };
  if (n.approvalAction && SELECTION_ACTIONS.has(n.approvalAction)) return { notice: n };
  if (override?.body) {
    return { notice: { ...n, body: override.body }, details: override.details ?? n.body };
  }
  const r = shortBody(n.body ?? "", ref, t.maxLines);
  return r.shortened ? { notice: { ...n, body: r.body }, details: n.body } : { notice: n };
}

/** Several routine updates for one item, sent as one message. */
export function mergedNotice(items: Notice[]): Notice {
  const first = items[0], last = items[items.length - 1];
  const ref = refOf(first) ?? "";
  const lines = items.map((n) => {
    const extra = (n.body ?? "").split("\n").find((l) => l.trim());
    return `• ${cut(n.title, 110)}${extra ? ` – ${cut(extra.trim(), 80)}` : ""}`;
  });
  const shown = lines.length > 9 ? [...lines.slice(0, 8), `• …and ${lines.length - 8} more`] : lines;
  return { kind: "merged", taskId: last.taskId, taskRef: last.taskRef ?? first.taskRef, title: `${ref}: ${items.length} updates`, body: shown.join("\n"),
    url: [...items].reverse().find((n) => n.url)?.url, dedupeKey: `merged:${items.map((n) => n.dedupeKey ?? n.title).join("|").slice(0, 200)}` };
}

/** The one catch-up message after quiet hours: per item, how many updates and the last one. */
export function catchUpNotice(items: Notice[], interactive = 0): Notice {
  const byRef = new Map<string, Notice[]>();
  for (const n of items) {
    const k = refOf(n) ?? "general";
    byRef.set(k, [...(byRef.get(k) ?? []), n]);
  }
  const lines = [...byRef.entries()].map(([ref, ns]) => {
    const lastN = ns[ns.length - 1];
    return `• ${ref === "general" ? "" : `${ref}: `}${ns.length > 1 ? `${ns.length} updates, last: ` : ""}${cut(lastN.title, 100)}`;
  });
  const shown = lines.length > 8 ? [...lines.slice(0, 7), `• …and ${lines.length - 7} more – say "inbox" for all`] : lines;
  if (interactive) shown.push(`${interactive} thing${interactive === 1 ? "" : "s"} need${interactive === 1 ? "s" : ""} your answer – sent next.`);
  return { kind: "catch_up", title: `While you were away: ${items.length} update${items.length === 1 ? "" : "s"}`, body: shown.join("\n"),
    dedupeKey: `catchup:${items.map((n) => n.dedupeKey ?? n.title).join("|").slice(0, 200)}` };
}

// ------------------------------------------------------------------ builders for new callers (short by design)

/** Short notices for callers that want the messenger's wording directly. Titles carry the ref; bodies ≤ 3 lines. */
export const T = {
  pickedUp: (ref: string, title: string, size?: string): Notice =>
    ({ kind: "picked_up", taskRef: ref, title: `👍 ${ref} picked up`, body: `${cut(title, 120)}${size ? ` – size ${size}` : ""}` }),
  planReady: (ref: string, summaryText: string, approvalId: string): Notice =>
    ({ kind: "approval_needed", taskRef: ref, title: `📋 Plan ready – ${ref}`, body: summaryText, approvalId, approvalAction: "implement_plan", dedupeKey: approvalId }),
  built: (ref: string, resultText: string, approvalId: string): Notice =>
    ({ kind: "approval_needed", taskRef: ref, title: `✅ ${ref} Built and tested – raise the PR?`, body: resultText, approvalId, approvalAction: "create_pr", dedupeKey: approvalId }),
  prRaised: (ref: string, num: number, url?: string): Notice =>
    ({ kind: "pr_created", taskRef: ref, title: `🚀 ${ref} PR #${num} raised`, body: "", url, dedupeKey: `pr:${num}` }),
  ciFailed: (ref: string, num: number, round: number, max: number): Notice =>
    ({ kind: "info", taskRef: ref, title: `❌ CI failed on PR #${num} – fixing it (round ${round} of ${max})`, body: "", dedupeKey: `ci-red:${num}:${round}` }),
  ciGreen: (ref: string, num: number): Notice =>
    ({ kind: "info", taskRef: ref, title: `✅ CI passes on PR #${num}`, body: "", dedupeKey: `ci-green:${num}` }),
  failed: (ref: string, what: string, reason: string): Notice =>
    ({ kind: "failed", taskRef: ref, title: `${ref}: ${what} failed`, body: cut(reason, 400) }),
  paused: (ref: string, reason: string): Notice =>
    ({ kind: "paused", taskRef: ref, title: `${ref} paused`, body: cut(reason, 300) }),
  connectorDown: (provider: string): Notice =>
    ({ kind: "connector_problem", title: `${provider} is disconnected`, body: `Reconnect with \`aiw connect ${provider}\`. Work that needs it waits until then.`, urgent: true }),
};
