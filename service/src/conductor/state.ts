import { getMeta, setMeta, delMeta } from "../core/db.js";

/**
 * Small conversation state shared by the fast path (intake/teamsIntent.ts) and the Conductor:
 *  - "awaiting": the one short question we asked and what a "yes" / a number will do;
 *  - "undo": the last action that can be undone safely (J5 corrections, J14 "undo that").
 * Kept in `meta` so it survives a restart; both expire.
 */
export interface ConductorCall { tool: string; args: Record<string, any> }

export type Awaiting =
  | { type: "reject_reason"; ref: string; at: number }
  | { type: "confirm_cancel"; ref: string; at: number }
  | { type: "pick_project"; text: string; choices: string[]; at: number }
  | { type: "confirm_answer"; ref: string; text: string; at: number }
  | { type: "confirm_actions"; actions: any[]; at: number }
  /** The Conductor asked one short question: "yes" runs `calls`; a number (or a key) picks one of `options`. */
  | { type: "conductor"; question: string; calls?: ConductorCall[]; options?: { label: string; key?: string; calls: ConductorCall[] }[]; at: number };

const AWAIT_KEY = "teams.awaiting";
const AWAIT_MS = 60 * 60_000;

export function getAwaiting(): Awaiting | undefined {
  try {
    const a = JSON.parse(getMeta(AWAIT_KEY) ?? "null") as Awaiting | null;
    if (!a || Date.now() - a.at > AWAIT_MS) return undefined;
    return a;
  } catch { return undefined; }
}
export const setAwaiting = (a: Awaiting): void => setMeta(AWAIT_KEY, JSON.stringify(a));
export const clearAwaiting = (): void => delMeta(AWAIT_KEY);

// ------------------------------------------------------------------ undo

export type UndoRecord =
  | { kind: "start"; itemId: string; ref: string; at: number }
  | { kind: "directive"; id: string; text: string; at: number }
  | { kind: "prefs"; path: string; old: unknown; text: string; at: number }
  | { kind: "team"; old: unknown; text: string; at: number }
  | { kind: "priority"; itemId: string; ref: string; old: { priority: number; due: string | null }; at: number }
  | { kind: "pause"; itemId?: string; ref?: string; all?: boolean; at: number };

const UNDO_KEY = "conductor.undo";
/** Undo is offered for 30 minutes after the action. */
export const UNDO_MS = 30 * 60_000;

export function recordUndo(u: UndoRecord): void { setMeta(UNDO_KEY, JSON.stringify(u)); }
export function lastUndo(): UndoRecord | undefined {
  try {
    const u = JSON.parse(getMeta(UNDO_KEY) ?? "null") as UndoRecord | null;
    return u && Date.now() - u.at < UNDO_MS ? u : undefined;
  } catch { return undefined; }
}
export const clearUndo = (): void => delMeta(UNDO_KEY);
