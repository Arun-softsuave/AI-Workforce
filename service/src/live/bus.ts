/**
 * In-process live event bus for the dashboard (W19, module 5.24). No AI, no I/O.
 *
 * Producers call publish(kind, payload). Subscribers (the SSE stream) get every event that passes the throttle.
 * Throttling is per key (e.g. "activity:<taskId>"): within the window only the LAST payload is kept and it is
 * delivered when the window ends (trailing), so the final state is never lost.
 * The bus also keeps the last event per kind+key and a short ring of recent events, so a fresh client can catch up.
 */
export type LiveKind = "job" | "activity" | "item" | "needs" | "connector" | "slots" | "timer" | "feed" | "snapshot";

export interface LiveEvent<T = unknown> { seq: number; kind: LiveKind; key: string; at: string; payload: T }
export type Listener = (e: LiveEvent) => void;

export interface PublishOpts {
  /** Throttle key. Defaults to the kind, or "<kind>:<payload.taskId>" when the payload carries a taskId. */
  key?: string;
  /** Minimum gap between deliveries for this key, in ms. Defaults per kind (activity: 2000 ms, others: 0). */
  throttleMs?: number;
}

const DEFAULT_THROTTLE: Partial<Record<LiveKind, number>> = { activity: 2000 };
const RECENT_MAX = 200;

const listeners = new Set<Listener>();
const lastSent = new Map<string, number>();                                   // key -> time of last delivery
const pending = new Map<string, { kind: LiveKind; payload: unknown; timer: NodeJS.Timeout }>();
const latest = new Map<string, LiveEvent>();                                  // key -> last delivered event
const recentRing: LiveEvent[] = [];
let seq = 0;
let clock: () => number = () => Date.now();
let snapshotCache: { at: number; value: unknown } | undefined;

/** Tests only: replace the clock used for throttling. */
export function _setClock(fn?: () => number): void { clock = fn ?? (() => Date.now()); }

function keyFor(kind: LiveKind, payload: unknown, opts: PublishOpts): string {
  if (opts.key) return opts.key;
  const id = payload && typeof payload === "object" ? (payload as any).taskId : undefined;
  return id ? `${kind}:${id}` : kind;
}

function deliver(kind: LiveKind, key: string, payload: unknown): LiveEvent {
  const e: LiveEvent = { seq: ++seq, kind, key, at: new Date(clock()).toISOString(), payload };
  lastSent.set(key, clock());
  latest.set(key, e);
  recentRing.push(e);
  if (recentRing.length > RECENT_MAX) recentRing.shift();
  if (kind !== "activity") snapshotCache = undefined;                         // the next snapshot is rebuilt
  for (const l of [...listeners]) {
    try { l(e); } catch { /* a broken subscriber never breaks a producer */ }
  }
  return e;
}

/**
 * Publish a live event. Returns "sent" when delivered now, "queued" when it will be delivered at the end of the
 * throttle window (replacing any earlier queued payload for the same key).
 */
export function publish<T>(kind: LiveKind, payload: T, opts: PublishOpts = {}): "sent" | "queued" {
  const key = keyFor(kind, payload, opts);
  const gap = opts.throttleMs ?? DEFAULT_THROTTLE[kind] ?? 0;
  const last = lastSent.get(key);
  const now = clock();
  if (!gap || last === undefined || now - last >= gap) {
    const p = pending.get(key);
    if (p) { clearTimeout(p.timer); pending.delete(key); }
    deliver(kind, key, payload);
    return "sent";
  }
  const p = pending.get(key);
  if (p) { p.payload = payload; return "queued"; }
  const timer = setTimeout(() => {
    const q = pending.get(key);
    pending.delete(key);
    if (q) deliver(q.kind, key, q.payload);
  }, Math.max(1, gap - (now - last)));
  timer.unref?.();
  pending.set(key, { kind, payload, timer });
  return "queued";
}

/** Subscribe to every delivered event. Returns the unsubscribe function. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const subscriberCount = () => listeners.size;

/** The last delivered event per key (optionally only one kind) – what a new client needs to catch up. */
export function lastEvents(kind?: LiveKind): LiveEvent[] {
  return [...latest.values()].filter((e) => !kind || e.kind === kind).sort((a, b) => a.seq - b.seq);
}

/** Recent delivered events, oldest first, optionally after a sequence number. */
export function recent(afterSeq = 0, kind?: LiveKind): LiveEvent[] {
  return recentRing.filter((e) => e.seq > afterSeq && (!kind || e.kind === kind));
}

/**
 * The last full snapshot, rebuilt by `build` when anything other than an activity line changed, or when older
 * than maxAgeMs. Keeps several dashboard clients from rebuilding it on every connect.
 */
export function snapshot<T>(build: () => T, maxAgeMs = 2000): T {
  const now = clock();
  if (snapshotCache && now - snapshotCache.at < maxAgeMs) return snapshotCache.value as T;
  const value = build();
  snapshotCache = { at: now, value };
  return value;
}

/** Forget a key (e.g. a finished job) so it is not replayed to new clients. */
export function forget(key: string): void {
  latest.delete(key);
  const p = pending.get(key);
  if (p) { clearTimeout(p.timer); pending.delete(key); }
}

/** Tests only: clear all state. */
export function _resetBus(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear(); listeners.clear(); lastSent.clear(); latest.clear(); recentRing.length = 0;
  snapshotCache = undefined; seq = 0; clock = () => Date.now();
}
