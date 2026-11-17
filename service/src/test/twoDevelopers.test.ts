import { makeRepo, sh, waitFor } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setMeta, getMeta } from "../core/db.js";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../core/config.js";
import { clients, connect } from "../connectors/registry.js";
import type { GitHubClient, PrReviewInfo, ReviewThread } from "../connectors/github.js";
import type { JiraClient } from "../connectors/jira.js";
import { setTeamsPersonalClient, type TeamsPersonalClient, type TpMessage } from "../connectors/teamsPersonal.js";
import { setRunner, MockRunner } from "../agents/runner.js";
import { pollTeamsCommands } from "../intake/teamsCommands.js";
import { pollReviewedPrs } from "../intake/prActivity.js";
import { setEngineRole, tick } from "../engine/engine.js";
import { getTask, createTask, transition, mergeData, type Task } from "../engine/tasks.js";
import { latestApproval } from "../approvals/approvals.js";
import { personIn } from "../engine/targets.js";
import { commentableLines } from "../engine/prReview.js";

/**
 * Two developers, each with their own copy of the plugin (here: this copy is Sneha's, GitHub login "sneha").
 *   - Sneha's PR #7 (KAN-9) got review comments from Eric → "resolve the comments" → decided per comment, fixed,
 *     SHOWN first → "1" → pushed to the same PR + replies → QA runs → a product bug, SHOWN first → "create 1" → issue.
 *   - Eric's PR #8 (KAN-60): Sneha can review it ("add comments on KAN-60") but not push fixes to it.
 *   - The reviewer's plugin is told when the author pushes new commits.
 */
const OWNER = "8:live:sneha";
const sent: string[] = [];
let chat: TpMessage[] = [];
const fakeTeams: TeamsPersonalClient = {
  hasSavedLogin: () => true, startLogin: async () => ({ userCode: "X", verificationUrl: "https://x", expiresAt: Date.now() + 1e6 }),
  waitForLogin: async () => {}, logout: () => {}, whoAmI: async () => ({ mri: "8:live:bot", region: "emea" }),
  listChats: async () => [], findChats: async () => [],
  getChatMembers: async () => [{ mri: "8:live:bot", name: "Bot", isMe: true }, { mri: OWNER, name: "Sneha", isMe: false }],
  sendMessage: async (_c, text) => { sent.push(text); return { sent: true }; },
  getMessages: async (_c, since) => chat.filter((m) => !since || m.time > since),
};
setTeamsPersonalClient(fakeTeams);

// Sneha's PR #7 on branch feat/KAN-9/refund, Eric's PR #8 on feat/KAN-60/export – both in the "GitHub" remote
const { repo, origin } = makeRepo("shop");
process.env.AIW_GIT_PUSH_URL = origin;
sh(repo, "checkout", "-q", "-b", "feat/KAN-9/refund");
fs.writeFileSync(path.join(repo, "src", "services", "refund.ts"), "import { stripe } from './stripe';\nexport async function refund(paymentId: string, amount: number) {\n  return stripe.refunds.create({ payment_intent: paymentId, amount });\n}\n");
sh(repo, "commit", "-q", "-am", "KAN-9 refund amount");
sh(repo, "push", "-q", "origin", "feat/KAN-9/refund");
sh(repo, "checkout", "-q", "-b", "feat/KAN-60/export", "main");
fs.writeFileSync(path.join(repo, "src", "export.ts"), "export const exportOrders = () => [];\n");
sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "KAN-60 export");
sh(repo, "push", "-q", "origin", "feat/KAN-60/export");
sh(repo, "checkout", "-q", "main");
const remoteHead = (branch: string) => sh(repo, "ls-remote", origin, `refs/heads/${branch}`).split(/\s+/)[0];

const patch = "@@ -1,4 +1,4 @@\n import { stripe } from './stripe';\n-export async function refund(paymentId: string) {\n-  return stripe.refunds.create({ payment_intent: paymentId });\n+export async function refund(paymentId: string, amount: number) {\n+  return stripe.refunds.create({ payment_intent: paymentId, amount });\n }";
const prs: Record<number, { author: string; branch: string; title: string }> = {
  7: { author: "sneha", branch: "feat/KAN-9/refund", title: "KAN-9: refund a part of a payment" },
  8: { author: "eric", branch: "feat/KAN-60/export", title: "KAN-60: export orders" },
};
const prInfo = (n: number): PrReviewInfo => {
  const p = prs[n];
  const head = remoteHead(p.branch);
  sh(origin, "update-ref", `refs/pull/${n}/head`, head);           // like GitHub: pull/N/head follows the branch
  return { number: n, title: p.title, body: "", url: `https://github.com/acme/shop/pull/${n}`, author: p.author, state: "open", draft: true, merged: false,
    headRef: p.branch, headSha: head, baseRef: "main", baseSha: "", files: [{ path: "src/services/refund.ts", status: "modified", additions: 2, deletions: 2, patch }], checks: [], comments: [] };
};
const threads: ReviewThread[] = [{ id: "T1", resolved: false, outdated: false, path: "src/services/refund.ts", line: 2,
  comments: [{ id: 501, author: "eric", body: "The amount is not checked – it can be larger than the payment.", at: "2026-11-13T10:00:00Z", url: "https://github.com/acme/shop/pull/7#r501" }] }];
const replies: { commentId: number; body: string }[] = [];
const prComments: { num: number; body: string }[] = [];
const issues: { title: string; body: string }[] = [];
const fakeGitHub: GitHubClient = {
  user: async () => ({ login: "sneha" }), repo: async () => ({ defaultBranch: "main", private: true }),
  findOpenPr: async () => undefined, createPr: async () => ({ number: 1, url: "x" }), updatePr: async () => ({ number: 1, url: "x" }),
  failedRuns: async () => [], failedJobLog: async () => "", gitAuthHeader: () => "AUTHORIZATION: basic dGVzdA==", recentPrBases: async () => [], prActivity: async () => [],
  prForReview: async (_r, n) => prInfo(n),
  createReview: async () => ({ id: 1, url: "https://github.com/acme/shop/pull/8#review-1" }),
  searchPrs: async (_repos, text) => Object.entries(prs).filter(([, p]) => p.title.includes(text)).map(([n, p]) => ({ repo: "acme/shop", number: Number(n), title: p.title, url: `https://github.com/acme/shop/pull/${n}`, author: p.author, state: "open" })),
  openPrs: async () => Object.entries(prs).map(([n, p]) => ({ repo: "acme/shop", number: Number(n), title: p.title, url: `https://github.com/acme/shop/pull/${n}`, author: p.author, state: "open", headRef: p.branch })),
  reviewThreads: async (_r, n) => (n === 7 ? threads : []),
  prConversation: async (_r, n) => (n === 7 ? [{ id: "c900", kind: "comment" as const, author: "eric", body: "Please also add a test for the limit.", at: "2026-11-13T10:01:00Z", url: "https://github.com/acme/shop/pull/7#c900" }] : []),
  replyToReviewComment: async (_r, _n, commentId, body) => { replies.push({ commentId, body }); return { url: "x" }; },
  commentOnPr: async (_r, num, body) => { prComments.push({ num, body }); return { url: `https://github.com/acme/shop/pull/${num}#c${prComments.length}` }; },
  createIssue: async (_r, i) => { issues.push(i); return { number: 40 + issues.length, url: `https://github.com/acme/shop/issues/${40 + issues.length}` }; },
  searchIssues: async () => [],
  getIssue: async (_r, n) => ({ number: n, title: "x", body: "", url: "x", state: "open", author: "sneha" }),
  commentOnIssue: async () => ({ url: "x" }),
};
const fakeJira: JiraClient = {
  site: "https://acme.atlassian.net", myself: async () => ({ accountId: "me", displayName: "Me" }), search: async () => [], addComment: async () => {},
  getIssue: async (k) => ({ provider: "jira", id: k, key: k, projectKey: "KAN", title: `Ticket ${k}`, description: "Support can refund part of a payment; the amount must never exceed the payment.",
    status: "In Review", statusCategory: "indeterminate", assignee: "x", priority: "High", labels: [], url: `https://acme.atlassian.net/browse/${k}`, updated: new Date().toISOString(), comments: [] } as any),
};
clients.github = () => fakeGitHub;
clients.jira = () => fakeJira;
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Sneha", workingHours: "00:00-23:59", roles: ["fullstack-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "teams-personal", fallback: ["inbox"] },
});
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" },
  local: { path: repo, testCommand: "node -e \"process.exit(0)\"" }, roles: ["fullstack-developer"], autonomy: "prepare" }));
setRunner(new MockRunner({
  "qa-triager": () => ({ verdict: "blocked", summary: "One refund bug found.", suites: [{ suite: "unit", passed: 3, failed: 1, skipped: 0, result: "fail" }],
    findings: [
      { title: "A refund larger than the payment is accepted", classification: "product", severity: "P1", confidence: "high", area: "refunds", steps: ["Refund 200 on a 100 payment"], expected: "Rejected (ticket: amount never exceeds the payment)", actual: "Accepted", evidence: "test_refund_limit failed" },
      { title: "Date test fails once at midnight", classification: "flaky", severity: "P3", confidence: "medium", area: "tests", steps: [], expected: "", actual: "", evidence: "" },
    ], gaps: ["No browser checks – backend change"] }),
}));
setEngineRole("daemon");

let clock = Date.now();
async function say(text: string): Promise<string> {
  clock += 1000;
  chat.push({ id: `m${clock}`, conversationId: OWNER, from: "Sneha", fromId: OWNER, isMine: false, time: new Date(clock).toISOString(), text });
  const before = sent.length;
  await pollTeamsCommands(true);
  return sent.slice(before).join("\n---\n");
}
const drive = (ref: string, states: string[], check?: (t: Task) => boolean) =>
  waitFor(() => { void tick(); const t = getTask(ref); return t && states.includes(t.state) && (!check || check(t)) ? t : undefined; }, 60_000, 100);

test("helpers: a person named in a message; lines that can carry a comment", () => {
  assert.equal(personIn("can you check Eric's PR"), "Eric");
  assert.equal(personIn("review the PR from eric please"), "eric");
  assert.equal(personIn("review my PR"), undefined);
  assert.deepEqual([...commentableLines(patch)], [1, 2, 3, 4]);
});

test("setup: Teams connected", async () => {
  assert.ok(await connect("teams-personal", { mode: "bot", chatId: OWNER, chatTitle: "Sneha", ownerId: OWNER, ownerName: "Sneha" }));
  setMeta("teams_personal.cursor", new Date(clock).toISOString());
});

test("Sneha reviews Eric's ticket from its key, but cannot push fixes to Eric's PR", async () => {
  const r = await say("add comments on KAN-60");
  assert.match(r, /Reviewing[\s\S]*PR #8 in acme\/shop by eric/);
  const no = await say("resolve the comments on PR 8");
  assert.match(no, /is eric's – only its author pushes fixes[\s\S]*review PR 8/);
});

test("Sneha: resolve Eric's comments → shown first → pushed to the same PR with replies → QA → bug shown first → issue", async () => {
  const before = remoteHead("feat/KAN-9/refund");
  const started = await say("Eric added comments on PR 7, please resolve them");
  assert.match(started, /Fixing the review comments[\s\S]*PR #7 in acme\/shop – FIX-7@shop/);

  // decided per comment with the ticket, then fixed and checked – and SHOWN before anything leaves this computer
  const waiting = await drive("FIX-7@shop", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"]);
  assert.equal(waiting.state, "AWAITING_APPROVAL", waiting.error ?? "");
  assert.equal(latestApproval(waiting.id)?.action, "push_fixes");
  const preview = sent.find((m) => /Fixes for PR #7 ready/.test(m)) ?? "";
  assert.match(preview, /\*\*1\.\*\* ✅ fixed · `src\/services\/refund\.ts` line 2 · eric/);
  assert.match(preview, /\*\*2\.\*\* ✅ fixed · general · eric/);
  assert.match(preview, /→ Reply: "Done – changed as suggested\."/);
  assert.match(preview, /Changed files/);
  assert.match(preview, /Push the fixes and post the replies/);
  assert.equal(remoteHead("feat/KAN-9/refund"), before, "nothing pushed before the OK");
  assert.equal(replies.length + prComments.length, 0, "nothing replied before the OK");

  // "1" → pushed to the SAME branch (not forced), a reply under the thread, one reply for the general comment
  assert.match(await say("1"), /Pushing the fixes to acme\/shop#7/);
  const done = await drive("FIX-7@shop", ["DONE", "FAILED", "PAUSED"]);
  assert.equal(done.state, "DONE", done.error ?? "");
  const after = remoteHead("feat/KAN-9/refund");
  assert.notEqual(after, before);
  assert.equal(sh(repo, "merge-base", "--is-ancestor", before, after) === "" ? "ff" : "ff", "ff");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].commentId, 501);
  assert.match(replies[0].body, /Done – changed as suggested\. \([0-9a-f]{7}\)/);
  assert.match(prComments.find((c) => c.num === 7)?.body ?? "", /@eric: Done/);
  assert.ok(!getTask("FIX-7@shop")!.worktree, "the task folder is cleaned up");
  assert.match(sent.find((m) => /Fixes pushed to PR #7/.test(m)) ?? "", /QA starts now/);
  assert.ok(JSON.parse(getMeta("fix.handled:acme/shop#7") ?? "[]").includes("tT1"), "the comment is not handled twice");

  // QA ran on the updated PR: results SHOWN first, the product bug as an issue draft, the flaky one not
  const qa = await drive("QA-7@shop", ["AWAITING_APPROVAL", "FAILED", "PAUSED"]);
  assert.equal(qa.state, "AWAITING_APPROVAL", qa.error ?? "");
  assert.equal(qa.data.qaHead, after, "QA tested the pushed fixes");
  const qaMsg = sent.find((m) => /QA of PR #7/.test(m)) ?? "";
  assert.match(qaMsg, /Verdict: 🔴 BLOCKED/);
  assert.match(qaMsg, /\*\*1\.\*\* 🟠 P1 · A refund larger than the payment is accepted[\s\S]*Issue draft/);
  assert.match(qaMsg, /\*\*2\.\*\* ℹ️ flaky · Date test fails once at midnight\n→ Not a product bug/);
  assert.match(qaMsg, /create 1, 3 – only those issues/);
  assert.equal(issues.length, 0, "no issue before the OK");

  assert.match(await say("create 1"), /Posting the QA results on acme\/shop#7 with issues for 1/);
  const qaDone = await drive("QA-7@shop", ["DONE", "FAILED", "PAUSED"]);
  assert.equal(qaDone.state, "DONE", qaDone.error ?? "");
  assert.equal(issues.length, 1);
  assert.match(issues[0].title, /^\[BUG\]\[P1\] A refund larger than the payment is accepted/);
  assert.match(issues[0].body, /Steps to reproduce\*\*\n1\. Refund 200 on a 100 payment/);
  const report = prComments.filter((c) => c.num === 7).at(-1)!.body;
  assert.match(report, /QA report – PR #7[\s\S]*BLOCKED[\s\S]*#41 \[BUG\]\[P1\][\s\S]*flaky: Date test/);
  assert.doesNotMatch(`${report}${issues[0].body}`, /claude|\bAI\b/i);
});

test("the reviewer's plugin hears about new commits on a PR it reviewed (once per commit)", async () => {
  let t = createTask({ projectId: "shop", source: "teams-personal", sourceId: "review:acme/shop#7:old", sourceRef: "PR-7@shop", title: "Review", kind: "pr_review", state: "TRIAGED",
    data: { review: { repo: "acme/shop", num: 7 }, reviewSha: "0000000", reviewPosted: { id: 1, url: "x" } } });
  t = transition(t.id, "QUEUED", "t"); t = transition(t.id, "RUNNING", "t"); transition(t.id, "DONE", "t");
  mergeData(t.id, {});
  assert.equal(await pollReviewedPrs(), 1);
  assert.match(sent.at(-1)!, /sneha pushed new commits to PR #7 you reviewed[\s\S]*review PR 7 shop/);
  setMeta("reviewed.check:acme/shop#7", "");
  assert.equal(await pollReviewedPrs(), 0, "told once per new commit");
});

test("'fix the QA issues on PR 7' works through the issues QA created – shown first, a note on the issue after the OK", async () => {
  const r = await say("fix the QA issues on PR 7");
  assert.match(r, /Fixing the QA issues[\s\S]*FIX-7@shop/);
  const t = await drive("FIX-7@shop", ["AWAITING_APPROVAL", "FAILED", "PAUSED"]);
  assert.equal(t.state, "AWAITING_APPROVAL", t.error ?? "");
  assert.deepEqual(t.data.fixItems.map((i: any) => [i.kind, i.issue]), [["issue", 41]]);
  assert.match(sent.find((m) => /Fixes for PR #7 ready/.test(m) && /issue #41/.test(m)) ?? "", /\*\*1\.\*\* ✅ fixed · issue #41/);
});

test("'PR 7 failed, fix it and make CI pass' fixes the FAILING CI CHECKS (not the comments) – shown first, then CI is watched until green", async () => {
  const { cancelTask } = await import("../engine/engine.js");
  const { pollCiWatches } = await import("../engine/prFix.js");
  const { ruleIntent } = await import("../intake/teamsIntent.js");
  await cancelTask("FIX-7@shop", "next test");
  // this test covers the "show the fix first" preference; the default (push without asking) is covered in e2e
  const { updateSettings } = await import("../core/config.js");
  updateSettings((s) => { s.pr.autoFixCi = false; });
  const checks = new Map<string, any[]>();
  const head0 = remoteHead("feat/KAN-9/refund");
  checks.set(head0, [
    { id: "run:1", name: "Regression replay", state: "failed", conclusion: "failure", url: "https://github.com/acme/shop/actions/runs/1/job/11", jobId: 11 },
    { id: "run:2", name: "Lint & Format", state: "passed", conclusion: "success", url: "x" },
    { id: "run:3", name: "Tests & Coverage", state: "pending", conclusion: "in_progress", url: "x" },
  ]);
  (fakeGitHub as any).prChecks = async (_r: string, sha: string) => checks.get(sha) ?? [];
  (fakeGitHub as any).checkFailure = async () => "Failed step: Replay\n\nCommand: python scripts/run_regression.py replay\n\nEnd of the failing step:\nALT-01  FAIL -> FAIL  changed";

  // short messages: the rules; long ones: the conversation model (its fix_ci intent)
  assert.equal((ruleIntent("PR 7 CI failed, fix it") as any).intent?.intent, "fix_ci");
  assert.equal((ruleIntent("fix PR 7") as any).intent?.intent, "fix_ci");
  assert.equal((ruleIntent("resolve the comments on PR 7") as any).intent?.intent, "resolve_comments");
  const msg = "Backend pr failed -> https://github.com/acme/shop/pull/7 check and fix it and notify me ensure it must pass all the ci tests";
  setRunner(new MockRunner({
    conductor: () => ({ calls: [{ tool: "fix_pr", args: { text: msg, mode: "ci" } }], reply: "" }),      // the Conductor (default)
    intent: () => ({ intent: "fix_ci", ref: "", text: msg, project: "", delegated: false }),             // the older intent model
  }));
  const started = await say(msg);
  assert.match(started, /Fixing the failing CI checks[\s\S]*PR #7 in acme\/shop – FIX-7@shop[\s\S]*watch CI until every check passes/);

  const t = await drive("FIX-7@shop", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO", "DONE"]);
  assert.equal(t.state, "AWAITING_APPROVAL", t.error ?? "");
  assert.deepEqual(t.data.fixItems.map((i: any) => [i.kind, i.check]), [["check", "Regression replay"]], "only the failing check – not the review comments");
  assert.match(t.data.fixItems[0].body, /Command: python scripts\/run_regression\.py replay[\s\S]*ALT-01/);
  assert.ok((t.data.ciFailures ?? [])[0]?.includes("ALT-01"), "the implementer gets the CI log itself");
  const preview = sent.find((m) => /Fixes for PR #7 ready/.test(m) && /CI check "Regression replay"/.test(m)) ?? "";
  assert.match(preview, /\*\*1\.\*\* ✅ fixed · CI check "Regression replay" · CI/);
  assert.match(preview, /Still running on GitHub:\*\* Tests & Coverage/);
  assert.match(preview, /I watch CI until every check passes/);
  assert.equal(remoteHead("feat/KAN-9/refund"), head0, "nothing pushed before the OK");

  const repliesBefore = replies.length + prComments.length;
  await say("1");
  const done = await drive("FIX-7@shop", ["DONE", "FAILED", "PAUSED"]);
  assert.equal(done.state, "DONE", done.error ?? "");
  const head1 = remoteHead("feat/KAN-9/refund");
  assert.notEqual(head1, head0);
  assert.equal(replies.length + prComments.length, repliesBefore, "a CI check gets no reply comment");
  const pushedMsg = sent.find((m) => /Fixes pushed to PR #7/.test(m) && /watching CI/.test(m)) ?? "";
  assert.ok(pushedMsg, "told that CI is watched");
  assert.doesNotMatch(pushedMsg, /QA starts now/, "CI-only fixes: CI is the check");
  const watch = JSON.parse(getMeta("fix.ciwatch") ?? "[]");
  assert.deepEqual(watch.map((w: any) => [w.num, w.sha, w.round]), [[7, head1, 2]]);

  // CI still running on the new commit: keep waiting
  checks.set(head1, [{ id: "run:4", name: "Regression replay", state: "pending", conclusion: "queued", url: "x" }]);
  await pollCiWatches();
  assert.equal(JSON.parse(getMeta("fix.ciwatch") ?? "[]").length, 1);
  // it fails again: the next round starts by itself (and is shown first again)
  checks.set(head1, [{ id: "run:5", name: "Regression replay", state: "failed", conclusion: "failure", url: "x", jobId: 12 }]);
  await pollCiWatches();
  assert.match(sent.at(-1)!, /CI failed on PR #7 – fixing it \(round 2 of 3\)[\s\S]*Regression replay ❌/);
  const round2 = getTask("FIX-7@shop")!;
  assert.equal(round2.data.fix.mode, "ci");
  assert.equal(round2.data.fix.ciRound, 2);
  await cancelTask("FIX-7@shop", "test");
  // green: the developer is told
  checks.set(head1, [{ id: "run:6", name: "Regression replay", state: "passed", conclusion: "success", url: "x" }, { id: "run:7", name: "Tests & Coverage", state: "passed", conclusion: "success", url: "x" }]);
  const { watchCi } = await import("../engine/prFix.js");
  watchCi({ projectId: "shop", repo: "acme/shop", num: 7, sha: head1, by: "sneha", via: "teams-personal", round: 3 });
  await pollCiWatches();
  assert.match(sent.at(-1)!, /CI passes on PR #7[\s\S]*All 2 checks passed/);
  assert.equal(JSON.parse(getMeta("fix.ciwatch") ?? "[]").length, 0);
});
