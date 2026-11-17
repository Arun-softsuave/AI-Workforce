import { db, getMeta } from "../core/db.js";
import { loadProjects, type ProjectConfig } from "../core/config.js";
import { truncate } from "../core/util.js";
import { findTickets, ticketIndex, type IndexedTicket } from "../intake/ticketIndex.js";
import { isGroupLead } from "../engine/routing.js";
import { parsePrRef } from "../engine/prReview.js";
import { listTasks, getTask, type Task } from "../engine/tasks.js";
import { getFocus, recentChat } from "../notify/chatLog.js";

/**
 * find (IMPLEMENTATION-PLAN 5.15): what a message points at – ticket keys, Jira links, ticket names (the local ticket
 * index), PR numbers and links, branch names, items we already worked on, and history from the chat log ("that bug
 * fix last week"). Plain code, no model call. Ambiguity is reported, never guessed: the caller asks one question.
 */
export type FoundKind = "ticket" | "pr" | "branch" | "item" | "history";

export interface Found {
  kind: FoundKind;
  /** A ticket key ("KAN-45"), a PR ("PR 90" or "acme/shop#90"), a branch name, or an item ref. */
  ref: string;
  title?: string;
  /** Our item for it, when we have one (any state). */
  itemId?: string;
  state?: string;
  /** Jira assignee (display name) when the index knows it; `mine` = assigned to you. */
  assignee?: string;
  mine?: boolean;
  url?: string;
  /** How it was found: "key", "link", "name", "pr", "branch", "focus", "ordinal", "history". */
  via: string;
  score?: number;
}

export interface FindResult { matches: Found[]; ambiguous: boolean; question?: string }

/** Ticket keys a project here knows (KAN, OPS…), plus TASK for requests without a ticket. */
export function knownPrefixes(projects: ProjectConfig[] = loadProjects()): Set<string> {
  return new Set(["TASK", ...projects.flatMap((p) => p.jira?.keys ?? []).map((k) => k.toUpperCase())]);
}

const KEY_RE = /\b([A-Za-z][A-Za-z0-9]+-\d+)(@[\w-]+)?\b/g;

/**
 * Every ticket key in a text, in order, without repeats. Keys of configured projects in any case ("kan-52");
 * other keys only when written in capitals ("OPS-12") – so "covid-19" is not a ticket.
 */
export function keysIn(text: string, prefixes = knownPrefixes()): string[] {
  const out: string[] = [];
  const t = String(text ?? "").replace(/https?:\/\/\S+\/pull\/\d+\S*/gi, " ");   // PR links are not tickets
  for (const m of t.matchAll(KEY_RE)) {
    const prefix = m[1].split("-")[0].toUpperCase();
    const upper = /^[A-Z][A-Z0-9]+-\d+$/.test(m[1]);
    if (!prefixes.has(prefix) && !upper) continue;
    if (/^(SHA|UTF|ISO|HTTP|HTTPS)$/.test(prefix)) continue;
    const k = `${m[1].toUpperCase()}${(m[2] ?? "").toLowerCase()}`;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** Jira links: ".../browse/KAN-45" and "?selectedIssue=KAN-45". */
export function jiraLinkKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(/https?:\/\/[^\s)>\]]*?(?:\/browse\/|[?&]selectedIssue=)([A-Za-z][A-Za-z0-9]+-\d+)/gi)) {
    const k = m[1].toUpperCase();
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** Branch names: "feat/KAN-45-invite-email", "branch fix/login". */
export function branchesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(/\b((?:feat|feature|fix|bugfix|hotfix|chore|refactor|release|aiw)\/[\w./-]+[\w-])/gi)) if (!out.includes(m[1])) out.push(m[1]);
  const named = /\bbranch\s+([\w./-]{3,80})/i.exec(text ?? "");
  if (named && !/^(name|is|of|for|with|the)$/i.test(named[1]) && !out.includes(named[1])) out.push(named[1]);
  return out;
}

const keyOf = (t: Task) => String(t.data?.ticket?.key ?? t.source_ref ?? "").split("@")[0].toUpperCase();

/** Our newest item (lead or single task, never a part) for a ticket key – in ANY state, including DONE. */
export function itemForKey(key: string): Task | undefined {
  const k = key.toUpperCase().split("@")[0];
  const rows = db().prepare("SELECT id FROM tasks WHERE kind != 'part' AND (source_ref = ? OR source_ref LIKE ? OR json_extract(data,'$.ticket.key') = ?) ORDER BY created_at DESC LIMIT 5")
    .all(k, `${k}@%`, k) as { id: string }[];
  const tasks = rows.map((r) => getTask(r.id)).filter((t): t is Task => !!t && keyOf(t) === k);
  // a live one wins over an old finished or cancelled one
  return tasks.find((t) => !["DONE", "CANCELLED", "FAILED", "MERGED", "CLOSED"].includes(t.state)) ?? tasks[0];
}

function ticketFound(key: string, via: string, index: IndexedTicket[]): Found {
  const ix = index.find((t) => t.key === key);
  const item = itemForKey(key);
  return {
    kind: "ticket", ref: key, via,
    ...(ix ? { title: ix.title, assignee: ix.assignee, mine: ix.mine, url: ix.url } : item?.title ? { title: item.title } : {}),
    ...(item ? { itemId: item.id, state: item.state } : {}),
  };
}

const VAGUE = /\b(that one|this one|it|this|that|the ticket|this ticket|that ticket|the same)\b/i;
const ORDINALS: Record<string, number> = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, last: -1 };
const PAST = /\b(last (week|month|time|friday|monday)|yesterday|days? ago|weeks? ago|earlier|before|the other day|back then|what happened (to|with))\b/i;
const HISTORY_STOP = new Set(["what", "happened", "with", "that", "this", "the", "last", "week", "month", "days", "ago", "yesterday", "about", "did", "you", "do",
  "was", "were", "is", "are", "a", "an", "to", "of", "on", "for", "in", "and", "or", "it", "its", "my", "me", "we", "our", "status", "where", "how", "any", "news", "one", "thing", "earlier", "before", "time"]);

function historyWords(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/https?:\/\/\S+/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !HISTORY_STOP.has(w)))];
}

/**
 * Items and chat history that match a free-text description ("that bug fix last week", "the invite email work").
 * Searches item titles (every state, last 60 days) and the chat log, newest first.
 */
export function findInHistory(text: string, limit = 5): Found[] {
  const words = historyWords(text);
  if (!words.length) return [];
  const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "") || w;
  const q = words.map(stem);
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const rows = db().prepare("SELECT id FROM tasks WHERE kind != 'part' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 400").all(since) as { id: string }[];
  const found = new Map<string, Found>();
  for (const r of rows) {
    const t = getTask(r.id);
    if (!t) continue;
    const tw = new Set((`${t.title ?? ""} ${t.data?.ticket?.description ?? ""}`).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2).map(stem));
    const hit = q.filter((w) => tw.has(w)).length;
    if (!hit) continue;
    const score = hit / q.length;
    if (score < 0.5) continue;
    const ref = t.source_ref ?? t.id;
    if (!found.has(ref)) found.set(ref, { kind: "item", ref, title: t.title ?? undefined, itemId: t.id, state: t.state, via: "history", score: Math.round(score * 100) / 100 });
  }
  // the chat log: lines that mention the words, and the items they were about
  try {
    const lines = db().prepare("SELECT text, task_ref, item_id, refs FROM chat_log ORDER BY id DESC LIMIT 2000").all() as { text: string; task_ref: string | null; item_id: string | null; refs: string | null }[];
    for (const l of lines) {
      const lw = new Set(l.text.toLowerCase().split(/[^a-z0-9]+/).map(stem));
      const hit = q.filter((w) => lw.has(w)).length;
      if (hit / q.length < 0.6) continue;
      const refs: string[] = [l.item_id, l.task_ref, ...(() => { try { return JSON.parse(l.refs ?? "[]"); } catch { return []; } })()].filter(Boolean);
      for (const ref of refs.slice(0, 2)) {
        if (found.has(ref)) continue;
        const t = getTask(ref);
        found.set(ref, { kind: "history", ref: t?.source_ref ?? ref, title: t?.title ?? truncate(l.text.replace(/\s+/g, " "), 80), itemId: t?.id, state: t?.state, via: "history", score: Math.round((hit / q.length) * 90) / 100 });
      }
      if (found.size >= limit * 2) break;
    }
  } catch { /* history is best effort */ }
  return [...found.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}

/** "the second ticket", "the last one": counted in the last message we sent that named several items. */
function ordinalRef(text: string): string | undefined {
  const m = /\b(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+(one|ticket|item|task|pr|question)\b/i.exec(text);
  if (!m) return undefined;
  const lastOut = recentChat(20).reverse().find((l) => l.direction === "out" && l.refs.length > 1);
  if (!lastOut) return undefined;
  const n = ORDINALS[m[1].toLowerCase()];
  return n === -1 ? lastOut.refs.at(-1) : lastOut.refs[n];
}

/**
 * Resolve what a message names. Order: keys and Jira links, PRs, branches, ordinals ("the second ticket"),
 * ticket names from the index, then (only when nothing else matched) history, then the focus for "it" / "that one".
 */
export function find(text: string, opts: { history?: boolean; focus?: string | null; index?: IndexedTicket[] } = {}): FindResult {
  const index = opts.index ?? ticketIndex();
  const matches: Found[] = [];
  const keys = [...jiraLinkKeys(text), ...keysIn(text)].filter((k, i, a) => a.indexOf(k) === i);
  for (const k of keys) matches.push(ticketFound(k.split("@")[0], jiraLinkKeys(text).includes(k) ? "link" : "key", index));
  const pr = parsePrRef(text);
  if (pr) matches.push({ kind: "pr", ref: pr.repo ? `${pr.repo}#${pr.num}` : `PR ${pr.num}`, via: "pr", url: pr.repo ? `https://github.com/${pr.repo}/pull/${pr.num}` : undefined });
  for (const b of branchesIn(text)) matches.push({ kind: "branch", ref: b, via: "branch" });
  const ord = ordinalRef(text);
  if (ord && !matches.some((m) => m.ref === ord)) matches.push({ kind: "item", ref: ord, itemId: getTask(ord)?.id, state: getTask(ord)?.state, title: getTask(ord)?.title ?? undefined, via: "ordinal" });
  if (!matches.length) {
    const named = findTickets(text, 5, index).filter((t) => t.score >= 6);
    if (named.length) {
      const top = named[0].score;
      // close scores are ambiguous: keep every ticket within 1.5 points of the best
      for (const t of named.filter((x) => top - x.score < 1.5)) matches.push({ ...ticketFound(t.key, "name", index), score: t.score });
    }
  }
  if (!matches.length && (opts.history || PAST.test(text))) matches.push(...findInHistory(text));
  if (!matches.length && VAGUE.test(text)) {
    const f = opts.focus === undefined ? getFocus() : opts.focus;
    if (f) { const t = getTask(f); matches.push({ kind: "item", ref: f, itemId: t?.id, state: t?.state, title: t?.title ?? undefined, via: "focus" }); }
  }
  const names = matches.filter((m) => m.via === "name" || m.via === "history");
  const ambiguous = names.length > 1 && names.length === matches.length;
  return {
    matches, ambiguous,
    ...(ambiguous ? { question: `Do you mean ${names.slice(0, 3).map((m) => `${m.ref}${m.title ? ` (${truncate(m.title, 50)})` : ""}`).join(" or ")}?` } : {}),
  };
}

/** One line per match, for the Conductor's tool results and replies. */
export function foundLine(f: Found): string {
  const who = f.mine ? "yours" : f.assignee ? `assigned to ${f.assignee}` : "";
  return `${f.ref}${f.title ? ` – ${truncate(f.title, 70)}` : ""}${f.state ? ` [${f.state.toLowerCase().replace(/_/g, " ")}]` : ""}${who ? ` (${who})` : ""}`;
}

/** The project a ticket key belongs to (by its Jira key), or undefined when no project here has that key. */
export function projectForKey(key: string, projects: ProjectConfig[] = loadProjects()): ProjectConfig | undefined {
  const prefix = key.toUpperCase().split("-")[0];
  const all = projects.filter((p) => (p.jira?.keys ?? []).map((k) => k.toUpperCase()).includes(prefix));
  return all.find((p) => isGroupLead(p)) ?? all[0];
}

/** The ticket index entry for a key, if it is indexed. */
export function indexed(key: string): IndexedTicket | undefined {
  return ticketIndex().find((t) => t.key === key.toUpperCase());
}

/** For tests and the dashboard: when the ticket index was last refreshed. */
export const indexAt = () => getMeta("tickets.indexAt");

export { listTasks };
