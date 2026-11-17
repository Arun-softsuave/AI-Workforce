import { db, getMeta, setMeta, delMeta } from "../core/db.js";
import { nowIso, truncate } from "../core/util.js";
import { publish } from "../live/bus.js";

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
    publish("feed", { at: nowIso(), tone: direction === "in" ? "wait" : "work", text: `${direction === "in" ? "You" : "Sent you"}: ${truncate(text.replace(/\s+/g, " "), 140)}`, ref: opts.taskRef });
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

// --------------------------------------------------------------- catch-up (J10): what we sent while you were away

/**
 * What we sent since `sinceIso` (or since your message before the latest one), one line per item, newest message
 * each. Plain text from the history, no model. The messenger's quiet-hours catch-up can use it too.
 */
export function awaySummary(sinceIso?: string, maxItems = 6): { count: number; lines: string[] } {
  try {
    let since = sinceIso;
    if (!since) {
      const ins = db().prepare("SELECT ts FROM chat_log WHERE direction='in' ORDER BY id DESC LIMIT 2").all() as { ts: string }[];
      since = ins[1]?.ts ?? new Date(Date.now() - 24 * 3_600_000).toISOString();
    }
    const rows = db().prepare("SELECT text, task_ref, item_id, refs FROM chat_log WHERE direction='out' AND ts > ? ORDER BY id DESC LIMIT 200").all(since) as { text: string; task_ref: string | null; item_id: string | null; refs: string | null }[];
    const byRef = new Map<string, string>();
    let general = 0;
    for (const r of rows) {
      const refs: string[] = (() => { try { return JSON.parse(r.refs ?? "[]"); } catch { return []; } })();
      const ref = r.item_id ?? r.task_ref ?? refs[0];
      const first = truncate((r.text.split("\n").find((l) => l.trim() && !/^🤖/u.test(l.trim())) ?? r.text).replace(/[*_`]/g, "").replace(/\s+/g, " ").trim(), 90);
      if (!ref) { general++; continue; }
      if (!byRef.has(ref)) byRef.set(ref, first);            // rows are newest first: keep the newest per item
    }
    const lines = [...byRef.entries()].slice(0, maxItems).map(([ref, line]) => `- ${line.includes(ref) ? line : `${ref}: ${line}`}`);
    if (byRef.size > maxItems) lines.push(`- and ${byRef.size - maxItems} more`);
    if (general) lines.push(`- ${general} other update${general > 1 ? "s" : ""}`);
    return { count: rows.length, lines };
  } catch { return { count: 0, lines: [] }; }
}

/** "I'm back" / "what did I miss?" – one short catch-up message. */
export function catchUpText(sinceIso?: string): string {
  const s = awaySummary(sinceIso);
  if (!s.count) return "Welcome back 👋 Nothing new while you were away.";
  return `Welcome back 👋 While you were away (${s.count} message${s.count > 1 ? "s" : ""}):\n${s.lines.join("\n")}`;
}

export function pruneChat(): number {
  try {
    const since = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
    return Number(db().prepare("DELETE FROM chat_log WHERE ts < ?").run(since).changes);
  } catch { return 0; }
}
