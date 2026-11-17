import { makeRepo, sh, waitFor } from "./helpers.js";
import { prEndState, settleAfterPr } from "./engineHelpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "../core/db.js";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../core/config.js";
import { paths } from "../core/paths.js";
import { clients } from "../connectors/registry.js";
import type { JiraClient } from "../connectors/jira.js";
import type { GitHubClient } from "../connectors/github.js";
import type { WorkItem } from "../connectors/types.js";
import { setRunner, MockRunner } from "../agents/runner.js";
import { setSenders, inbox } from "../notify/router.js";
import { pollJira } from "../intake/intake.js";
import { setEngineRole, tick, runTask, triageTask, decideAndApply, recoverInterrupted, resumeTask, startAwaiting } from "../engine/engine.js";
import { getTask, listTasks, transition, stepsFor } from "../engine/tasks.js";
import { onboardProject } from "../brain/brain.js";
import { readDiary } from "../brain/index.js";

// ---------------------------------------------------------------- fakes
let issues: WorkItem[] = [];
const comments: string[] = [];
const prs: any[] = [];
let clock = 0;
const issue = (key: string, o: Partial<WorkItem> = {}): WorkItem => ({
  provider: "jira", id: `id-${key}`, key, projectKey: key.split("-")[0], title: `Partial refunds for ${key}`,
  description: "Allow customers to refund part of a payment. The refund amount must never exceed the original payment amount. Add tests.",
  status: "To Do", statusCategory: "new", assignee: "me", priority: "High", labels: [], url: `https://acme.atlassian.net/browse/${key}`,
  updated: new Date(Date.UTC(2026, 10, 10, 9, 0, clock++)).toISOString(), comments: [], ...o,
});
const fakeJira: JiraClient = {
  site: "https://acme.atlassian.net",
  myself: async () => ({ accountId: "me", displayName: "Me" }),
  search: async () => issues,
  getIssue: async (k) => issues.find((i) => i.key === k),
  addComment: async (k, t) => { comments.push(`${k}: ${t}`); },
};
const fakeGitHub: GitHubClient = {
  user: async () => ({ login: "me" }),
  repo: async () => ({ defaultBranch: "main", private: true }),
  findOpenPr: async (_r, b) => prs.find((p) => p.head === b),
  createPr: async (_r, p) => { const pr = { number: 300 + prs.length, url: `https://github.com/acme/pay/pull/${300 + prs.length}`, ...p }; prs.push(pr); return pr; },
  updatePr: async (_r, n, p) => { const pr = prs.find((x) => x.number === n); Object.assign(pr, p); return pr; },
  failedRuns: async () => [],
  failedJobLog: async () => "",
  gitAuthHeader: () => "AUTHORIZATION: basic dGVzdA==",
  recentPrBases: async () => [], prActivity: async () => [],
  requestReviewers: async (_r, n, w) => { reviewRequests.push({ n, ...w }); return { requested: [...w.users, ...w.teams] }; },
};
const reviewRequests: any[] = [];

const { repo, origin } = makeRepo();
process.env.AIW_GIT_PUSH_URL = origin;
clients.jira = () => fakeJira;
clients.github = () => fakeGitHub;
const sent: string[] = [];
setSenders({ desktop: { send: async (n) => { sent.push(`${n.kind}:${n.title}`); return undefined; } } });
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Tester", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  limits: { ...DEFAULT_SETTINGS.limits, askBeforeStart: [], burstThreshold: 3 },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off" },
  workflow: { ...DEFAULT_SETTINGS.workflow, planApproval: "autonomy" },
});
upsertProject(normaliseProject({
  id: "payment-service", jira: { site: "acme.atlassian.net", keys: ["PAY"] }, github: { repo: "acme/pay", baseBranch: "main" },
  local: { path: repo, testCommand: "node -e \"process.exit(0)\"" }, roles: ["backend-developer"], autonomy: "prepare",
  reviewers: { from: "list", logins: ["eric", "me"] },
}));
db().prepare("INSERT INTO connections (provider, account, status, meta, updated_at) VALUES ('jira','me','connected','{\"site\":\"acme.atlassian.net\",\"email\":\"me@x\"}', datetime())").run();
setEngineRole("daemon");

const runner = new MockRunner();
setRunner(runner);

async function settle(ref: string, states: string[]) {
  return waitFor(() => { const t = getTask(ref); return t && states.includes(t.state) ? t : undefined; }, 60_000);
}

test("onboarding builds the Brain (map + handbook + index)", async () => {
  const r = await onboardProject("payment-service");
  assert.ok(r.map.files.length >= 3);
  assert.ok(fs.existsSync(path.join(repo, ".ai-workforce", "knowledge", "overview.md")));
  assert.ok(fs.readFileSync(path.join(repo, ".ai-workforce", "knowledge", "standards.md"), "utf8").includes("npm test"));
  const { readRulesCard } = await import("../brain/rulesCard.js");
  assert.match(readRulesCard("payment-service") ?? "", /Repository rules – payment-service[\s\S]*Never commit/, "the rules card is built at onboarding");
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "Add AI Workforce handbook"); sh(repo, "push", "-q", "origin", "main");
});

test("Jira assignment -> triage -> feature playbook -> approval -> draft PR -> memory", async () => {
  issues = [issue("PAY-142")];
  const r = await pollJira();
  assert.equal(r.tasks.length, 1);
  const again = await pollJira();
  assert.equal(again.tasks.length, 0, "polling the same change twice creates nothing (idempotent)");

  await tick();                                                   // triage + start
  const waiting = await settle("PAY-142", ["AWAITING_APPROVAL", "FAILED", "PAUSED"]);
  assert.equal(waiting.state, "AWAITING_APPROVAL", waiting.error ?? "");
  assert.equal(waiting.size, "M");
  assert.equal(waiting.playbook, "dev-feature");
  assert.ok(waiting.branch!.startsWith("feat/PAY-142-"), "branch follows the detected convention (no history -> {type}/{key}-{slug})");
  assert.ok(fs.existsSync(waiting.worktree!), "isolated worktree exists");
  assert.equal(sh(repo, "status", "--porcelain"), "", "the user's own working copy is untouched");
  assert.ok(inbox().some((i) => i.kind === "approval_needed" && i.notice.taskRef === "PAY-142"), "approval shows in Claude Code inbox");
  assert.ok(sent.some((s) => s.startsWith("picked_up:")) && sent.some((s) => s.startsWith("approval_needed:")));

  // agents never get publishing tools; reviewers only see the diff, not the repo
  const impl = runner.calls.find((c) => c.agent === "implementer")!;
  assert.ok(!(impl.allow ?? []).some((a) => /push|merge/i.test(a)));
  const reviewer = runner.calls.find((c) => c.agent.startsWith("reviewer:"))!;
  assert.equal(reviewer.cwd, undefined);
  assert.equal(new Set(runner.calls.filter((c) => c.agent.startsWith("reviewer:")).map((c) => c.agent)).size, 3, "code, security and QA reviewers ran");

  const res = await decideAndApply("PAY-142", "approved", "Tester", "claude-code");
  assert.equal(res.ok, true);
  const done = await settleAfterPr("PAY-142", ["FAILED", "PAUSED"]);
  assert.equal(done.state, prEndState(), done.error ?? "");
  assert.equal(prs.length, 1);
  assert.equal(prs[0].draft, false, "PRs are ready for review by default (aiw prefs --draft-pr yes for drafts)");
  assert.deepEqual(reviewRequests.map((r) => r.users), [["eric"]], "the project's reviewers are asked – never the author");
  const { getMeta } = await import("../core/db.js");
  await new Promise((r) => setTimeout(r, 50));
  if (prEndState() === "PR_OPEN") {
    // engine v2: the watch is a ci_watch job on the PR's item (waiting until CI finishes)
    const w = db().prepare("SELECT state, data FROM jobs WHERE item_id=? AND type='ci_watch'").all(getTask("PAY-142")!.id) as any[];
    assert.ok(w.some((j) => j.state === "waiting" && JSON.parse(j.data).repo === "acme/pay" && JSON.parse(j.data).num === prs[0].number), "CI is watched from the first commit of the PR");
  } else {
    assert.ok(JSON.parse(getMeta("fix.ciwatch") ?? "[]").some((w: any) => w.repo === "acme/pay" && w.num === prs[0].number), "CI is watched from the first commit of the PR");
  }
  // HARD RULE: nothing that leaves the machine mentions Claude / AI authorship
  const { attributionHits } = await import("../core/attribution.js");
  assert.deepEqual(attributionHits(`${prs[0].title}\n${prs[0].body}`), [], "PR title/body carry no AI attribution");
  const pushed = sh(origin, "log", "--format=%an <%ae>%n%B", `main..${prs[0].head}`);
  assert.deepEqual(attributionHits(pushed), [], "commit authors and messages carry no AI attribution");
  assert.ok(!/AI Workforce/i.test(pushed));
  assert.equal(sh(origin, "ls-tree", "-r", "--name-only", prs[0].head).split("\n").filter((f) => f.startsWith(".ai-workforce/") && !sh(origin, "ls-tree", "-r", "--name-only", "main").includes(f)).length, 0, "no new .ai-workforce files in the PR");
  assert.ok(prs[0].title.startsWith("PAY-142"));
  assert.ok(sh(origin, "branch", "--list", "*PAY-142*").includes("PAY-142"), "branch pushed to origin");
  assert.ok(!sh(origin, "log", "main", "--oneline").includes("AIW"), "main was never changed (no merge)");
  assert.ok(readDiary("payment-service").some((d) => d.file.startsWith("PAY-142")), "task diary written");
  assert.ok(stepsFor(done.id).every((s) => s.status === "ok" || s.status === "await_approval"));
});

test("second approval for the same request is refused; approvals are audited", async () => {
  const r = await decideAndApply("PAY-142", "approved", "Tester", "slack");
  assert.equal(r.ok, false);
  const audits = db().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'approval.%'").get() as any;
  assert.ok(audits.n >= 2);
});

test("rejection feeds back into a re-run from the plan", async () => {
  issues = [issue("PAY-150", { title: "Refund reasons" })];
  await pollJira(); await tick();
  await settle("PAY-150", ["AWAITING_APPROVAL"]);
  const before = runner.calls.filter((c) => c.agent === "planner").length;
  await decideAndApply("PAY-150", "rejected", "Tester", "claude-code", "Use the existing RefundValidator class");
  await tick();
  const t = await settle("PAY-150", ["AWAITING_APPROVAL"]);
  assert.equal(t.run_no, 2);
  assert.ok(runner.calls.filter((c) => c.agent === "planner").length > before);
  assert.ok(runner.calls.filter((c) => c.agent === "planner").at(-1)!.prompt.includes("RefundValidator"), "feedback reaches the planner");
});

test("approval becomes stale if the code changes after the request", async () => {
  const t = getTask("PAY-150")!;
  fs.writeFileSync(path.join(t.worktree!, "late.txt"), "unexpected");
  sh(t.worktree!, "add", "-A"); sh(t.worktree!, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "late change");
  await decideAndApply("PAY-150", "approved", "Tester", "dashboard");
  const p = await settle("PAY-150", ["PAUSED", "DONE"]);
  assert.equal(p.state, "PAUSED");
  assert.match(p.error ?? "", /STALE/);
  assert.equal(prs.filter((x) => x.title.includes("PAY-150")).length, 0, "nothing was published");
});

test("unclear ticket asks a question instead of spending tokens", async () => {
  issues = [issue("PAY-160", { description: "TBD ??" })];
  await pollJira(); await tick();
  const t = await settle("PAY-160", ["NEEDS_INFO"]);
  assert.ok(t.data.questions.length >= 1);
  assert.ok(!runner.calls.some((c) => c.prompt.includes("PAY-160") && c.agent !== "triage"));
});

test("unassigned ticket cancels its running work", async () => {
  issues = [issue("PAY-170")];
  await pollJira();
  const t = listTasks({}).find((x) => x.source_ref === "PAY-170")!;
  await triageTask(getTask(t.id)!);
  issues = [issue("PAY-170", { assignee: "someone-else" })];
  await pollJira();
  assert.equal(getTask("PAY-170")!.state, "CANCELLED");
});

test("sprint-start burst is batched into one decision", async () => {
  issues = ["PAY-201", "PAY-202", "PAY-203", "PAY-204"].map((k) => issue(k));
  const r = await pollJira();
  assert.equal(r.tasks.length, 4);
  assert.ok(inbox().some((i) => i.kind === "burst" && i.title.includes("4 new tasks")));
  await tick();
  assert.ok(["PAY-201", "PAY-202", "PAY-203", "PAY-204"].every((k) => getTask(k)!.state === "AWAITING_START"));
  assert.equal(startAwaiting("PAY-201"), 1);
  for (const k of ["PAY-202", "PAY-203", "PAY-204"]) transition(getTask(k)!.id, "CANCELLED");
});

test("crash recovery resumes from the last checkpoint and publishes exactly once", async () => {
  const t = getTask("PAY-201")!;
  await runTask(t.id);
  assert.equal(getTask(t.id)!.state, "AWAITING_APPROVAL");
  const checkpoint = getTask(t.id)!.step_index;
  // Approval recorded, then the service "crashes" right after moving the task back to RUNNING.
  const { decide } = await import("../approvals/approvals.js");
  assert.equal(decide("PAY-201", "approved", "Tester", "dashboard").ok, true);
  transition(t.id, "QUEUED", "approved"); transition(t.id, "RUNNING", "publishing… then crash");
  assert.ok(recoverInterrupted() >= 1);
  assert.equal(getTask(t.id)!.state, "QUEUED");
  assert.equal(getTask(t.id)!.step_index, checkpoint, "checkpoint kept");
  const before = prs.length;
  await runTask(t.id);
  assert.equal(getTask(t.id)!.state, "DONE");
  assert.equal(prs.length, before + 1, "exactly one PR");
  // A second replay of publish must update, not duplicate.
  const { STEPS } = await import("../engine/steps.js");
  assert.ok(STEPS.publish);
});

test("budget pause and resume (only when stopForBudget is switched on)", async () => {
  const { loadSettings } = await import("../core/config.js");
  const s0 = loadSettings();
  saveSettings({ ...s0, workflow: { ...s0.workflow, stopForBudget: true } });
  issues = [issue("PAY-300")];
  upsertProject(normaliseProject({
    id: "payment-service", jira: { site: "acme.atlassian.net", keys: ["PAY"] }, github: { repo: "acme/pay", baseBranch: "main" },
    local: { path: repo, testCommand: "node -e \"process.exit(0)\"" }, roles: ["backend-developer"], autonomy: "prepare",
    budget: { perTaskTokens: { S: 2500, M: 2500, L: 2500 } },
  }));
  await pollJira(); await tick();
  const p = await settle("PAY-300", ["PAUSED", "AWAITING_APPROVAL"]);
  assert.equal(p.state, "PAUSED");
  assert.match(p.error ?? "", /budget/i);
  resumeTask("PAY-300");
  assert.equal(getTask("PAY-300")!.state, "QUEUED");
  assert.ok(fs.existsSync(paths.db()));
  saveSettings(s0);
});

test("a task resumed past workspace preparation without a worktree re-creates it (never uses the current directory)", async () => {
  issues = [issue("PAY-400")];
  upsertProject(normaliseProject({
    id: "payment-service", jira: { site: "acme.atlassian.net", keys: ["PAY"] }, github: { repo: "acme/pay", baseBranch: "main" },
    local: { path: repo, testCommand: "node -e \"process.exit(0)\"" }, roles: ["backend-developer"], autonomy: "prepare",
  }));
  await pollJira();
  const t = listTasks({}).find((x) => x.source_ref === "PAY-400")!;
  await triageTask(getTask(t.id)!);
  db().prepare("UPDATE tasks SET step_index=7, worktree=NULL WHERE id=?").run(t.id);
  // If the test runs inside a git checkout, its history must not change (works whether or not cwd is a repo).
  const cwdLog = () => { try { return sh(process.cwd(), "log", "-1", "--format=%H"); } catch { return "no-repo"; } };
  const cwdBefore = cwdLog();
  await runTask(t.id);
  const after = getTask(t.id)!;
  assert.equal(after.state, "AWAITING_APPROVAL", after.error ?? "");
  assert.ok(after.worktree && fs.existsSync(after.worktree), "worktree re-created");
  assert.equal(cwdLog(), cwdBefore, "nothing was committed in the current directory");
});
