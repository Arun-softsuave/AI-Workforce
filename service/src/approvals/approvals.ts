import { db, audit, tx } from "../core/db.js";
import { newId, nowIso } from "../core/util.js";
import { headSha, diffHash } from "../git/git.js";
import { getTask } from "../engine/tasks.js";

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

export function latestApproval(taskId: string): Approval | undefined {
  return db().prepare("SELECT * FROM approvals WHERE task_id=? ORDER BY requested_at DESC LIMIT 1").get(taskId) as Approval | undefined;
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
