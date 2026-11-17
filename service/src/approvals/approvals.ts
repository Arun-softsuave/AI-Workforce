import { db, audit, tx } from "../core/db.js";
import { newId, nowIso } from "../core/util.js";
import { headSha, diffHash } from "../git/git.js";
import { getTask, mergeData } from "../engine/tasks.js";

/**
 * Approval Service (PRD §9). An approval is bound to the exact repository, branch, base, head commit
 * and diff hash. Any change after the request makes it STALE. First decision wins (atomic update).
 */
export interface Approval {
  id: string; task_id: string; action: string; repo: string | null; branch: string | null;
  base_sha: string | null; head_sha: string | null; diff_hash: string | null; state: string;
  approver: string | null; channel: string | null; reason: string | null;
  requested_at: string; expires_at: string; decided_at: string | null;
}

export function requestApproval(taskId: string, action: string, b: { repo?: string; branch?: string; baseSha?: string; headSha?: string; diffHash?: string }, ttlHours = 72): Approval {
  return tx(() => {
    db().prepare("UPDATE approvals SET state='superseded' WHERE task_id=? AND state='pending'").run(taskId);
    const id = newId("a");
    const now = new Date();
    db().prepare(`INSERT INTO approvals (id, task_id, action, repo, branch, base_sha, head_sha, diff_hash, state, requested_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)`).run(id, taskId, action, b.repo ?? null, b.branch ?? null, b.baseSha ?? null,
      b.headSha ?? null, b.diffHash ?? null, now.toISOString(), new Date(now.getTime() + ttlHours * 3_600_000).toISOString());
    audit("service", "approval.requested", taskId, { approvalId: id, action, head: b.headSha });
    return getApproval(id)!;
  });
}

export function getApproval(id: string): Approval | undefined {
  return db().prepare("SELECT * FROM approvals WHERE id=?").get(id) as Approval | undefined;
}

/**
 * The newest approval of a task. Pass `action` (or a list) so a job only sees its own kind – e.g. a ci_fix job on a
 * PR_OPEN item must not pick up the ticket's earlier create_pr approval.
 */
export function latestApproval(taskId: string, action?: string | string[]): Approval | undefined {
  const actions = action === undefined ? [] : Array.isArray(action) ? action : [action];
  if (!actions.length) return db().prepare("SELECT * FROM approvals WHERE task_id=? ORDER BY requested_at DESC LIMIT 1").get(taskId) as Approval | undefined;
  return db().prepare(`SELECT * FROM approvals WHERE task_id=? AND action IN (${actions.map(() => "?").join(",")}) ORDER BY requested_at DESC LIMIT 1`)
    .get(taskId, ...actions) as Approval | undefined;
}

/** Resolve "a_xxx", a task id or a ticket key (PAY-142) to its pending approval. */
export function findPending(ref: string): Approval | undefined {
  const direct = getApproval(ref);
  if (direct) return direct;
  const task = getTask(ref);
  if (!task) return undefined;
  return db().prepare("SELECT * FROM approvals WHERE task_id=? AND state='pending' ORDER BY requested_at DESC LIMIT 1").get(task.id) as Approval | undefined;
}

export type Decision = { ok: true; approval: Approval } | { ok: false; message: string };

export function decide(ref: string, decision: "approved" | "rejected", approver: string, channel: string, reason?: string): Decision {
  const a = findPending(ref) ?? getApproval(ref);
  if (!a) return { ok: false, message: `No approval request found for ${ref}` };
  if (a.state !== "pending") return { ok: false, message: `Already ${a.state}${a.channel ? ` via ${a.channel}` : ""}` };
  if (new Date(a.expires_at).getTime() < Date.now()) {
    db().prepare("UPDATE approvals SET state='expired' WHERE id=? AND state='pending'").run(a.id);
    return { ok: false, message: "This approval request expired – refresh the task to get a new one" };
  }
  const r = db().prepare("UPDATE approvals SET state=?, approver=?, channel=?, reason=?, decided_at=? WHERE id=? AND state='pending'")
    .run(decision, approver, channel, reason ?? null, nowIso(), a.id);
  if (!r.changes) return { ok: false, message: "Already decided" };
  audit(`user:${approver}`, `approval.${decision}`, a.task_id, { approvalId: a.id, channel, reason });
  return { ok: true, approval: getApproval(a.id)! };
}

/** Re-check the binding right before publishing. */
export function verifyBinding(a: Approval, worktree: string): { ok: boolean; reason?: string } {
  if (a.state !== "approved") return { ok: false, reason: `approval is ${a.state}` };
  const head = headSha(worktree);
  if (a.head_sha && head !== a.head_sha) return { ok: false, reason: `commit changed (${a.head_sha.slice(0, 7)} -> ${head.slice(0, 7)})` };
  if (a.base_sha && a.diff_hash && diffHash(worktree, a.base_sha) !== a.diff_hash) return { ok: false, reason: "diff changed after approval" };
  return { ok: true };
}

export function expireApprovals(): Approval[] {
  const rows = db().prepare("SELECT * FROM approvals WHERE state='pending' AND expires_at < ?").all(nowIso()) as unknown as Approval[];
  for (const a of rows) db().prepare("UPDATE approvals SET state='expired' WHERE id=?").run(a.id);
  return rows;
}

/** Approve on the user's behalf because a directive or setting says no approval is needed (D5, F2). */
export function approveByPolicy(approvalId: string, rule: string): Decision {
  return decide(approvalId, "approved", `policy:${rule}`, "policy");
}

// ---------------------------------------------------------------------------------------------
// Approve with a change (D4): "yes but skip the email part"

/** Actions whose change means the plan is redone (without another approval round). */
export const REPLAN_ACTIONS = new Set(["implement_plan", "confirm_requirements", "start"]);

export interface ApprovedChange { approvalId: string; action: string; change: string; at: string; applied?: string }

export type ChangeDecision =
  | { ok: true; approval: Approval; change: ApprovedChange; replan: boolean }
  | { ok: false; message: string };

const CHANGE_PREFIX = "change: ";

/**
 * Approve and store the change. For a plan (or requirements) approval `replan` is true: the plan step re-plans with
 * the change and continues without asking again. For other actions the change is kept for the step to apply
 * (e.g. a PR title), and work goes ahead.
 */
export function decideWithChange(ref: string, change: string, approver: string, channel: string): ChangeDecision {
  const text = String(change ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!text) return { ok: false, message: "What should I change?" };
  const d = decide(ref, "approved", approver, channel, CHANGE_PREFIX + text);
  if (!d.ok) return d;
  const entry: ApprovedChange = { approvalId: d.approval.id, action: d.approval.action, change: text, at: d.approval.decided_at ?? new Date().toISOString() };
  const t = getTask(d.approval.task_id);
  if (t) mergeData(t.id, { approvedChanges: [...(t.data.approvedChanges ?? []), entry], ...(REPLAN_ACTIONS.has(entry.action) ? { replanPending: true } : {}) });
  audit(`user:${approver}`, "approval.change", d.approval.task_id, { approvalId: d.approval.id, channel });
  return { ok: true, approval: d.approval, change: entry, replan: REPLAN_ACTIONS.has(entry.action) };
}

/** The change text stored on an approval, or undefined. */
export function changeOf(a: Approval | undefined): string | undefined {
  return a?.reason?.startsWith(CHANGE_PREFIX) ? a.reason.slice(CHANGE_PREFIX.length) : undefined;
}

/** Changes not yet applied (optionally for one action). */
export function pendingChanges(taskId: string, action?: string): ApprovedChange[] {
  const t = getTask(taskId);
  return ((t?.data.approvedChanges ?? []) as ApprovedChange[]).filter((c) => !c.applied && (!action || c.action === action));
}

/** Mark changes applied once the re-plan (or the step) used them. */
export function markChangesApplied(taskId: string, approvalIds?: string[]): void {
  const t = getTask(taskId);
  if (!t) return;
  const at = new Date().toISOString();
  const list = ((t.data.approvedChanges ?? []) as ApprovedChange[]).map((c) => (!c.applied && (!approvalIds || approvalIds.includes(c.approvalId)) ? { ...c, applied: at } : c));
  mergeData(t.id, { approvedChanges: list, replanPending: list.some((c) => !c.applied && REPLAN_ACTIONS.has(c.action)) });
}
