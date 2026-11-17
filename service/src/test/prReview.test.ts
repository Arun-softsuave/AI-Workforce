import { makeRepo, sh, waitFor } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setMeta } from "../core/db.js";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../core/config.js";
import { clients, connect } from "../connectors/registry.js";
import type { GitHubClient, PrReviewInfo, ReviewComment } from "../connectors/github.js";
import type { JiraClient } from "../connectors/jira.js";
import { setTeamsPersonalClient, type TeamsPersonalClient, type TpMessage } from "../connectors/teamsPersonal.js";
import { setRunner, MockRunner, type AgentRequest } from "../agents/runner.js";
import { pollTeamsCommands } from "../intake/teamsCommands.js";
import { setEngineRole, tick } from "../engine/engine.js";
import { getTask, createTask, type Task } from "../engine/tasks.js";
import { parsePrRef, commentableLines } from "../engine/prReview.js";
import { screenshotsLine, withScreenshots } from "../engine/screenshots.js";
import { flowSvg, contractSvg, reportHtml } from "../report/ticketReport.js";
import { formatQuestions, resolveReply, formatChoices } from "../core/questions.js";
import { splitMessage, chatText } from "../notify/channels.js";

/**
 * Reviewing a teammate's PR from Teams: the PR is checked out read-only, reviewed with the ticket and the PRD, the
 * comments are shown FIRST, edited in the chat ("change 1: …"), and only posted after "post" – as a comment review.
 * Also: screenshots in the PR body, the ticket report and the chat layout.
 */
const OWNER = "8:live:owner";
const sent: string[] = [];
let chat: TpMessage[] = [];
const fakeTeams: TeamsPersonalClient = {
  hasSavedLogin: () => true, startLogin: async () => ({ userCode: "X", verificationUrl: "https://x", expiresAt: Date.now() + 1e6 }),
  waitForLogin: async () => {}, logout: () => {}, whoAmI: async () => ({ mri: "8:live:bot", region: "emea" }),
  listChats: async () => [], findChats: async () => [],
  getChatMembers: async () => [{ mri: "8:live:bot", name: "Bot", isMe: true }, { mri: OWNER, name: "Owner", isMe: false }],
  sendMessage: async (_c, text) => { sent.push(text); return { sent: true }; },
  getMessages: async (_c, since) => chat.filter((m) => !since || m.time > since),
};
setTeamsPersonalClient(fakeTeams);

// a teammate's PR #7: a commit on another branch, published as refs/pull/7/head in the "GitHub" remote
const { repo, origin } = makeRepo("shop");
sh(repo, "checkout", "-q", "-b", "teammate/refund-limit");
fs.writeFileSync(path.join(repo, "src", "services", "refund.ts"), "import { stripe } from './stripe';\nexport async function refund(paymentId: string, amount: number) {\n  return stripe.refunds.create({ payment_intent: paymentId, amount });\n}\n");
sh(repo, "commit", "-q", "-am", "KAN-9 refund amount");
const head = sh(repo, "rev-parse", "HEAD");
sh(repo, "push", "-q", "origin", "HEAD:refs/pull/7/head");
sh(repo, "checkout", "-q", "main");
process.env.AIW_GIT_PUSH_URL = origin;

const patch = "@@ -1,4 +1,4 @@\n import { stripe } from './stripe';\n-export async function refund(paymentId: string) {\n-  return stripe.refunds.create({ payment_intent: paymentId });\n+export async function refund(paymentId: string, amount: number) {\n+  return stripe.refunds.create({ payment_intent: paymentId, amount });\n }";
const pr: PrReviewInfo = {
  number: 7, title: "KAN-9 refund amount", body: "Adds the amount to refunds.", url: "https://github.com/acme/shop/pull/7", author: "teammate", state: "open", draft: false, merged: false,
  headRef: "teammate/refund-limit", headSha: head, baseRef: "main", baseSha: "", files: [{ path: "src/services/refund.ts", status: "modified", additions: 2, deletions: 2, patch }],
  checks: [{ name: "build", conclusion: "success" }], comments: [],
};
const posted: { repo: string; num: number; r: { commitId: string; body: string; comments: ReviewComment[] } }[] = [];
const fakeGitHub: GitHubClient = {
  user: async () => ({ login: "me" }), repo: async () => ({ defaultBranch: "main", private: true }),
  findOpenPr: async () => undefined, createPr: async () => ({ number: 1, url: "x" }), updatePr: async () => ({ number: 1, url: "x" }),
  failedRuns: async () => [], failedJobLog: async () => "", gitAuthHeader: () => "AUTHORIZATION: basic dGVzdA==", recentPrBases: async () => [], prActivity: async () => [],
  prForReview: async (_r, n) => { if (n !== 7) throw new Error("404"); return pr; },
  createReview: async (r, num, review) => { posted.push({ repo: r, num, r: review }); return { id: 55, url: "https://github.com/acme/shop/pull/7#pullrequestreview-55" }; },
};
const fakeJira: JiraClient = {
  site: "https://acme.atlassian.net", myself: async () => ({ accountId: "me", displayName: "Me" }), search: async () => [], addComment: async () => {},
  getIssue: async (k) => (k === "KAN-9" ? { provider: "jira", id: "9", key: "KAN-9", projectKey: "KAN", title: "Refund a part of a payment", description: "Support can refund part of a payment. The amount must never exceed the payment.",
    status: "In Review", statusCategory: "indeterminate", assignee: "teammate", priority: "High", labels: [], url: "https://acme.atlassian.net/browse/KAN-9", updated: new Date().toISOString(), comments: [{ author: "PM", body: "Amounts are in cents." }] } as any : undefined),
};
clients.github = () => fakeGitHub;
clients.jira = () => fakeJira;

saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Owner", workingHours: "00:00-23:59", roles: ["fullstack-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "teams-personal", fallback: ["inbox"] },
});
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" }, local: { path: repo }, roles: ["fullstack-developer"], autonomy: "prepare" }));
const reviewerCalls: AgentRequest[] = [];
setRunner(new MockRunner({ "pr-reviewer": (req) => {
  reviewerCalls.push(req);
  return { summary: "Adds a refund amount but never checks it.", ticketCoverage: "Partly", verdict: "changes_needed", verdictReason: "The amount is not limited to the payment.",
    requirementsCheck: [{ requirement: "Refund part of a payment", status: "met", where: "refund.ts" }, { requirement: "Amount never exceeds the payment", status: "missing", where: "" }],
    comments: [
      { file: "src/services/refund.ts", line: 2, severity: "major", title: "Amount is not checked", body: "The amount can be larger than the payment.", suggestion: "" },
      { file: "src/services/refund.ts", line: 40, severity: "minor", title: "Off the diff", body: "This line is not part of the change.", suggestion: "" },
    ] };
} }));
setEngineRole("daemon");

let clock = Date.now();
async function say(text: string): Promise<string> {
  clock += 1000;
  chat.push({ id: `m${clock}`, conversationId: OWNER, from: "Owner", fromId: OWNER, isMine: false, time: new Date(clock).toISOString(), text });
  const before = sent.length;
  await pollTeamsCommands(true);
  return sent.slice(before).join("\n---\n");
}
const drive = (ref: string, states: string[]) => waitFor(() => { void tick(); const t = getTask(ref); return t && states.includes(t.state) ? t : undefined; }, 60_000, 100);

test("PR references and the lines GitHub accepts comments on", () => {
  assert.deepEqual(parsePrRef("review https://github.com/acme/shop/pull/90 please"), { repo: "acme/shop", num: 90 });
  assert.equal(parsePrRef("review PR #12 frontend")?.num, 12);
  assert.equal(parsePrRef("can you review pull request 5")?.num, 5);
  assert.equal(parsePrRef("review the code"), undefined);
  assert.deepEqual([...commentableLines(patch)], [1, 2, 3, 4]);
  assert.deepEqual([...commentableLines("@@ -10,3 +20,4 @@\n a\n+b\n-c\n d")], [20, 21, 22]);
});

test("review a teammate's PR from Teams: ticket + PRD considered, shown first, edited, then posted as comments only", async () => {
  const c = await connect("teams-personal", { mode: "bot", chatId: OWNER, chatTitle: "Owner", ownerId: OWNER, ownerName: "Owner" });
  assert.equal(c.ok, true);
  setMeta("teams_personal.cursor", new Date(clock).toISOString());

  const started = await say("can you review PR 7");
  assert.match(started, /Reviewing[\s\S]*PR #7 in acme\/shop[\s\S]*Nothing is posted until you reply "post"/);

  const waiting = await drive("PR-7@shop", ["AWAITING_APPROVAL", "FAILED", "PAUSED"]);
  assert.equal(waiting.state, "AWAITING_APPROVAL", waiting.error ?? "");
  // the PR code was checked out read-only at the PR's commit; no branch was created
  assert.ok(waiting.worktree && fs.existsSync(path.join(waiting.worktree, "src", "services", "refund.ts")));
  assert.equal(sh(waiting.worktree!, "rev-parse", "HEAD"), head);
  assert.match(fs.readFileSync(path.join(waiting.worktree!, "src", "services", "refund.ts"), "utf8"), /amount: number/);
  // the reviewer saw the Jira ticket with its comments, the PRD/Brain section and the diff
  const prompt = reviewerCalls.at(-1)!.prompt;
  assert.match(prompt, /Jira ticket KAN-9/);
  assert.match(prompt, /Amounts are in cents/);
  assert.match(prompt, /Product requirements and project knowledge/);
  assert.match(prompt, /### src\/services\/refund\.ts\n```diff/);

  // nothing posted yet; the preview shows verdict, requirement check and the comment that is on the diff
  assert.equal(posted.length, 0);
  const preview = sent.at(-1)!;
  assert.match(preview, /Review of PR #7 ready/);
  assert.match(preview, /Verdict: 🟠 Changes needed/);
  assert.match(preview, /❌ Amount never exceeds the payment – missing/);
  assert.match(preview, /\*\*1\.\*\* 🟠 major · `src\/services\/refund\.ts` line 2/);
  assert.match(preview, /General points[\s\S]*around line 40/, "a comment off the diff goes to the summary");
  assert.match(preview, /post 1, 3 – post only those comments/);

  // "drop 1" must not cancel the review ("drop" is also a cancel word)
  const changed = await say("change 1: Please check that the amount is not larger than the payment (in cents).");
  assert.match(changed, /Comment 1 of PR-7@shop now says/);
  assert.equal(getTask("PR-7@shop")!.state, "AWAITING_APPROVAL");

  const ok = await say("post");
  assert.match(ok, /Posting the review on acme\/shop#7 – as comments only/);
  const done = await drive("PR-7@shop", ["DONE", "FAILED", "PAUSED"]);
  assert.equal(done.state, "DONE", done.error ?? "");
  assert.equal(posted.length, 1);
  const r = posted[0];
  assert.equal(r.r.commitId, head);
  assert.deepEqual(r.r.comments.map((x) => [x.path, x.line, x.side]), [["src/services/refund.ts", 2, "RIGHT"]]);
  assert.match(r.r.comments[0].body, /in cents/);
  assert.match(r.r.body, /Changes needed\*\* – The amount is not limited/);
  assert.doesNotMatch(`${r.r.body}${r.r.comments.map((x) => x.body).join("")}`, /claude|\bAI\b/i);
  assert.ok(!getTask("PR-7@shop")!.worktree, "the read-only checkout is removed");
  assert.match(sent.at(-1)!, /Review posted on PR #7/);
});

test("drop and post a selection", async () => {
  pr.headSha = head;
  const started = await say("review https://github.com/acme/shop/pull/7");
  assert.match(started, /PR #7/);
  await drive("PR-7@shop", ["AWAITING_APPROVAL", "FAILED"]);
  const dropped = await say("drop 1");
  assert.match(dropped, /Removed comment 1/);
  assert.equal(getTask("PR-7@shop")!.state, "AWAITING_APPROVAL", "drop edits the review, it does not cancel it");
  assert.match(await say("post 1"), /comments 1, 3|there are comments/i);
});

test("screenshots go into the PR body on their own branch", () => {
  const shots = path.join(path.dirname(repo), "shots");
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, "orders-desktop.png"), "png");
  fs.writeFileSync(path.join(shots, "orders-mobile.png"), "png");
  const t = createTask({ projectId: "shop", source: "jira", sourceRef: "KAN-11", title: "Orders", kind: "assigned",
    data: { ticket: { key: "KAN-11" }, screenshots: { taken: true, pages: [{ name: "orders", route: "/orders", state: "filled", desktop: path.join(shots, "orders-desktop.png"), mobile: path.join(shots, "orders-mobile.png") }], problems: [], at: "" } } }) as Task;
  const body = withScreenshots(t, normaliseProject({ id: "shop", github: { repo: "acme/shop" }, local: { path: repo }, roles: [] }), "## Summary\nx\n\n## Screenshots\n\nNot attached yet.\n\n## Testing\nok", "AUTHORIZATION: basic dGVzdA==");
  assert.match(body, /## Screenshots\n\n\*\*orders\*\* – filled \(`\/orders`\)/);
  assert.match(body, /blob\/pr-screenshots\/KAN-11\/KAN-11\/orders-desktop\.png\?raw=true/);
  assert.doesNotMatch(body, /Not attached yet/);
  assert.match(body, /## Testing\nok/);
  // the images are on the remote branch, the task branch is untouched
  assert.match(sh(repo, "ls-remote", origin, "refs/heads/pr-screenshots/KAN-11"), /pr-screenshots\/KAN-11/);
  assert.match(screenshotsLine({ taken: false, reason: "the app did not start", pages: [], problems: [], at: "" }), /Could not be taken – the app did not start/);
});

test("ticket report: diagrams and sections", () => {
  const svg = flowSvg([{ id: "a", label: "Orders page", layer: "ui", changed: true }, { id: "b", label: "GET /orders", layer: "api" }], [{ from: "a", to: "b", label: "loads" }]);
  for (const s of ["<svg", "Orders page", "node changed", "loads", "marker-end"]) assert.ok(svg.includes(s), s);
  assert.match(contractSvg({ items: [{ kind: "endpoint", name: "GET /orders", producer: "api", consumer: "web" }] }, ["api", "web"]), /GET \/orders/);
  const t = createTask({ projectId: "shop", source: "jira", sourceRef: "KAN-12", title: "Orders export", kind: "assigned",
    data: { ticket: { key: "KAN-12", title: "Orders export" }, requirements: { acceptanceCriteria: ["CSV has all columns"] }, pr: { number: 3, url: "https://github.com/acme/shop/pull/3" }, changedFiles: ["src/export.ts"] } });
  const html = reportHtml(t, { summary: "Adds a CSV export.", asked: "Export orders", outcome: "Done", changes: [{ repo: "shop", what: "New export", files: [{ file: "src/export.ts", why: "builds the CSV" }] }], flow: { nodes: [], edges: [] }, followUps: [] }, []);
  for (const s of ["KAN-12", "What was asked", "CSV has all columns", "src/export.ts", "builds the CSV", "PR #3", "What happened"]) assert.ok(html.includes(s), s);
});

test("chat layout: spaced options, keycap numbers understood, long messages split between sections", () => {
  const q = formatQuestions([{ question: "Which limit?", options: ["10 MB", "25 MB"] }]);
  assert.match(q, /❓ \*\*Question\*\*\nWhich limit\?\n\n1️⃣  10 MB   ⭐ recommended\n\n2️⃣  25 MB\n\n↩️/);
  assert.deepEqual(resolveReply([{ question: "Which limit?", options: ["10 MB", "25 MB"] }], "2️⃣"), { ok: true, answer: "Which limit? → 25 MB" });
  assert.match(formatChoices("post_review"), /drop 2 – remove comment 2/);
  const text = chatText({ kind: "info", title: "Title", body: "Body", facts: [["Tests", "passed"]], url: "https://x" });
  assert.equal(text, "**Title**\n\nBody\n\n- **Tests:** passed\n\n🔗 https://x");
  const sections = Array.from({ length: 30 }, (_, i) => `**Section ${i}**\n${"word ".repeat(40)}`).join("\n\n");
  const parts = splitMessage(sections, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.match(p.replace(/^\(\d+\/\d+\)\n\n/, ""), /^\*\*Section \d+\*\*/, "every part starts at a section");
});
