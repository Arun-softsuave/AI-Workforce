/**
 * Shared helpers for the after-PR step files (W9, W10, W13, W14): which job runs a step, which PR an item has, and the
 * short Teams lines. Code only – no model calls here.
 *
 * A step function only gets a StepCtx. On engine v2 a job that does not own its item (ci_fix, rebase, close…) sees the
 * item's data with the job's own context on top (kernel/runner.ts jobView), and ctx.save writes into the job, never the
 * item. These helpers find that job (one active job per item) so a step can read the job's events and keep job-scoped
 * state such as its approval id.
 */
import { db } from "../../core/db.js";
import { getProject, type ProjectConfig } from "../../core/config.js";
import { safeJson, truncate } from "../../core/util.js";
import type { Task } from "../tasks.js";
import type { Job, KernelEvent } from "../../kernel/types.js";

/** The job now running on this item (the only active, non-passive one), or undefined on engine v1. */
export function runningJob(itemId: string, type?: string): Job | undefined {
  const r = type
    ? db().prepare("SELECT * FROM jobs WHERE item_id=? AND type=? AND state='running' ORDER BY updated_at DESC LIMIT 1").get(itemId, type)
    : db().prepare("SELECT * FROM jobs WHERE item_id=? AND state='running' AND type<>'ci_watch' ORDER BY updated_at DESC LIMIT 1").get(itemId);
  return r ? ({ ...(r as any), data: safeJson((r as any).data, {}) } as Job) : undefined;
}

/** The events folded into a job (oldest first), as their payloads with the type. */
export function jobEvents(job: Job | undefined): { type: string; payload: Record<string, any> }[] {
  return ((job?.data?.events ?? []) as any[]).map((e) => ({ type: String(e?.type ?? ""), payload: e?.payload ?? {} }));
}

/** The event row that created a job (or undefined). */
export function triggerEvent(job: Job | undefined): KernelEvent | undefined {
  if (!job?.trigger_event) return undefined;
  const r = db().prepare("SELECT * FROM events WHERE id=?").get(job.trigger_event) as any;
  return r ? { ...r, payload: safeJson(r.payload, {}) } : undefined;
}

/**
 * Is this step running for a job beside the item (engine v2: a fix, rebase or close-out on a ticket's open PR) rather
 * than for a task of its own (a v1 FIX-n / QA-n / REVIEW-n task, or such a task migrated to a pr item)?
 */
export function jobScoped(t: Pick<Task, "kind">): boolean {
  return !["pr_fix", "pr_qa", "pr_review"].includes(t.kind);
}

/** The PR an item raised (or adopted): repo and number, or undefined. */
export function prOf(t: Pick<Task, "data" | "project_id">, project?: ProjectConfig): { repo: string; num: number; url?: string } | undefined {
  const p = t.data?.pr ?? t.data?.prRef ?? (t.data?.prs ?? [])[0];
  if (!p) return undefined;
  const num = Number(p.number ?? p.num);
  const repo = p.repo ?? (project ?? getProject(t.project_id))?.github?.repo;
  return repo && num ? { repo, num, url: p.url } : undefined;
}

/** Folder id for a job's own worktree, so it never replaces the item's build worktree (same item id). */
export function jobFolderId(itemId: string, what: string, num?: number): string {
  return `${itemId}-${what}${num ? `-${num}` : ""}`;
}

/**
 * The approval a step asked for, scoped to whoever asked: the id the step saved in its context (`idKey`), else – for a
 * task of its own (v1 REVIEW / QA / FIX tasks) – the task's latest approval of that action. A job beside a ticket never
 * sees the ticket's other approvals (e.g. create_pr).
 */
export async function ownApproval(t: Pick<Task, "id" | "kind" | "data">, idKey: string, action: string) {
  const A = await import("../../approvals/approvals.js");
  if (t.data?.[idKey]) return A.getApproval(t.data[idKey]);
  if (jobScoped(t)) return undefined;
  const a = A.latestApproval(t.id, action);
  return a?.action === action ? a : undefined;
}

/** "KAN-45" or the item id. */
export const refOf = (t: Pick<Task, "id" | "source_ref">): string => t.source_ref ?? t.id;

/** One short line (Teams messages stay short; questions may be longer). */
export const line = (s: string, max = 300): string => truncate(s.replace(/\s+/g, " ").trim(), max);
