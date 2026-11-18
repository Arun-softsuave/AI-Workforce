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
import { mergeData, getTask } from "../tasks.js";
import { truncate } from "../../core/util.js";
import { clients } from "../../connectors/registry.js";
import * as G from "../../git/git.js";
import { attributionHits, attributionInDiff } from "../../core/attribution.js";
import { requestApproval, getApproval, decide, verifyBinding } from "../../approvals/approvals.js";
import { notify } from "../../notify/router.js";
import { untrusted } from "../../agents/runner.js";
import type { ProjectConfig } from "../../core/config.js";
import { commitMessageFor } from "../../brain/conventions.js";
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
/** Recorded expected output (baselines, golden files, cassettes, snapshots): a person decides what is right, always. */
const RECORDED = /(^|\/)(baselines?|golden|goldens|cassettes?|__snapshots__|snapshots)(\/|$)|\.snap$/i;

/** Why a conflicted file must stay with you even when you asked the plugin to resolve everything, or undefined. */
export function mustStayWithYou(p: string): string | undefined {
  if (NEVER_SIMPLE.test(p)) return /\.lock$|lock\.json$|lock\.yaml$|go\.sum$/i.test(p) ? "lock file – regenerate it with the package manager" : "binary file";
  if (RECORDED.test(p)) return "recorded expected output – a person decides which version is right";
  return undefined;
}

/** The checks a git hook (pre-commit) reported as failed, from git's error text. */
export function failedHooks(text: string): string[] {
  return [...new Set(String(text ?? "").split("\n")
    .map((l) => /^(.+?)\.{3,}\s*Failed\b/.exec(l.trim().replace(/^git \S+ failed:\s*/i, ""))?.[1]?.trim())
    .filter((x): x is string => !!x))];
}

/**
 * Messages for the merge commit, best first: the team's own commit convention, then a plain Conventional Commit.
 * git's default ("Merge commit 'refs/aiw/base/dev' into …") is refused by commit-message hooks (Conventional Commit).
 */
export function mergeMessages(project: Pick<ProjectConfig, "conventions">, task: { source_ref?: string | null; data?: Record<string, any> }, base: string, branch: string): string[] {
  const key0 = String(task.data?.ticket?.key ?? task.source_ref ?? "").split("@")[0];
  const key = /^[A-Z][A-Z0-9]+-\d+$/.test(key0) && !/^(PR|FIX|QA|CI)-/.test(key0) ? key0 : "";
  const summary = `merge ${base} into ${branch}`;
  const own = commitMessageFor(project.conventions as any, key, "chore", summary, []);
  return [...new Set([own, `chore: ${summary}`].filter(Boolean))];
}

/** Your explicit order on this job: "resolve the conflicts yourself" (payload.resolveAll). */
function resolveAllOrdered(ctx: StepCtx): boolean {
  return jobEvents(runningJob(ctx.task.id)).some((e) => e.type === "user_command" && e.payload.command === "rebase" && e.payload.resolveAll === true);
}

/** Remember on the ticket whether its PR still conflicts (for "is it resolved?" and the "no conflicts now" line). */
export function recordConflict(itemId: string, c: { state: "open" | "resolved"; num?: number; base?: string; files?: string[]; why?: string }): void {
  try { mergeData(itemId, { conflict: { ...c, at: new Date().toISOString() } }); } catch { /* the item is gone */ }
}

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
    // M7 hard rail: a PR whose head IS a protected branch (dev → main release PRs, hotfix branches …) is never pushed to
    const { isProtectedBranch } = await import("../../policy/gate.js");
    if (isProtectedBranch(pr.headRef)) {
      await tell(ctx, `⚠️ PR #${pr0.num}: I don't update ${pr.headRef}`, `PR #${pr0.num} comes from ${pr.headRef}, a protected branch – I never push to it. Bring ${pr.baseRef} into it yourself if needed.`, pr.url);
      return { status: "done", note: `head ${pr.headRef} is protected – told you` };
    }
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
      // (a job's view hides the item's folder – read it from the item itself)
      const own = ctx.task.worktree ?? getTask(ctx.task.id)?.worktree ?? undefined;
      const wt = own && fs.existsSync(own) ? own : undefined;
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
    // a retry of this step must start clean: an earlier attempt may have stopped mid-merge (e.g. a hook refused the
    // commit after the conflicts were resolved). Never commit leftovers that were not checked again.
    if (G.git(wt, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFail: true })) {
      G.git(wt, ["merge", "--abort"], { allowFail: true });
      G.git(wt, ["reset", "--hard", "HEAD"], { allowFail: true });
    }
    const before = G.headSha(wt);
    const messages = mergeMessages(ctx.project, ctx.task as any, r.base, r.branch);
    let mergeError = "";
    for (const msg of messages) {
      mergeError = "";
      try { G.git(wt, ["merge", "--no-ff", "-m", msg, r.baseRefName]); break; } catch (e: any) { mergeError = String(e?.message ?? e); }
      // file conflicts: handled below. A refused merge commit (a hook on the message): try the next message once.
      const conflicted = G.git(wt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).trim();
      if (conflicted) break;
      G.git(wt, ["merge", "--abort"], { allowFail: true });
      G.git(wt, ["reset", "--hard", before], { allowFail: true });
    }
    if (!mergeError) {
      const changed = G.headSha(wt) !== before;
      ctx.save({ rebase: { ...r, changed, how: changed ? `merged ${r.base} in (no conflicts)` : "already up to date" } });
      return done(changed ? `merged ${r.base} in` : "already up to date");
    }
    const names = G.git(wt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).split("\n").map((s) => s.trim()).filter(Boolean);

    // No file conflicts: the merge itself worked but the merge COMMIT was refused – almost always the team's git hook
    // (pre-merge-commit / pre-commit). It is told as what it is – a hook, not a conflict. It is never skipped or worked
    // around (finishing the merge with a plain commit would not run the merge hook again).
    if (!names.length) {
      G.git(wt, ["merge", "--abort"], { allowFail: true });
      const hooks = failedHooks(mergeError);
      const what = hooks.length
        ? `Merging ${r.base} in has no file conflicts, but your git hook failed on the merge commit: ${hooks.join(", ")}.`
        : `Merging ${r.base} in has no file conflicts, but git refused the merge commit: ${truncate(mergeError.split("\n").filter(Boolean).slice(-3).join(" "), 300)}`;
      recordConflict(ctx.task.id, { state: "open", num: r.num, base: r.base, files: [], why: hooks.length ? `git hook failed: ${hooks.join(", ")}` : "git refused the merge commit" });
      await tell(ctx, `⚠️ PR #${r.num} (${ref}): git hook stopped the update from ${r.base}`, `${what}\n\nNothing was pushed and the hook was not skipped. Fix what the hook reports on ${r.branch}, or tell me what to change.`, r.url);
      audit("service", "rebase.hook_failed", ctx.task.id, { hooks, error: truncate(mergeError, 500) });
      return { status: "done", note: hooks.length ? `git hook failed (${hooks.join(", ")}) – told you` : "merge commit refused – told you" };
    }

    // conflicts: simple ones are resolved by the agent; bigger ones only on your explicit order ("resolve them yourself")
    const files: ConflictFile[] = names.map((p) => { let t = ""; try { t = fs.readFileSync(path.join(wt, p), "utf8"); } catch { /* binary or gone */ } return { path: p, ...conflictStats(t) }; });
    const stop = async (why: string, list: string[] = names) => {
      G.git(wt, ["merge", "--abort"], { allowFail: true });
      recordConflict(ctx.task.id, { state: "open", num: r.num, base: r.base, files: names, why });
      await tell(ctx, `⚠️ PR #${r.num} (${ref}) conflicts with ${r.base}`, `${why}\n\n${list.map((n) => `- ${n}`).join("\n")}\n\nNothing was pushed. Resolve it on ${r.branch}, or tell me how to resolve it.`, r.url);
      audit("service", "rebase.conflict", ctx.task.id, { files: names, why });
      return { status: "done", note: "real conflict – told you" } as StepResult;
    };
    const ordered = resolveAllOrdered(ctx);
    const simple = isSimpleConflict(files);
    if (!simple && !ordered) {
      return stop(`A real conflict (${files.length} file${files.length === 1 ? "" : "s"}) – too big for me to resolve without your OK. Say "resolve the conflicts on PR ${r.num} yourself" and I'll resolve them, run the tests and show you the result before anything is pushed.`);
    }
    if (!simple) {
      // even on your order, lock files, binaries and recorded expected output stay with you
      const yours = names.map((n) => ({ n, why: mustStayWithYou(n) })).filter((x) => x.why);
      if (yours.length) {
        return stop(`I can resolve ${names.length - yours.length} of the ${names.length} conflicted files, but these must be yours, so I stopped before changing anything:`,
          yours.map((x) => `${x.n} – ${x.why}`));
      }
    }
    const big = !simple;
    const blocks = big
      ? `Conflicted files (${names.length}) – open each one with Read:\n${names.map((n) => `- ${n}`).join("\n")}`
      : files.map((f) => `### ${f.path}\n${untrusted(`conflict:${f.path}`, truncate(fs.readFileSync(path.join(wt, f.path), "utf8"), 8000))}`).join("\n\n");
    await ctx.agent("implementer", [
      `The pull request branch could not be merged with ${r.base} automatically. Resolve ONLY the merge conflicts in the current directory.`,
      "Keep the intent of both sides (this PR's change AND what landed on the base); remove every conflict marker (<<<<<<<, =======, >>>>>>>); change nothing else; do not commit.",
      big ? "Read the surrounding code and the base branch's version of each changed function before choosing; when both sides changed the same lines, combine them so both behaviours remain." : "",
      blocks,
    ].filter(Boolean).join("\n\n"), { cwd: wt, tools: ["Read", "Edit", "Write", "Grep", "Glob"], maxTurns: big ? 60 : 20 });
    const left = files.filter((f) => { try { return MARKERS.test(fs.readFileSync(path.join(wt, f.path), "utf8")); } catch { return true; } });
    // M4: what the agent wrote into the resolved files must not mention AI / Claude (hard rule)
    const marks = attributionInDiff(G.git(wt, ["diff", "HEAD", "--", ...names], { allowFail: true }));
    if (marks.length) return stop(`The resolution mentioned AI authorship, so I stopped before committing (${marks.slice(0, 3).map((m) => m.file).join(", ")}).`);
    if (left.length) return stop(`I could not resolve every conflict safely (${left.length} file${left.length === 1 ? "" : "s"} still have conflict markers).`, left.map((f) => f.path));
    let commitError = "";
    for (const msg of messages) {
      try { G.git(wt, ["add", "-A"]); G.git(wt, ["commit", "--quiet", "-m", msg]); commitError = ""; break; } catch (e: any) { commitError = String(e?.message ?? e); }
    }
    if (commitError) {
      const hooks = failedHooks(commitError);
      return stop(hooks.length ? `I resolved the conflicts, but your git hook failed on the merge commit (${hooks.join(", ")}), so I stopped.` : "I resolved the conflicts, but git refused the merge commit, so I stopped.");
    }
    const test = ctx.project.local.testCommand;
    if (test) {
      const t = await G.runCommand(test, wt, 15 * 60_000).catch((e: any) => ({ code: 1, output: String(e?.message ?? e) }));
      if (t.code !== 0) {
        G.git(wt, ["reset", "--hard", before], { allowFail: true });
        recordConflict(ctx.task.id, { state: "open", num: r.num, base: r.base, files: names, why: "tests failed after resolving" });
        await tell(ctx, `⚠️ PR #${r.num} (${ref}) conflicts with ${r.base}`, `I resolved the conflict in ${names.join(", ")} but the tests then failed, so nothing was pushed. Please resolve it on ${r.branch}.`, r.url);
        return { status: "done", note: "tests failed after resolving – told you" };
      }
    }
    ctx.save({ rebase: { ...r, changed: true, resolved: names, big, how: `merged ${r.base} in, resolved ${names.length > 4 ? `${names.length} files` : names.join(", ")}` } });
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
    // conflicts the agent resolved are shown first; bigger ones (resolved on your order) ALWAYS, even under "no approvals"
    if (r.resolved?.length && (r.big || !ctx.task.data.directives?.no_approvals)) {
      const prev = ctx.task.data.rebaseApprovalId ? getApproval(ctx.task.data.rebaseApprovalId) : undefined;
      if (prev?.state !== "approved") {
        const ap = requestApproval(ctx.task.id, "push_rebase", { repo: r.repo, branch: r.branch, baseSha: r.headSha, headSha: G.headSha(wt), diffHash: G.diffHash(wt, r.headSha) });
        ctx.save({ rebaseApprovalId: ap.id });
        await notify({ kind: "approval_needed", taskId: ctx.task.id, taskRef: ref, approvalId: ap.id, approvalAction: "push_rebase", dedupeKey: ap.id,
          title: `🔀 PR #${r.num}: merged ${r.base} in and resolved ${r.resolved.length} conflicted file${r.resolved.length === 1 ? "" : "s"} – push?`, body: `${r.resolved.map((n: string) => `- ${n}`).join("\n")}\n\n${ctx.project.local.testCommand ? "The tests passed here." : "No test command is set for this project, so no tests ran here – please look at the change."} Reply 1 to push (a normal push, never forced), or 2 to drop it.`, url: r.url });
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
    recordConflict(ctx.task.id, { state: "resolved", num: r.num, base: r.base, files: r.resolved ?? [] });
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
