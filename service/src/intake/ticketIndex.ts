import { loadProjects } from "../core/config.js";
import { getMeta, setMeta } from "../core/db.js";
import { clients } from "../connectors/registry.js";

/**
 * A small local index of the open Jira tickets of every project (key, title, status, assignee), kept up to date
 * by the intake loop (one Jira search every 15 minutes, no AI). Lets Teams messages name a ticket by what it is about
 * ("start the invite email task") instead of its key.
 */

export interface IndexedTicket { key: string; title: string; status: string; mine: boolean; assignee?: string; updated: string; url?: string }

const KEY = "tickets.index";
const AT = "tickets.indexAt";
const EVERY_MS = 15 * 60_000;

export function ticketIndex(): IndexedTicket[] {
  try { return JSON.parse(getMeta(KEY) ?? "[]"); } catch { return []; }
}

export async function refreshTicketIndex(force = false): Promise<number> {
  const last = Date.parse(getMeta(AT) ?? "");
  if (!force && Number.isFinite(last) && Date.now() - last < EVERY_MS) return -1;
  const jira = clients.jira();
  const keys = [...new Set(loadProjects().flatMap((p) => p.jira?.keys ?? []))];
  if (!jira || !keys.length) return 0;
  setMeta(AT, new Date().toISOString());
  let me: string | undefined;
  try { me = (await jira.myself()).accountId; } catch { /* still index */ }
  const items = await jira.search(`project in (${keys.join(",")}) AND statusCategory != Done ORDER BY updated DESC`, 200);
  const list: IndexedTicket[] = items.map((i) => ({ key: i.key, title: i.title, status: i.status, mine: !!me && i.assignee === me, assignee: i.assigneeName, updated: i.updated, url: i.url }));
  setMeta(KEY, JSON.stringify(list));
  return list.length;
}

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "with", "at", "by", "from", "is", "it", "that", "this", "task", "tasks", "ticket", "tickets",
  "story", "issue", "please", "start", "do", "work", "pick", "take", "up", "can", "you", "me", "my", "one", "about", "which", "fix", "implement", "make", "new", "add", "need", "want", "now", "also"]);

export function words(s: string): string[] {
  return s.toLowerCase().replace(/\[[a-z]+-\d+\]/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
}

/** Light stemming so "emails" finds "email" and "inviting" finds "invite". */
function stem(w: string): string { return w.replace(/(ing|ed|es|s)$/, "") || w; }

/**
 * Tickets that match a text: an exact key first, then by title words (all words matched ranks highest; tickets assigned
 * to you and recently updated win ties). Pure ranking – no AI.
 */
export function findTickets(text: string, limit = 5, list = ticketIndex()): (IndexedTicket & { score: number })[] {
  const keyHits = [...text.toUpperCase().matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)].map((m) => m[1]);
  const exact = list.filter((t) => keyHits.includes(t.key)).map((t) => ({ ...t, score: 100 }));
  const q = [...new Set(words(text).map(stem))];
  if (!q.length) return exact.slice(0, limit);
  const scored = list.filter((t) => !keyHits.includes(t.key)).map((t) => {
    const tw = new Set(words(t.title).map(stem));
    const hit = q.filter((w) => tw.has(w) || [...tw].some((x) => x.length > 3 && (x.startsWith(w) || w.startsWith(x)))).length;
    const score = hit === 0 ? 0 : (hit / q.length) * 10 + (hit / Math.max(tw.size, 1)) * 3 + (t.mine ? 1 : 0);
    return { ...t, score: Math.round(score * 100) / 100 };
  }).filter((t) => t.score >= 4).sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated));
  return [...exact, ...scored].slice(0, limit);
}

/** For the Teams intent model: the open tickets most related to a message, one line each. */
export function ticketsForPrompt(text: string, limit = 12): string {
  const hits = findTickets(text, limit);
  const mine = ticketIndex().filter((t) => t.mine && !hits.some((h) => h.key === t.key)).slice(0, Math.max(0, limit - hits.length));
  return [...hits, ...mine].map((t) => `- ${t.key}: ${t.title} [${t.status}${t.mine ? ", assigned to you" : t.assignee ? `, ${t.assignee}` : ""}]`).join("\n");
}
