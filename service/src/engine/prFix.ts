import fs from "node:fs";
import { getProject, loadSettings, engineVersion, type ProjectConfig } from "../core/config.js";
import { truncate } from "../core/util.js";
import { audit, getMeta, setMeta } from "../core/db.js";
import { untrusted } from "../agents/runner.js";
import { clients } from "../connectors/registry.js";
import type { PrReviewInfo } from "../connectors/github.js";
import * as G from "../git/git.js";
import { scanDiff } from "../git/secretScan.js";
import { buildContextPack } from "../brain/brain.js";
import { stripAttribution, attributionHits, attributionInDiff } from "../core/attribution.js";
import { requestApproval, latestApproval, verifyBinding, decide } from "../approvals/approvals.js";
import { notify } from "../notify/router.js";
import { normaliseQuestions } from "../core/questions.js";
import { createTask, getTask, listTasks, transition, updateTask, type Task } from "./tasks.js";
import { STEPS, ticketBlock, contractText, markUntested, clarifyRoundsLeft, costText, type StepCtx, type StepResult } from "./steps.js";
import { myLogin, resolvePrTargets, findTicketPrs, projectForRepo, type PrTarget } from "./targets.js";

/**
 * Fix the review comments and failing CI checks on a pull request (or the GitHub issues QA found) – for any developer, on
 * their own PR. After the push, CI is watched until every check passes; a check that fails again starts the next round.
 *   collect the open comments → decide each one with the Brain, ticket, PRD and code (fix / answer / disagree / other repo /
 *   ask the human) → change the code in the PR's branch → checks, tests, review → SHOW the developer → after their OK:
 *   push to the same PR, reply in each thread → QA runs on the updated PR.
 * Nothing is pushed or posted without the developer's approval; threads are not resolved (the reviewer does that); never merged.
 */

export interface FixItem {
  n: number; kind: "thread" | "comment" | "issue" | "request" | "check";
  id: string;                 // thread id, conversation comment id, issue number or request id – never handled twice
  replyTo?: number;           // review comment to reply under (threads)
  issue?: number;             // GitHub issue (QA findings)
  check?: string;             // failing CI check name
  path?: string; line?: number | null; author: string; body: string; url?: string;
}

const handledKey = (repo: string, num: number) => `fix.handled:${repo.toLowerCase()}#${num}`;
const handled = (repo: string, num: number): string[] => { try { return JSON.parse(getMeta(handledKey(repo, num)) ?? "[]"); } catch { return []; } };

/** Was this PR raised by this plugin (so it is this developer's work even if GitHub shows another login)? */
function raisedHere(repo: string, num: number): boolean {
  return listTasks({ limit: 2000 }).some((t) => [t.data.pr, ...(t.data.prs ?? [])].some((p: any) => p?.number === num && (p.repo ?? getProject(t.project_id)?.github?.repo)?.toLowerCase() === repo.toLowerCase()));
}

// ------------------------------------------------------------------ starting a fix

/** comments = review comments AND failing CI checks · ci = failing CI checks only · issues = QA's GitHub issues */
export type FixMode = "comments" | "issues" | "ci";

export function startFixTask(project: ProjectConfig, repo: string, num: number, by: string, via: string, opts: { mode?: FixMode; issues?: number[]; requests?: string[]; ciRound?: number } = {}): { task: Task; existing: boolean } {
  const sourceId = `fix:${repo}#${num}`;
  const before = listTasks({ states: ["TRIAGED", "QUEUED", "RUNNING", "NEEDS_INFO", "AWAITING_APPROVAL", "PAUSED", "REJECTED", "STALE"] }).find((t) => t.source_id === sourceId);
  if (before) return { task: before, existing: true };
  const t = createTask({ projectId: project.id, source: via, sourceId, sourceRef: `FIX-${num}@${project.id}`, title: `Fixes for ${repo}#${num}`, kind: "pr_fix", state: "TRIAGED",
    data: { fix: { repo, num, by, via, mode: opts.mode ?? "comments", issues: opts.issues ?? [], requests: opts.requests ?? [], ciRound: opts.ciRound ?? 1, requestedAt: new Date().toISOString() } } });
  updateTask(t.id, { playbook: "pr-fix", size: "S" });
  transition(t.id, "QUEUED", `fixes requested by ${by}`);
  audit(`user:${by}`, "fix.requested", t.id, { repo, num, mode: opts.mode ?? "comments" });
  return { task: getTask(t.id)!, existing: false };
}

/** Teams: "resolve the comments on PR 90 / KAN-52", "fix the QA issues on KAN-60". Only the PR's author fixes it. */
export async function startFixFromText(text: string, ticketRef: string | undefined, by: string, mode: FixMode = "comments", via = "teams-personal"): Promise<string> {
  const found = await resolvePrTargets(text, ticketRef);
  if ("error" in found) return `❓ ${found.error}`;
  const me = await myLogin();
  const lines: string[] = [];
  let started = 0;
  for (const x of found.targets) {
    let author = x.author;
    if (!author) { try { author = (await clients.github()?.prForReview?.(x.repo, x.num))?.author; } catch { /* checked again when it runs */ } }
    if (author && me && author.toLowerCase() !== me.toLowerCase() && !raisedHere(x.repo, x.num)) {
      lines.push(`- PR #${x.num} (${x.project.id}) is ${author}'s – only its author pushes fixes. I can review it instead: "review PR ${x.num} ${x.project.id}".`);
      continue;
    }
    const issues = mode === "issues" ? qaIssuesOf(x) : [];
    if (mode === "issues" && !issues.length) { lines.push(`- PR #${x.num} (${x.project.id}): no open QA issues I created for it.`); continue; }
    const { task, existing } = startFixTask(x.project, x.repo, x.num, by, via, { mode, issues });
    if (!existing) started++;
    lines.push(existing ? `- PR #${x.num} (${x.project.id}) – already in progress (${task.source_ref})` : `- PR #${x.num} in ${x.repo} – ${task.source_ref}`);
  }
  const what = mode === "issues" ? "the QA issues" : mode === "ci" ? "the failing CI checks" : "the review comments and failing CI checks";
  const how = mode === "issues" ? "every issue" : mode === "ci" ? "every failing check's log" : "every comment and failing check";
  return `🛠️ **Fixing ${what}**\n\n${lines.join("\n")}${started ? `\n\nI'll read ${how} with the ticket, the PRD and the code, make the changes and run the checks here, then show you everything before anything is pushed or replied. After the push I watch CI until every check passes – if one fails again, I fix it again (shown to you each time).` : ""}`;
}

/** Issues the QA engineer created for a PR (still open). */
function qaIssuesOf(x: PrTarget): number[] {
  return listTasks({ limit: 2000 }).filter((t) => t.kind === "pr_qa" && t.data.qa?.repo === x.repo && t.data.qa?.num === x.num)
    .flatMap((t) => (t.data.qaPublished?.issues ?? []).map((i: any) => i.number as number));
}

// ------------------------------------------------------------------ steps

const ICON: Record<string, string> = { fix: "✅ fixed", answer: "💬 answered", disagree: "⚖️ disagreed", other_repo: "↪️ other repository", needs_decision: "❓ your decision", skip: "➖ skipped" };

export const FIX_STEPS: Record<string, (ctx: StepCtx) => Promise<StepResult>> = {
  /** Read the PR and its open comments; check the PR's branch out into this task's own folder. */
  async fix_prepare(ctx) {
    const f = ctx.task.data.fix;
    if (ctx.task.worktree && fs.existsSync(ctx.task.worktree) && ctx.task.data.baseSha && ctx.task.data.fixItems) return { status: "ok", note: "workspace reused" };
    const gh = clients.github();
    if (!gh?.prForReview) return { status: "fail", reason: "GitHub is not connected" };
    const pr = await gh.prForReview(f.repo, f.num);
    if (pr.merged || pr.state !== "open") return { status: "fail", reason: `PR #${f.num} is ${pr.merged ? "merged" : pr.state} – nothing to fix` };
    if (pr.headRepo && pr.headRepo.toLowerCase() !== f.repo.toLowerCase()) return { status: "fail", reason: `PR #${f.num} comes from a fork (${pr.headRepo}) – its branch can't be pushed from here` };
    const me = await myLogin();
    if (me && pr.author.toLowerCase() !== me.toLowerCase() && !raisedHere(f.repo, f.num)) return { status: "fail", reason: `PR #${f.num} is ${pr.author}'s – only its author pushes fixes. Say "review PR ${f.num}" to review it instead.` };

    // what is still open
    const done = new Set(handled(f.repo, f.num));
    const items: FixItem[] = [];
    const push = (x: Omit<FixItem, "n">) => { if (!done.has(x.id)) items.push({ ...x, n: items.length + 1 }); };
    const notMe = (a: string) => !!a && (!me || a.toLowerCase() !== me.toLowerCase()) && !/\[bot\]$/i.test(a);
    if (f.mode === "issues") {
      for (const num of f.issues ?? []) {
        try { const i = await gh.getIssue!(f.repo, num); if (i.state === "open") push({ kind: "issue", id: `i${num}`, issue: num, author: i.author, body: `${i.title}\n\n${i.body}`, url: i.url }); } catch { /* deleted */ }
      }
    } else {
      for (const t of (await gh.reviewThreads?.(f.repo, f.num)) ?? []) {
        if (t.resolved || !t.comments.length) continue;
        const last = t.comments[t.comments.length - 1];
        if (!notMe(last.author)) continue;                                     // already answered by this developer
        push({ kind: "thread", id: `t${t.id}`, replyTo: t.comments[0].id, path: t.path, line: t.line, author: last.author,
          body: t.comments.map((c) => `${c.author}: ${c.body}`).join("\n---\n"), url: t.comments[0].url });
      }
      for (const c of (await gh.prConversation?.(f.repo, f.num)) ?? []) {
        if (!notMe(c.author) || c.body.trim().length < 3) continue;
        push({ kind: "comment", id: c.id, author: c.author, body: c.body, url: c.url });
      }
    }
    (f.requests ?? []).forEach((r: string, i: number) => push({ kind: "request", id: `r${ctx.task.id}:${i}`, author: "another repository of this ticket", body: r }));
    // the PR's CI: every failing check becomes an item with its failing step, command and log
    let ciPending: string[] = [];
    let ciPassed = 0;
    if (f.mode !== "issues" && gh.prChecks) {
      const checks = await gh.prChecks(f.repo, pr.headSha);
      ciPending = checks.filter((c) => c.state === "pending").map((c) => c.name);
      ciPassed = checks.filter((c) => c.state === "passed").length;
      const failed = checks.filter((c) => c.state === "failed");
      let onBase = new Set<string>();
      if (failed.length) { try { onBase = new Set((await gh.prChecks(f.repo, pr.baseSha)).filter((c) => c.state === "failed").map((c) => c.name)); } catch { /* optional */ } }
      for (const c of failed) {
        let log = "";
        try { log = (await gh.checkFailure?.(f.repo, c)) ?? ""; } catch (e: any) { log = `The log could not be read (${truncate(e.message, 120)}) – open ${c.url}`; }
        push({ kind: "check", id: `c:${c.name}:${pr.headSha.slice(0, 12)}`, check: c.name, author: "CI", url: c.url,
          body: `CI check "${c.name}" failed (${c.conclusion}) on ${pr.headSha.slice(0, 7)}${onBase.has(c.name) ? ` – it ALSO fails on ${pr.baseRef}, so it may be older than this PR` : ""}\n\n${log}` });
      }
    }
    if (!items.length) {
      // nothing to fix yet, but CI is still running: watch it and fix whatever fails
      if (ciPending.length) {
        watchCi({ projectId: ctx.project.id, repo: f.repo, num: f.num, sha: pr.headSha, by: f.by, via: f.via, round: f.ciRound ?? 1 });
        await notify({ kind: "info", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, dedupeKey: `fix-wait:${ctx.task.id}`, title: `⏳ CI is still running on PR #${f.num}`,
          body: `Nothing has failed yet${f.mode === "ci" ? "" : " and no review comment is open"}.\n\n- **Still running:** ${ciPending.join(", ")}\n- **Passed:** ${ciPassed}\n\nI'm watching it. ${loadSettings().pr?.autoFixCi !== false ? "If a check fails I'll fix it, push the fix and tell you" : "If a check fails I'll fix it and show you the fix first"}; if all pass I'll tell you.`, url: pr.url });
        return { status: "done", note: `CI running (${ciPending.length}) – watching` };
      }
      const none = f.mode === "issues" ? "The QA issues are already closed or handled."
        : f.mode === "ci" ? `Every CI check passes (${ciPassed}).`
        : `Every review comment is resolved or already answered, and every CI check passes (${ciPassed}).`;
      await notify({ kind: "info", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, dedupeKey: `fix-none:${ctx.task.id}`, title: `👍 Nothing to fix on PR #${f.num}`, body: none, url: pr.url });
      return { status: "done", note: "nothing open" };
    }

    // the PR's branch, in this task's own folder (a local branch of its own; the push goes to the PR's branch)
    const repo = ctx.project.local.path;
    const ref = `refs/aiw/fix/${f.num}`;
    G.git(repo, ["fetch", "--quiet", "--force", G.remoteUrl(f.repo), `+refs/heads/${pr.headRef}:${ref}`], { extraHeader: gh.gitAuthHeader() });
    const sha = G.git(repo, ["rev-parse", ref]);
    G.git(repo, ["fetch", "--quiet", G.remoteUrl(f.repo), `+refs/heads/${pr.baseRef}:refs/aiw/base/${pr.baseRef}`], { extraHeader: gh.gitAuthHeader(), allowFail: true });
    const branch = G.uniqueBranch(repo, `aiw-fix/${f.num}`);
    const wt = G.createWorktree(repo, ctx.project.id, ctx.task.id, branch, sha, ctx.project.conventions?.env?.linkedDirs ?? []);
    ctx.task = { ...ctx.task, worktree: wt, branch };

    // the ticket behind the PR (title / branch / description), and the lead's contract when it is a multi-repo ticket
    const keys = ctx.project.jira?.keys ?? [];
    const key = (keys.length ? new RegExp(`\\b(${keys.join("|")})-\\d+\\b`, "i") : /\b[A-Z][A-Z0-9]+-\d+\b/).exec(`${pr.title} ${pr.headRef} ${pr.body}`)?.[0]?.toUpperCase();
    let ticket: any = { key: key ?? `PR-${f.num}`, title: pr.title, description: pr.body };
    if (key) { try { const i = await clients.jira()?.getIssue(key); if (i) ticket = { key: i.key, title: i.title, description: i.description, url: i.url, comments: i.comments ?? [] }; } catch { /* optional */ } }
    const lead = key ? listTasks({ limit: 2000 }).find((t) => t.playbook === "dev-lead" && (t.data.ticket?.key ?? "").toUpperCase() === key && t.data.contract) : undefined;

    // tests that can't run on this computer don't stop the work (same rule as building a ticket)
    const env = ctx.project.conventions?.env;
    const testCmd = ctx.project.local.testCommand;
    // (same rule as building a ticket: a stale "broken" note doesn't count when a working Python is found for the repo)
    const { isPythonBackend, findPython } = await import("./localStack.js");
    if (env?.brokenPython && (!testCmd || testCmd.includes(env.brokenPython)) && !(isPythonBackend(repo) && findPython(repo))) markUntested(ctx, "the project's Python environment can't start on this computer");

    let budget = 120_000;
    const files = pr.files.map((x) => { const patch = x.patch ? truncate(x.patch, Math.max(0, Math.min(15_000, budget))) : undefined; budget -= patch?.length ?? 0; return { ...x, patch }; });
    ctx.save({ ciPending, prInfo: { ...pr, files }, fixItems: items, baseSha: sha, prHeadRef: pr.headRef, ticket, contract: lead?.data.contract ?? null, worktreePath: wt, branchName: branch });
    return { status: "ok", note: `${items.length} open item(s) on ${pr.headRef}` };
  },

  /** Decide every item from the Brain, ticket, PRD and code; ask the developer only for real product decisions. */
  async fix_plan(ctx) {
    const d = ctx.task.data;
    const pr: PrReviewInfo = d.prInfo;
    const items: FixItem[] = d.fixItems ?? [];
    const others = (getProject(ctx.project.id)?.group ? (await import("./routing.js")).groupMembers(ctx.project) : [ctx.project]).filter((p) => p.id !== ctx.project.id);
    const brain = buildContextPack(ctx.project.id, `${d.ticket?.title ?? ""}\n${d.ticket?.description ?? ""}\n${items.map((i) => i.body).join("\n")}`, 8000).text;
    const diff = truncate(G.git(ctx.task.worktree!, ["diff", `refs/aiw/base/${pr.baseRef}...HEAD`], { allowFail: true }) || pr.files.map((x) => `### ${x.path}\n${x.patch ?? ""}`).join("\n\n"), 30_000);
    const list = items.map((i) => `**${i.n}.** ${i.kind === "issue" ? `QA issue #${i.issue}` : i.kind === "check" ? `failing CI check "${i.check}"` : i.kind === "thread" ? `on \`${i.path}\`${i.line ? ` line ${i.line}` : ""}` : i.kind === "request" ? "request from the other repository" : "general comment"} – ${i.author}\n${untrusted(`comment:${i.id}`, truncate(i.body, i.kind === "check" ? 14_000 : 3000))}`).join("\n\n");
    const prompt = [
      ticketBlock(ctx.task),
      `## Product requirements and project knowledge (PRD sections, standards, past tasks)\n${brain}`,
      d.contract ? `## Contract between the repositories\n${contractText(d.contract)}` : "",
      others.length ? `## Other repositories of this product (read-only, for context)\n${others.map((o) => `- ${o.id}: ${o.local.path}`).join("\n")}` : "",
      `## The pull request #${pr.number}: ${pr.title}\n${untrusted(`pr-description:${pr.number}`, truncate(pr.body, 3000))}\n\n## Its change\n${untrusted("diff", diff)}`,
      `## Items to handle (${items.length})\n${list}`,
      (d.feedback ?? []).length ? `## What the developer wants changed in your previous decisions\n${d.feedback.map((x: string) => `- ${x}`).join("\n")}` : "",
      "The PR's code is the current directory (read-only in this step). Do not modify anything.",
    ].filter(Boolean).join("\n\n");
    const r = await ctx.agent("comment-resolver", prompt, { cwd: ctx.task.worktree!, dirs: others.map((o) => o.local.path).filter((p) => fs.existsSync(p)), tools: ["Read", "Grep", "Glob"], maxTurns: 30 });
    const decisions = (r.data.items ?? []).filter((x: any) => items.some((i) => i.n === x.n));
    const ask = decisions.filter((x: any) => x.action === "needs_decision" && x.question);
    if (ask.length && clarifyRoundsLeft(ctx.task, ctx.settings) > 0) {
      ctx.save({ fixPlan: { summary: r.data.summary, items: decisions } });
      return { status: "need_info", questions: normaliseQuestions(ask.map((x: any) => ({ question: `Comment ${x.n} (${items.find((i) => i.n === x.n)?.author}): ${x.question}`, options: x.options ?? [] })), 3), context: `While working through the comments on PR #${pr.number}` };
    }
    // still undecided after the questions: use the recommended option and say so
    const final = decisions.map((x: any) => (x.action === "needs_decision" ? { ...x, action: "fix", instruction: `${x.instruction || x.question} – use the recommended option: ${(x.options ?? [])[0] ?? "the safest choice"}`, reply: x.reply || "Changed as discussed." } : x));
    // a fix that belongs in another repository of the ticket: that repository's PR gets it as a request
    const cross: string[] = [];
    for (const x of final.filter((y: any) => y.action === "other_repo" && y.otherRepo)) {
      const target = (await findTicketPrs(d.ticket?.key ?? "")).find((p) => p.project.id === x.otherRepo || p.repo.toLowerCase().endsWith(`/${x.otherRepo}`.toLowerCase()));
      if (target && target.repo.toLowerCase() !== d.fix.repo.toLowerCase()) {
        const { task } = startFixTask(target.project, target.repo, target.num, d.fix.by, d.fix.via, { requests: [`From the review of ${d.fix.repo}#${d.fix.num}: ${x.instruction}`] });
        cross.push(`${x.otherRepo}: ${task.source_ref}`);
      } else cross.push(`${x.otherRepo}: no open PR found – change it there yourself`);
    }
    const fixes = final.filter((x: any) => x.action === "fix");
    ctx.save({
      fixPlan: { summary: r.data.summary, items: final, cross },
      plan: { summary: items.every((i) => i.kind === "check") ? `Make the failing CI checks pass on PR #${pr.number}` : `Address the review feedback on PR #${pr.number}`, steps: fixes.map((x: any) => { const i = items.find((y) => y.n === x.n)!; return `Item ${x.n}${i.check ? ` (CI check "${i.check}")` : i.path ? ` (${i.path}${i.line ? `:${i.line}` : ""})` : ""}: ${x.instruction}`; }), files: [], tests: ["Add or update tests for every behaviour change"], risks: [] },
      requirements: { acceptanceCriteria: fixes.map((x: any) => `Item ${x.n} is addressed: ${x.instruction}`) },
      contextPack: brain,
      // the implementer gets the failing CI output itself, not only the instruction
      ciFailures: items.filter((i) => i.kind === "check" && fixes.some((x: any) => x.n === i.n)).map((i) => truncate(i.body, 8000)),
    });
    return { status: "ok", note: `${fixes.length} to fix, ${final.length - fixes.length} replies only` };
  },

  /** Make the code changes (the normal implement + test loop), only when something needs a change. */
  async fix_apply(ctx) {
    if (!(ctx.task.data.fixPlan?.items ?? []).some((x: any) => x.action === "fix")) return { status: "ok", note: "no code change needed" };
    if (G.headSha(ctx.task.worktree!) !== ctx.task.data.baseSha && ctx.task.data.implementation && !(ctx.task.data.feedback ?? []).length) return { status: "ok", note: "already changed" };
    return STEPS.implement_test(ctx);
  },

  async fix_review(ctx) {
    if (G.headSha(ctx.task.worktree!) === ctx.task.data.baseSha) return { status: "ok", note: "no code change" };
    return STEPS.reviews(ctx);
  },

  /** Show the developer everything: per comment what was done and the reply; the change; the checks. */
  async fix_gate(ctx) {
    const a = latestApproval(ctx.task.id);
    if (a?.action === "push_fixes" && a.state === "approved") return { status: "ok", note: "approved" };
    const wt = ctx.task.worktree!;
    const d = ctx.task.data;
    const binding = { repo: d.fix.repo, branch: d.prHeadRef, baseSha: d.baseSha, headSha: G.headSha(wt), diffHash: G.diffHash(wt, d.baseSha) };
    const ap = requestApproval(ctx.task.id, "push_fixes", binding);
    const pr: PrReviewInfo = d.prInfo;
    // your preference: CI failures are fixed and pushed without asking (the same checks, tests and reviews ran first)
    if (d.fix?.mode === "ci" && loadSettings().pr?.autoFixCi !== false && !(d.fixItems ?? []).some((i: any) => i.action === "needs_decision")) {
      decide(ap.id, "approved", "policy:auto-fix-ci", "policy");
      return { status: "ok", note: "CI fix pushed without asking (your preference)" };
    }
    await notify({ kind: "approval_needed", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, approvalId: ap.id, approvalAction: "push_fixes", dedupeKey: ap.id,
      title: `🛠️ Fixes for PR #${pr.number} ready – ${ctx.project.id}`, body: fixPreview(getTask(ctx.task.id)!), url: pr.url });
    return { status: "await_approval", approvalId: ap.id };
  },

  /** Push to the same PR and reply in each thread (never resolves threads, never merges); then QA runs. */
  async fix_publish(ctx) {
    const a = latestApproval(ctx.task.id);
    if (!a || a.state !== "approved" || a.action !== "push_fixes") return { status: "fail", reason: "No approval to push the fixes" };
    const wt = ctx.task.worktree!;
    const bind = verifyBinding(a, wt);
    if (!bind.ok) return { status: "pause", reason: `STALE: ${bind.reason}` };
    const gh = clients.github();
    if (!gh) return { status: "fail", reason: "GitHub is not connected" };
    const d = ctx.task.data;
    const url = G.remoteUrl(d.fix.repo);
    const changed = G.headSha(wt) !== d.baseSha;
    let pushed = "";
    let pushedSha = "";
    if (changed) {
      // someone pushed to the PR meanwhile: put these fixes on top (no force push); a conflict stops here
      const remote = G.git(ctx.project.local.path, ["ls-remote", url, `refs/heads/${d.prHeadRef}`], { extraHeader: gh.gitAuthHeader(), allowFail: true }).split(/\s+/)[0];
      if (remote && remote !== d.baseSha) {
        G.git(wt, ["fetch", "--quiet", url, `refs/heads/${d.prHeadRef}`], { extraHeader: gh.gitAuthHeader() });
        if (!G.rebaseOnto(wt, "FETCH_HEAD")) return { status: "pause", reason: `The PR's branch got new commits that conflict with these fixes. Resolve in ${wt} and say "resume ${ctx.task.source_ref}".` };
      }
      const diff = G.diffAgainst(wt, d.baseSha);
      const marks = attributionInDiff(diff);
      if (marks.length) return { status: "fail", reason: `Hard rule: the change mentions Claude/AI – ${marks.slice(0, 3).map((m) => `${m.file}: "${m.line}"`).join("; ")}` };
      const log = G.git(wt, ["log", "--format=%an <%ae>%n%B", `${d.baseSha}..HEAD`], { allowFail: true });
      if (attributionHits(log).length) return { status: "fail", reason: "Hard rule: a commit message mentions Claude/AI" };
      const secrets = scanDiff(diff);
      if (secrets.length) return { status: "fail", reason: `Possible secrets in the change: ${secrets.map((s) => `${s.rule} in ${s.file}`).join(", ")}` };
      G.git(wt, ["push", "--quiet", url, `HEAD:refs/heads/${d.prHeadRef}`], { extraHeader: gh.gitAuthHeader() });   // never forced
      pushedSha = G.headSha(wt);
      pushed = pushedSha.slice(0, 7);
    }
    // replies: under each review thread; one PR comment for the general comments; on each QA issue
    const items: FixItem[] = d.fixItems ?? [];
    const plan: any[] = d.fixPlan?.items ?? [];
    const general: string[] = [];
    const posted: string[] = [];
    const ids: string[] = [];
    for (const x of plan) {
      const i = items.find((y) => y.n === x.n);
      if (!i) continue;
      ids.push(i.id);
      if (x.action === "skip" || !x.reply?.trim()) continue;
      const reply = stripAttribution(`${x.reply.trim()}${x.action === "fix" && pushed ? ` (${pushed})` : ""}`);
      if (attributionHits(reply).length) continue;
      if (i.kind === "thread" && i.replyTo && gh.replyToReviewComment) { await gh.replyToReviewComment(d.fix.repo, d.fix.num, i.replyTo, reply); posted.push(`thread ${x.n}`); }
      else if (i.kind === "issue" && i.issue && gh.commentOnIssue) { await gh.commentOnIssue(d.fix.repo, i.issue, `${reply}\n\nIn PR #${d.fix.num}.`); posted.push(`issue #${i.issue}`); }
      else if (i.kind === "comment") general.push(`- @${i.author}: ${reply}`);
      // a CI check has nobody to reply to: the re-run of CI is the answer
    }
    if (general.length && gh.commentOnPr) { await gh.commentOnPr(d.fix.repo, d.fix.num, stripAttribution(`Thanks for the review – updates:\n${general.join("\n")}`)); posted.push("one general reply"); }
    setMeta(handledKey(d.fix.repo, d.fix.num), JSON.stringify([...new Set([...handled(d.fix.repo, d.fix.num), ...ids])].slice(-500)));
    ctx.save({ fixPublished: { pushed: pushed || null, replies: posted, at: new Date().toISOString() } });
    audit("service", "fix.published", ctx.task.id, { repo: d.fix.repo, num: d.fix.num, pushed, replies: posted.length, approvalId: a.id });
    // clean up this task's folder; the PR branch on GitHub has the change
    try { G.removeWorktree(ctx.project.local.path, wt); G.git(ctx.project.local.path, ["branch", "-D", ctx.task.branch!], { allowFail: true }); } catch { /* best effort */ }
    ctx.task = { ...ctx.task, worktree: null, branch: null };
    // CI runs again on the pushed commit: watch it until every check passes (a failing check starts the next round)
    const newSha = pushedSha;
    const watching = !!(changed && newSha && gh.prChecks);
    if (watching) watchCi({ projectId: ctx.project.id, repo: d.fix.repo, num: d.fix.num, sha: newSha, by: d.fix.by, via: d.fix.via, round: (d.fix.ciRound ?? 1) + 1 });
    const qa = changed && d.fix.mode !== "ci" && loadSettings().workflow.qaAfterFix !== false;
    let qaRef = "";
    if (qa) {
      const { startQaTask } = await import("./qa.js");
      qaRef = startQaTask(ctx.project, d.fix.repo, d.fix.num, d.fix.by, "after the review fixes").task.source_ref ?? "";
    }
    await notify({ kind: "info", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, dedupeKey: `fix-done:${ctx.task.id}:${ctx.task.run_no}`,
      title: `✅ Fixes pushed to PR #${d.fix.num}`,
      body: [
        pushed ? `- **Pushed:** ${pushed} to \`${d.prHeadRef}\` (the same PR – nothing merged)` : "- **No code change** – replies only",
        posted.length ? `- **Replied:** ${posted.join(", ")}` : "",
        items.some((i) => i.kind !== "check") ? "- Threads are left for the reviewer to resolve." : "",
        watching ? "\n🔄 I'm watching CI on the new commit and will tell you when every check passes – or fix it again (shown to you first) if one fails." : "",
        qa ? `\n🧪 QA starts now on the updated PR (${qaRef}). Its results come here first.` : "",
        `\n💰 ${costText(ctx.task)}`,
      ].filter(Boolean).join("\n"),
      url: d.prInfo?.url });
    return { status: "ok", note: pushed || "replies only" };
  },
};

/** What the developer sees before anything is pushed or replied. */
export function fixPreview(t: Task): string {
  const d = t.data;
  const pr: PrReviewInfo | undefined = d.prInfo;
  const items: FixItem[] = d.fixItems ?? [];
  const blocks: string[] = [`**${pr?.title ?? ""}**\n${d.fix.repo}#${d.fix.num} · ${pr?.headRef ?? ""}${d.ticket?.key ? ` · ticket ${d.ticket.key}` : ""}`];
  if (d.fixPlan?.summary) blocks.push(d.fixPlan.summary);
  blocks.push(`**${items.length} item${items.length === 1 ? "" : "s"}**`);
  for (const x of d.fixPlan?.items ?? []) {
    const i = items.find((y) => y.n === x.n);
    if (!i) continue;
    blocks.push([
      `**${x.n}.** ${ICON[x.action] ?? x.action} · ${i.kind === "issue" ? `issue #${i.issue}` : i.kind === "check" ? `CI check "${i.check}"` : i.path ? `\`${i.path}\`${i.line ? ` line ${i.line}` : ""}` : "general"} · ${i.author}`,
      i.kind === "check" ? `"${truncate(i.body.split("\n")[0], 220)}"` : `"${truncate(i.body.split("\n---\n").at(-1)!.replace(/^[^:]{1,40}:\s*/, "").replace(/\s+/g, " "), 220)}"`,
      x.action === "fix" ? `→ Changed: ${x.instruction}` : "",
      x.reason && x.action !== "fix" ? `→ Why: ${x.reason}` : "",
      x.reply ? `→ Reply: "${truncate(x.reply, 300)}"` : "",
    ].filter(Boolean).join("\n"));
  }
  if (d.fixPlan?.cross?.length) blocks.push(`**Other repository**\n${d.fixPlan.cross.map((c: string) => `- ${c}`).join("\n")}`);
  const wt = t.worktree;
  if (wt && fs.existsSync(wt) && G.headSha(wt) !== d.baseSha) {
    const files = G.changedFiles(wt, d.baseSha);
    const stat = G.diffStat(wt, d.baseSha);
    blocks.push(`**📄 Changed files (${files.length}, +${stat.added}/-${stat.removed})**\n${files.slice(0, 20).map((f) => `- ${f}`).join("\n")}`);
  }
  const tests = d.testsUnavailable ? `⚠️ not run on this computer – ${d.testsUnavailable.reason}` : d.tests?.ran ? (d.tests.passed ? "✅ passed" : "❌ failing") : d.implementation ? "no test command" : "no code change";
  const reviews = Object.entries(d.reviews ?? {}).map(([k, v]: any) => `${k} ${v.pass ? "✅" : "⚠️"}`).join(" · ");
  blocks.push(`**🔎 Checks**\n- **Tests:** ${tests}${reviews ? `\n- **Review:** ${reviews}` : ""}`);
  if ((d.ciPending ?? []).length) blocks.push(`⏳ **Still running on GitHub:** ${d.ciPending.join(", ")} – checked again after the push.`);
  const onlyCi = items.every((i) => i.kind === "check");
  blocks.push(onlyCi
    ? "After you approve: the fixes are pushed to the same PR and I watch CI until every check passes. If one fails again, I fix it again and show you first."
    : "After you approve: the fixes are pushed to the same PR, each comment gets its reply, QA runs on the updated PR, and I watch CI until every check passes. Threads are left for the reviewer to resolve.");
  blocks.push(`💰 ${costText(t)}`);
  return blocks.join("\n\n");
}

// ------------------------------------------------------------------ watching CI after a push

/** A PR whose CI is being watched until every check passes. */
interface CiWatch { projectId: string; repo: string; num: number; sha: string; by: string; via: string; round: number; since?: string }

const WATCH_KEY = "fix.ciwatch";
/** At most this many fix rounds for one PR's CI; then the developer is asked to look. */
export const MAX_CI_ROUNDS = 3;

function watches(): CiWatch[] { try { return JSON.parse(getMeta(WATCH_KEY) ?? "[]"); } catch { return []; } }
function saveWatches(w: CiWatch[]) { setMeta(WATCH_KEY, JSON.stringify(w.slice(-50))); }

export function watchCi(w: CiWatch): void {
  saveWatches([...watches().filter((x) => !(x.repo.toLowerCase() === w.repo.toLowerCase() && x.num === w.num)), { ...w, since: new Date().toISOString() }]);
  // engine v2: the PR's item shows a passive ci_watch job while CI is watched
  if (engineVersion() === "v2") void import("../kernel/prs.js").then(({ upsertCiWatchJob }) => upsertCiWatchJob(w)).catch(() => {});
}

/** engine v2: the watch of this PR ended (green, merged, closed or handed to the developer). */
function watchEnded(repo: string, num: number, error?: string): void {
  if (engineVersion() !== "v2") return;
  void import("../kernel/prs.js").then(({ endCiWatchJob }) => endCiWatchJob(repo, num, error)).catch(() => {});
}

/**
 * Called from the intake loop: for each watched PR, once every check on the watched commit has finished –
 * all passed → tell the developer; something failed → the next fix round (shown first), up to MAX_CI_ROUNDS.
 * A newer commit on the PR (pushed by someone) moves the watch to that commit.
 */
export async function pollCiWatches(): Promise<void> {
  const gh = clients.github();
  if (!gh?.prChecks || !gh.prForReview) return;
  const keep: CiWatch[] = [];
  for (const w of watches()) {
    try {
      const pr = await gh.prForReview(w.repo, w.num);
      if (pr.merged || pr.state !== "open") { watchEnded(w.repo, w.num); continue; }
      if (pr.headSha !== w.sha) w.sha = pr.headSha;
      const checks = await gh.prChecks(w.repo, w.sha);
      // GitHub needs a moment to register the runs of a fresh push; give up waiting after 3 hours
      const age = Date.now() - Date.parse(w.since ?? new Date().toISOString());
      if (!checks.length && age < 10 * 60_000) { keep.push(w); continue; }
      if (checks.some((c) => c.state === "pending") && age < 3 * 3_600_000) { keep.push(w); continue; }
      const project = getProject(w.projectId);
      const failed = checks.filter((c) => c.state !== "passed");
      const ref = `FIX-${w.num}@${w.projectId}`;
      if (!failed.length) {
        await notify({ kind: "info", taskRef: ref, dedupeKey: `ci-green:${w.repo}#${w.num}:${w.sha}`, title: `✅ CI passes on PR #${w.num}`,
          body: `All ${checks.length} checks passed on ${w.sha.slice(0, 7)} (${pr.headRef}).\n\n${checks.map((c) => `- ${c.name} ✅`).join("\n")}\n\nNothing merged – the PR is ready for review.`, url: pr.url });
        audit("service", "fix.ci_green", undefined, { repo: w.repo, num: w.num, sha: w.sha });
        watchEnded(w.repo, w.num);
        continue;
      }
      const list = failed.map((c) => `- ${c.name} ❌ (${c.state === "pending" ? "still running after 3 hours" : c.conclusion})`).join("\n");
      if (!project || w.round > MAX_CI_ROUNDS || failed.every((c) => c.state === "pending")) {
        await notify({ kind: "failed", taskRef: ref, dedupeKey: `ci-stuck:${w.repo}#${w.num}:${w.sha}`, title: `⚠️ CI still not green on PR #${w.num} – please take a look`,
          body: `${list}\n\n${w.round > MAX_CI_ROUNDS ? `I already tried ${MAX_CI_ROUNDS} rounds of fixes. ` : ""}Say "fix the CI on PR ${w.num}" to try again.`, url: pr.url });
        watchEnded(w.repo, w.num, "CI still failing");
        continue;
      }
      // engine v2: the failure is an event on the PR's item; the reactions start ONE ci_fix job (merged with others)
      if (engineVersion() === "v2") {
        const { itemForPr } = await import("../kernel/prs.js");
        const item = itemForPr(w.repo, w.num);
        if (item && !["DONE", "CANCELLED", "FAILED", "MERGED"].includes(item.state)) {
          const { emit } = await import("../kernel/events.js");
          emit({ type: "ci_failed", idemKey: `ci_failed:${w.repo.toLowerCase()}#${w.num}:${w.sha}`, itemId: item.id,
            payload: { repo: w.repo, num: w.num, sha: w.sha, round: w.round, by: w.by, via: w.via, ours: true, checks: failed.map((c) => c.name) } });
          watchEnded(w.repo, w.num);
          await notify({ kind: "info", taskId: item.id, taskRef: item.source_ref ?? undefined, dedupeKey: `ci-red:${w.repo}#${w.num}:${w.sha}`, title: `❌ CI failed on PR #${w.num} – fixing it (round ${w.round} of ${MAX_CI_ROUNDS})`,
            body: `${list}\n\n${loadSettings().pr?.autoFixCi !== false ? "I'll read the logs, fix it, push the fix and tell you the result." : "I'll read the logs, fix it and show you the fix before anything is pushed."}`, url: pr.url });
          continue;
        }
      }
      const { task, existing } = startFixTask(project, w.repo, w.num, w.by, w.via, { mode: "ci", ciRound: w.round });
      await notify({ kind: "info", taskId: task.id, taskRef: task.source_ref ?? undefined, dedupeKey: `ci-red:${w.repo}#${w.num}:${w.sha}`, title: `❌ CI failed on PR #${w.num} – fixing it (round ${w.round} of ${MAX_CI_ROUNDS})`,
        body: `${list}\n\n${existing ? `Already being fixed in ${task.source_ref}.` : loadSettings().pr?.autoFixCi !== false ? "I'll read the logs, fix it, push the fix and tell you the result." : "I'll read the logs, fix it and show you the fix before anything is pushed."}`, url: pr.url });
    } catch { keep.push(w); }   // GitHub unreachable: try again next time
  }
  saveWatches(keep);
}

export { projectForRepo };
