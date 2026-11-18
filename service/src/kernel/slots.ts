import os from "node:os";
import { getMeta, setMeta } from "../core/db.js";
import { loadProjects, type Settings } from "../core/config.js";
import { tokensToday } from "../engine/budget.js";

/**
 * Dynamic slots (Wave B): how many model-using jobs may run at once right now.
 *
 *   slots = min(cap, budget, rate limit, this computer), at least 1
 *
 *  - cap: limits.maxParallel (8 by default; "use 4 slots" in Teams changes it)
 *  - budget: the projects' daily token budgets – ¾ used → half the cap; 90 % used → 1
 *  - rate limit: a model 429 / overload in the last 10 minutes → half the cap
 *  - this computer: about one slot per 0.4 GB of free memory and per CPU core, never fewer than 2
 *
 * Jobs that call no model (git and GitHub only: rebase checks, close-out, the CI watch) never use a slot.
 */

export const DEFAULT_CAP = 8;
const RATE_KEY = "model.rateLimitedAt";
const RATE_WINDOW_MS = 10 * 60_000;

/** Job types that run git / GitHub work only (a conflict resolution inside a rebase is short and rare). */
export const LIGHT_JOBS: readonly string[] = ["rebase", "close", "ci_watch"];

export interface SlotPlan { slots: number; cap: number; limitedBy?: string; parts: { budget: number; rate: number; machine: number } }

/** Remember a model rate limit (agents/runner.ts calls this on a 429 / overload). */
export function noteRateLimit(at = Date.now()): void { try { setMeta(RATE_KEY, String(at)); } catch { /* best effort */ } }

/** A model error that means "too many requests right now". */
export const RATE_LIMITED = /\b429\b|rate[ _-]?limit|overloaded|too many requests|\b529\b/i;

export function slotPlan(settings: Settings, now = Date.now(), machine = { freeGb: os.freemem() / 2 ** 30, cpus: os.cpus().length }): SlotPlan {
  const cap = Math.max(1, Math.min(16, Number(settings?.limits?.maxParallel) || DEFAULT_CAP));
  // budget: the most-used project decides (one project at its limit should not starve, but should not grow either)
  let budget = cap;
  let budgetWhy = "";
  try {
    for (const p of loadProjects()) {
      const limit = p.budget?.dailyTokens;
      if (!limit) continue;
      const share = tokensToday(p.id) / limit;
      const b = share >= 0.9 ? 1 : share >= 0.75 ? Math.max(1, Math.floor(cap / 2)) : cap;
      if (b < budget) { budget = b; budgetWhy = `${p.id} has used ${Math.round(share * 100)}% of today's budget`; }
    }
  } catch { /* no projects yet */ }
  const last = Number(getMeta(RATE_KEY) ?? 0);
  const rate = last && now - last < RATE_WINDOW_MS ? Math.max(1, Math.ceil(cap / 2)) : cap;
  const fromMachine = Math.max(2, Math.min(Math.floor(machine.freeGb / 0.4), machine.cpus));   // ~0.4 GB per agent process
  const slots = Math.max(1, Math.min(cap, budget, rate, fromMachine));
  let limitedBy: string | undefined;
  if (slots < cap) {
    if (budget === slots) limitedBy = `budget – ${budgetWhy}`;
    else if (rate === slots) limitedBy = "the model asked us to slow down (rate limit) – back to full in 10 minutes";
    else limitedBy = `this computer (${machine.freeGb.toFixed(1)} GB free memory, ${machine.cpus} cores)`;
  }
  return { slots, cap, limitedBy, parts: { budget, rate, machine: fromMachine } };
}
