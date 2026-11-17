/**
 * Kernel (engine v2): finding the item behind a pull request, and the passive ci_watch job that shows a PR's CI is
 * being watched. The watching itself is still engine/prFix.ts pollCiWatches (meta fix.ciwatch); in v2 a failure
 * becomes a ci_failed event on the item instead of a separate FIX-n task.
 */
import { db, audit } from "../core/db.js";
import { getProject } from "../core/config.js";
import { nowIso } from "../core/util.js";
import { createItem, toItem, getItem } from "./items.js";
import { createJob, rowToJob } from "./mailbox.js";
import type { Item, Job } from "./types.js";

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Does the item's data say its PR(s) were merged or closed? */
function prEnded(data: Record<string, any>): boolean {
  const prs = [data.pr, ...(data.prs ?? []), data.prRef].filter(Boolean);
  return !!(data.merged || data.prMerged || data.closedAt || prs.some((p: any) => p.merged || p.mergedAt || p.state === "merged" || p.state === "closed"));
}

/**
 * The old engine (v1) ended a ticket at DONE as soon as its PR was raised. When something shows that PR is still
 * open (a conflict, a failing check, a review, or you asking for a fix), the item is looked after again: DONE → PR_OPEN.
 * (DONE → PR_OPEN is not a normal move, so it is written directly, only for items that have a PR and no merge.)
 * Returns the reopened item, the item unchanged when it is not a DONE item with an open PR, or undefined.
 */
export function reopenForOpenPr(itemId: string): Item | undefined {
  const it = getItem(itemId);
  if (!it || it.state !== "DONE") return it;
  const hasPr = !!(it.data.pr || (it.data.prs ?? []).length || it.data.prRef);
  if (!hasPr || prEnded(it.data)) return it;
  db().prepare("UPDATE tasks SET state='PR_OPEN', error=NULL, updated_at=? WHERE id=? AND state='DONE'").run(nowIso(), itemId);
  audit("service", "item.reopened_for_open_pr", itemId, { from: "DONE", to: "PR_OPEN" });
  return getItem(itemId);
}

/** Does this task data name PR `num` of `repo` (data.pr, data.prs[], or a light pr item's data.prRef)? */
function names(t: { project_id: string; data: Record<string, any> }, repo: string, num: number): boolean {
  const prs = [t.data.pr, ...(t.data.prs ?? []), t.data.prRef].filter(Boolean);
  return prs.some((p: any) => Number(p.number ?? p.num) === Number(num) && same(p.repo ?? getProject(t.project_id)?.github?.repo, repo));
}

/** The work item that raised (or adopted) this PR: a ticket / lead item, else a light pr item. Never a fix task. */
export function itemForPr(repo: string, num: number): Item | undefined {
  const rows = db().prepare(`SELECT * FROM tasks WHERE state NOT IN ('CANCELLED') AND kind NOT IN ('pr_fix','pr_qa','pr_review')
    AND (json_extract(data,'$.pr.number')=? OR json_extract(data,'$.prRef.number')=? OR data LIKE ?) ORDER BY created_at DESC`)
    .all(num, num, `%"number":${num}%`) as any[];
  const hit = rows.map(toItem).filter((t) => names(t, repo, num));
  return hit.find((t) => t.level !== "pr") ?? hit[0];
}

/** The item for a PR, creating a light "pr" item (state PR_OPEN) when nothing here raised it. */
export function itemForPrOrLight(projectId: string, repo: string, num: number, owner = "me"): Item {
  const found = itemForPr(repo, num);
  if (found) return found;
  return createItem({ projectId, source: "github", sourceId: `pr:${repo.toLowerCase()}#${num}`, sourceRef: `PR-${num}@${projectId}`,
    title: `${repo}#${num}`, kind: "pr", level: "pr", owner, state: "PR_OPEN", data: { prRef: { repo, number: num } } });
}

export interface CiWatchRow { projectId: string; repo: string; num: number; sha?: string; by?: string; via?: string; round?: number; since?: string }

/** The PR's ci_watch job (state waiting while CI is watched), or undefined. */
export function ciWatchJob(itemId: string): Job | undefined {
  const r = db().prepare("SELECT * FROM jobs WHERE item_id=? AND type='ci_watch' AND state='waiting' ORDER BY created_at DESC LIMIT 1").get(itemId);
  return r ? rowToJob(r) : undefined;
}

/** Record (or refresh) the passive ci_watch job on the PR's item. Returns it, or undefined when no item was found. */
export function upsertCiWatchJob(w: CiWatchRow, opts: { createLight?: boolean } = {}): Job | undefined {
  const item = opts.createLight ? itemForPrOrLight(w.projectId, w.repo, w.num) : itemForPr(w.repo, w.num);
  if (!item) return undefined;
  const existing = ciWatchJob(item.id);
  const data = { repo: w.repo, num: w.num, sha: w.sha ?? null, by: w.by ?? "you", via: w.via ?? "teams-personal", round: w.round ?? 1, since: w.since ?? nowIso() };
  if (existing) {
    db().prepare("UPDATE jobs SET data=?, updated_at=? WHERE id=?").run(JSON.stringify({ ...existing.data, ...data }), nowIso(), existing.id);
    return { ...existing, data: { ...existing.data, ...data } };
  }
  const j = createJob({ itemId: item.id, type: "ci_watch", recipe: "ci_watch", priority: 5, data });
  db().prepare("UPDATE jobs SET state='waiting', activity=?, updated_at=? WHERE id=?").run("watching CI", nowIso(), j.id);
  return { ...j, state: "waiting" };
}

/** CI watching ended for this PR (green, merged, closed or handed to the developer). */
export function endCiWatchJob(repo: string, num: number, error?: string): void {
  const item = itemForPr(repo, num);
  if (!item) return;
  db().prepare("UPDATE jobs SET state=?, error=?, updated_at=? WHERE item_id=? AND type='ci_watch' AND state='waiting'")
    .run(error ? "failed" : "done", error ?? null, nowIso(), item.id);
}

export { getItem };
