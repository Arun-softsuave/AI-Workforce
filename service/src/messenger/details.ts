import { db } from "../core/db.js";
import { readDoc } from "../knowledge/designDoc.js";

/**
 * "details KAN-45": the full text behind a short message. Looks in this order:
 *  1. the latest message for that item that was shortened (notifications.details_ref, full text kept with it);
 *  2. the item's design document;
 *  3. the latest message about the item (its full body, from the inbox copy).
 * Local data only, no model call.
 */
const REF = /^[A-Za-z][A-Za-z0-9]*-\d+(?:@[\w.-]+)?$|^digest$/i;

/** "details KAN-45", "detail kan-45", "details for KAN-45", "show details KAN-45" → "KAN-45"; anything else → undefined. */
export function parseDetailsCommand(text: string): string | undefined {
  const m = /^\s*(?:show\s+)?(?:full\s+)?details?\s+(?:for\s+|of\s+|on\s+)?([A-Za-z][A-Za-z0-9]*-\d+(?:@[\w.-]+)?|digest|check-?up)\s*[.!?]?\s*$/i.exec(text ?? "");
  if (!m) return undefined;
  const ref = m[1];
  if (/^(digest|check-?up)$/i.test(ref)) return "digest";
  return ref.replace(/^([a-z]+)/i, (k) => k.toUpperCase());
}

/** Find the task id for a ref (source_ref or id) – the design document is stored under the item id. */
function itemIdOf(ref: string): string | undefined {
  const r = db().prepare("SELECT id FROM tasks WHERE source_ref=? OR id=? ORDER BY created_at DESC LIMIT 1").get(ref, ref) as any;
  return r?.id;
}

function docText(id: string): string | undefined {
  try { return readDoc(id)?.text; } catch { return undefined; }   // invalid id for a file name
}

export function detailsFor(ref: string): { title: string; text: string; source: "message" | "design" | "inbox" } | undefined {
  if (!REF.test(ref)) return undefined;
  const short = db().prepare("SELECT title, body FROM notifications WHERE details_ref=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(ref) as any;
  if (short) {
    try {
      const n = JSON.parse(short.body);
      if (typeof n.details === "string" && n.details.trim()) return { title: n.title ?? short.title, text: n.details, source: "message" };
    } catch { /* fall through */ }
  }
  const id = itemIdOf(ref);
  for (const k of [id, ref].filter(Boolean) as string[]) {
    const t = docText(k);
    if (t) return { title: `${ref} – design document`, text: t, source: "design" };
  }
  const last = db().prepare("SELECT title, body FROM notifications WHERE channel='inbox' AND (item_id=? OR item_id=? OR task_id=?) ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(ref, id ?? ref, id ?? ref) as any;
  if (last) {
    try { const n = JSON.parse(last.body); return { title: n.title ?? last.title, text: n.body ?? "", source: "inbox" }; } catch { /* ignore */ }
  }
  return undefined;
}

/** The reply to a "details" message, or undefined when the text is not a details request. */
export function detailsReply(text: string): string | undefined {
  const ref = parseDetailsCommand(text);
  if (!ref) return undefined;
  const d = detailsFor(ref);
  if (!d) return `I have no details for ${ref} yet.`;
  return `**${d.title}**\n\n${d.text.trim()}`;
}

/** The "details" answer as a notice (kind "details": never shortened or merged; long text is split into parts by the sender). */
export function detailsNotice(ref: string): { kind: string; taskRef?: string; title: string; body: string; dedupeKey: string } {
  const d = detailsFor(ref);
  return { kind: "details", taskRef: ref === "digest" ? undefined : ref, title: d ? d.title : `${ref}: no details yet`, body: d ? d.text.trim() : `I have no details for ${ref} yet.`, dedupeKey: `details:${ref}:${Date.now()}` };
}

// ------------------------------------------------------------------ long chat replies (R-MSG)

const MORE_KEY = "chat.moreText";
/** Most lines of a chat reply before the rest waits behind "more" (questions and "more" itself are never cut). */
export const CHAT_MAX_LINES = 12;

/**
 * A long reply (a status list, a long answer) is shortened to its first lines plus "say more"; the rest is kept
 * (one at a time) and sent when you say "more". Replies with choices or questions are never cut.
 */
export function shortenReply(reply: string, maxLines = CHAT_MAX_LINES): string {
  const lines = String(reply ?? "").split("\n");
  if (lines.length <= maxLines + 3 || /\b(reply|say)\s+["“]?\d/i.test(reply) || /\?\s*$/.test(lines.slice(0, maxLines).join("\n").trim())) return reply;
  const cut = maxLines;
  const rest = lines.slice(cut).join("\n").trim();
  if (!rest) return reply;
  try { db().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(MORE_KEY, rest); } catch { return reply; }
  const n = rest.split("\n").filter((l) => l.trim()).length;
  return `${lines.slice(0, cut).join("\n").trimEnd()}\n\n… ${n} more line${n === 1 ? "" : "s"} – say "more" (or open the dashboard).`;
}

/** "more": the rest of the last shortened reply (itself shortened again when still long). */
export function moreReply(text: string): string | undefined {
  if (!/^\s*(more|show more|the rest|continue)\s*[.!]?\s*$/i.test(text ?? "")) return undefined;
  let rest: string | undefined;
  try { rest = (db().prepare("SELECT value FROM meta WHERE key=?").get(MORE_KEY) as any)?.value; } catch { /* none */ }
  if (!rest) return undefined;
  try { db().prepare("DELETE FROM meta WHERE key=?").run(MORE_KEY); } catch { /* ignore */ }
  return shortenReply(rest);
}
