/**
 * Connector gate (W3, IMPLEMENTATION-PLAN 5.18): which connector an item's next work needs, and whether that connector
 * is down right now. Kept light (database + recipes only) so the scheduler can import it without pulling in the
 * connectors or the notification router. intake/health.ts writes `connector_health`; this file only reads it.
 *
 * Rule from the plan: "Jobs that need it go BLOCKED; everything else runs." So a GitHub outage holds a CI fix or a
 * publish, but a build that is still planning or coding keeps going. Teams never holds work (questions wait anyway).
 */
import { db } from "../core/db.js";
import { safeJson } from "../core/util.js";
import { getRecipe } from "../kernel/recipes.js";
import type { Job, JobType } from "../kernel/types.js";

/** What the health loop checks. "teams" is whichever Teams client is in use; "model" is model access. */
export const HEALTH_PROVIDERS = ["jira", "github", "figma", "teams", "model"] as const;
export type HealthProvider = (typeof HEALTH_PROVIDERS)[number];

/** up = last check fine; down = disconnected / sign-in expired / unreachable; limited = rate limited (L4); off = not set up. */
export type HealthState = "up" | "down" | "limited" | "off";

export const PROVIDER_LABEL: Record<HealthProvider, string> = { jira: "Jira", github: "GitHub", figma: "Figma", teams: "Teams", model: "Model access" };

export interface HealthRow { provider: string; state: HealthState; since: string; last_ok: string | null; last_alert: string | null; detail: string | null }

/** Job types that work on a pull request (all need GitHub). */
const GITHUB_JOBS: readonly JobType[] = ["ci_fix", "comment_fix", "review", "qa", "rebase", "close", "adopt", "audit", "ci_watch"];
/** Job types that never call the model. */
const NO_MODEL_JOBS: readonly JobType[] = ["ci_watch", "close"];
/** Recipe steps that call a connector directly. */
const STEP_NEEDS: Record<string, HealthProvider[]> = {
  prepare_workspace: ["github"],      // fetch of the base branch
  publish: ["github"],
  publish_parts: ["github"],
  ci_logs: ["github"],
  pm_collect: ["jira"],
  design_fetch: ["figma"],
};
/** Steps that read a linked Figma design when the ticket has one. */
const FIGMA_LINK_STEPS = new Set(["context_pack", "analyse", "understand", "plan", "design_fetch"]);
/** Steps that run without the model. */
const NO_MODEL_STEPS = new Set(["prepare_workspace", "plan_gate", "request_approval", "publish", "publish_parts", "part_ready", "ci_logs"]);

/** The fields of an item the gate reads (an Item satisfies it; the scheduler's SchedItem with data too). */
export interface GateItem { id: string; state: string; source?: string | null; title?: string | null; data?: any }

/** The recipe step a job runs next, or undefined (unknown recipe or past the end). */
export function nextStepName(job: Pick<Job, "recipe" | "step_index">): string | undefined {
  try { return getRecipe(job.recipe).steps[job.step_index]?.name; } catch { return undefined; }
}

const FIGMA_LINK = /figma\.com\/(?:design|file|proto)\//i;
function hasFigmaLink(item: GateItem): boolean {
  const data = typeof item.data === "string" ? item.data : JSON.stringify(item.data ?? {});
  return FIGMA_LINK.test(`${item.title ?? ""} ${data}`);
}

/** The connectors an item's next piece of work needs (job given: that job's next step; no job: from the item's state). */
export function needsOf(item: GateItem, job?: Pick<Job, "type" | "recipe" | "step_index">): Set<HealthProvider> {
  const out = new Set<HealthProvider>();
  if (!job) {
    if (["PR_OPEN", "PUBLISHING", "FAILED_PUBLISH"].includes(item.state)) out.add("github");
    if (["DETECTED", "TRIAGED", "QUEUED", "RUNNING", "PLANNING"].includes(item.state)) out.add("model");
    return out;
  }
  const step = nextStepName(job);
  if (GITHUB_JOBS.includes(job.type)) out.add("github");
  for (const p of (step && STEP_NEEDS[step]) || []) out.add(p);
  if (step && FIGMA_LINK_STEPS.has(step) && hasFigmaLink(item)) out.add("figma");
  if (!NO_MODEL_JOBS.includes(job.type) && !(step && NO_MODEL_STEPS.has(step))) out.add("model");
  return out;
}

/** Connectors that are down or rate limited now (one small query). */
export function unavailableConnectors(): Map<HealthProvider, HealthRow> {
  const rows = db().prepare("SELECT * FROM connector_health WHERE state IN ('down','limited')").all() as unknown as HealthRow[];
  return new Map(rows.filter((r) => (HEALTH_PROVIDERS as readonly string[]).includes(r.provider)).map((r) => [r.provider as HealthProvider, r]));
}

export interface ConnectorBlock { provider: HealthProvider; state: "down" | "limited"; reason: string }

/** Plain reason for a held job: "GitHub disconnected" / "GitHub rate limited". */
export function blockReason(p: HealthProvider, state: "down" | "limited"): string {
  return `${PROVIDER_LABEL[p]} ${state === "limited" ? "rate limited" : "disconnected"}`;
}

/**
 * The first down connector this item's next work needs, or undefined when it may run.
 * `down` lets a caller that checks many jobs read the table once (unavailableConnectors()).
 */
export function blockingConnector(item: GateItem, job?: Pick<Job, "type" | "recipe" | "step_index">, down = unavailableConnectors()): ConnectorBlock | undefined {
  if (!down.size) return undefined;
  for (const p of needsOf(item, job)) {
    const r = down.get(p);
    if (r) return { provider: p, state: r.state as "down" | "limited", reason: blockReason(p, r.state as "down" | "limited") };
  }
  return undefined;
}

/** For the scheduler: true when the item's next work needs a connector that is down (or rate limited) now. */
export function isBlockedByConnector(item: GateItem, job?: Pick<Job, "type" | "recipe" | "step_index">, down?: Map<HealthProvider, HealthRow>): boolean {
  return !!blockingConnector(item, job, down);
}

/** Item data written when health.ts parks an item as BLOCKED. */
export interface BlockedBy { connectors: HealthProvider[]; prev: string; at: string }
export function blockedByOf(item: { data?: any }): BlockedBy | undefined {
  const d = typeof item.data === "string" ? safeJson<any>(item.data, {}) : item.data ?? {};
  const b = d?.blockedBy;
  return b && Array.isArray(b.connectors) ? b : undefined;
}
