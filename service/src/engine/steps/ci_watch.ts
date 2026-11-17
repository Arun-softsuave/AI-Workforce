/**
 * W9 on engine v2: watching a PR's CI is a real `ci_watch` recipe (recipes/ci_watch.yaml) on the PR's item instead of
 * the meta list `fix.ciwatch` (which engine v1 keeps using).
 *
 * - startCiWatch() puts a passive ci_watch job on the item (state waiting; passive jobs never block the item's other jobs).
 * - runCiWatches() (called from prFix.pollCiWatches, the 60 s CI timer) checks each watched PR cheaply; only when CI has
 *   finished, the head moved, or the watch ran out of time is the job resumed and its `ci_watch_check` step run.
 * - ci_watch_check: all green → ONE result message ("CI green on PR #7 – fixed lint in 2 files"); something failed →
 *   a `ci_failed` event (the reactions start ONE ci_fix job, round + 1, at most 3 rounds); merged/closed → ends.
 * No model calls.
 */
import { db, audit } from "../../core/db.js";
import { getProject, loadSettings } from "../../core/config.js";
import { nowIso } from "../../core/util.js";
import { clients } from "../../connectors/registry.js";
import type { CiCheck } from "../../connectors/github.js";
import { notify } from "../../notify/router.js";
import { emit } from "../../kernel/events.js";
import { createJob, rowToJob } from "../../kernel/mailbox.js";
import { itemForPr } from "../../kernel/prs.js";
import { getItem } from "../../kernel/items.js";
import type { Job } from "../../kernel/types.js";
import type { StepCtx, StepResult } from "../steps.js";
import { runningJob } from "./common.js";

/** Fix rounds for one PR's CI before the developer is asked to look (same as prFix MAX_CI_ROUNDS / reactions CI_MAX_ROUNDS). */
export const CI_ROUNDS = 3;
/** GitHub needs a moment to register the runs of a fresh push. */
const NO_RUNS_GRACE_MS = 10 * 60_000;
/** A check still running after this long is reported. */
const PENDING_LIMIT_MS = 3 * 3_600_000;

export interface CiWatch {
  projectId: string; repo: string; num: number; sha: string; by?: string; via?: string; round: number; since?: string;
  /** What the last fix round changed, for the one result message ("lint in 2 files"). */
  fixed?: string;
}

const ENDED = ["DONE", "CANCELLED", "MERGED", "FAILED", "CLOSED"];

/** The watch a ci_watch job carries (job.data.ctx.ciwatch; jobs made by the v2 migration keep it at the top of data). */
export function watchOf(job: Pick<Job, "data">): CiWatch | undefined {
  const w = job.data?.ctx?.ciwatch ?? (job.data?.repo ? { ...job.data, projectId: job.data.projectId } : undefined);
  if (!w?.repo || !w?.num) return undefined;
  return { ...w, round: Number(w.round ?? 1) };
}

function watchJobOf(itemId: string): Job | undefined {
  const r = db().prepare("SELECT * FROM jobs WHERE item_id=? AND type='ci_watch' AND state IN ('waiting','queued','running') ORDER BY created_at DESC LIMIT 1").get(itemId);
  return r ? rowToJob(r) : undefined;
}

/**
 * Watch this PR's CI (engine v2). Creates or refreshes the item's ci_watch job. Returns it, or undefined when no item
 * here raised or adopted the PR.
 */
export function startCiWatch(w: CiWatch): Job | undefined {
  const item = itemForPr(w.repo, w.num);
  if (!item || ENDED.includes(item.state)) return undefined;
  const watch: CiWatch = { ...w, since: nowIso() };
  const existing = watchJobOf(item.id);
  if (existing) {
    const data = { ...existing.data, ...watch, started: undefined, ctx: { ...(existing.data.ctx ?? {}), ciwatch: watch } };
    db().prepare("UPDATE jobs SET data=?, state='waiting', step_index=0, activity='watching CI', updated_at=? WHERE id=? AND state<>'running'")
      .run(JSON.stringify(data), nowIso(), existing.id);
    return rowToJob(db().prepare("SELECT * FROM jobs WHERE id=?").get(existing.id));
  }
  const j = createJob({ itemId: item.id, type: "ci_watch", recipe: "ci_watch", priority: 5, data: { ...watch, ctx: { ciwatch: watch } } });
  db().prepare("UPDATE jobs SET state='waiting', activity='watching CI', activity_at=?, updated_at=? WHERE id=?").run(nowIso(), nowIso(), j.id);
  audit("service", "ci.watch", item.id, { repo: w.repo, num: w.num, sha: w.sha, round: w.round });
  return rowToJob(db().prepare("SELECT * FROM jobs WHERE id=?").get(j.id));
}

/** End the PR's watch (merged, closed, handed over). */
export function endCiWatch(itemId: string, error?: string): void {
  db().prepare("UPDATE jobs SET state=?, error=?, updated_at=? WHERE item_id=? AND type='ci_watch' AND state IN ('waiting','queued')")
    .run(error ? "failed" : "done", error ?? null, nowIso(), itemId);
}

type CiState =
  | { at: "closed"; merged: boolean }
  | { at: "running"; sha: string }
  | { at: "green"; sha: string; checks: CiCheck[]; url: string; headRef: string }
  | { at: "red"; sha: string; failed: CiCheck[]; stuck: boolean; url: string; headRef: string };

/** Where the PR's CI stands now (one PR read + one checks read). */
async function ciState(w: CiWatch): Promise<CiState | undefined> {
  const gh = clients.github();
  if (!gh?.prChecks || !gh.prForReview) return undefined;
  const pr = await gh.prForReview(w.repo, w.num);
  if (pr.merged || pr.state !== "open") return { at: "closed", merged: !!pr.merged };
  const sha = pr.headSha || w.sha;
  const checks = await gh.prChecks(w.repo, sha);
  const age = Date.now() - Date.parse(w.since ?? nowIso());
  if (!checks.length && age < NO_RUNS_GRACE_MS) return { at: "running", sha };
  if (checks.some((c) => c.state === "pending") && age < PENDING_LIMIT_MS) return { at: "running", sha };
  const failed = checks.filter((c) => c.state !== "passed");
  if (!failed.length) return { at: "green", sha, checks, url: pr.url, headRef: pr.headRef };
  return { at: "red", sha, failed, stuck: failed.every((c) => c.state === "pending"), url: pr.url, headRef: pr.headRef };
}

/** The one result message after CI went green. */
export function ciGreenText(num: number, n: number, fixed?: string): string {
  return fixed ? `CI green on PR #${num} – fixed ${fixed}.` : `CI green on PR #${num} – all ${n} checks passed.`;
}

export const CI_WATCH_STEPS: Record<string, (ctx: StepCtx) => Promise<StepResult>> = {
  /** One look at the PR's CI: wait, tell green, start the next fix round, or stop. */
  async ci_watch_check(ctx) {
    const job = runningJob(ctx.task.id, "ci_watch");
    const w = ctx.task.data.ciwatch ?? (job ? watchOf(job) : undefined);
    if (!w) return { status: "done", note: "nothing to watch" };
    const st = await ciState(w);
    if (!st) return { status: "pause", reason: "GitHub is not connected – CI is watched again when it is back" };
    const ref = ctx.task.source_ref ?? ctx.task.id;
    if (st.at === "closed") return { status: "done", note: st.merged ? "PR merged" : "PR closed" };
    if (st.sha !== w.sha) ctx.save({ ciwatch: { ...w, sha: st.sha } });
    if (st.at === "running") return { status: "wait", state: "PART_READY", note: "CI running" };
    if (st.at === "green") {
      await notify({ kind: "info", taskId: ctx.task.id, taskRef: ref, dedupeKey: `ci-green:${w.repo}#${w.num}:${st.sha}`,
        title: `✅ ${ciGreenText(w.num, st.checks.length, w.fixed)}`, body: `${ref} · ${st.headRef} · nothing merged.`, url: st.url });
      audit("service", "fix.ci_green", ctx.task.id, { repo: w.repo, num: w.num, sha: st.sha, round: w.round });
      return { status: "done", note: "CI green" };
    }
    const list = st.failed.map((c) => `${c.name}${c.state === "pending" ? " (still running after 3 h)" : ""}`).join(", ");
    if (w.round > CI_ROUNDS || st.stuck) {
      await notify({ kind: "failed", taskId: ctx.task.id, taskRef: ref, dedupeKey: `ci-stuck:${w.repo}#${w.num}:${st.sha}`,
        title: `⚠️ CI still red on PR #${w.num} – please take a look`,
        body: `${list}.${w.round > CI_ROUNDS ? ` I tried ${CI_ROUNDS} rounds.` : ""} Say "fix the CI on PR ${w.num}" to try again.`, url: st.url });
      return { status: "done", note: "CI still failing – handed to you" };
    }
    emit({ type: "ci_failed", idemKey: `ci_failed:${w.repo.toLowerCase()}#${w.num}:${st.sha}`, itemId: ctx.task.id,
      payload: { repo: w.repo, num: w.num, sha: st.sha, round: w.round, by: w.by, via: w.via, ours: true, checks: st.failed.map((c) => c.name) } });
    return { status: "done", note: `CI failed (${list}) – fix round ${w.round}` };
  },
};

/**
 * The CI timer on engine v2: look at every watched PR; run its ci_watch job only when there is something to act on.
 * Returns how many jobs ran.
 */
export async function runCiWatches(): Promise<number> {
  const rows = (db().prepare("SELECT * FROM jobs WHERE type='ci_watch' AND state='waiting' ORDER BY created_at").all() as any[]).map(rowToJob);
  if (!rows.length) return 0;
  const { resumeJob, runJob } = await import("../../kernel/runner.js");
  let ran = 0;
  for (const j of rows) {
    const item = getItem(j.item_id);
    if (!item || ENDED.includes(item.state)) { endCiWatch(j.item_id); continue; }
    const w = watchOf(j);
    if (!w) { endCiWatch(j.item_id, "no PR to watch"); continue; }
    if (!getProject(item.project_id)) continue;
    let st: CiState | undefined;
    try { st = await ciState(w); } catch { continue; }                 // GitHub unreachable: next time
    if (!st || (st.at === "running" && st.sha === w.sha)) continue;
    resumeJob(j.id, { stepIndex: 0 });
    await runJob(j.id);
    ran++;
  }
  return ran;
}

/** Settings shortcut used by messages: are CI fixes pushed without asking? */
export const autoFixCi = (): boolean => loadSettings().pr?.autoFixCi !== false;
