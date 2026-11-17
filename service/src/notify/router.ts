import { db } from "../core/db.js";
import { loadSettings, type Channel, type Settings } from "../core/config.js";
import { newId, nowIso, inTimeWindow, redactSecrets } from "../core/util.js";
import { logger } from "../core/log.js";
import { senders, ACTION_KINDS, type Notice, type Sender } from "./channels.js";
import { getTask, mergeData } from "../engine/tasks.js";
import { publish } from "../live/bus.js";
import { prepare, rowMeta, messengerOn, catchUpFor } from "../messenger/messenger.js";
import { dueMerges, markMerged } from "../messenger/merge.js";
import { messengerNowIso } from "../messenger/clock.js";

/**
 * Notification Router (PRD §8):
 *  - the Claude Code inbox always records action-needed items (nothing is ever lost);
 *  - primary channel + fallbacks per kind; one thread per task on Slack;
 *  - exclusive mode (default): everything goes to the primary channel only (e.g. the two-way Teams chat), failed
 *    messages are retried on that channel and never moved to another one;
 *  - optional quiet hours hold non-urgent external messages until the next working window (off by default: 24h);
 *  - idempotent per (kind, task, dedupeKey, channel); no secrets or code in messages.
 * Chat channels go through the Messenger (messenger/messenger.ts): short templates with "details KAN-x", routine
 * updates about one item merged within 60 s, and one catch-up message after quiet hours.
 */
let channelImpl: Partial<Record<Channel, Sender>> = senders;
export function setSenders(s: Partial<Record<Channel, Sender>>): void { channelImpl = s; }

export function channelsFor(kind: string, s: Settings): Channel[] {
  const primary = s.notifications.primary;
  if (s.notifications.exclusive) return dedupe([primary]);            // one channel for everything (e.g. Teams only)
  const custom = s.notifications.perKind?.[kind];
  if (custom?.length) return dedupe(custom);
  if (kind === "connector_problem") return dedupe(["desktop", primary === "inbox" ? "desktop" : primary]);
  if (ACTION_KINDS.has(kind)) return dedupe([primary, "desktop"]);
  return dedupe([primary]);
}

const dedupe = (a: Channel[]) => [...new Set(a.filter((c) => c !== "inbox"))];

export async function notify(n: Notice, now = new Date()): Promise<{ delivered: Channel[]; held: Channel[] }> {
  const s = loadSettings();
  n = { ...n, title: redactSecrets(n.title), body: redactSecrets(n.body) };
  const given = n as Notice & { details?: string; detailsRef?: string };
  if (typeof given.details === "string") given.details = redactSecrets(given.details);
  const action = ACTION_KINDS.has(n.kind);
  const delivered: Channel[] = [], held: Channel[] = [];
  const meta = rowMeta(n);

  // 1. Inbox: always for action-needed items, and as an activity record for others (full text, never shortened).
  const inboxKey = `${n.kind}:${n.taskId ?? "-"}:${n.dedupeKey ?? ""}:inbox`;
  insertRow(n, "inbox", inboxKey, action ? "unread" : "read", { itemId: meta.itemId ?? meta.ref, detailsRef: given.details ? given.detailsRef ?? meta.ref : null });
  try {
    const tone = n.kind === "approval_needed" || n.kind === "needs_info" ? "you" : n.kind === "failed" || n.kind === "paused" ? "bad" : n.kind === "done" ? "ok" : "work";
    publish("feed", { at: nowIso(), tone, text: n.title, ref: n.taskRef, taskId: n.taskId });
    if (action) publish("needs", { taskId: n.taskId });
  } catch { /* live view only */ }

  // 2. External channels.
  const quiet = inTimeWindow(s.notifications.quietHours, now, s.profile.timezone) && !n.urgent;
  const wanted = channelsFor(n.kind, s);
  const fallbacks = s.notifications.exclusive ? [] : s.notifications.fallback.filter((c) => c !== "inbox" && !wanted.includes(c));
  const chain = [...wanted, ...fallbacks];
  let primaryDone = false;
  for (const ch of chain) {
    const isFallback = !wanted.includes(ch);
    if (isFallback && primaryDone) break;
    const key = `${n.kind}:${n.taskId ?? "-"}:${n.dedupeKey ?? ""}:${ch}`;
    const p = prepare(n, ch, s, { quiet });
    const status = quiet ? "held" : p.merge ? "merging" : "pending";
    const rowId = insertRow(p.notice, ch, key, status, { itemId: p.itemId ?? meta.ref, mergeKey: p.mergeKey, detailsRef: p.detailsRef });
    if (!rowId) { primaryDone = true; continue; }            // already sent before -> idempotent
    if (quiet || p.merge) { held.push(ch); primaryDone = true; continue; }
    const ok = await deliver(rowId, ch, p.notice);
    if (ok) { delivered.push(ch); primaryDone = true; }
  }
  return { delivered, held };
}

interface RowExtra { itemId?: string | null; mergeKey?: string | null; detailsRef?: string | null }

function insertRow(n: Notice, ch: Channel, key: string, status: string, x: RowExtra = {}): string | undefined {
  const id = newId("n");
  const r = db().prepare(`INSERT OR IGNORE INTO notifications (id, task_id, channel, kind, idem_key, title, body, action_needed, status, created_at, item_id, merge_key, details_ref)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, n.taskId ?? null, ch, n.kind, key, n.title, JSON.stringify(n), ACTION_KINDS.has(n.kind) ? 1 : 0, status, messengerNowIso(),
    x.itemId ?? null, x.mergeKey ?? null, x.detailsRef ?? null);
  return r.changes ? id : undefined;
}

async function deliver(rowId: string, ch: Channel, n: Notice): Promise<boolean> {
  const impl = channelImpl[ch];
  if (!impl) { markRow(rowId, "failed", "no sender"); return false; }
  try {
    const thread = ch === "slack" && n.taskId ? getTask(n.taskId)?.data.slackThread : undefined;
    const ref = await impl.send(n, thread);
    if (ch === "slack" && n.taskId && ref && !thread) mergeData(n.taskId, { slackThread: ref });
    markRow(rowId, "sent", undefined, ref);
    return true;
  } catch (e: any) {
    markRow(rowId, "failed", e.message);
    logger.warn("notification delivery failed", { channel: ch, kind: n.kind, error: e.message });
    return false;
  }
}

function markRow(id: string, status: string, error?: string, ref?: string): void {
  db().prepare("UPDATE notifications SET status=?, error=?, thread_ref=COALESCE(?, thread_ref), attempts=attempts+1, sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END WHERE id=?")
    .run(status, error ?? null, ref ?? null, status, nowIso(), id);
}

/** Send the routine updates kept for 60 s merging whose window has ended: one message per item and channel. */
export async function flushMerges(): Promise<number> {
  let n = 0;
  for (const b of dueMerges()) {
    if (b.rowIds.length === 1) {
      db().prepare("UPDATE notifications SET status='pending' WHERE id=? AND status='merging'").run(b.rowIds[0]);
      if (await deliver(b.rowIds[0], b.channel, b.notice)) n++;
      continue;
    }
    const first = b.rowIds[0];
    const id = insertRow(b.notice, b.channel, `merged:${first}:${b.channel}`, "pending", { itemId: b.notice.taskId ?? b.notice.taskRef ?? null, mergeKey: b.key });
    if (!id) { markMerged(b.rowIds, "an earlier merge"); continue; }
    markMerged(b.rowIds, id);
    if (await deliver(id, b.channel, b.notice)) n++;
  }
  return n;
}

/** After quiet hours, per chat channel: the held plain updates become ONE catch-up message (questions follow on their own). */
async function flushCatchUp(s: Settings): Promise<number> {
  if (!messengerOn(s)) return 0;
  const rows = db().prepare("SELECT id, channel, body FROM notifications WHERE channel!='inbox' AND status='held' ORDER BY created_at, rowid").all() as any[];
  const byCh = new Map<Channel, { id: string; notice: Notice }[]>();
  for (const r of rows) byCh.set(r.channel, [...(byCh.get(r.channel) ?? []), { id: r.id, notice: JSON.parse(r.body) }]);
  let n = 0;
  for (const [ch, held] of byCh) {
    const c = catchUpFor(held);
    if (!c) continue;
    const id = insertRow(c.notice, ch, `catchup:${c.replaced[0]}:${ch}`, "pending");
    if (!id) continue;
    db().prepare(`UPDATE notifications SET status='merged', error=? WHERE status='held' AND id IN (${c.replaced.map(() => "?").join(",")})`).run(`in catch-up ${id}`, ...c.replaced);
    if (await deliver(id, ch, c.notice)) n++;
  }
  return n;
}

/** Deliver messages held during quiet hours (as one catch-up), merged updates, and retry failed ones (max 5 attempts). */
export async function flushNotifications(now = new Date()): Promise<number> {
  const s = loadSettings();
  if (inTimeWindow(s.notifications.quietHours, now, s.profile.timezone)) {
    // quiet hours began while updates were waiting to merge: they wait for the catch-up instead
    db().prepare("UPDATE notifications SET status='held' WHERE status='merging'").run();
    return 0;
  }
  let n = await flushMerges();
  n += await flushCatchUp(s);
  const rows = db().prepare("SELECT id, channel, body, idem_key, status, attempts FROM notifications WHERE channel!='inbox' AND (status='held' OR (status='failed' AND attempts<5)) ORDER BY created_at LIMIT 50").all() as any[];
  for (const r of rows) {
    const notice: Notice = JSON.parse(r.body);
    if (await deliver(r.id, r.channel, notice)) { n++; continue; }
    // Exclusive channel (e.g. Teams only): keep retrying the same channel, never switch to another one.
    if (s.notifications.exclusive) continue;
    // Held message whose channel is still failing, or a channel that keeps failing: use the fallback chain.
    if (r.status === "held" || r.attempts + 1 >= 3) {
      markRow(r.id, "abandoned", "delivered via fallback");
      for (const ch of s.notifications.fallback.filter((c) => c !== "inbox" && c !== r.channel)) {
        const id = insertRow(notice, ch, `${r.idem_key}:fallback:${ch}`, "pending");
        if (id && (await deliver(id, ch, notice))) { n++; break; }
      }
    }
  }
  return n;
}

export interface InboxItem { id: string; task_id: string | null; kind: string; title: string; created_at: string; notice: Notice }

export function inbox(includeRead = false, limit = 30): InboxItem[] {
  return (db().prepare(`SELECT id, task_id, kind, title, created_at, body FROM notifications WHERE channel='inbox' ${includeRead ? "" : "AND status='unread'"} ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as any[]).map((r) => ({ ...r, notice: JSON.parse(r.body) }));
}

export function markInboxRead(taskId?: string, kind?: string): void {
  if (taskId) db().prepare(`UPDATE notifications SET status='read', read_at=? WHERE channel='inbox' AND task_id=? ${kind ? "AND kind=?" : ""}`).run(nowIso(), taskId, ...(kind ? [kind] : []));
  else db().prepare("UPDATE notifications SET status='read', read_at=? WHERE channel='inbox' AND status='unread'").run(nowIso());
}
