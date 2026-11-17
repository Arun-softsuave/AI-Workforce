/**
 * Kernel event log (engine v2) on the existing `events` table – the same table intake.ts writes for idempotency.
 * emit() dedupes on the UNIQUE idem_key. An event is pending until markHandled() gives it a job id or "ignored".
 */
import { db } from "../core/db.js";
import { newId, nowIso, safeJson } from "../core/util.js";
import type { KernelEvent, NewEvent, Emit, PendingEvents, MarkHandled, EventsFor } from "./types.js";

const row2event = (r: any): KernelEvent => ({
  id: r.id, type: r.type, idem_key: r.idem_key, item_id: r.item_id ?? null, project_id: r.project_id ?? null,
  source_ref: r.source_ref ?? null, payload: safeJson(r.payload, {}), handled_by: r.handled_by ?? null,
  received_at: r.received_at, processed_at: r.processed_at ?? null,
});

export const emit: Emit = (e: NewEvent) => {
  if (!e.idemKey) throw new Error("emit: idemKey is required");
  let projectId = e.projectId ?? null, sourceRef = e.sourceRef ?? null;
  if (e.itemId && (!projectId || !sourceRef)) {
    const t = db().prepare("SELECT project_id, source_ref FROM tasks WHERE id=?").get(e.itemId) as { project_id: string; source_ref: string | null } | undefined;
    projectId ??= t?.project_id ?? null;
    sourceRef ??= t?.source_ref ?? null;
  }
  const id = newId("e");
  const r = db().prepare("INSERT OR IGNORE INTO events (id, idem_key, type, project_id, source_ref, payload, received_at, item_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, e.idemKey, e.type, projectId, sourceRef, JSON.stringify(e.payload ?? {}), nowIso(), e.itemId ?? null);
  if (!r.changes) return undefined;
  return getEvent(id);
};

export function getEvent(id: string): KernelEvent | undefined {
  const r = db().prepare("SELECT * FROM events WHERE id=?").get(id);
  return r ? row2event(r) : undefined;
}

/** Unhandled events, oldest first. */
export const pendingEvents: PendingEvents = (limit = 100) =>
  (db().prepare("SELECT * FROM events WHERE handled_by IS NULL ORDER BY received_at, rowid LIMIT ?").all(limit) as any[]).map(row2event);

export const markHandled: MarkHandled = (eventId, by) => {
  if (!by) throw new Error("markHandled: a job id or \"ignored\" is required");
  db().prepare("UPDATE events SET handled_by=?, processed_at=COALESCE(processed_at, ?) WHERE id=?").run(by, nowIso(), eventId);
};

/** Events of one item, newest first. */
export const eventsFor: EventsFor = (itemId, limit = 50) =>
  (db().prepare("SELECT * FROM events WHERE item_id=? ORDER BY received_at DESC, rowid DESC LIMIT ?").all(itemId, limit) as any[]).map(row2event);

/**
 * Mark every pending event received before `before` as "ignored" (default: all). For switching to v2: events v1
 * already acted on have handled_by NULL and would otherwise be routed again. Returns how many.
 */
export function ignoreBacklog(before?: string): number {
  const r = before
    ? db().prepare("UPDATE events SET handled_by='ignored', processed_at=COALESCE(processed_at, ?) WHERE handled_by IS NULL AND received_at < ?").run(nowIso(), before)
    : db().prepare("UPDATE events SET handled_by='ignored', processed_at=COALESCE(processed_at, ?) WHERE handled_by IS NULL").run(nowIso());
  return Number(r.changes);
}

/** Short names from the task text. */
export const pending = pendingEvents;
export const recent = eventsFor;
