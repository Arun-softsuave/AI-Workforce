import fs from "node:fs";
import path from "node:path";
import type { Tier } from "../core/config.js";
import type { Effort } from "../agents/catalog.js";
import { aiwHome, ensureDir } from "../core/paths.js";
import { audit } from "../core/db.js";
import { nowIso } from "../core/util.js";
import { acceptSaving, type AccuracySummary, type SavingVerdict } from "./benchmark.js";

/**
 * Per-step model / effort overrides that only the quality gate can promote (§9.1.1, §9.1.8, Phase 8 "Move more calls
 * to Haiku only where the replay or eval accuracy is unchanged").
 *
 * An override starts as a "trial" (used only when a benchmark or replay asks for trial settings). After the trial
 * the gate compares accuracy before and after: it becomes "kept" (used by every call) or "rejected". Your own
 * settings.cost.effort still wins over the table. Stored as one JSON file under <AIW_HOME>/cost/overrides.json.
 */

export interface OverrideChange { tier?: Tier; effort?: Effort }

export interface CostOverride extends OverrideChange {
  /** agent name ("chat-summary", "reviewer:security") or step name */
  key: string;
  status: "trial" | "kept" | "rejected";
  reason?: string;
  verdict?: SavingVerdict;
  createdAt: string;
  decidedAt?: string;
}

/** The calls §9.1.8 names as Haiku candidates (each moves only through the gate). */
export const SMALL_TIER_CANDIDATES: { key: string; what: string }[] = [
  { key: "memory-keeper", what: "distilling lessons" },
  { key: "ci-classifier", what: "CI log classification" },
  { key: "comment-classifier", what: "review comment classification" },
  { key: "file-classifier", what: "file classification" },
  { key: "chat-summary", what: "activity summaries" },
  { key: "conductor", what: "simple Conductor turns" },
];

const file = (f?: string) => f ?? path.join(aiwHome(), "cost", "overrides.json");

export function listOverrides(f?: string): CostOverride[] {
  try { const v = JSON.parse(fs.readFileSync(file(f), "utf8")); return Array.isArray(v) ? v : []; } catch { return []; }
}

function save(list: CostOverride[], f?: string): void {
  const p = file(f);
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, p);
}

/** Start a trial of a cheaper setting for one agent or step. Replaces an earlier entry for the same key. */
export function proposeOverride(key: string, change: OverrideChange, opts: { reason?: string; file?: string } = {}): CostOverride {
  if (!key || (!change.tier && !change.effort)) throw new Error("An override needs a key and a tier or an effort");
  const list = listOverrides(opts.file).filter((o) => o.key !== key);
  const o: CostOverride = { key, ...change, status: "trial", reason: opts.reason, createdAt: nowIso() };
  list.push(o);
  save(list, opts.file);
  return o;
}

/** The gate decides a trial: kept only if it is cheaper and no accuracy field is lower. */
export function decideOverride(key: string, before: AccuracySummary, after: AccuracySummary, opts: { file?: string } = {}): CostOverride | undefined {
  const list = listOverrides(opts.file);
  const o = list.find((x) => x.key === key);
  if (!o) return undefined;
  const v = acceptSaving(before, after);
  o.status = v.keep ? "kept" : "rejected";
  o.verdict = v;
  o.decidedAt = nowIso();
  save(list, opts.file);
  try { audit("service", "cost.override", key, { status: o.status, tier: o.tier, effort: o.effort, text: v.text }); } catch { /* no db */ }
  return o;
}

/** Drop an override (back to the catalog's tier and effort). */
export function removeOverride(key: string, opts: { file?: string } = {}): boolean {
  const list = listOverrides(opts.file);
  const left = list.filter((o) => o.key !== key);
  if (left.length === list.length) return false;
  save(left, opts.file);
  return true;
}

/**
 * The override for one call: an exact key first ("reviewer:security"), then the base agent ("reviewer").
 * Only "kept" entries apply, plus "trial" entries when `trial` is set (benchmark / replay runs).
 */
export function overrideFor(agentOrStep: string, opts: { trial?: boolean; file?: string; list?: CostOverride[] } = {}): OverrideChange {
  const list = opts.list ?? listOverrides(opts.file);
  const ok = (o: CostOverride) => o.status === "kept" || (opts.trial && o.status === "trial");
  const o = list.find((x) => x.key === agentOrStep && ok(x)) ?? list.find((x) => x.key === agentOrStep.split(":")[0] && ok(x));
  return o ? { ...(o.tier ? { tier: o.tier } : {}), ...(o.effort ? { effort: o.effort } : {}) } : {};
}

/** The tier and effort one call should use: your settings.cost.effort first, then a kept override, then the defaults. */
export function applyOverride(agent: string, base: { tier: Tier; effort?: Effort }, opts: { userEffort?: Record<string, Effort>; trial?: boolean; file?: string; list?: CostOverride[] } = {}): { tier: Tier; effort?: Effort } {
  const o = overrideFor(agent, opts);
  const user = opts.userEffort?.[agent] ?? opts.userEffort?.[agent.split(":")[0]];
  return { tier: o.tier ?? base.tier, effort: user ?? o.effort ?? base.effort };
}

/** One line per override for `aiw cost` / the dashboard. */
export function renderOverrides(list = listOverrides()): string {
  if (!list.length) return "No model or effort changes are being tried.";
  return list.map((o) => {
    const what = [o.tier ? `${o.tier} model` : "", o.effort ? `${o.effort} effort` : ""].filter(Boolean).join(", ");
    const st = o.status === "trial" ? "on trial" : o.status === "kept" ? "kept" : "not kept";
    return `- ${o.key}: ${what} – ${st}${o.verdict ? `. ${o.verdict.text}` : ""}`;
  }).join("\n");
}
