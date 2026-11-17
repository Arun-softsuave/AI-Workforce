/**
 * W13 – keeping our PR healthy (recipes/rebase.yaml). Never a force-push, never a merge of the PR.
 *
 *  - pr_conflict (or the base moved under a stacked PR): bring the base branch in THE TEAM'S WAY. The default is a merge
 *    commit of the base into the PR branch (a normal push). A team that only rebases would need a force-push – that is
 *    never done here, so the developer is told what to run instead.
 *    Simple conflicts (few files, small hunks, no lock files) are resolved by the implementer agent, then the project's
 *    tests run; anything bigger stops and tells you, with nothing pushed.
 *  - new_commits by someone else on our branch: local work that was not pushed yet is rebased ON TOP of their commits
 *    (their commits are never overwritten); with nothing local there is nothing to move.
 * Code drives every decision; the only model call is resolving a simple conflict.
 */
import fs from "node:fs";
import path from "node:path";
import { audit } from "../../core/db.js";
import { truncate } from "../../core/util.js";
import { clients } from "../../connectors/registry.js";
import * as G from "../../git/git.js";
import { attributionHits } from "../../core/attribution.js";
import { requestApproval, getApproval, decide, verifyBinding } from "../../approvals/approvals.js";
import { notify } from "../../notify/router.js";
import { untrusted } from "../../agents/runner.js";
import type { ProjectConfig } from "../../core/config.js";
import type { StepCtx, StepResult } from "../steps.js";
import { runningJob, jobEvents, prOf, jobFolderId, refOf } from "./common.js";

/** How the team brings the base branch into a PR: "merge" (a merge commit, the safe default) or "rebase". */
export function teamUpdateStyle(project: Pick<ProjectConfig, "conventions">): "merge" | "rebase" {
  const c: any = project.conventions ?? {};
  const v = c.prUpdate ?? c.overrides?.prUpdate ?? c.updateStyle;
  return v === "rebase" ? "rebase" : "merge";
}

/** Files whose conflicts are never "simple" (generated or binary). */
const NEVER_SIMPLE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.(png|jpe?g|gif|pdf|zip|ico|woff2?|ttf|bin)$/i;

export interface ConflictFile { path: string; hunks: number; lines: number }

/** Conflict hunks and their size in one file's text (between <<<<<<< and >>>>>>>). */
export function conflictStats(text: string): { hunks: number; lines: number } {
  let hunks = 0, lines = 0, inside = false;
  for (const l of text.split("\n")) {
    if (l.startsWith("<<<<<<<")) { inside = true; hunks++; continue; }
    if (l.startsWith(">>>>>>>")) { inside = false; continue; }
    if (inside && !l.startsWith("=======")) lines++;
  }
  return { hunks, lines };
}

/** A conflict the agent may resolve: at most 3 files, 4 hunks each, 60 changed lines in all, nothing generated or binary. */
export function isSimpleConflict(files: ConflictFile[]): boolean {
  if (!files.length || files.length > 3) return false;
  if (files.some((f) => NEVER_SIMPLE.test(f.path) || f.hunks === 0 || f.hunks > 4)) return false;
  return files.reduce((n, f) => n + f.lines, 0) <= 60;
}

const MARKERS = /^(<<<<<<<|>>>>>>>)( |$)/m;

/** Why the job runs: a conflict with the base (or a stacked parent merged), or someone pushed to our branch. */
function modeOf(ctx: StepCtx): "conflict" | "new_commits" {
  const evs = jobEvents(runningJob(ctx.task.id));
  if (evs.some((e) => e.type === "pr_conflict" || e.type === "new_base" || (e.type === "user_command" && e.payload.command === "rebase"))) return "conflict";
  return evs.some((e) => e.type === "new_commits") ? "new_commits" : "conflict";
}

const done = (note: string): StepResult => ({ status: "ok", note });

export const REBASE_STEPS: Record<string, (ctx: StepCtx) => Promise<StepResult>> = {
  /** The PR, its head and base fetched; a folder of this job's own on the PR's head (conflict mode). */
  async rebase_prepare(ctx) {
    const pr0 = prOf(ctx.task, ctx.project);
    if (!pr0) return { status: "done", note: "no PR on this item" };
    const gh = clients.github();
    if (!gh?.prForReview) return { status: "fail", reason: "GitHub is not connected" };
    const pr = await gh.prForReview(pr0.repo, pr0.num);
    if (pr.merged || pr.state !== "open") return { status: "done", note: `PR #${pr0.num} is ${pr.merged ? "merged" : pr.state}` };
    const repo = ctx.project.local.path;
    const url = G.remoteUrl(pr0.repo);
    const auth = gh.gitAuthHeader();
    const evs = jobEvents(runningJob(ctx.task.id));
    const base = String(evs.find((e) => e.payload.base)?.payload.base ?? pr.baseRef);
    const headRef = `refs/aiw/rebase/${pr0.num}`, baseRef = `refs/aiw/base/${base}`;
    G.git(repo, ["fetch", "--quiet", "--force", url, `+refs/heads/${pr.headRef}:${headRef}`], { extraHeader: auth });
    G.git(repo, ["fetch", "--quiet", "--force", url, `+refs/heads/${base}:${baseRef}`], { extraHeader: auth });
    const headSha = G.git(repo, ["rev-parse", headRef]);
    const mode = modeOf(ctx);
    const info = { mode, repo: pr0.repo, num: pr0.num, url: pr.url, branch: pr.headRef, base, headSha, baseRefName: baseRef, headRefName: headRef };
    if (mode === "new_commits") {
      // our own folder of the item (the build's): only work that was never pushed has to move on top of their commits
      const wt = ctx.task.worktree && fs.existsSync(ctx.task.worktree) ? ctx.task.worktree : undefined;
      const ahead = wt ? Number(G.git(wt, ["rev-list", "--count", `${headSha}..HEAD`], { allowFail: true }) || "0") : 0;
      ctx.save({ rebase: { ...info, wt: wt ?? null, ahead } });
      return done(ahead ? `${ahead} local commit(s) to put on top` : "nothing local to move");
    }
    const branch = G.uniqueBranch(repo, `aiw-rebase/${pr0.num}`);
    const wt = G.createWorktree(repo, ctx.project.id, jobFolderId(ctx.task.id, "rebase", pr0.num), branch, headSha, ctx.project.conventions?.env?.linkedDirs ?? []);
    ctx.task = { ...ctx.task, worktree: wt, branch };
    ctx.save({ rebase: { ...info, wt, ahead: 0 }, baseSha: headSha });
    return done(`PR #${pr0.num} checked out`);
  },

  /** Bring the base in the team's way, or put local work on top of the new commits. Real conflicts stop here. */
  async rebase_apply(ctx) {
    const r = ctx.task.data.rebase;
    if (!r) return done("nothing to do");
    const ref = refOf(ctx.task);
    if (r.mode === "new_commits") {
      if (!r.ahead || !r.wt) return done("nothing local to move");
      if (!G.rebaseOnto(r.wt, r.headSha)) {
        await tell(ctx, `⚠️ ${ref}: new commits on PR #${r.num} conflict with work here`, `Your branch got new commits that conflict with ${r.ahead} local commit(s) here. Nothing was pushed or overwritten. Resolve it in ${r.wt}.`, r.url);
        return { status: "done", note: "conflict with the new commits – told you" };
      }
      ctx.save({ rebase: { ...r, changed: true, how: "rebased local work on top" } });
      return done("local work is on top of the new commits");
    }
    const wt: string = r.wt;
    if (teamUpdateStyle(ctx.project) === "rebase") {
      await tell(ctx, `⚠️ PR #${r.num} (${ref}) needs an update from ${r.base}`,
        `Your team rebases PR branches, which needs a force-push – I never force-push. Rebase it yourself, or say "merge ${r.base} into PR ${r.num}" to add a merge commit instead.`, r.url);
      return { status: "done", note: "team rebases – told you (no force-push)" };
    }
    const before = G.headSha(wt);
    let mergedOk = true;
    try { G.git(wt, ["merge", "--no-ff", "--no-edit", r.baseRefName]); } catch { mergedOk = false; }
    if (mergedOk) {
      const changed = G.headSha(wt) !== before;
      ctx.save({ rebase: { ...r, changed, how: changed ? `merged ${r.base} in (no conflicts)` : "already up to date" } });
      return done(changed ? `merged ${r.base} in` : "already up to date");
    }
    // conflicts: resolve simple ones with the agent, stop on real ones
    const names = G.git(wt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).split("\n").map((s) => s.trim()).filter(Boolean);
    const files: ConflictFile[] = names.map((p) => { let t = ""; try { t = fs.readFileSync(path.join(wt, p), "utf8"); } catch { /* binary or gone */ } return { path: p, ...conflictStats(t) }; });
    const stop = async (why: string) => {
      G.git(wt, ["merge", "--abort"], { allowFail: true });
      await tell(ctx, `⚠️ PR #${r.num} (${ref}) conflicts with ${r.base}`, `${why}\n\n${names.map((n) => `- ${n}`).join("\n")}\n\nNothing was pushed. Resolve it on ${r.branch}, or tell me how to resolve it.`, r.url);
      audit("service", "rebase.conflict", ctx.task.id, { files: names, why });
      return { status: "done", note: "real conflict – told you" } as StepResult;
    };
    if (!isSimpleConflict(files)) return stop(`A real conflict (${files.length} file${files.length === 1 ? "" : "s"}) – it needs your call.`);
    const blocks = files.map((f) => `### ${f.path}\n${untrusted(`conflict:${f.path}`, truncate(fs.readFileSync(path.join(wt, f.path), "utf8"), 8000))}`).join("\n\n");
    await ctx.agent("implementer", [
      `The pull request branch could not be merged with ${r.base} automatically. Resolve ONLY the merge conflicts below in the current directory.`,
      "Keep the intent of both sides; remove every conflict marker (<<<<<<<, =======, >>>>>>>); change nothing else; do not commit.",
      blocks,
    ].join("\n\n"), { cwd: wt, tools: ["Read", "Edit", "Write", "Grep", "Glob"], maxTurns: 20 });
    const left = files.filter((f) => { try { return MARKERS.test(fs.readFileSync(path.join(wt, f.path), "utf8")); } catch { return true; } });
    if (left.length) return stop("I could not resolve every conflict safely.");
    G.git(wt, ["add", "-A"]);
    G.git(wt, ["commit", "--no-edit", "--quiet"]);
    const test = ctx.project.local.testCommand;
    if (test) {
      const t = await G.runCommand(test, wt, 15 * 60_000).catch((e: any) => ({ code: 1, output: String(e?.message ?? e) }));
      if (t.code !== 0) {
        G.git(wt, ["reset", "--hard", before], { allowFail: true });
        await tell(ctx, `⚠️ PR #${r.num} (${ref}) conflicts with ${r.base}`, `I resolved the conflict in ${names.join(", ")} but the tests then failed, so nothing was pushed. Please resolve it on ${r.branch}.`, r.url);
        return { status: "done", note: "tests failed after resolving – told you" };
      }
    }
    ctx.save({ rebase: { ...r, changed: true, resolved: names, how: `merged ${r.base} in, resolved ${names.join(", ")}` } });
    return done(`merged ${r.base} in, ${names.length} conflict(s) resolved`);
  },

  /** Push (never forced): a clean merge or moved local work goes without asking; agent-resolved conflicts are shown first. */
  async rebase_publish(ctx) {
    const r = ctx.task.data.rebase;
    if (!r?.changed) return { status: "done", note: r?.how ?? "nothing to push" };
    const wt: string = r.wt;
    const gh = clients.github();
    if (!gh) return { status: "fail", reason: "GitHub is not connected" };
    const ref = refOf(ctx.task);
    if (r.resolved?.length && !ctx.task.data.directives?.no_approvals) {
      const prev = ctx.task.data.rebaseApprovalId ? getApproval(ctx.task.data.rebaseApprovalId) : undefined;
      if (prev?.state !== "approved") {
        const ap = requestApproval(ctx.task.id, "push_rebase", { repo: r.repo, branch: r.branch, baseSha: r.headSha, headSha: G.headSha(wt), diffHash: G.diffHash(wt, r.headSha) });
        ctx.save({ rebaseApprovalId: ap.id });
        await notify({ kind: "approval_needed", taskId: ctx.task.id, taskRef: ref, approvalId: ap.id, approvalAction: "push_rebase", dedupeKey: ap.id,
          title: `🔀 PR #${r.num}: merged ${r.base} in and resolved ${r.resolved.join(", ")} – push?`, body: `${r.how}. Tests ran here. Reply 1 to push (a normal push, never forced).`, url: r.url });
        return { status: "await_approval", approvalId: ap.id };
      }
      const bind = verifyBinding(prev, wt);
      if (!bind.ok) return { status: "pause", reason: `STALE: ${bind.reason}` };
    }
    const log = G.git(wt, ["log", "--format=%B", `${r.headSha}..HEAD`], { allowFail: true });
    if (attributionHits(log).length) return { status: "fail", reason: "Hard rule: a commit message mentions Claude/AI" };
    try {
      G.git(wt, ["push", "--quiet", G.remoteUrl(r.repo), `HEAD:refs/heads/${r.branch}`], { extraHeader: gh.gitAuthHeader() });   // never forced
    } catch (e: any) {
      await tell(ctx, `⚠️ PR #${r.num} (${ref}) could not be updated`, `The push was refused (the branch moved again, or it is protected). Nothing was forced. ${truncate(e.message ?? "", 200)}`, r.url);
      return { status: "done", note: "push refused – told you" };
    }
    const sha = G.headSha(wt);
    audit("service", "rebase.pushed", ctx.task.id, { repo: r.repo, num: r.num, sha, how: r.how });
    if (r.mode === "conflict") {
      try { G.removeWorktree(ctx.project.local.path, wt); G.git(ctx.project.local.path, ["branch", "-D", ctx.task.branch ?? ""], { allowFail: true }); } catch { /* best effort */ }
      ctx.task = { ...ctx.task, worktree: null, branch: null };
    }
    await tell(ctx, `🔀 PR #${r.num} (${ref}) updated`, `${r.how[0].toUpperCase()}${r.how.slice(1)}; pushed ${sha.slice(0, 7)} (normal push, nothing merged).`, r.url, "info");
    // CI runs again on the new head
    try { const { watchCi } = await import("../prFix.js"); watchCi({ projectId: ctx.project.id, repo: r.repo, num: r.num, sha, by: "you", via: "teams-personal", round: 1 }); } catch { /* optional */ }
    return { status: "done", note: `pushed ${sha.slice(0, 7)}` };
  },
};

async function tell(ctx: StepCtx, title: string, body: string, url?: string, kind = "failed"): Promise<void> {
  await notify({ kind, taskId: ctx.task.id, taskRef: refOf(ctx.task), dedupeKey: `rebase:${title}`, title, body, url }).catch(() => {});
}
