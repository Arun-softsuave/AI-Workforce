import type { DatabaseSync } from "node:sqlite";
import { db } from "../core/db.js";
import { nowIso, newId } from "../core/util.js";

/**
 * Phase 0.5 (5.30): measure first. A baseline from the recorded `steps` rows, benchmark runs of chosen past tickets
 * (re-run on throwaway local branches, never pushed, no Teams or Jira writes) stored in `benchmarks`, and a
 * comparison between two runs so every later change can prove it kept or improved cost and accuracy.
 */

// ------------------------------------------------------------------ baseline from the steps table

export interface UsageGroup {
  key: string;            // step name or agent
  runs: number;
  tokensIn: number;       // total input as recorded (fresh + cache mixed in older rows)
  freshIn: number;        // only rows where the split was recorded
  cacheRead: number;
  cacheWrite: number;
  splitRuns: number;      // how many runs have the fresh / cache split filled
  tokensOut: number;
  cost: number;
  avgIn: number;
  avgOut: number;
  avgCost: number;
}

export interface CostlyStep { stepId: number; name: string; agent: string | null; ticket: string; taskId: string; tokensIn: number; tokensOut: number; cost: number }

export interface BaselineReport {
  totals: { runs: number; tokensIn: number; tokensOut: number; cost: number };
  byStep: UsageGroup[];
  byAgent: UsageGroup[];
  top: CostlyStep[];
}

interface Row { id: number; task_id: string; name: string; agent: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null;
  fresh_in: number | null; cache_read: number | null; cache_write: number | null; source_ref: string | null; ticket_key: string | null }

function group(rows: Row[], keyOf: (r: Row) => string): UsageGroup[] {
  const m = new Map<string, UsageGroup>();
  for (const r of rows) {
    const key = keyOf(r);
    const g = m.get(key) ?? { key, runs: 0, tokensIn: 0, freshIn: 0, cacheRead: 0, cacheWrite: 0, splitRuns: 0, tokensOut: 0, cost: 0, avgIn: 0, avgOut: 0, avgCost: 0 };
    g.runs++;
    g.tokensIn += r.tokens_in ?? 0;
    g.tokensOut += r.tokens_out ?? 0;
    g.cost += r.cost_usd ?? 0;
    const f = r.fresh_in ?? 0, cr = r.cache_read ?? 0, cw = r.cache_write ?? 0;
    if (f || cr || cw) { g.splitRuns++; g.freshIn += f; g.cacheRead += cr; g.cacheWrite += cw; }
    m.set(key, g);
  }
  const out = [...m.values()];
  for (const g of out) { g.avgIn = Math.round(g.tokensIn / g.runs); g.avgOut = Math.round(g.tokensOut / g.runs); g.avgCost = g.cost / g.runs; }
  return out.sort((a, b) => b.cost - a.cost || b.tokensIn - a.tokensIn);
}

const ticketOf = (r: Row): string => r.ticket_key || (r.source_ref ?? "").split("@")[0] || r.task_id;

/** Cost and token use by step name and by agent, plus the 10 costliest single steps with their ticket. */
export function baselineReport(d: DatabaseSync = db(), opts: { since?: string; limit?: number } = {}): BaselineReport {
  const since = opts.since ?? null;
  const rows = d.prepare(`SELECT s.id, s.task_id, s.name, s.agent, s.tokens_in, s.tokens_out, s.cost_usd, s.fresh_in, s.cache_read, s.cache_write,
      t.source_ref, json_extract(t.data, '$.ticket.key') AS ticket_key
    FROM steps s LEFT JOIN tasks t ON t.id = s.task_id
    WHERE (s.tokens_in > 0 OR s.tokens_out > 0 OR s.cost_usd > 0) AND (? IS NULL OR s.started_at >= ?)`)
    .all(since, since) as unknown as Row[];
  const top = [...rows]
    .sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0) || (b.tokens_in ?? 0) - (a.tokens_in ?? 0))
    .slice(0, opts.limit ?? 10)
    .map((r) => ({ stepId: r.id, name: r.name, agent: r.agent, ticket: ticketOf(r), taskId: r.task_id, tokensIn: r.tokens_in ?? 0, tokensOut: r.tokens_out ?? 0, cost: r.cost_usd ?? 0 }));
  return {
    totals: {
      runs: rows.length,
      tokensIn: rows.reduce((s, r) => s + (r.tokens_in ?? 0), 0),
      tokensOut: rows.reduce((s, r) => s + (r.tokens_out ?? 0), 0),
      cost: rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
    },
    byStep: group(rows, (r) => r.name),
    byAgent: group(rows, (r) => r.agent || "(none)"),
    top,
  };
}

// ------------------------------------------------------------------ text rendering

/** 1234567 -> "1.2M", 45200 -> "45k". */
export function fmtTokens(n: number): string {
  const a = Math.abs(n), sign = n < 0 ? "-" : "";
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}${Math.round(a / 1_000)}k`;
  return `${sign}${a}`;
}
export const fmtUsd = (n: number): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

function table(head: string[], rows: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

function groupTable(title: string, first: string, gs: UsageGroup[]): string {
  const rows = gs.map((g) => [
    g.key, String(g.runs), fmtTokens(g.tokensIn),
    g.splitRuns ? `${fmtTokens(g.freshIn)}/${fmtTokens(g.cacheRead)}/${fmtTokens(g.cacheWrite)}` : "-",
    fmtTokens(g.tokensOut), fmtUsd(g.cost), fmtTokens(g.avgIn), fmtUsd(g.avgCost),
  ]);
  return `${title}\n${table([first, "Runs", "In", "Fresh/cache read/write", "Out", "Cost", "Avg in", "Avg cost"], rows)}`;
}

/** Short plain-text tables for the terminal or a Teams "details" reply. */
export function renderBaseline(r: BaselineReport): string {
  if (!r.totals.runs) return "No recorded steps yet, so there is no baseline.";
  return [
    `Baseline: ${r.totals.runs} step runs, ${fmtTokens(r.totals.tokensIn)} in, ${fmtTokens(r.totals.tokensOut)} out, ${fmtUsd(r.totals.cost)}.`,
    groupTable("By step", "Step", r.byStep),
    groupTable("By agent", "Agent", r.byAgent),
    `Costliest steps\n${table(["Step", "Ticket", "In", "Out", "Cost"], r.top.map((t) => [t.name, t.ticket, fmtTokens(t.tokensIn), fmtTokens(t.tokensOut), fmtUsd(t.cost)]))}`,
  ].join("\n\n");
}

// ------------------------------------------------------------------ benchmark rows

export interface BenchRow {
  runId: string;
  ticket: string;
  version: string;
  freshIn?: number | null;
  cacheRead?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  questions?: number | null;
  reviewRounds?: number | null;
  ciFirstGreen?: boolean | number | null;
  prAcceptedUnchanged?: boolean | number | null;
  notes?: string | null;
  createdAt?: string;
}

const b2i = (v: boolean | number | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);

/** Insert or replace one ticket result of a benchmark run. */
export function recordBenchmark(row: BenchRow, d: DatabaseSync = db()): void {
  d.prepare(`INSERT OR REPLACE INTO benchmarks (run_id, ticket, version, fresh_in, cache_read, tokens_out, cost_usd, questions, review_rounds,
      ci_first_green, pr_accepted_unchanged, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.runId, row.ticket, row.version, row.freshIn ?? null, row.cacheRead ?? null, row.tokensOut ?? null, row.costUsd ?? null,
      row.questions ?? null, row.reviewRounds ?? null, b2i(row.ciFirstGreen), b2i(row.prAcceptedUnchanged), row.notes ?? null, row.createdAt ?? nowIso());
}

/** Your once-per-ticket mark: would the PR be accepted unchanged. */
export function markAccepted(runId: string, ticket: string, accepted: boolean, d: DatabaseSync = db()): boolean {
  return Number(d.prepare("UPDATE benchmarks SET pr_accepted_unchanged=? WHERE run_id=? AND ticket=?").run(accepted ? 1 : 0, runId, ticket).changes) > 0;
}

interface DbBench { run_id: string; ticket: string; version: string; fresh_in: number | null; cache_read: number | null; tokens_out: number | null; cost_usd: number | null;
  questions: number | null; review_rounds: number | null; ci_first_green: number | null; pr_accepted_unchanged: number | null; notes: string | null; created_at: string }

export function benchmarkRows(runId: string, d: DatabaseSync = db()): BenchRow[] {
  return (d.prepare("SELECT * FROM benchmarks WHERE run_id=? ORDER BY ticket").all(runId) as unknown as DbBench[]).map((r) => ({
    runId: r.run_id, ticket: r.ticket, version: r.version, freshIn: r.fresh_in, cacheRead: r.cache_read, tokensOut: r.tokens_out, costUsd: r.cost_usd,
    questions: r.questions, reviewRounds: r.review_rounds, ciFirstGreen: r.ci_first_green, prAcceptedUnchanged: r.pr_accepted_unchanged, notes: r.notes, createdAt: r.created_at,
  }));
}

/** Benchmark runs, newest first. */
export function listBenchmarkRuns(d: DatabaseSync = db()): { runId: string; version: string; tickets: number; cost: number; createdAt: string }[] {
  return (d.prepare(`SELECT run_id, MAX(version) AS version, COUNT(*) AS tickets, COALESCE(SUM(cost_usd),0) AS cost, MIN(created_at) AS created_at
      FROM benchmarks GROUP BY run_id ORDER BY created_at DESC`).all() as any[])
    .map((r) => ({ runId: r.run_id, version: r.version, tickets: Number(r.tickets), cost: Number(r.cost), createdAt: r.created_at }));
}

// ------------------------------------------------------------------ compare two runs

export const METRICS = ["costUsd", "freshIn", "cacheRead", "tokensOut", "questions", "reviewRounds", "ciFirstGreen", "prAcceptedUnchanged"] as const;
export type Metric = typeof METRICS[number];
/** Lower is better for these; higher is better for the rest. */
const LOWER_BETTER: ReadonlySet<Metric> = new Set<Metric>(["costUsd", "freshIn", "cacheRead", "tokensOut", "questions", "reviewRounds"]);

export type Deltas = Record<Metric, number | null>;
export interface TicketDelta { ticket: string; a?: BenchRow; b?: BenchRow; delta: Deltas; worse: Metric[] }
export interface RunComparison { runA: string; runB: string; tickets: TicketDelta[]; totalA: Deltas; totalB: Deltas; total: Deltas; worse: Metric[] }

const val = (r: BenchRow | undefined, m: Metric): number | null => {
  const v = r?.[m];
  return v === null || v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v;
};

function worseOf(d: Deltas): Metric[] {
  return METRICS.filter((m) => d[m] !== null && Math.abs(d[m]!) > 1e-9 && (LOWER_BETTER.has(m) ? d[m]! > 0 : d[m]! < 0));
}

/** Per ticket and total deltas (B minus A) for cost and accuracy fields. Totals use only tickets where both runs have the value. */
export function compareRuns(runA: string, runB: string, d: DatabaseSync = db()): RunComparison {
  const A = new Map(benchmarkRows(runA, d).map((r) => [r.ticket, r]));
  const B = new Map(benchmarkRows(runB, d).map((r) => [r.ticket, r]));
  const tickets = [...new Set([...A.keys(), ...B.keys()])].sort();
  const empty = (): Deltas => Object.fromEntries(METRICS.map((m) => [m, null])) as Deltas;
  const totalA = empty(), totalB = empty();
  const out: TicketDelta[] = tickets.map((t) => {
    const a = A.get(t), b = B.get(t);
    const delta = empty();
    for (const m of METRICS) {
      const va = val(a, m), vb = val(b, m);
      if (va !== null && vb !== null) {
        delta[m] = vb - va;
        totalA[m] = (totalA[m] ?? 0) + va;
        totalB[m] = (totalB[m] ?? 0) + vb;
      }
    }
    return { ticket: t, a, b, delta, worse: worseOf(delta) };
  });
  const total = empty();
  for (const m of METRICS) if (totalA[m] !== null && totalB[m] !== null) total[m] = totalB[m]! - totalA[m]!;
  return { runA, runB, tickets: out, totalA, totalB, total, worse: worseOf(total) };
}

const LABEL: Record<Metric, string> = { costUsd: "Cost", freshIn: "Fresh input", cacheRead: "Cache read", tokensOut: "Output", questions: "Questions",
  reviewRounds: "Review rounds", ciFirstGreen: "Checks green first time", prAcceptedUnchanged: "PR accepted unchanged" };

function fmtDelta(m: Metric, v: number | null): string {
  if (v === null) return "-";
  if (m === "costUsd") return v >= 0 ? `+${fmtUsd(v)}` : fmtUsd(v);
  const s = v > 0 ? "+" : "";
  if (m === "freshIn" || m === "cacheRead" || m === "tokensOut") return s + fmtTokens(v);
  return s + String(v);
}

export function renderComparison(c: RunComparison): string {
  const head = ["Ticket", "Cost", "Fresh in", "Out", "Questions", "Reviews", "Green 1st", "Accepted"];
  const cols: Metric[] = ["costUsd", "freshIn", "tokensOut", "questions", "reviewRounds", "ciFirstGreen", "prAcceptedUnchanged"];
  const rows = c.tickets.map((t) => [t.ticket + (!t.a ? " (new)" : !t.b ? " (missing)" : ""), ...cols.map((m) => fmtDelta(m, t.delta[m]))]);
  rows.push(["Total", ...cols.map((m) => fmtDelta(m, c.total[m]))]);
  const verdict = c.worse.length ? `Worse than ${c.runA} on: ${c.worse.map((m) => LABEL[m].toLowerCase()).join(", ")}.` : `At least as good as ${c.runA}.`;
  return `${c.runB} compared with ${c.runA}\n${table(head, rows)}\n${verdict}`;
}

// ------------------------------------------------------------------ plan and run

export interface BenchPlan { tickets: string[]; rules: string[]; text: string }

/** What a benchmark run will do, shown before it starts. */
export function benchmarkPlan(tickets: string[]): BenchPlan {
  const rules = [
    "Each ticket runs on a new local branch that is thrown away afterwards.",
    "Nothing is pushed and no pull request is opened.",
    "Nothing is posted to Teams and nothing is changed in Jira.",
    "Cost (fresh input, cache read, output, dollars) and accuracy (questions, review rounds, checks green first time, PR accepted unchanged) are recorded.",
  ];
  const text = tickets.length
    ? [`Benchmark of ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}: ${tickets.join(", ")}.`, ...rules.map((r) => `- ${r}`)].join("\n")
    : "No tickets chosen for the benchmark.";
  return { tickets: [...tickets], rules, text };
}

/** What one isolated ticket run returns. Accuracy fields may be left out and marked later. */
export interface IsolatedResult {
  freshIn?: number; cacheRead?: number; tokensOut?: number; costUsd?: number;
  questions?: number; reviewRounds?: number; ciFirstGreen?: boolean; prAcceptedUnchanged?: boolean; notes?: string;
}

export interface BenchDeps {
  /** Runs one ticket on a throwaway local branch: never pushed, no Teams or Jira writes. */
  runTicketIsolated: (ticket: string) => Promise<IsolatedResult>;
  version: string;
  runId?: string;
  db?: DatabaseSync;
  onProgress?: (line: string) => void;
}

export interface BenchRunResult { runId: string; version: string; ok: string[]; failed: { ticket: string; error: string }[]; rows: BenchRow[] }

/** Runs the tickets one after another and records each result; a failed ticket is recorded with a note and does not stop the run. */
export async function runBenchmark(tickets: string[], deps: BenchDeps): Promise<BenchRunResult> {
  const d = deps.db ?? db();
  const runId = deps.runId ?? newId("bench");
  const res: BenchRunResult = { runId, version: deps.version, ok: [], failed: [], rows: [] };
  for (const ticket of tickets) {
    deps.onProgress?.(`Running ${ticket}`);
    let row: BenchRow;
    try {
      const r = await deps.runTicketIsolated(ticket);
      row = { runId, ticket, version: deps.version, ...r, notes: r.notes ?? null };
      res.ok.push(ticket);
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      row = { runId, ticket, version: deps.version, notes: `failed: ${error.slice(0, 300)}` };
      res.failed.push({ ticket, error });
    }
    recordBenchmark(row, d);
    res.rows.push(row);
  }
  deps.onProgress?.(`Done: ${res.ok.length} ran, ${res.failed.length} failed.`);
  return res;
}
