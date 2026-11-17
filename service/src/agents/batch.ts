import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { aiwHome, ensureDir } from "../core/paths.js";
import { getSecret } from "../core/secrets.js";
import { log } from "../core/log.js";
import { nowIso, sha256 } from "../core/util.js";
import { priceUsd } from "../bench/costView.js";

/**
 * Batch API for work that isn't urgent (module 5.8b, §9.1.6): single calls that can wait a few hours (handbook and
 * rules-card rebuild, nightly Brain doc summaries, close-out learning, digest drafts, old-work audit summaries) go
 * through `messages.batches` at half the price. Agent loops and anything someone waits for never use this.
 *
 * Flow: queueBatchCall() -> flushBatch() -> pollBatches() -> getResult(). A call that has no result by its deadline
 * (or whose batch item failed) is run normally by runOverdue(), so nothing waits forever. tickBatches() does all three
 * and is what the service calls on its timer.
 *
 * State is one JSON file under <AIW_HOME>/batch/queue.json (requests, open batches, results). It never holds secrets.
 */

export interface BatchCall {
  /** caller's stable key, e.g. "handbook:proj1:2026-11-17" – the same key is only queued once */
  key: string;
  model: string;
  system?: string;
  prompt: string;
  maxTokens: number;
  /** how long the call may wait before it is run normally (default 6 hours) */
  waitMs?: number;
}

export interface BatchUsage { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

export interface BatchResult {
  key: string;
  text: string;
  model: string;
  usage?: BatchUsage;
  /** "batch" = half price, "direct" = the fallback ran it as a normal call */
  via: "batch" | "direct";
  at: string;
  /** set when the call could not be done at all */
  error?: string;
  /** its usage is already in the steps table (recordBatchUsage) */
  recorded?: boolean;
}

interface QueuedCall extends Required<Omit<BatchCall, "waitMs" | "system">> {
  system?: string;
  customId: string;
  queuedAt: string;
  deadline: string;
  /** batch it was sent in */
  batchId?: string;
  /** the batch item failed: run it normally at the next tick */
  retryDirect?: boolean;
  directAttempts?: number;
}

interface BatchRecord { id: string; customIds: string[]; submittedAt: string; status: string }

interface QueueState { calls: QueuedCall[]; batches: BatchRecord[]; results: Record<string, BatchResult> }

/** The part of the Anthropic client this module uses (inject a fake in tests). */
export interface BatchClient {
  messages: {
    create(params: any): Promise<any>;
    batches: {
      create(params: { requests: { custom_id: string; params: any }[] }): Promise<{ id: string; processing_status: string }>;
      retrieve(id: string): Promise<{ id: string; processing_status: string }>;
      results(id: string): Promise<AsyncIterable<{ custom_id: string; result: any }>>;
    };
  };
}

export interface BatchDeps {
  client?: BatchClient;
  /** runs one call normally (default: client.messages.create). The service may pass its own runner here. */
  direct?: (call: { model: string; system?: string; prompt: string; maxTokens: number }) => Promise<{ text: string; usage?: BatchUsage }>;
  now?: () => number;
  file?: string;
}

const DEFAULT_WAIT_MS = 6 * 60 * 60 * 1000;
const MAX_PER_BATCH = 10_000;                 // well under the API limit of 100k requests / 256 MB
const MAX_DIRECT_ATTEMPTS = 3;
const RESULT_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

const stateFile = (d?: BatchDeps) => d?.file ?? path.join(aiwHome(), "batch", "queue.json");
const now = (d?: BatchDeps) => (d?.now ? d.now() : Date.now());

function load(d?: BatchDeps): QueueState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(d), "utf8"));
    return { calls: s.calls ?? [], batches: s.batches ?? [], results: s.results ?? {} };
  } catch { return { calls: [], batches: [], results: {} }; }
}

function save(s: QueueState, d?: BatchDeps): void {
  const file = stateFile(d);
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
}

/** custom_id must match ^[a-zA-Z0-9_-]{1,64}$ – a readable prefix plus a hash of the key. */
export function customIdFor(key: string): string {
  return `${key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}_${sha256(key).slice(0, 16)}`;
}

let defaultClient: BatchClient | undefined;
function client(d?: BatchDeps): BatchClient {
  if (d?.client) return d.client;
  if (!defaultClient) {
    const apiKey = getSecret("anthropic.apiKey") ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("No model API key is set up, so batch calls cannot run");
    defaultClient = new Anthropic({ apiKey }) as unknown as BatchClient;
  }
  return defaultClient;
}

/** Can calls go through the Batch API here? (needs an API key; a sign-in without a key cannot use batches) */
export function batchAvailable(d?: BatchDeps): boolean {
  return !!d?.client || !!getSecret("anthropic.apiKey") || !!process.env.ANTHROPIC_API_KEY;
}

function params(c: { model: string; system?: string; prompt: string; maxTokens: number }) {
  return {
    model: c.model,
    max_tokens: c.maxTokens,
    ...(c.system ? { system: c.system } : {}),
    messages: [{ role: "user" as const, content: c.prompt }],
  };
}

const textOf = (m: any): string => (m?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");

/** Queue one non-urgent call. Returns false when the key is already queued or already has a result. */
export function queueBatchCall(call: BatchCall, d?: BatchDeps): boolean {
  if (!call.key || !call.model || !call.prompt) throw new Error("A batch call needs a key, a model and a prompt");
  const s = load(d);
  if (s.results[call.key] || s.calls.some((c) => c.key === call.key)) return false;
  const t = now(d);
  s.calls.push({
    key: call.key, model: call.model, system: call.system, prompt: call.prompt, maxTokens: call.maxTokens,
    customId: customIdFor(call.key), queuedAt: new Date(t).toISOString(), deadline: new Date(t + (call.waitMs ?? DEFAULT_WAIT_MS)).toISOString(),
  });
  save(s, d);
  return true;
}

/** Calls still waiting to be sent, and calls sent but not answered yet. */
export function batchQueue(d?: BatchDeps): { waiting: string[]; sent: string[]; results: number; openBatches: number } {
  const s = load(d);
  return {
    waiting: s.calls.filter((c) => !c.batchId).map((c) => c.key),
    sent: s.calls.filter((c) => c.batchId).map((c) => c.key),
    results: Object.keys(s.results).length,
    openBatches: s.batches.filter((b) => b.status !== "ended").length,
  };
}

/** Send every waiting call in one batch (or a few, if very many). Returns the new batch ids. */
export async function flushBatch(d?: BatchDeps): Promise<string[]> {
  const s = load(d);
  const waiting = s.calls.filter((c) => !c.batchId && !c.retryDirect);
  if (!waiting.length) return [];
  const ids: string[] = [];
  for (let i = 0; i < waiting.length; i += MAX_PER_BATCH) {
    const part = waiting.slice(i, i + MAX_PER_BATCH);
    const b = await client(d).messages.batches.create({ requests: part.map((c) => ({ custom_id: c.customId, params: params(c) })) });
    for (const c of part) c.batchId = b.id;
    s.batches.push({ id: b.id, customIds: part.map((c) => c.customId), submittedAt: new Date(now(d)).toISOString(), status: b.processing_status ?? "in_progress" });
    ids.push(b.id);
    save(s, d);                                         // after each batch, so a failure later does not resend it
  }
  log("info", "batch sent", { batches: ids.length, calls: waiting.length });
  return ids;
}

/** Check the open batches; store the answers of ended ones. Returns how many results were stored. */
export async function pollBatches(d?: BatchDeps): Promise<number> {
  const s = load(d);
  let stored = 0;
  for (const b of s.batches.filter((x) => x.status !== "ended")) {
    const r = await client(d).messages.batches.retrieve(b.id);
    b.status = r.processing_status;
    if (r.processing_status !== "ended") continue;
    const byCustom = new Map(s.calls.filter((c) => c.batchId === b.id).map((c) => [c.customId, c]));
    for await (const item of await client(d).messages.batches.results(b.id)) {
      const c = byCustom.get(item.custom_id);
      if (!c) continue;                                 // already answered by the fallback
      byCustom.delete(item.custom_id);
      if (item.result?.type === "succeeded") {
        const m = item.result.message;
        s.results[c.key] = { key: c.key, text: textOf(m), model: m?.model ?? c.model, usage: m?.usage, via: "batch", at: nowIso() };
        s.calls = s.calls.filter((x) => x !== c);
        stored++;
      } else {
        c.retryDirect = true;                           // errored / expired / canceled: run it normally
      }
    }
    for (const c of byCustom.values()) c.retryDirect = true;   // missing from the results file
  }
  // ended batches with nothing left to answer are forgotten
  s.batches = s.batches.filter((b) => b.status !== "ended" || s.calls.some((c) => c.batchId === b.id && !c.retryDirect));
  save(s, d);
  return stored;
}

/**
 * The fallback: every call past its deadline (or whose batch item failed) is run as a normal call, so nothing waits
 * longer than its deadline. A batch answer that arrives later is ignored. Returns how many calls ran.
 */
export async function runOverdue(d?: BatchDeps): Promise<number> {
  const s = load(d);
  const t = now(d);
  const due = s.calls.filter((c) => c.retryDirect || Date.parse(c.deadline) <= t);
  let ran = 0;
  for (const c of due) {
    try {
      const r = d?.direct
        ? await d.direct({ model: c.model, system: c.system, prompt: c.prompt, maxTokens: c.maxTokens })
        : await client(d).messages.create(params(c)).then((m: any) => ({ text: textOf(m), usage: m?.usage }));
      s.results[c.key] = { key: c.key, text: r.text, model: c.model, usage: r.usage, via: "direct", at: nowIso() };
      s.calls = s.calls.filter((x) => x !== c);
      ran++;
    } catch (e: any) {
      c.directAttempts = (c.directAttempts ?? 0) + 1;
      log("warn", "batch fallback call failed", { key: c.key, attempt: c.directAttempts, error: String(e?.message ?? e).slice(0, 200) });
      if (c.directAttempts >= MAX_DIRECT_ATTEMPTS) {
        s.results[c.key] = { key: c.key, text: "", model: c.model, via: "direct", at: nowIso(), error: String(e?.message ?? e).slice(0, 300) };
        s.calls = s.calls.filter((x) => x !== c);
      }
    }
    save(s, d);
  }
  return ran;
}

/** One timer tick: send waiting calls, collect finished batches, run overdue calls normally, drop old results. */
export async function tickBatches(d?: BatchDeps): Promise<{ sent: number; stored: number; ranDirect: number }> {
  let sent = 0, stored = 0;
  try { sent = (await flushBatch(d)).length; } catch (e: any) { log("warn", "batch send failed", { error: String(e?.message ?? e).slice(0, 200) }); }
  try { stored = await pollBatches(d); } catch (e: any) { log("warn", "batch check failed", { error: String(e?.message ?? e).slice(0, 200) }); }
  const ranDirect = await runOverdue(d);
  try { await recordBatchUsage(d); } catch { /* cost recording never breaks the work */ }
  const s = load(d);
  const cutoff = now(d) - RESULT_KEEP_MS;
  let dropped = false;
  for (const [k, r] of Object.entries(s.results)) if (Date.parse(r.at) < cutoff) { delete s.results[k]; dropped = true; }
  if (dropped) save(s, d);
  return { sent, stored, ranDirect };
}

// ------------------------------------------------------------------ which calls may wait (§9.1.6)

/** The only kinds of call that go through the Batch API. Agent loops and anything someone waits for never do. */
export const NON_URGENT_KINDS = ["handbook", "rules_card", "doc_summary", "close_out_learning", "digest_draft", "audit_summary"] as const;
export type NonUrgentKind = typeof NON_URGENT_KINDS[number];

export function isNonUrgent(kind: string): kind is NonUrgentKind {
  return (NON_URGENT_KINDS as readonly string[]).includes(kind);
}

/** Default wait before the fallback runs the call normally, by kind (a digest must still be ready the same morning). */
export const WAIT_BY_KIND: Record<NonUrgentKind, number> = {
  handbook: 6 * 3_600_000, rules_card: 6 * 3_600_000, doc_summary: 8 * 3_600_000,
  close_out_learning: 6 * 3_600_000, digest_draft: 2 * 3_600_000, audit_summary: 4 * 3_600_000,
};

export interface RouteOpts {
  /** settings.models.provider: only "claude" (an API key) can use batches; a sign-in or the mock runs normally */
  provider?: string;
  /** someone is waiting for this answer now */
  urgent?: boolean;
  deps?: BatchDeps;
}

/** "batch" when the call may wait and batches can be used here, else "direct". Pure apart from the key check. */
export function routeFor(kind: string, o: RouteOpts = {}): "batch" | "direct" {
  if (o.urgent || !isNonUrgent(kind)) return "direct";
  if (o.provider && o.provider !== "claude") return "direct";
  return batchAvailable(o.deps) ? "batch" : "direct";
}

/** Batch key with the kind in front, so the cost view can group by it: "close_out_learning:<key>". */
export const kindKey = (kind: NonUrgentKind, key: string): string => `${kind}:${key}`;

/**
 * Queue a non-urgent call with the right deadline for its kind. Returns the full key to read the answer with
 * getResult(), or undefined when the kind may not wait (the caller runs it normally then).
 */
export function queueNonUrgent(kind: string, call: Omit<BatchCall, "key" | "waitMs"> & { key: string; waitMs?: number }, d?: BatchDeps): string | undefined {
  if (!isNonUrgent(kind)) return undefined;
  const key = kindKey(kind, call.key);
  queueBatchCall({ ...call, key, waitMs: call.waitMs ?? WAIT_BY_KIND[kind] }, d);
  return key;
}

/** What one stored answer cost, as a steps-row usage (batch answers are half price; unknown models stay $0). */
export function usageOfResult(r: BatchResult): { model: string; tokensIn: number; tokensOut: number; freshIn: number; cacheRead: number; cacheWrite: number; costUsd: number; error?: string } {
  const u = r.usage;
  const freshIn = Number(u?.input_tokens ?? 0), cacheRead = Number(u?.cache_read_input_tokens ?? 0), cacheWrite = Number(u?.cache_creation_input_tokens ?? 0);
  return { model: r.model, tokensIn: freshIn + cacheRead + cacheWrite, tokensOut: Number(u?.output_tokens ?? 0), freshIn, cacheRead, cacheWrite,
    costUsd: priceUsd(r.model, u, { batch: r.via === "batch" }) ?? 0, ...(r.error ? { error: r.error } : {}) };
}

/**
 * Record every stored answer's usage once (in the steps table as "batch:<kind>", so the cost view shows the batch
 * spend and its saving). `record` defaults to engine/tasks recordUsage. Returns how many were recorded.
 */
export async function recordBatchUsage(d?: BatchDeps, record?: (scope: string, u: ReturnType<typeof usageOfResult>) => void): Promise<number> {
  const s = load(d);
  const todo = Object.values(s.results).filter((r) => !r.recorded && (r.usage || r.error));
  if (!todo.length) return 0;
  let rec: (scope: string, u: ReturnType<typeof usageOfResult>) => void;
  if (record) rec = record;
  else { const m = await import("../engine/tasks.js"); rec = (scope, u) => m.recordUsage(scope, u, { agent: "batch" }); }
  for (const r of todo) {
    const kind = r.key.split(":")[0];
    try { rec(`batch:${isNonUrgent(kind) ? kind : "other"}`, usageOfResult(r)); } catch { /* cost recording never breaks the work */ }
    r.recorded = true;
  }
  save(s, d);
  return todo.length;
}

/** The answer for a key, once there is one. */
export function getResult(key: string, d?: BatchDeps): BatchResult | undefined {
  return load(d).results[key];
}

/** Take the answer and forget it (so the same key can be queued again later). */
export function takeResult(key: string, d?: BatchDeps): BatchResult | undefined {
  const s = load(d);
  const r = s.results[key];
  if (r) { delete s.results[key]; save(s, d); }
  return r;
}
