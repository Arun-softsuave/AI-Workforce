import { db } from "../core/db.js";
import { loadSettings, type ProjectConfig, type Size } from "../core/config.js";
import type { Task } from "./tasks.js";
import { effective, chainOf, scopeLabel } from "../policy/directives.js";

/** Budget Guard: token limits per task (by size) and per project per day. */
export interface BudgetCheck { ok: boolean; warn: boolean; reason?: string; used: number; limit: number }

export function taskBudget(project: ProjectConfig, size: string | null): number {
  const s = (size ?? "M") as Size;
  return project.budget.perTaskTokens[s] ?? project.budget.perTaskTokens.M;
}

export function tokensToday(projectId: string): number {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const r = db().prepare(
    `SELECT COALESCE(SUM(s.tokens_in + s.tokens_out), 0) AS n FROM steps s JOIN tasks t ON t.id = s.task_id
     WHERE t.project_id = ? AND s.started_at >= ?`,
  ).get(projectId, since.toISOString()) as { n: number };
  return r.n;
}

/** Called before every AI step. Pauses at 80% of the task budget (once) and hard-stops at 100% / daily cap. */
export function checkBudget(project: ProjectConfig, task: Task): BudgetCheck {
  // Default: budgets never stop work – the cost is shown in Teams instead (settings.workflow.stopForBudget).
  if (!project?.budget) return { ok: true, warn: false, used: task.tokens_used, limit: Infinity };
  const limit = taskBudget(project, task.size) * (task.data.budgetExtensions ?? 1);
  // E12: without budget stops (the default) the work never stops – but you are still told once at 80 %
  if (!loadSettings().workflow.stopForBudget) return { ok: true, warn: task.tokens_used >= 0.8 * limit && !task.data.budgetWarned, used: task.tokens_used, limit };
  const used = task.tokens_used;
  const day = tokensToday(project.id);
  if (day >= project.budget.dailyTokens) return { ok: false, warn: false, used: day, limit: project.budget.dailyTokens, reason: `daily token budget for ${project.id} reached` };
  if (used >= limit) return { ok: false, warn: false, used, limit, reason: "task token budget exhausted" };
  const warn = used >= 0.8 * limit && !task.data.budgetWarned;
  return { ok: true, warn, used, limit };
}

export interface CostRow { scope: string; tasks: number; tokens: number; cost: number }

export function costReport(days = 7): { byProject: CostRow[]; byDay: CostRow[]; topTasks: CostRow[] } {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const q = (sql: string) => db().prepare(sql).all(since) as unknown as CostRow[];
  return {
    byProject: q(`SELECT t.project_id AS scope, COUNT(DISTINCT t.id) AS tasks, SUM(s.tokens_in+s.tokens_out) AS tokens, ROUND(SUM(s.cost_usd),4) AS cost
                  FROM steps s JOIN tasks t ON t.id=s.task_id WHERE s.started_at >= ? GROUP BY t.project_id ORDER BY tokens DESC`),
    byDay: q(`SELECT substr(s.started_at,1,10) AS scope, COUNT(DISTINCT s.task_id) AS tasks, SUM(s.tokens_in+s.tokens_out) AS tokens, ROUND(SUM(s.cost_usd),4) AS cost
              FROM steps s WHERE s.started_at >= ? GROUP BY scope ORDER BY scope DESC`),
    topTasks: q(`SELECT COALESCE(t.source_ref, t.id) AS scope, 1 AS tasks, t.tokens_used AS tokens, ROUND(t.cost_usd,4) AS cost
                 FROM tasks t WHERE t.created_at >= ? ORDER BY t.tokens_used DESC LIMIT 10`),
  };
}

// ---------------------------------------------------------------------------------------------
// Budgets per item, per scope (batch / epic / sprint) and per day, with the 80% warning (§9).

export type BudgetState = "ok" | "warn" | "over";
export interface BudgetLine { scope: "item" | "batch" | "epic" | "sprint" | "day"; id: string; label: string; used: number; limit: number; state: BudgetState; text: string }

export const WARN_AT = 0.8;

export function budgetState(used: number, limit: number): BudgetState {
  if (!Number.isFinite(limit) || limit <= 0) return "ok";
  return used >= limit ? "over" : used >= WARN_AT * limit ? "warn" : "ok";
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

/** Short plain text: "KAN-45 has used 82% of its token budget (490k of 600k)." / "KAN-45 reached its token budget (600k)." */
export function budgetText(label: string, used: number, limit: number, stops = loadSettings().workflow.stopForBudget): string {
  const st = budgetState(used, limit);
  if (st === "ok") return "";
  const who = label || "Today";
  if (st === "warn") return `${who} has used ${Math.floor((used / limit) * 100)}% of its token budget (${fmtTokens(used)} of ${fmtTokens(limit)}).`;
  return stops ? `${who} reached its token budget (${fmtTokens(limit)}). Paused – resume it to allow more.`
    : `${who} went over its token budget (${fmtTokens(used)} of ${fmtTokens(limit)}). Still running.`;
}

/** Tokens used by an item and everything under it (children, parts), by the steps table. */
export function treeTokens(itemId: string): number {
  const r = db().prepare(
    `WITH RECURSIVE tree(id) AS (SELECT id FROM tasks WHERE id = ? UNION SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)
     SELECT COALESCE(SUM(tokens_used), 0) AS n FROM tasks WHERE id IN (SELECT id FROM tree)`,
  ).get(itemId) as { n: number };
  return r.n;
}

/**
 * Every budget that applies to an item, nearest first: the item (directive budget_tokens, else the size budget),
 * any batch/epic/sprint above it with a budget_tokens directive, and the project's day.
 */
export function budgetLines(project: ProjectConfig, task: Pick<Task, "id" | "size" | "tokens_used" | "data">): BudgetLine[] {
  const stops = loadSettings().workflow.stopForBudget;
  const out: BudgetLine[] = [];
  const chain = chainOf(task.id);
  const own = effective(task.id, "budget_tokens");
  const ownLimit = (own.source === "directive" && own.scope === "item" && own.directive?.scope_id === task.id ? Number(own.value) : taskBudget(project, task.size)) * (task.data?.budgetExtensions ?? 1);
  const label0 = scopeLabel("item", task.id) || task.id;
  const used0 = chain.length ? treeTokens(task.id) : task.tokens_used;
  out.push({ scope: "item", id: task.id, label: label0, used: used0, limit: ownLimit, state: budgetState(used0, ownLimit), text: budgetText(label0, used0, ownLimit, stops) });
  for (const n of chain.slice(1)) {
    if (n.level !== "batch" && n.level !== "epic" && n.level !== "sprint") continue;
    const row = db().prepare("SELECT value FROM directives WHERE active=1 AND rule='budget_tokens' AND scope=? AND scope_id=? AND (until_at IS NULL OR until_at > ?) ORDER BY created_at DESC LIMIT 1")
      .get(n.level, n.id, new Date().toISOString()) as { value: string } | undefined;
    if (!row) continue;
    const limit = Number(JSON.parse(row.value)) * (n.data?.budgetExtensions ?? 1);
    const used = treeTokens(n.id);
    const label = scopeLabel(n.level as any, n.id);
    out.push({ scope: n.level as any, id: n.id, label, used, limit, state: budgetState(used, limit), text: budgetText(label, used, limit, stops) });
  }
  const day = tokensToday(project.id);
  const dayLabel = `${project.id} today`;
  out.push({ scope: "day", id: project.id, label: dayLabel, used: day, limit: project.budget.dailyTokens, state: budgetState(day, project.budget.dailyTokens), text: budgetText(dayLabel, day, project.budget.dailyTokens, stops) });
  return out;
}

export interface ScopeBudgetCheck { ok: boolean; warnings: BudgetLine[]; over?: BudgetLine; text: string }

/**
 * The scope-aware check: stops only when settings.workflow.stopForBudget is on and a budget is used up;
 * 80% warnings are returned once per budget (keys kept in task.data.budgetWarnings by markBudgetWarned).
 */
export function checkScopeBudget(project: ProjectConfig, task: Pick<Task, "id" | "size" | "tokens_used" | "data">): ScopeBudgetCheck {
  const lines = budgetLines(project, task);
  const seen: string[] = task.data?.budgetWarnings ?? [];
  const over = lines.find((l) => l.state === "over");
  const warnings = lines.filter((l) => l.state === "warn" && !seen.includes(warnKey(l)));
  const stops = loadSettings().workflow.stopForBudget;
  const ok = !(stops && over);
  const text = over ? over.text : warnings.map((w) => w.text).join(" ");
  return { ok, warnings, over, text };
}

export const warnKey = (l: Pick<BudgetLine, "scope" | "id">) => `${l.scope}:${l.id}:${l.scope === "day" ? new Date().toISOString().slice(0, 10) : ""}`;

/** Remember that these warnings were sent (so each 80% warning is sent once). */
export function markBudgetWarned(taskId: string, lines: BudgetLine[]): void {
  const r = db().prepare("SELECT data FROM tasks WHERE id=?").get(taskId) as { data: string } | undefined;
  if (!r) return;
  const data = JSON.parse(r.data || "{}");
  data.budgetWarnings = [...new Set([...(data.budgetWarnings ?? []), ...lines.map(warnKey)])];
  db().prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(data), taskId);
}
