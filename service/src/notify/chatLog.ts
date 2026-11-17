import { db, getMeta, setMeta, delMeta } from "../core/db.js";
import { nowIso, truncate } from "../core/util.js";

/**
 * The Teams conversation, both directions: what AI Workforce sent (questions, plans, results, chat replies) and what
 * the user wrote. Replies are understood against it ("this one", "you decide", "go ahead"), like a person would.
 * Local only; kept for 30 days.
 */
export interface ChatLine { id: number; ts: string; direction: "in" | "out"; kind: string | null; text: string; task_ref: string | null; refs: string[] }

const REF = /\b((?:[A-Z][A-Z0-9]+|TASK)-\d+(?:@[\w-]+)?)\b/g;
const KEEP_DAYS = 30;

export function refsIn(text: string): string[] {
  return [...new Set([...(text ?? "").matchAll(REF)].map((m) => m[1]))];
}

/** Tokens and keys never go into the chat history the assistant reads (JWTs, long key-like strings, NAME=secret lines). */
export function redactSecrets(text: string): string {
  return text
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, "[token hidden]")
    .replace(/\b((?:[A-Z_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Z_]*)\s*=\s*)\S+/gi, "$1[hidden]")
    .replace(/\b(qa\s+token\s+)[\s\S]*/i, "$1[hidden]")
    .replace(/\b[A-Za-z0-9+/=_-]{60,}\b/g, "[hidden]");
}

export function logChat(direction: "in" | "out", text: string, opts: { kind?: string; taskRef?: string } = {}): void {
  text = redactSecrets(text);
  try {
    const refs = refsIn(text);
    if (opts.taskRef && !refs.includes(opts.taskRef)) refs.unshift(opts.taskRef);
    db().prepare("INSERT INTO chat_log (ts, direction, kind, text, task_ref, refs) VALUES (?,?,?,?,?,?)")
      .run(nowIso(), direction, opts.kind ?? null, truncate(text, 8000), opts.taskRef ?? null, JSON.stringify(refs));
  } catch { /* history is best effort – never block a message */ }
}

export function recentChat(n = 20): ChatLine[] {
  try {
    const rows = db().prepare("SELECT * FROM chat_log ORDER BY id DESC LIMIT ?").all(n) as any[];
    return rows.reverse().map((r) => ({ ...r, refs: JSON.parse(r.refs ?? "[]") }));
  } catch { return []; }
}

/** The history as plain text for a prompt (oldest first, each line cut short). */
export function chatHistoryText(n = 20, maxPerLine = 400): string {
  return recentChat(n).map((l) => `${l.direction === "in" ? "USER" : "ASSISTANT"}${l.task_ref ? ` [about ${l.task_ref}]` : ""}: ${truncate(l.text.replace(/\s+/g, " "), maxPerLine)}`).join("\n");
}

// --------------------------------------------------------------- focus: the item the conversation is about right now

const FOCUS_KEY = "teams.focus";
const FOCUS_MS = 24 * 3_600_000;

export function setFocus(ref: string | undefined): void {
  if (!ref) return;
  setMeta(FOCUS_KEY, JSON.stringify({ ref, at: Date.now() }));
}
export function getFocus(): string | undefined {
  try {
    const f = JSON.parse(getMeta(FOCUS_KEY) ?? "null");
    return f && Date.now() - f.at < FOCUS_MS ? f.ref : undefined;
  } catch { return undefined; }
}
export function clearFocus(): void { delMeta(FOCUS_KEY); }

export function pruneChat(): number {
  try {
    const since = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
    return Number(db().prepare("DELETE FROM chat_log WHERE ts < ?").run(since).changes);
  } catch { return 0; }
}
