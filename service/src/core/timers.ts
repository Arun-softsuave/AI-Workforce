import { db } from "./db.js";
import { logger } from "./log.js";
import { redactSecrets } from "./util.js";
import { publish } from "../live/bus.js";

/**
 * One registry for every background timer (W19, module 5.28): Jira check, Teams inbox, PR watcher, CI watch,
 * connector health, ticket index, Brain refresh, daily digest. Each run records last run, result and next run in
 * the `timers` table, so the dashboard can show "every 2 min · last run 40 s ago · next in 1 min · healthy".
 * No AI; nothing here changes how the timers behave – runTimed() only wraps the existing work.
 */

export interface TimerInfo {
  name: string; every: string; detail: string | null;
  lastRun: string | null; lastOk: boolean | null; nextRun: string | null;
  state: "running" | "healthy" | "failed" | "scheduled";
  error?: string;
}

/** "every 2 min", "every 10 s", "daily 18:00", "on CI event" – or a number of milliseconds. */
export type Every = number | string;

const everyMs = new Map<string, number | undefined>();
const running = new Set<string>();
const lastError = new Map<string, string>();

export function everyText(every: Every): string {
  if (typeof every === "string") return every;
  const s = Math.round(every / 1000);
  if (s < 60) return `every ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `every ${m} min`;
  const h = Math.round(m / 60);
  return h === 24 ? "daily" : `every ${h} h`;
}

/** Milliseconds for a numeric `every` or a text like "every 2 min" / "every 10 s" / "every 1 h". Daily/event timers: undefined. */
export function everyToMs(every: Every): number | undefined {
  if (typeof every === "number") return every > 0 ? every : undefined;
  const m = /^every\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)\b/i.exec(every.trim());
  if (!m) return undefined;
  const n = Number(m[1]), u = m[2].toLowerCase();
  return Math.round(n * (u.startsWith("s") ? 1000 : u.startsWith("h") ? 3_600_000 : 60_000));
}

/**
 * Register (or update) a timer. `name` is what the person sees ("Jira check"); `detail` says what it checks.
 * Keeps the last run / result of an existing row.
 */
export function registerTimer(name: string, every: Every, detail?: string): void {
  const ms = everyToMs(every);
  everyMs.set(name, ms);
  db().prepare(`INSERT INTO timers (name, every, detail) VALUES (?,?,?)
    ON CONFLICT(name) DO UPDATE SET every=excluded.every, detail=coalesce(excluded.detail, timers.detail)`)
    .run(name, everyText(every), detail ?? null);
}

/** Set the next planned run by hand (daily jobs, event-driven jobs). */
export function setNextRun(name: string, next: Date | string | null): void {
  db().prepare("UPDATE timers SET next_run=? WHERE name=?").run(next == null ? null : typeof next === "string" ? next : next.toISOString(), name);
  publishTimer(name);
}

/**
 * Run `fn` as one run of timer `name`: records the start, then the result and the next run. The result (or the
 * error) of `fn` is passed through unchanged, so wrapping existing work never changes its behaviour.
 * A run that starts while the previous one is still going is still executed (the caller decides about overlap).
 */
export async function runTimed<T>(name: string, fn: () => Promise<T> | T, opts: { nextRun?: Date } = {}): Promise<T> {
  if (!db().prepare("SELECT 1 FROM timers WHERE name=?").get(name)) registerTimer(name, "on demand");
  const start = new Date();
  running.add(name);
  db().prepare("UPDATE timers SET last_run=? WHERE name=?").run(start.toISOString(), name);
  publishTimer(name);
  let ok = false;
  try {
    const r = await fn();
    ok = true;
    lastError.delete(name);
    return r;
  } catch (e: any) {
    lastError.set(name, redactSecrets(String(e?.message ?? e)).slice(0, 200));
    throw e;
  } finally {
    running.delete(name);
    const ms = everyMs.get(name) ?? everyToMs((db().prepare("SELECT every FROM timers WHERE name=?").get(name) as { every: string } | undefined)?.every ?? "");
    const next = opts.nextRun ?? (ms ? new Date(Date.now() + ms) : undefined);
    try {
      db().prepare(`UPDATE timers SET last_ok=?, next_run=${next ? "?" : "next_run"} WHERE name=?`).run(...(next ? [ok ? 1 : 0, next.toISOString(), name] : [ok ? 1 : 0, name]));
      publishTimer(name);
    } catch (e: any) { logger.warn("timer bookkeeping failed", { name, error: e.message }); }
  }
}

function rowToInfo(r: any): TimerInfo {
  const isRunning = running.has(r.name);
  const state: TimerInfo["state"] = isRunning ? "running" : r.last_ok === 0 ? "failed" : r.last_ok === 1 ? "healthy" : "scheduled";
  return {
    name: r.name, every: r.every, detail: r.detail ?? null, lastRun: r.last_run ?? null,
    lastOk: r.last_ok == null ? null : r.last_ok === 1, nextRun: r.next_run ?? null, state,
    ...(state === "failed" && lastError.get(r.name) ? { error: lastError.get(r.name) } : {}),
  };
}

function publishTimer(name: string): void {
  const r = db().prepare("SELECT * FROM timers WHERE name=?").get(name);
  if (r) publish("timer", rowToInfo(r), { key: `timer:${name}` });
}

/** Every registered timer, in the order they were first registered. */
export function listTimers(): TimerInfo[] {
  return (db().prepare("SELECT * FROM timers ORDER BY rowid").all() as any[]).map(rowToInfo);
}

/** Tests only. */
export function _resetTimers(): void { everyMs.clear(); running.clear(); lastError.clear(); }
