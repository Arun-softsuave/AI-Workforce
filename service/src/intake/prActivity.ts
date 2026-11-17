import { db, getCursor, setCursor, getMeta, setMeta } from "../core/db.js";
import { getProject } from "../core/config.js";
import { nowIso, truncate } from "../core/util.js";
import { logger } from "../core/log.js";
import { clients } from "../connectors/registry.js";
import { getTask, mergeData, type Task } from "../engine/tasks.js";
import { notify } from "../notify/router.js";

/**
 * Watch pull requests that AI Workforce opened: when someone ELSE comments, leaves a review comment, approves or
 * requests changes, the user is notified (Teams / desktop / inbox) with the text and a link.
 * Read-only: nothing is posted to GitHub and nothing is merged.
 */
const WATCH_DAYS = 30;

function watchedTasks(): Task[] {
  const since = new Date(Date.now() - WATCH_DAYS * 86_400_000).toISOString();
  const rows = db().prepare("SELECT id FROM tasks WHERE json_extract(data,'$.pr.number') IS NOT NULL AND updated_at >= ? AND state != 'CANCELLED'").all(since) as any[];
  return rows.map((r) => getTask(r.id)!).filter(Boolean);
}

export async function pollPrActivity(): Promise<number> {
  const gh = clients.github();
  if (!gh) return 0;
  let me = getMeta("github.login");
  if (!me) { try { me = (await gh.user()).login; setMeta("github.login", me); } catch { return 0; } }
  let sent = 0;
  for (const t of watchedTasks()) {
    const p = getProject(t.project_id);
    const repo = p?.github?.repo;
    const pr = t.data.pr as { number: number; url: string } | undefined;
    if (!repo || !pr) continue;
    const cursorName = `pr:${repo}#${pr.number}`;
    const since = getCursor(cursorName) ?? t.data.prOpenedAt ?? t.updated_at;
    const started = nowIso();
    try {
      const seenIds = new Set((t.data.prActivity ?? []).map((x: any) => x.id));
      const items = (await gh.prActivity(repo, pr.number, since)).filter((a) => !seenIds.has(a.id));   // each comment once
      for (const a of items) {
        if (!a.author || a.author === me || /\[bot\]$/i.test(a.author)) continue;      // only other people
        const what = a.kind === "review"
          ? (a.state === "APPROVED" ? "approved" : a.state === "CHANGES_REQUESTED" ? "requested changes on" : "reviewed")
          : a.kind === "review_comment" ? `commented on ${a.path ?? "the code"} in` : "commented on";
        const action = a.state === "CHANGES_REQUESTED";
        await notify({
          kind: action ? "pr_changes_requested" : "pr_comment", taskId: t.id, taskRef: t.source_ref ?? undefined, dedupeKey: a.id,
          title: `${a.author} ${what} PR #${pr.number} (${t.source_ref})`,
          body: truncate(a.body.replace(/\r/g, "").trim() || "(no text)", 700) + (action ? "\n\nThe reviewer asked for changes on GitHub." : ""),
          url: a.url, urgent: action,
        });
        sent++;
      }
      const seen = [...(t.data.prActivity ?? []), ...items.filter((a) => a.author !== me).map((a) => ({ id: a.id, author: a.author, kind: a.kind, state: a.state, at: a.at }))].slice(-50);
      mergeData(t.id, { prActivity: seen });
      setCursor(cursorName, started);
    } catch (e: any) {
      logger.warn("PR activity poll failed", { repo, pr: pr.number, error: e.message });
    }
  }
  return sent;
}

/**
 * PRs this developer reviewed (anyone's): when their author pushes new commits, tell the reviewer once per new commit
 * and offer a new review. Read-only; a new review is shown first, as always.
 */
export async function pollReviewedPrs(): Promise<number> {
  const gh = clients.github();
  if (!gh?.prForReview) return 0;
  const since = new Date(Date.now() - WATCH_DAYS * 86_400_000).toISOString();
  const rows = db().prepare("SELECT id FROM tasks WHERE kind='pr_review' AND state='DONE' AND json_extract(data,'$.reviewPosted.id') IS NOT NULL AND updated_at >= ?").all(since) as any[];
  // the latest review of each PR
  const latest = new Map<string, Task>();
  for (const r of rows) {
    const t = getTask(r.id);
    if (!t?.data.review) continue;
    const k = `${t.data.review.repo}#${t.data.review.num}`;
    if (!latest.has(k) || latest.get(k)!.updated_at < t.updated_at) latest.set(k, t);
  }
  let sent = 0;
  for (const [k, t] of latest) {
    const due = getMeta(`reviewed.check:${k}`);
    if (due && Date.now() - new Date(due).getTime() < 15 * 60_000) continue;        // at most every 15 minutes per PR
    setMeta(`reviewed.check:${k}`, nowIso());
    try {
      const pr = await gh.prForReview(t.data.review.repo, t.data.review.num);
      if (pr.state !== "open" || !t.data.reviewSha || pr.headSha === t.data.reviewSha) continue;
      if (getMeta(`reviewed.told:${k}`) === pr.headSha) continue;
      setMeta(`reviewed.told:${k}`, pr.headSha);
      await notify({
        kind: "pr_comment", taskId: t.id, taskRef: t.source_ref ?? undefined, dedupeKey: `reviewed:${k}:${pr.headSha}`,
        title: `🔁 ${pr.author} pushed new commits to PR #${pr.number} you reviewed`,
        body: `${pr.title}\n\nReply "review PR ${pr.number} ${t.project_id}" to review the new changes – I check whether your earlier comments were addressed and show you the result first.`,
        url: pr.url,
      });
      sent++;
    } catch (e: any) {
      logger.warn("reviewed PR check failed", { pr: k, error: e.message });
    }
  }
  return sent;
}
