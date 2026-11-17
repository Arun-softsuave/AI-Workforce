import fs from "node:fs";
import { loadProjects, getProject, type ProjectConfig } from "../core/config.js";
import { truncate } from "../core/util.js";
import { audit } from "../core/db.js";
import { untrusted } from "../agents/runner.js";
import { clients } from "../connectors/registry.js";
import type { PrReviewInfo } from "../connectors/github.js";
import * as G from "../git/git.js";
import { rulesBlock } from "../brain/conventions.js";
import { buildContextPack } from "../brain/brain.js";
import { stripAttribution, attributionHits } from "../core/attribution.js";
import { requestApproval } from "../approvals/approvals.js";
import { notify } from "../notify/router.js";
import { createTask, getTask, listTasks, mergeData, transition, updateTask, type Task } from "./tasks.js";
import type { StepCtx, StepResult } from "./steps.js";
import { jobScoped, prOf, jobFolderId, ownApproval } from "./steps/common.js";

/**
 * Review anyone's pull request (a teammate's or your own) from Teams: "review PR 90", "review <link>", "review KAN-52 PR".
 * The PR code is checked out read-only, reviewed with the ticket, the team's rules and the code graph, and the comments
 * are shown in Teams FIRST. Nothing is posted until the user says "post" – and then only as a plain comment review
 * (never "approve" or "request changes"), under the user's GitHub account.
 */

// ------------------------------------------------------------------ finding the PR

export interface PrRef { repo?: string; num: number; hint?: string }

/** A PR link, "PR 90", "PR #90", "pull request 90" or "#90" (with an optional repository hint like "frontend"). */
export function parsePrRef(text: string): PrRef | undefined {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(text);
  if (url) return { repo: url[1], num: Number(url[2]) };
  const m = /\b(?:pr|pull request|pull)\s*#?\s*(\d+)\b/i.exec(text) ?? /(?:^|\s)#(\d+)\b/.exec(text);
  if (!m) return undefined;
  return { num: Number(m[1]), hint: text };
}

/** Which configured repository a PR number belongs to (a link names it; otherwise the hint or GitHub decides). */
export async function resolvePr(ref: PrRef): Promise<{ project: ProjectConfig; repo: string; num: number } | { error: string }> {
  const withRepo = loadProjects().filter((p) => p.github?.repo);
  if (!withRepo.length) return { error: "No project with a GitHub repository is set up." };
  if (ref.repo) {
    const project = withRepo.find((p) => p.github!.repo.toLowerCase() === ref.repo!.toLowerCase());
    if (!project) return { error: `${ref.repo} is not one of your AI Workforce projects, so I have no local copy of its code to review it with. Add it with \`aiw project add\`.` };
    return { project, repo: project.github!.repo, num: ref.num };
  }
  let candidates = withRepo;
  if (ref.hint) {
    const h = ref.hint.toLowerCase();
    const named = withRepo.filter((p) => h.includes(p.id.toLowerCase()) || h.includes(p.github!.repo.split("/")[1].toLowerCase())
      || (/\b(front|frontend|front-end|ui|web)\b/.test(h) && /front|web|ui|client/i.test(p.id))
      || (/\b(back|backend|back-end|api|server)\b/.test(h) && /back|api|server|service/i.test(p.id)));
    if (named.length) candidates = named;
  }
  if (candidates.length === 1) return { project: candidates[0], repo: candidates[0].github!.repo, num: ref.num };
  // several repositories: ask GitHub which of them has an open PR with this number
  const gh = clients.github();
  const open: ProjectConfig[] = [];
  for (const p of candidates) {
    try { const pr = await gh?.prForReview?.(p.github!.repo, ref.num); if (pr && pr.state === "open") open.push(p); } catch { /* no such PR there */ }
  }
  if (open.length === 1) return { project: open[0], repo: open[0].github!.repo, num: ref.num };
  const names = (open.length ? open : candidates).map((p) => p.id);
  return { error: `PR #${ref.num} could be in ${names.join(" or ")}. Which one? e.g. "review PR ${ref.num} ${names[0]}" – or paste the PR link.` };
}

/** Start (or reuse) the review task of one PR. */
export function startPrReview(project: ProjectConfig, repo: string, num: number, by: string, via: string): { task: Task; existing: boolean } {
  const sourceId = `review:${repo}#${num}`;
  const before = listTasks({ states: ["TRIAGED", "QUEUED", "RUNNING", "AWAITING_APPROVAL", "PAUSED", "REJECTED"] }).find((t) => t.source_id === sourceId);
  if (before) return { task: before, existing: true };
  const t = createTask({ projectId: project.id, source: via, sourceId, sourceRef: `PR-${num}@${project.id}`, title: `Review of ${repo}#${num}`, kind: "pr_review", state: "TRIAGED",
    data: { review: { repo, num, by, via, requestedAt: new Date().toISOString() } } });
  updateTask(t.id, { playbook: "pr-review", size: "S" });
  transition(t.id, "QUEUED", `review requested by ${by}`);
  audit(`user:${by}`, "review.requested", t.id, { repo, num });
  return { task: getTask(t.id)!, existing: false };
}

/** Teams / Claude Code: "review PR 90", a PR link, or a ticket whose PRs should be reviewed. Returns the chat reply. */
export async function startReviewFromText(text: string, ticketRef: string | undefined, by: string, via = "teams-personal"): Promise<string> {
  // a PR link / number, a ticket (yours or a teammate's – found on GitHub), or a person ("Eric's PR")
  const { resolvePrTargets } = await import("./targets.js");
  const found = await resolvePrTargets(text, ticketRef);
  if ("error" in found) return `❓ ${found.error}`;
  const targets = found.targets;
  const lines: string[] = [];
  for (const x of targets) {
    const { task, existing } = startPrReview(x.project, x.repo, x.num, by, via);
    lines.push(existing ? `- PR #${x.num} (${x.project.id}) is already being reviewed – ${task.source_ref}` : `- PR #${x.num} in ${x.repo}${x.author ? ` by ${x.author}` : ""} – ${task.source_ref}`);
  }
  return `🔎 **Reviewing**\n\n${lines.join("\n")}\n\nI'll read the change, the ticket and the related code, then show you the comments here first. Nothing is posted until you reply "post".`;
}

// ------------------------------------------------------------------ the diff: which lines can carry a comment

/** Lines of the NEW file that GitHub accepts a comment on: added and context lines inside the patch's hunks. */
export function commentableLines(patch?: string): Set<number> {
  const out = new Set<number>();
  if (!patch) return out;
  let line = 0;
  for (const l of patch.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (!line) continue;
    if (l.startsWith("-")) continue;
    if (l.startsWith("\\")) continue;              // "\ No newline at end of file"
    out.add(line);
    line++;
  }
  return out;
}

const SEVERITY_ICON: Record<string, string> = { blocker: "🔴", major: "🟠", minor: "🟡" };

export interface DraftComment { n: number; file: string; line: number; severity: string; title: string; body: string; suggestion?: string }
export interface ReviewDraft {
  summary: string; ticketCoverage: string; comments: DraftComment[]; general: string[];
  verdict?: "ready" | "changes_needed" | "blocking"; verdictReason?: string;
  requirementsCheck?: { requirement: string; status: "met" | "partial" | "missing" | "conflicts"; where: string }[];
}

const VERDICT: Record<string, string> = { ready: "✅ Ready to merge once CI passes", changes_needed: "🟠 Changes needed", blocking: "🔴 Blocking – should not be merged as it is" };
const REQ_ICON: Record<string, string> = { met: "✅", partial: "🟡", missing: "❌", conflicts: "⚠️" };

/** The requirement check as lines (used in Teams and in the posted summary). */
function requirementLines(d: ReviewDraft): string {
  return (d.requirementsCheck ?? []).map((x) => `- ${REQ_ICON[x.status] ?? "•"} ${x.requirement}${x.status !== "met" ? ` – ${x.status}` : ""}${x.where ? ` (${x.where})` : ""}`).join("\n");
}

/** The review as the user sees it in Teams before anything is posted. */
export function reviewPreview(t: Task): string {
  const pr: PrReviewInfo | undefined = t.data.prInfo;
  const d: ReviewDraft | undefined = t.data.reviewDraft;
  if (!pr || !d) return "(no review yet)";
  const blocks = [
    `**${pr.title}**\nby ${pr.author} · ${pr.baseRef} ← ${pr.headRef}${t.data.ticket?.key ? ` · ticket ${t.data.ticket.key}` : ""}`,
    `**Verdict: ${VERDICT[d.verdict ?? "changes_needed"]}**${d.verdictReason ? `\n${d.verdictReason}` : ""}`,
    `**Summary**\n${d.summary || "(none)"}`,
  ];
  if (d.requirementsCheck?.length) blocks.push(`**Ticket & PRD requirements**\n${requirementLines(d)}`);
  else if (d.ticketCoverage) blocks.push(`**Ticket coverage**\n${d.ticketCoverage}`);
  if (!d.comments.length) blocks.push("**No line comments** – only the summary above would be posted.");
  else blocks.push(`**Comments to post (${d.comments.length})**`);
  for (const c of d.comments) {
    blocks.push([
      `**${c.n}.** ${SEVERITY_ICON[c.severity] ?? "•"} ${c.severity} · \`${c.file}\` line ${c.line}`,
      `**${c.title}**`,
      c.body,
      c.suggestion ? `Suggested line: \`${truncate(c.suggestion, 200)}\`` : "",
    ].filter(Boolean).join("\n"));
  }
  if (d.general.length) blocks.push(`**General points (go in the summary)**\n${d.general.map((g) => `- ${g}`).join("\n")}`);
  const failing = (pr.checks ?? []).filter((c) => c.conclusion && !["success", "skipped", "neutral", "completed", "in_progress", "queued"].includes(c.conclusion));
  if (failing.length) blocks.push(`⚠️ CI: ${failing.map((c) => `${c.name} (${c.conclusion})`).join(", ")}`);
  return blocks.join("\n\n");
}

// ------------------------------------------------------------------ steps (registered in STEPS by steps.ts)

const ticketKeyRe = (keys: string[]) => (keys.length ? new RegExp(`\\b(${keys.map((k) => k.replace(/[^A-Z0-9]/gi, "")).join("|")})-\\d+\\b`, "i") : /\b[A-Z][A-Z0-9]+-\d+\b/);

export const REVIEW_STEPS: Record<string, (ctx: StepCtx) => Promise<StepResult>> = {
  /** Read the PR from GitHub and check its code out read-only (a detached worktree; no branch is created). */
  async fetch_pr(ctx) {
    // a review job on a PR item (engine v2, e.g. "review requested" with autoReview) names its PR through the item
    const scoped = jobScoped(ctx.task);
    let r = ctx.task.data.review;
    if (!r && scoped) { const p = prOf(ctx.task, ctx.project); if (p) { r = { repo: p.repo, num: p.num }; ctx.save({ review: r }); } }
    if (!r) return { status: "fail", reason: "No pull request to review" };
    const gh = clients.github();
    if (!gh?.prForReview) return { status: "fail", reason: "GitHub is not connected" };
    const pr = await gh.prForReview(r.repo, r.num);
    if (pr.merged) return { status: "fail", reason: `PR #${r.num} is already merged` };
    if (pr.state !== "open") return { status: "fail", reason: `PR #${r.num} is ${pr.state}` };
    let wt = ctx.task.worktree;
    if (!wt || !fs.existsSync(wt) || ctx.task.data.reviewSha !== pr.headSha) {
      const sha = G.fetchPrHead(ctx.project.local.path, r.repo, r.num, gh.gitAuthHeader());
      if (wt && fs.existsSync(wt)) G.removeWorktree(ctx.project.local.path, wt);
      wt = G.createDetachedWorktree(ctx.project.local.path, ctx.project.id, scoped ? jobFolderId(ctx.task.id, "review", r.num) : ctx.task.id, sha, ctx.project.conventions?.env?.linkedDirs ?? []);
      ctx.task = { ...ctx.task, worktree: wt };
    }
    // the linked Jira ticket, from the title, branch or description
    const key = ticketKeyRe(ctx.project.jira?.keys ?? []).exec(`${pr.title} ${pr.headRef} ${pr.body}`)?.[0]?.toUpperCase();
    let ticket: any;
    if (key) { try { const i = await clients.jira()?.getIssue(key); if (i) ticket = { key: i.key, title: i.title, description: i.description, url: i.url, comments: i.comments ?? [] }; } catch { /* optional */ } }
    // patches can be large: keep what a reviewer needs
    let budget = 150_000;
    const files = pr.files.map((f) => { const patch = f.patch ? truncate(f.patch, Math.max(0, Math.min(20_000, budget))) : undefined; budget -= patch?.length ?? 0; return { ...f, patch }; });
    ctx.save({ prInfo: { ...pr, files }, reviewSha: pr.headSha, ticket, worktreePath: wt });
    return { status: "ok", note: `${pr.files.length} files at ${pr.headSha.slice(0, 7)}${key ? `, ticket ${key}` : ""}` };
  },

  /** One careful review of the whole PR; comments are checked against the diff so GitHub accepts every one. */
  async review_pr(ctx) {
    const pr: PrReviewInfo = ctx.task.data.prInfo;
    const t = ctx.task.data.ticket;
    let diffBudget = 60_000;
    const patches = pr.files.map((f) => {
      if (!f.patch) return `### ${f.path}\n(${f.status}, no text diff)`;
      const p = truncate(f.patch, Math.max(500, Math.min(15_000, diffBudget)));
      diffBudget -= p.length;
      return `### ${f.path}\n\`\`\`diff\n${p}\n\`\`\``;
    }).join("\n\n");
    const feedback = (ctx.task.data.feedback ?? []).length ? `## What the user wants changed in your previous review draft\n${ctx.task.data.feedback.map((f: string) => `- ${f}`).join("\n")}\n\n## Your previous draft\n${JSON.stringify(ctx.task.data.reviewDraft ?? {}, null, 1)}` : "";
    // What SHOULD be built: the Jira ticket (with comments), the PRD sections from the project documents, linked pages
    const { ticketText, linkedDocsText } = await import("./steps.js");
    const ticketish = { ...ctx.task, data: { ...ctx.task.data, ticket: t ?? { title: pr.title, description: pr.body } }, source_ref: t?.key ?? ctx.task.source_ref } as Task;
    const brain = buildContextPack(ctx.project.id, `${pr.title}\n${t ? `${t.title}\n${t.description ?? ""}` : pr.body}\n${pr.files.map((f) => f.path).join(" ")}`, 8000).text;
    let docs = "";
    try { docs = await linkedDocsText(ticketish, ctx.project); } catch { /* optional */ }
    const prompt = [
      `## Pull request #${pr.number}: ${pr.title}\nAuthor: ${pr.author} · ${pr.baseRef} ← ${pr.headRef} · ${pr.url}\n${untrusted(`pr-description:${pr.number}`, truncate(pr.body, 6000))}`,
      t ? `## Jira ticket ${t.key} (with comments)\n${untrusted(`ticket:${t.key}`, truncate(ticketText(ticketish), 8000))}` : "## Jira ticket\nNone linked in the title, branch or description – judge the change by its description and the PRD; use jira_search if the PR clearly belongs to a ticket.",
      `## Product requirements and project knowledge (PRD sections from the project documents, team standards, past tasks)\n${brain}`,
      docs.trim(),
      rulesBlock(ctx.project, 3000),
      pr.checks?.length ? `## CI checks\n${pr.checks.map((c) => `- ${c.name}: ${c.conclusion}`).join("\n")}` : "",
      pr.comments?.length ? `## Comments already on the PR (do not repeat these; when this is a new review after more commits, check whether each one was addressed and name the ones that were not in the summary)\n${untrusted("pr-comments", truncate(pr.comments.map((c) => `- ${c.author}${c.path ? ` on ${c.path}:${c.line ?? ""}` : ""}: ${c.body}`).join("\n"), 4000))}` : "",
      `## Changed files (${pr.files.length})\n${untrusted(`pr-diff:${pr.number}`, patches)}`,
      feedback,
      "The PR's code is checked out in the current directory (read-only). Read the code around the change where it helps. Do not modify anything.",
    ].filter(Boolean).join("\n\n");
    const r = await ctx.agent("pr-reviewer", prompt, { cwd: ctx.task.worktree!, tools: ["Read", "Grep", "Glob"], maxTurns: 30 });
    const lines = new Map(pr.files.map((f) => [f.path, commentableLines(f.patch)]));
    const comments: DraftComment[] = [];
    const general: string[] = [];
    for (const c of r.data.comments ?? []) {
      const body = stripAttribution(String(c.body ?? "")).trim();
      if (!body) continue;
      const ok = lines.get(c.file)?.has(Number(c.line));
      if (ok) comments.push({ n: comments.length + 1, file: c.file, line: Number(c.line), severity: c.severity ?? "minor", title: stripAttribution(String(c.title ?? "")).trim() || "Comment", body, suggestion: c.suggestion?.trim() || undefined });
      else general.push(`${c.file}${c.line ? ` (around line ${c.line})` : ""}: ${body}`);
    }
    const draft: ReviewDraft = {
      summary: stripAttribution(String(r.data.summary ?? "")).trim(), ticketCoverage: stripAttribution(String(r.data.ticketCoverage ?? "")).trim(), comments, general,
      verdict: r.data.verdict ?? "changes_needed", verdictReason: stripAttribution(String(r.data.verdictReason ?? "")).trim(),
      requirementsCheck: (r.data.requirementsCheck ?? []).map((x: any) => ({ requirement: stripAttribution(String(x.requirement ?? "")), status: x.status, where: stripAttribution(String(x.where ?? "")) })),
    };
    ctx.save({ reviewDraft: draft, reviewAt: new Date().toISOString(), reviewSelection: null });
    return { status: "ok", note: `${comments.length} line comments, ${general.length} general points` };
  },

  /** Show the comments in Teams and wait: post all / post some / drop / change / cancel. */
  async review_gate(ctx) {
    const a = await ownApproval(ctx.task, "reviewApprovalId", "post_review");
    if (a?.action === "post_review" && a.state === "approved" && a.requested_at >= (ctx.task.data.reviewAt ?? "")) return { status: "ok", note: "post approved" };
    const ap = requestApproval(ctx.task.id, "post_review", {});
    ctx.save({ reviewApprovalId: ap.id });
    // the policy gate: "post review comments without showing them first" (settings.pr.autoPostReview or your rule)
    const { canComment } = await import("../policy/gate.js");
    const { approveByPolicy } = await import("../approvals/approvals.js");
    const g = canComment(ctx.task.id, { target: "teammate_pr" });
    if (g.verdict === "deny") return { status: "fail", reason: g.reason };
    if (g.verdict === "allow") { approveByPolicy(ap.id, g.rule ?? "post_review"); return { status: "ok", note: "posted without asking (your preference)" }; }
    const pr: PrReviewInfo = ctx.task.data.prInfo;
    await notify({ kind: "approval_needed", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, approvalId: ap.id, approvalAction: "post_review", dedupeKey: ap.id,
      title: `📝 Review of PR #${pr.number} ready – ${ctx.project.id}`, body: reviewPreview(getTask(ctx.task.id)!), url: pr.url });
    return { status: "await_approval", approvalId: ap.id };
  },

  /** Post the approved comments as ONE review of type COMMENT. Never approves, never requests changes, never merges. */
  async post_review(ctx) {
    const a = await ownApproval(ctx.task, "reviewApprovalId", "post_review");
    if (!a || a.state !== "approved" || a.action !== "post_review") return { status: "fail", reason: "No approval to post the review" };
    const gh = clients.github();
    if (!gh?.createReview) return { status: "fail", reason: "GitHub is not connected" };
    const r = ctx.task.data.review;
    const d: ReviewDraft = ctx.task.data.reviewDraft;
    const pick: number[] | null = ctx.task.data.reviewSelection ?? null;
    const chosen = d.comments.filter((c) => !pick || pick.includes(c.n));
    const commentBody = (c: DraftComment) => `**${c.title}**\n\n${c.body}${c.suggestion ? `\n\n\`\`\`suggestion\n${c.suggestion}\n\`\`\`` : ""}`;
    // the verdict is shared as words only – the review itself is always a plain comment, never approve / request changes
    const body = [
      d.verdict ? `**${VERDICT[d.verdict].replace(/^\S+\s/, "")}**${d.verdictReason ? ` – ${d.verdictReason}` : ""}` : "",
      d.summary,
      d.requirementsCheck?.length ? `**Ticket & PRD requirements**\n${requirementLines(d)}` : "",
      d.general.length ? `**General points**\n${d.general.map((g) => `- ${g}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    const all = `${body}\n${chosen.map(commentBody).join("\n")}`;
    if (attributionHits(all).length) return { status: "fail", reason: "Hard rule: the review text mentions Claude/AI – change the comments and approve again" };
    let res: { id: number; url: string };
    try {
      res = await gh.createReview(r.repo, r.num, { commitId: ctx.task.data.reviewSha, body, comments: chosen.map((c) => ({ path: c.file, line: c.line, side: "RIGHT" as const, body: commentBody(c) })) });
    } catch (e: any) {
      // GitHub refused a line (e.g. the PR changed since the review): post everything in the review body instead
      if (!/422|Unprocessable|line/i.test(e.message)) throw e;
      const fallback = [body, ...chosen.map((c) => `**${c.file} line ${c.line}** – ${commentBody(c)}`)].filter(Boolean).join("\n\n---\n\n");
      res = await gh.createReview(r.repo, r.num, { commitId: ctx.task.data.reviewSha, body: fallback, comments: [] });
    }
    ctx.save({ reviewPosted: { id: res.id, url: res.url, comments: chosen.length, at: new Date().toISOString() } });
    audit("service", "review.posted", ctx.task.id, { repo: r.repo, num: r.num, comments: chosen.length, approvalId: a.id });
    if (ctx.task.worktree && fs.existsSync(ctx.task.worktree)) { G.removeWorktree(ctx.project.local.path, ctx.task.worktree); ctx.task = { ...ctx.task, worktree: null }; }
    await notify({ kind: "info", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, dedupeKey: `review:${res.id}`,
      title: `💬 Review posted on PR #${r.num}`, body: `${chosen.length} comment${chosen.length === 1 ? "" : "s"} posted on ${r.repo}#${r.num} as a comment review (not an approval).`, url: res.url || ctx.task.data.prInfo?.url });
    return { status: "ok", note: res.url };
  },
};

// ------------------------------------------------------------------ "post 1, 3", "drop 2", "change 2: …"

export const REVIEW_EDIT = /^(post|drop|remove|delete|skip|change|edit|reword)\b/i;

const numbersIn = (s: string) => [...new Set((s.match(/\d+/g) ?? []).map(Number))];

/**
 * A reply to a waiting review. Returns { approve, selection } when the user wants to post, or { reply } after an edit
 * (the review keeps waiting). Undefined: not a review command.
 */
export function reviewCommand(t: Task, text: string): { approve: true } | { reply: string } | undefined {
  const d: ReviewDraft | undefined = t.data.reviewDraft;
  if (!d) return undefined;
  const ref = t.source_ref ?? t.id;
  const s = text.trim();
  const post = /^post\b\s*(?:only\s*)?(.*)$/i.exec(s);
  if (post) {
    const rest = post[1].trim();
    if (!rest || /^(all|everything|them|it)\b/i.test(rest)) { mergeData(t.id, { reviewSelection: null }); return { approve: true }; }
    const nums = numbersIn(rest);
    const bad = nums.filter((n) => !d.comments.some((c) => c.n === n));
    if (!nums.length || bad.length) return { reply: `For ${ref} there are comments ${d.comments.map((c) => c.n).join(", ") || "(none)"}. Reply e.g. "post 1, 3", or "post" for all.` };
    mergeData(t.id, { reviewSelection: nums });
    return { approve: true };
  }
  const drop = /^(drop|remove|delete|skip)\s+(.+)$/i.exec(s);
  if (drop) {
    const nums = numbersIn(drop[2]);
    if (!nums.length) return { reply: `Which comment? e.g. "drop 2".` };
    const left = d.comments.filter((c) => !nums.includes(c.n));
    if (left.length === d.comments.length) return { reply: `${ref} has comments ${d.comments.map((c) => c.n).join(", ")}.` };
    mergeData(t.id, { reviewDraft: { ...d, comments: left } });
    return { reply: `🗑️ Removed comment ${nums.join(", ")} from ${ref}. ${left.length} left${left.length ? ` (${left.map((c) => c.n).join(", ")})` : ""}.\n\nReply "post" to post them, or keep editing.` };
  }
  const change = /^(change|edit|reword)\s+(\d+)\s*[:\-–]?\s*([\s\S]+)$/i.exec(s);
  if (change) {
    const n = Number(change[2]);
    const c = d.comments.find((x) => x.n === n);
    if (!c) return { reply: `${ref} has comments ${d.comments.map((x) => x.n).join(", ")}.` };
    const body = stripAttribution(change[3].trim());
    mergeData(t.id, { reviewDraft: { ...d, comments: d.comments.map((x) => (x.n === n ? { ...x, body } : x)) } });
    return { reply: `✏️ Comment ${n} of ${ref} now says:\n\n${body}\n\nReply "post" to post the review, or keep editing.` };
  }
  return undefined;
}

export function isReviewTask(t?: Task): boolean { return !!t && t.kind === "pr_review"; }
export { getProject };
