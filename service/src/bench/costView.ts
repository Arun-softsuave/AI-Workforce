import type { DatabaseSync } from "node:sqlite";
import { db } from "../core/db.js";
import { fmtTokens, fmtUsd } from "./benchmark.js";

/**
 * The cost view (Phase 8, W19 "Cost" section, `aiw cost`): tokens and dollars by day, ticket, agent and recipe,
 * fresh input against cache reads, the cache-hit rate, and a zero-cache alert per recipe (§9.1.7: a recipe whose calls
 * never read the prompt cache has a changing prefix). Read-only; plain SQL over the `steps` table, no model calls.
 */

// ------------------------------------------------------------------ prices (only for calls that report no cost, e.g. batch answers)

/** USD per million tokens. Only models whose price is written in the plan (§9.1.8); others are left unpriced. */
export const PRICES: { match: RegExp; inUsd: number; outUsd: number }[] = [
  { match: /haiku/i, inUsd: 0.10, outUsd: 0.50 },
  { match: /sonnet/i, inUsd: 2, outUsd: 10 },
];
/** Cache reads cost a tenth of fresh input, cache writes a quarter more (Anthropic prompt-cache pricing). */
const CACHE_READ_FACTOR = 0.1, CACHE_WRITE_FACTOR = 1.25;
/** The Batch API is half price (§9.1.6). */
export const BATCH_DISCOUNT = 0.5;

export interface UsageNumbers { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** Dollar cost of one call, or undefined when the model's price is unknown. */
export function priceUsd(model: string, u: UsageNumbers | undefined, opts: { batch?: boolean } = {}): number | undefined {
  const p = PRICES.find((x) => x.match.test(model ?? ""));
  if (!p || !u) return undefined;
  const fresh = Number(u.input_tokens ?? 0), cr = Number(u.cache_read_input_tokens ?? 0), cw = Number(u.cache_creation_input_tokens ?? 0), out = Number(u.output_tokens ?? 0);
  const usd = ((fresh + cr * CACHE_READ_FACTOR + cw * CACHE_WRITE_FACTOR) * p.inUsd + out * p.outUsd) / 1_000_000;
  return opts.batch ? usd * BATCH_DISCOUNT : usd;
}

// ------------------------------------------------------------------ the view

export interface CostGroup {
  key: string;
  calls: number;
  tokensIn: number;
  freshIn: number;
  cacheRead: number;
  cacheWrite: number;
  tokensOut: number;
  cost: number;
  /** cacheRead / (fresh + cacheRead + cacheWrite) on the calls that recorded the split; null when none did */
  cacheHitRate: number | null;
  /** average seconds per call (speed view); null when no call has an end time */
  avgSeconds: number | null;
}

export interface CacheAlert { recipe: string; calls: number; freshIn: number; text: string }

export interface CostView {
  days: number;
  since: string;
  totals: CostGroup;
  byDay: CostGroup[];
  byTicket: CostGroup[];
  byAgent: CostGroup[];
  byRecipe: CostGroup[];
  alerts: CacheAlert[];
}

interface Row { task_id: string; name: string; agent: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null;
  fresh_in: number | null; cache_read: number | null; cache_write: number | null; started_at: string | null; ended_at: string | null;
  source_ref: string | null; ticket_key: string | null; recipe: string | null; playbook: string | null }

/** "KAN-45@repo-a" → "KAN-45"; calls outside a task ("system:rules-card:p1") → "(background)". */
export function ticketLabel(r: Pick<Row, "task_id" | "source_ref" | "ticket_key">): string {
  if (r.task_id.startsWith("system:")) return "(background)";
  return r.ticket_key || (r.source_ref ?? "").split("@")[0] || r.task_id;
}

/** The recipe a call belonged to: the job's recipe, else the task's playbook, else the background scope ("batch", "rules-card"). */
export function recipeLabel(r: Pick<Row, "task_id" | "name" | "recipe" | "playbook">): string {
  if (r.recipe) return r.recipe;
  if (r.playbook) return r.playbook;
  if (r.task_id.startsWith("system:")) return r.name.split(":")[0] || "(background)";
  return "(none)";
}

function emptyGroup(key: string): CostGroup {
  return { key, calls: 0, tokensIn: 0, freshIn: 0, cacheRead: 0, cacheWrite: 0, tokensOut: 0, cost: 0, cacheHitRate: null, avgSeconds: null };
}

function groupBy(rows: Row[], keyOf: (r: Row) => string): CostGroup[] {
  const m = new Map<string, { g: CostGroup; splitIn: number; secs: number; timed: number }>();
  for (const r of rows) {
    const key = keyOf(r);
    const e = m.get(key) ?? { g: emptyGroup(key), splitIn: 0, secs: 0, timed: 0 };
    add(e, r);
    m.set(key, e);
  }
  return [...m.values()].map(finish).sort((a, b) => b.cost - a.cost || b.tokensIn - a.tokensIn || a.key.localeCompare(b.key));
}

function add(e: { g: CostGroup; splitIn: number; secs: number; timed: number }, r: Row): void {
  const g = e.g;
  g.calls++;
  g.tokensIn += r.tokens_in ?? 0;
  g.tokensOut += r.tokens_out ?? 0;
  g.cost += r.cost_usd ?? 0;
  const f = r.fresh_in ?? 0, cr = r.cache_read ?? 0, cw = r.cache_write ?? 0;
  if (f || cr || cw) { g.freshIn += f; g.cacheRead += cr; g.cacheWrite += cw; e.splitIn += f + cr + cw; }
  if (r.started_at && r.ended_at) {
    const s = (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000;
    if (Number.isFinite(s) && s >= 0) { e.secs += s; e.timed++; }
  }
}

function finish(e: { g: CostGroup; splitIn: number; secs: number; timed: number }): CostGroup {
  e.g.cacheHitRate = e.splitIn > 0 ? e.g.cacheRead / e.splitIn : null;
  e.g.avgSeconds = e.timed ? Math.round(e.secs / e.timed) : null;
  e.g.cost = Math.round(e.g.cost * 10_000) / 10_000;
  return e.g;
}

export interface CostViewOpts { days?: number; now?: number; projectId?: string; ticketLimit?: number;
  /** a recipe needs at least this many calls with the split recorded before its zero cache reads raise an alert */
  alertMinCalls?: number }

/** Tokens and dollars by day, ticket, agent and recipe for the last `days` days (default 7). */
export function costView(opts: CostViewOpts = {}, d: DatabaseSync = db()): CostView {
  const days = opts.days ?? 7;
  const until = opts.now ?? Date.now();
  const since = new Date(until - days * 86_400_000).toISOString();
  const rows = d.prepare(`SELECT s.task_id, s.name, s.agent, s.tokens_in, s.tokens_out, s.cost_usd, s.fresh_in, s.cache_read, s.cache_write, s.started_at, s.ended_at,
      t.source_ref, t.playbook, json_extract(t.data, '$.ticket.key') AS ticket_key, j.recipe
    FROM steps s LEFT JOIN tasks t ON t.id = s.task_id LEFT JOIN jobs j ON j.id = s.job_id
    WHERE (s.tokens_in > 0 OR s.tokens_out > 0 OR s.cost_usd > 0) AND s.started_at >= ? AND s.started_at <= ? AND (? IS NULL OR t.project_id = ?)`)
    .all(since, new Date(until + 60_000).toISOString(), opts.projectId ?? null, opts.projectId ?? null) as unknown as Row[];
  const all = groupBy(rows, () => "total")[0] ?? emptyGroup("total");
  const byRecipe = groupBy(rows, recipeLabel);
  return {
    days, since,
    totals: all,
    byDay: groupBy(rows, (r) => (r.started_at ?? "").slice(0, 10)).sort((a, b) => b.key.localeCompare(a.key)),
    byTicket: groupBy(rows, ticketLabel).slice(0, opts.ticketLimit ?? 20),
    byAgent: groupBy(rows, (r) => r.agent || "(none)"),
    byRecipe,
    alerts: zeroCacheAlerts(rows, opts.alertMinCalls ?? 3),
  };
}

/** §9.1.7: a recipe whose recorded calls read nothing from the prompt cache. */
function zeroCacheAlerts(rows: Row[], minCalls: number): CacheAlert[] {
  const m = new Map<string, { calls: number; fresh: number; read: number }>();
  for (const r of rows) {
    const f = r.fresh_in ?? 0, cr = r.cache_read ?? 0, cw = r.cache_write ?? 0;
    if (!(f || cr || cw)) continue;                     // split not recorded: says nothing about the cache
    const k = recipeLabel(r);
    const e = m.get(k) ?? { calls: 0, fresh: 0, read: 0 };
    e.calls++; e.fresh += f; e.read += cr;
    m.set(k, e);
  }
  return [...m.entries()]
    .filter(([, e]) => e.calls >= minCalls && e.read === 0 && e.fresh > 0)
    .map(([recipe, e]) => ({ recipe, calls: e.calls, freshIn: e.fresh,
      text: `No cache reads in "${recipe}" over ${e.calls} calls (${fmtTokens(e.fresh)} fresh input). Its prompt start may be changing.` }))
    .sort((a, b) => b.freshIn - a.freshIn);
}

// ------------------------------------------------------------------ text (aiw cost, Teams "details")

const pct = (r: number | null): string => (r === null ? "-" : `${Math.round(r * 100)}%`);

function table(head: string[], rows: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

function groupTable(title: string, first: string, gs: CostGroup[], limit = 10): string {
  const rows = gs.slice(0, limit).map((g) => [g.key, String(g.calls), fmtTokens(g.freshIn), fmtTokens(g.cacheRead), fmtTokens(g.tokensOut), fmtUsd(g.cost), pct(g.cacheHitRate)]);
  return `${title}\n${table([first, "Calls", "Fresh in", "Cache read", "Out", "Cost", "Cache hit"], rows)}`;
}

/** Short plain-text tables. */
export function renderCostView(v: CostView): string {
  if (!v.totals.calls) return `No AI calls in the last ${v.days} days.`;
  const t = v.totals;
  return [
    `Last ${v.days} days: ${t.calls} calls, ${fmtUsd(t.cost)}. Fresh input ${fmtTokens(t.freshIn)}, cache read ${fmtTokens(t.cacheRead)}, output ${fmtTokens(t.tokensOut)}. Cache hit ${pct(t.cacheHitRate)}.`,
    ...v.alerts.map((a) => `⚠️ ${a.text}`),
    groupTable("By day", "Day", v.byDay, v.days),
    groupTable("By ticket", "Ticket", v.byTicket),
    groupTable("By agent", "Agent", v.byAgent),
    groupTable("By recipe", "Recipe", v.byRecipe),
  ].join("\n\n");
}
