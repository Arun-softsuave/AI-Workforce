import { db } from "../core/db.js";
import type { Channel } from "../core/config.js";
import type { Notice } from "../notify/channels.js";
import { mergedNotice, refOf } from "./templates.js";
import { messengerClock } from "./clock.js";

/**
 * 60 s merging (W17, J10). The first routine update about an item goes out at once; further routine updates about
 * the same item on the same channel within 60 s of the last one sent are kept as 'merging' and go out together as
 * ONE message when the window ends (flushed by the service loop, every 15 s).
 */
export const MERGE_WINDOW_MS = 60_000;

export const mergeKeyOf = (n: Notice): string | undefined => { const r = refOf(n); return r ? `item:${r}` : undefined; };

/** True when an update for this key was sent (or is already waiting to merge) on this channel within the window. */
export function inMergeWindow(key: string, ch: Channel, now = messengerClock()): boolean {
  const since = new Date(now - MERGE_WINDOW_MS).toISOString();
  return !!db().prepare("SELECT 1 FROM notifications WHERE merge_key=? AND channel=? AND status IN ('sent','merging','pending') AND created_at >= ? LIMIT 1")
    .get(key, ch, since);
}

export interface MergeBatch { key: string; channel: Channel; rowIds: string[]; notice: Notice }

/** Batches whose window has ended: the last message sent for the key is at least 60 s old. */
export function dueMerges(now = messengerClock()): MergeBatch[] {
  const rows = db().prepare("SELECT id, merge_key, channel, body, created_at FROM notifications WHERE status='merging' ORDER BY created_at, rowid").all() as any[];
  const groups = new Map<string, any[]>();
  for (const r of rows) { const k = `${r.merge_key}\u0000${r.channel}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const out: MergeBatch[] = [];
  for (const [, rs] of groups) {
    const { merge_key: key, channel } = rs[0];
    const anchor = db().prepare("SELECT MAX(created_at) AS at FROM notifications WHERE merge_key=? AND channel=? AND status IN ('sent','pending','failed')").get(key, channel) as any;
    const anchorAt = anchor?.at ? Date.parse(anchor.at) : Date.parse(rs[0].created_at);
    if (now - anchorAt < MERGE_WINDOW_MS) continue;
    const notices: Notice[] = rs.map((r) => JSON.parse(r.body));
    out.push({ key, channel, rowIds: rs.map((r) => r.id), notice: notices.length === 1 ? notices[0] : mergedNotice(notices) });
  }
  return out;
}

export function markMerged(rowIds: string[], into: string): void {
  const st = db().prepare("UPDATE notifications SET status='merged', error=? WHERE id=? AND status='merging'");
  for (const id of rowIds) st.run(`merged into ${into}`, id);
}
