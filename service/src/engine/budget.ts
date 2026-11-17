import { db } from "../core/db.js";
import { loadSettings, type ProjectConfig, type Size } from "../core/config.js";
import type { Task } from "./tasks.js";

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
  if (!loadSettings().workflow.stopForBudget) return { ok: true, warn: false, used: task.tokens_used, limit: Infinity };
  const limit = taskBudget(project, task.size) * (task.data.budgetExtensions ?? 1);
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
