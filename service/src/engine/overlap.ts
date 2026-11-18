import { db, audit } from "../core/db.js";
import { safeJson } from "../core/util.js";
import { addEdge } from "../kernel/items.js";
import { areasOverlap } from "../kernel/scheduler.js";

/**
 * L2 / B8 for tickets started on their own (no "batch" words needed): when building starts, the ticket's planned files
 * become its areas. If another ticket in the same repository is changing overlapping areas right now, this one waits
 * for it; if that one already has an open PR, this one is stacked on its branch (its PR targets that branch and is
 * re-targeted to the base when the first one merges – the close-out does that).
 */

/** "src/payments/refund.ts" → "src/payments/**"; a file in the repository root stays itself. Plan entries may be "[repo] path". */
export function areasFromFiles(files: unknown[]): string[] {
  const out = new Set<string>();
  for (const f0 of files ?? []) {
    const f = String(f0 ?? "").replace(/^\[[^\]]+\]\s*/, "").replace(/\\/g, "/").replace(/^\.\//, "").split(/[\s:(]/)[0].trim();
    if (!f || /^(n\/a|none|-)$/i.test(f)) continue;
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    out.add(dir ? `${dir}/**` : f);
  }
  return [...out].slice(0, 40);
}

/** Item states in which a ticket is still changing its files (or its PR is open). */
const ACTIVE = ["RUNNING", "QUEUED", "AWAITING_APPROVAL", "PUBLISHING", "WAITING_PARTS", "PART_READY", "ASKING_LEAD", "NEEDS_INFO", "PAUSED", "STALE", "PR_OPEN"];

export interface OverlapHit { id: string; ref: string; state: string; branch?: string; prOpen: boolean }

/**
 * The ticket in the same repository whose areas overlap these, that started building first (it already has areas).
 * The same lead's parts, its own lead and children of the same batch / epic (planned together) are not counted.
 */
export function overlappingItem(task: { id: string; project_id: string; data: Record<string, any> }, areas: string[]): OverlapHit | undefined {
  if (!areas.length) return undefined;
  const family = new Set([task.id, task.data.leadId, ...(task.data.parts ?? [])].filter(Boolean));
  const rows = db().prepare(`SELECT id, source_ref, state, areas, branch, parent_id, data FROM tasks WHERE project_id=? AND id<>? AND state IN (${ACTIVE.map(() => "?").join(",")})
    AND areas IS NOT NULL AND areas <> '[]' ORDER BY updated_at`).all(task.project_id, task.id, ...ACTIVE) as any[];
  const parent = (db().prepare("SELECT parent_id FROM tasks WHERE id=?").get(task.id) as any)?.parent_id;
  for (const r of rows) {
    const d = safeJson<Record<string, any>>(r.data, {});
    if (family.has(r.id) || (d.leadId && family.has(d.leadId))) continue;
    if (parent && r.parent_id === parent) continue;                     // a scope's own children: the scope plan orders them
    if (d.pr && (d.pr.merged || d.pr.state === "closed")) continue;
    const theirs = safeJson<string[]>(r.areas, []);
    if (!areasOverlap(areas, theirs)) continue;
    return { id: r.id, ref: r.source_ref ?? r.id, state: r.state, branch: r.branch ?? d.branchName ?? undefined, prOpen: r.state === "PR_OPEN" || !!d.pr?.number };
  }
  return undefined;
}

/** Record this ticket's areas (so later tickets see it). */
export function setAreas(itemId: string, areas: string[]): void {
  db().prepare("UPDATE tasks SET areas=? WHERE id=?").run(JSON.stringify(areas), itemId);
}

/** Stack this ticket on the other one's branch: an edge for the close-out, and the branch the PR will target. */
export function stackOn(itemId: string, other: OverlapHit): void {
  try { addEdge(itemId, other.id, "stacks_on"); } catch { /* already there */ }
  try { addEdge(itemId, other.id, "same_area"); } catch { /* already there */ }
  audit("service", "overlap.stacked", itemId, { on: other.ref, branch: other.branch });
}
