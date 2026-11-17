/**
 * W14 – close-out after the PR is merged (recipes/close.yaml), and the "drop or reopen?" question when it is closed
 * without a merge. Code only, no model calls. Never merges anything itself.
 *
 * close_item runs LAST: it moves the item PR_OPEN → MERGED → DONE (the runner stops a job once its item has ended), so
 * dependents, stacked PRs and the worktree are handled first.
 */
import fs from "node:fs";
import { audit } from "../../core/db.js";
import { getProject, loadSettings } from "../../core/config.js";
import { clients } from "../../connectors/registry.js";
import * as G from "../../git/git.js";
import { notify, markInboxRead } from "../../notify/router.js";
import { mergeData, updateTask, canTransition, jiraKey } from "../tasks.js";
import { getItem, edgesOf, setItemState, openDependencies, mergeOrderOf } from "../../kernel/items.js";
import { emit } from "../../kernel/events.js";
import { endCiWatch } from "./ci_watch.js";
import type { StepCtx, StepResult } from "../steps.js";
import { prOf, refOf } from "./common.js";

const FINISHED = ["MERGED", "DONE", "CANCELLED"];

/** "KAN-46 (PR #12)" */
function label(id: string): string {
  const it = getItem(id);
  if (!it) return id;
  const pr = prOf(it);
  return `${it.source_ref ?? it.id}${pr ? ` (PR #${pr.num})` : ""}`;
}

export const CLOSE_STEPS: Record<string, (ctx: StepCtx) => Promise<StepResult>> = {
  /** Items waiting for this one may start once it is done; the next PR in the merge order is named. */
  async unblock_dependents(ctx) {
    const waiting = edgesOf(ctx.task.id, "in").filter((e) => e.type === "depends_on").map((e) => getItem(e.from)).filter((x) => x && !FINISHED.includes(x.state));
    const unblocked = waiting.filter((x) => openDependencies(x!.id).every((d) => d.id === ctx.task.id)).map((x) => x!.id);
    const it = getItem(ctx.task.id);
    let next: string | undefined;
    try {
      const order = mergeOrderOf(it?.root_id ?? ctx.task.id);
      next = order.find((id) => id !== ctx.task.id && !FINISHED.includes(getItem(id)?.state ?? "DONE") && !!prOf(getItem(id)!));
    } catch { /* no merge order */ }
    // merged out of order: something this item depended on is still open
    const early = openDependencies(ctx.task.id).map((d) => d.source_ref ?? d.id);
    ctx.save({ closeOut: { unblocked, next: next ?? null, early } });
    return { status: "ok", note: `${unblocked.length} unblocked` };
  },

  /** PRs stacked on this one: their base moved – re-target them to the base branch and bring it in (a rebase job each). */
  async retarget_stacked(ctx) {
    const stacked = edgesOf(ctx.task.id, "in").filter((e) => e.type === "stacks_on").map((e) => getItem(e.from)).filter((x) => x && !FINISHED.includes(x.state));
    const base = ctx.project.github?.baseBranch ?? "main";
    const gh = clients.github() as any;
    const done: string[] = [], manual: string[] = [];
    for (const s of stacked) {
      const pr = prOf(s!);
      if (!pr) continue;
      try {
        if (typeof gh?.retargetPr === "function") { await gh.retargetPr(pr.repo, pr.num, base); done.push(label(s!.id)); }
        else manual.push(label(s!.id));
      } catch { manual.push(label(s!.id)); }
      emit({ type: "new_base", idemKey: `new_base:${s!.id}:${ctx.task.id}`, itemId: s!.id, payload: { base, parent: ctx.task.id, repo: pr.repo, num: pr.num, ours: true } });
    }
    ctx.save({ closeOut: { ...(ctx.task.data.closeOut ?? {}), retargeted: done, retargetManual: manual } });
    return { status: "ok", note: `${done.length} re-targeted` };
  },

  /** The item's folder and local branch are removed (the merged branch is on GitHub). */
  async clean_worktree(ctx) {
    const it = getItem(ctx.task.id);
    const wt = it?.worktree;
    if (wt && fs.existsSync(wt)) {
      try { G.removeWorktree(ctx.project.local.path, wt); } catch { /* best effort */ }
      if (it?.branch) G.git(ctx.project.local.path, ["branch", "-D", it.branch], { allowFail: true });
    }
    if (it?.worktree) updateTask(ctx.task.id, { worktree: null });
    endCiWatch(ctx.task.id);
    return { status: "ok", note: wt ? "folder removed" : "no folder" };
  },

  /** MERGED → DONE; a Jira note when allowed; one short message with what is next. Runs last. */
  async close_item(ctx) {
    const it = getItem(ctx.task.id);
    if (!it) return { status: "done", note: "item gone" };
    const pr = prOf(it, ctx.project);
    const ref = refOf(it);
    const s = loadSettings();
    if (s.notifications.jiraComments && it.source === "jira" && pr) {
      try { await clients.jira()?.addComment(jiraKey(it), `PR merged (${pr.repo}): ${pr.url ?? `#${pr.num}`}`); } catch { /* optional */ }
    }
    if (it.state === "PR_OPEN" || it.state === "CLOSED" || it.state === "BLOCKED") { try { setItemState(it.id, "MERGED", "PR merged"); } catch { /* not legal from here */ } }
    const now = getItem(it.id)!;
    if (canTransition(now, "DONE")) setItemState(it.id, "DONE", "close-out finished");
    mergeData(it.id, { mergedAt: new Date().toISOString() });
    markInboxRead(it.id);
    const c = ctx.task.data.closeOut ?? {};
    const lines = [
      c.unblocked?.length ? `Unblocked: ${c.unblocked.map(label).join(", ")}.` : "",
      c.next ? `Next to merge: ${label(c.next)}.` : "",
      c.early?.length ? `⚠️ Merged before ${c.early.join(", ")} – check the order of the rest.` : "",
      c.retargeted?.length ? `Re-targeted to ${getProject(it.project_id)?.github?.baseBranch ?? "the base"}: ${c.retargeted.join(", ")}.` : "",
      c.retargetManual?.length ? `Please re-target to the base branch: ${c.retargetManual.join(", ")}.` : "",
    ].filter(Boolean);
    await notify({ kind: "done", taskId: it.id, taskRef: ref, dedupeKey: `merged:${it.id}`, title: `✅ ${ref} merged – done`, body: lines.join("\n") || "Nothing else waits on it.", url: pr?.url });
    audit("service", "item.closed", it.id, { pr: pr?.num, ...c });
    return { status: "done", note: "merged → done" };
  },
};

/** G18: the PR was closed without a merge – ask once (the item is CLOSED; "cancel" drops it, a reopened PR picks it up). */
export async function askDropOrReopen(itemId: string): Promise<void> {
  const it = getItem(itemId);
  if (!it) return;
  const pr = prOf(it);
  const ref = refOf(it);
  await notify({ kind: "info", taskId: it.id, taskRef: ref, dedupeKey: `pr-closed:${it.id}:${pr?.num ?? ""}`, urgent: true,
    title: `❓ PR${pr ? ` #${pr.num}` : ""} for ${ref} was closed without merging`,
    body: `Drop the work or reopen?\n1. Drop it – say "cancel ${ref}" (the branch stays on GitHub)\n2. Reopen – reopen the PR on GitHub and I look after it again`, url: pr?.url });
}
