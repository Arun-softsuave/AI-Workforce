import type { Channel, Settings } from "../core/config.js";
import type { Notice } from "../notify/channels.js";
import { readDoc, summary as designSummary } from "../knowledge/designDoc.js";
import { db } from "../core/db.js";
import { isInteractive, isRoutine, refOf, shortNotice, catchUpNotice } from "./templates.js";
import { inMergeWindow, mergeKeyOf } from "./merge.js";

/**
 * The Messenger (IMPLEMENTATION-PLAN W17, §5 5.17): sits inside notify/router.ts and decides, per external channel,
 * what a notice looks like and when it goes:
 *  - short templates: long bodies shrink to ≤ 6 lines with "details KAN-x" (questions are never shortened);
 *  - 60 s merging of routine updates about the same item;
 *  - quiet hours: non-urgent messages are held and come back as ONE catch-up message (plus each open question);
 *  - the morning digest (digest.ts) and "details" (details.ts).
 * Switched off with `notifications.messenger: false` in settings (then the router behaves as before).
 */
export const CHAT_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(["teams-personal", "teams", "slack"]);

export function messengerOn(s: Settings): boolean {
  const v = (s.notifications as any)?.messenger;
  return v !== false && v !== "off";
}

export interface Prepared {
  notice: Notice;            // what goes to this channel
  itemId: string | null;     // the item the notice is about
  mergeKey: string | null;
  detailsRef: string | null; // set when the full text is kept for "details REF"
  merge: boolean;            // hold for the 60 s merge instead of sending now
}

function itemIdFor(n: Notice): string | null {
  if (n.taskId) return n.taskId;
  if (!n.taskRef) return null;
  const r = db().prepare("SELECT id FROM tasks WHERE source_ref=? ORDER BY created_at DESC LIMIT 1").get(n.taskRef) as any;
  return r?.id ?? null;
}

/** The plan notes that must reach you even when the message is the design document's summary. */
export function planNotes(body: string): string[] {
  const out: string[] = [];
  const blocks = body.split(/\n\s*\n/);
  const outside = blocks.find((b) => /Outside these repositories/.test(b));
  if (outside) out.push(outside.split("\n").slice(0, 4).join("\n"));
  const mig = body.split("\n").find((l) => /Database migration/i.test(l));
  if (mig) out.push(`⚠️ ${mig.replace(/^[-•*\s]+/, "")}`);
  const design = blocks.find((b) => /^🎨 /.test(b.trim()));
  if (design) out.push(design.trim());
  return out;
}

/** A plan with a design document: the document's ≤ 10-line summary, the full document behind "details". */
function designOverride(n: Notice, itemId: string | null): { body: string; details: string } | undefined {
  if (n.approvalAction !== "implement_plan" && !/plan/i.test(n.dedupeKey ?? "")) return undefined;
  for (const id of [itemId, n.taskRef].filter(Boolean) as string[]) {
    try {
      const doc = readDoc(id);
      // C6 / C9 / C11: the notes the plan message adds (no design given, a database migration, work outside the repos)
      // are not in the document's summary – they stay in the Teams message
      if (doc) return { body: [designSummary(id).replace(/Reply "details [^"]+"/, `Reply "details ${refOf(n)}"`), ...planNotes(n.body ?? "")].join("\n\n"), details: doc.text };
    } catch { /* not a valid document id */ }
  }
  return undefined;
}

/** The base row data for a notice (inbox copy too): which item and which ref. */
export function rowMeta(n: Notice): { itemId: string | null; ref: string | null } {
  return { itemId: itemIdFor(n), ref: refOf(n) ?? null };
}

export function prepare(n: Notice, ch: Channel, s: Settings, opts: { quiet: boolean }): Prepared {
  const itemId = itemIdFor(n);
  const base: Prepared = { notice: n, itemId, mergeKey: null, detailsRef: null, merge: false };
  if (!messengerOn(s) || !CHAT_CHANNELS.has(ch)) return base;
  const ref = refOf(n) ?? null;
  // a caller that already wrote the short text and the full one (e.g. the digest) names its own details ref
  const given = n as Notice & { details?: string; detailsRef?: string };
  if (given.details && (given.detailsRef ?? ref)) return { ...base, detailsRef: given.detailsRef ?? ref };
  const short = shortNotice(n, designOverride(n, itemId));
  const notice = short.details ? ({ ...short.notice, details: short.details } as Notice) : short.notice;
  const mergeKey = isRoutine(n) ? mergeKeyOf(n) ?? null : null;
  const merge = !!mergeKey && !opts.quiet && inMergeWindow(mergeKey, ch);
  return { notice, itemId, mergeKey, detailsRef: short.details && ref ? ref : null, merge };
}

/**
 * After quiet hours: the held messages of one channel become one catch-up message; questions and approvals are sent
 * on their own after it (their numbered choices must stay in their own message). Returns the catch-up notice and the
 * rows it replaces, or undefined when there is nothing to sum up (0 or 1 routine message).
 */
export function catchUpFor(held: { id: string; notice: Notice }[]): { notice: Notice; replaced: string[] } | undefined {
  const plain = held.filter((h) => !isInteractive(h.notice));
  if (held.length < 2 || !plain.length) return undefined;
  return { notice: catchUpNotice(plain.map((h) => h.notice), held.length - plain.length), replaced: plain.map((h) => h.id) };
}
