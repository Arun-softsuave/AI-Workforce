import { makeRepo, waitFor } from "./helpers.js";
import { prEndState, settleAfterPr } from "./engineHelpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../core/config.js";
import { clients } from "../connectors/registry.js";
import type { WorkItem } from "../connectors/types.js";
import type { GitHubClient } from "../connectors/github.js";
import { setRunner, MockRunner } from "../agents/runner.js";
import { setSenders } from "../notify/router.js";
import type { Notice } from "../notify/channels.js";
import { pollJira } from "../intake/intake.js";
import { setEngineRole, tick, decideAndApply, migrateToLeadTasks } from "../engine/engine.js";
import { getTask, listTasks, partsOf, stepsFor, createTask, transition, updateTask } from "../engine/tasks.js";
import { latestApproval } from "../approvals/approvals.js";
import { db, delMeta } from "../core/db.js";
import { planMessage } from "../engine/steps.js";
import { statusText } from "../api/ops.js";

/**
 * One ticket across two repositories (backend + frontend): ONE lead task reads both, decides the repositories and the
 * build order, writes the contract, gets ONE plan approval, builds the parts in order, checks they fit together and
 * gets ONE PR approval for two linked draft PRs.
 */
const be = makeRepo("nue-marketplace-backend");
const fe = makeRepo("nue-marketplace-frontend");
// one bare "origin" per repository (pushes go to {repo})
const originDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiw-origins-"));
for (const name of ["acme_nue-backend", "acme_nue-frontend"]) execFileSync("git", ["init", "--bare", "-q", "-b", "main", path.join(originDir, `${name}.git`)]);
process.env.AIW_GIT_PUSH_URL = path.join(originDir, "{repo}.git");

let issues: WorkItem[] = [];
let n = 0;
const issue = (key: string, title: string, description: string): WorkItem => ({
  provider: "jira", id: `id-${key}`, key, projectKey: "KAN", title, description, status: "To Do", statusCategory: "new",
  assignee: "me", labels: [], url: `https://nue.atlassian.net/browse/${key}`, updated: new Date(Date.UTC(2026, 10, 10, 8, 0, n++)).toISOString(),
});
clients.jira = () => ({ site: "x", myself: async () => ({ accountId: "me", displayName: "Me" }), search: async () => issues,
  getIssue: async (k) => issues.find((i) => i.key === k), addComment: async () => {} });
const prs: any[] = [];
const fakeGitHub: GitHubClient = {
  user: async () => ({ login: "me" }), repo: async () => ({ defaultBranch: "main", private: true }),
  findOpenPr: async (r: string, b: string) => prs.find((p) => p.repo === r && p.head === b),
  createPr: async (r: string, p: any) => { const pr = { repo: r, number: 500 + prs.length, url: `https://github.com/${r}/pull/${500 + prs.length}`, ...p }; prs.push(pr); return pr; },
  updatePr: async (r: string, num: number, p: any) => { const pr = prs.find((x) => x.repo === r && x.number === num); Object.assign(pr, p); return pr; },
  failedRuns: async () => [], failedJobLog: async () => "", gitAuthHeader: () => "AUTHORIZATION: basic dGVzdA==",
  recentPrBases: async () => [], prActivity: async () => [],
};
clients.github = () => fakeGitHub;
const sent: Notice[] = [];
setSenders({ desktop: { send: async (x) => { sent.push(x); return undefined; } } });
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS), profile: { name: "Sneha", workingHours: "00:00-23:59", roles: ["fullstack-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" }, limits: { ...DEFAULT_SETTINGS.limits, askBeforeStart: [], maxParallel: 2 },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off", exclusive: false },
});
const common = { jira: { site: "x", keys: ["KAN"] }, roles: ["fullstack-developer"], autonomy: "plan", group: "nue-marketplace" };
upsertProject(normaliseProject({ id: "nue-backend", ...common, github: { repo: "acme/nue-backend", baseBranch: "main" }, local: { path: be.repo, testCommand: "node -e \"process.exit(0)\"" } }));
upsertProject(normaliseProject({ id: "nue-frontend", ...common, github: { repo: "acme/nue-frontend", baseBranch: "main" }, local: { path: fe.repo, testCommand: "node -e \"process.exit(0)\"" } }));
setEngineRole("daemon");

/** Mock agents; the integration reviewer fails once on demand, a part asks the lead on demand. */
let integrationFailures = 0;
let askLeadOnce: string | undefined;
const mock = new MockRunner({
  "integration-reviewer": () => integrationFailures-- > 0
    ? { pass: false, summary: "Field name mismatch", issues: [{ repo: "nue-frontend", severity: "major", description: "The frontend reads `why` but the backend sends `reason`", fix: "Read `reason`" }], criteria: [] }
    : { pass: true, summary: "The parts fit together", issues: [], criteria: [{ criterion: "Behaviour matches the ticket description", covered: true, where: "both" }] },
  implementer: (req) => {
    if (askLeadOnce && req.cwd && req.cwd.includes(askLeadOnce) && !/Clarifications/.test(req.prompt)) {
      return { summary: "partial", filesChanged: [], testsAdded: [], questions: [{ question: "Is the reason field nullable?", options: ["Yes", "No"] }] };
    }
    fs.appendFileSync(path.join(req.cwd!, "AIW_CHANGE.md"), `Change at ${Date.now()}\n`);
    return { summary: "Applied the planned change (mock)", filesChanged: ["AIW_CHANGE.md"], testsAdded: [], questions: [] };
  },
});
setRunner(mock);
const settle = (ref: string, states: string[], ms = 60_000) => waitFor(() => { const t = getTask(ref); return t && states.includes(t.state) ? t : undefined; }, ms);

test("backend-only ticket: one lead task, targets only the backend, plan approval before any code", async () => {
  issues = [issue("KAN-301", "Add rate limit to the search API endpoint", "The search endpoint must reject more than 10 requests per second per user and store counters in the cache.")];
  await pollJira(); await tick();
  const t = await settle("KAN-301", ["AWAITING_APPROVAL", "FAILED"]);
  assert.equal(t.playbook, "dev-lead");
  assert.deepEqual(t.data.targets, ["nue-backend"]);
  assert.equal(latestApproval(t.id)?.action, "implement_plan", "approval is requested BEFORE implementation");
  assert.equal(partsOf(t.id).length, 0, "no repository work before the plan is approved");
  assert.equal(t.data.contract, null, "one repository – no contract");
  assert.equal(listTasks({}).filter((x) => x.source_ref?.startsWith("KAN-301")).length, 1);
});

test("tokens: the explorer looks at the code ONCE; a re-plan reuses its findings; the plan shows the cost", async () => {
  const ticketCalls = (agent: string) => mock.calls.filter((c) => c.agent === agent && c.prompt.includes('<untrusted source="ticket:KAN-301">')).length;
  assert.equal(ticketCalls("explorer"), 1);
  const t = getTask("KAN-301")!;
  assert.ok(t.data.findings?.repos?.length, "findings are saved on the task");
  assert.ok(mock.calls.some((c) => c.agent === "lead" && /Code Explorer findings/.test(c.prompt)), "the lead decides from the findings");
  assert.match(planMessage(t), /Cost so far: \$\d+\.\d\d \(\d+(\.\d)?[kM] tokens\)/);
  // "2, use the cache module" → re-plan from understand, without exploring again
  const r = await decideAndApply("KAN-301", "rejected", "Sneha", "claude-code", "use the existing cache module");
  assert.equal(r.ok, true, r.message);
  await settle("KAN-301", ["AWAITING_APPROVAL", "FAILED"]);
  assert.equal(ticketCalls("explorer"), 1, "no second exploration");
  assert.ok(ticketCalls("lead") >= 2, "the lead re-decided with the feedback");
  // without a code graph the code tools are simply not offered (agents search normally)
  const { lookupToolNames } = await import("../agents/lookup.js");
  assert.ok(!lookupToolNames({ codeRepos: ["nue-backend"] }).some((n) => n.includes("code_query")));
});

test("frontend-only ticket: the lead targets the frontend", async () => {
  issues = [issue("KAN-302", "Show a loading spinner on the dashboard page", "Display a spinner component while the dashboard view renders.")];
  await pollJira(); await tick();
  const t = await settle("KAN-302", ["AWAITING_APPROVAL", "FAILED"]);
  assert.deepEqual(t.data.targets, ["nue-frontend"]);
});

test("full-stack ticket: one lead, contract, ONE plan approval, backend first, integration fix, ONE PR approval, two linked PRs", async () => {
  integrationFailures = 1;
  issues = [issue("KAN-42", "[FR-025] Input guard", "Validate buyer input on the API endpoint and show validation errors in the form on the page.")];
  await pollJira(); await tick();
  const lead = await settle("KAN-42", ["AWAITING_APPROVAL", "FAILED"]);
  assert.equal(lead.playbook, "dev-lead");
  assert.deepEqual(lead.data.targets, ["nue-backend", "nue-frontend"], "both repositories, the producer (backend) first");
  assert.equal(lead.data.order, "sequential");
  assert.ok(lead.data.contract?.items?.length, "a contract between the repositories");
  assert.equal(lead.data.plan.parts.length, 2);
  const msg = planMessage(lead);
  assert.match(msg, /Repositories\*\*\nnue-backend → nue-frontend/);
  assert.match(msg, /Contract between the repositories/);
  assert.match(msg, /📦 \*\*nue-frontend\*\*/);
  assert.equal(latestApproval(lead.id)?.action, "implement_plan");
  assert.equal(listTasks({}).filter((x) => x.source_ref === "KAN-42").length, 1, "one task for the user");

  // the lead is found by the plain ticket key
  const r = await decideAndApply("KAN-42", "approved", "Sneha", "claude-code");
  assert.equal(r.ok, true, r.message);
  const ready = await settle("KAN-42", ["AWAITING_APPROVAL", "FAILED", "PAUSED"], 90_000);
  assert.equal(ready.state, "AWAITING_APPROVAL", ready.error ?? "");
  assert.equal(latestApproval(ready.id)?.action, "create_pr", "one PR approval for both repositories");

  const parts = partsOf(ready.id);
  assert.deepEqual(parts.map((p) => p.project_id).sort(), ["nue-backend", "nue-frontend"]);
  assert.ok(parts.every((p) => p.state === "PART_READY"));
  for (const p of parts) assert.equal(latestApproval(p.id), undefined, "parts never ask for approvals themselves");
  const back = parts.find((p) => p.project_id === "nue-backend")!, front = parts.find((p) => p.project_id === "nue-frontend")!;
  // built in order: the frontend started after the backend part was ready, and it saw the backend's change + contract
  const backReady = stepsFor(back.id).find((s) => s.name === "part_ready")!.started_at;
  const frontStart = stepsFor(front.id).find((s) => s.name === "prepare_workspace")!.started_at;
  assert.ok(frontStart >= backReady, "frontend starts after the backend is ready");
  assert.match(front.data.contextPack, /Contract between the repositories/);
  assert.match(front.data.contextPack, /The nue-backend part .*\n[\s\S]*Already built/);
  // the integration check sent one fix to the frontend, then passed
  assert.equal(ready.data.integrationRounds, 1);
  assert.equal(ready.data.integration.pass, true);
  assert.ok((front.data.feedback ?? []).some((f: string) => /Integration check/.test(f) && /reason/.test(f)));
  assert.ok(!(back.data.feedback ?? []).length, "the backend did not need a fix");
  const approvalMsg = sent.filter((x) => x.kind === "approval_needed" && x.taskRef === "KAN-42").at(-1)!;
  assert.match(approvalMsg.body, /Integration check .*✅/);
  assert.match(approvalMsg.body, /📦 \*\*nue-backend\*\*[\s\S]*📦 \*\*nue-frontend\*\*/);
  assert.match(statusText("KAN-42")!, /nue-frontend: built and tested/);

  // ONE PR approval → two draft PRs, linked to each other, then everything is done
  const before = sent.length;
  const ok = await decideAndApply("KAN-42", "approved", "Sneha", "claude-code");
  assert.equal(ok.ok, true, ok.message);
  const done = await settleAfterPr("KAN-42", ["FAILED", "PAUSED"]);
  assert.equal(done.state, prEndState(), done.error ?? "");
  const mine = prs.filter((p) => /KAN-42/.test(p.title));
  assert.equal(mine.length, 2);
  assert.ok(mine.every((p) => p.draft === false && p.base === "main"), "ready-for-review PRs by default");
  assert.match(mine.find((p) => p.repo === "acme/nue-backend").body, /Paired change[\s\S]*acme\/nue-frontend#/);
  assert.match(mine.find((p) => p.repo === "acme/nue-frontend").body, /Paired change[\s\S]*acme\/nue-backend#/);
  assert.ok(partsOf(done.id).every((p) => p.state === "DONE" && p.data.pr?.url), "each part carries its PR (watched for comments)");
  const prMsgs = sent.slice(before).filter((x) => x.kind === "pr_created");
  assert.equal(prMsgs.length, 1, "one message with both links");
  assert.match(prMsgs[0].body, /acme\/nue-backend\*\* – PR #\d+[\s\S]*acme\/nue-frontend\*\* – PR #\d+/);
  // both branches really pushed to their own repository
  for (const [name, part] of [["acme_nue-backend", back], ["acme_nue-frontend", front]] as const) {
    const refs = execFileSync("git", ["--git-dir", path.join(originDir, `${name}.git`), "branch", "--list"], { encoding: "utf8" });
    assert.match(refs, new RegExp(part.branch!.replace(/[/.]/g, "\\$&")));
  }
});

test("a part's question goes to the lead, who answers it without asking the user", async () => {
  integrationFailures = 0;
  askLeadOnce = "nue-backend";
  issues = [issue("KAN-43", "[FR-026] Reason field", "Add a reason field to the API response and show it on the page.")];
  await pollJira(); await tick();
  await settle("KAN-43", ["AWAITING_APPROVAL"]);
  const questionsBefore = sent.filter((x) => x.kind === "needs_info").length;
  await decideAndApply("KAN-43", "approved", "Sneha", "claude-code");
  const ready = await settle("KAN-43", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"], 90_000);
  askLeadOnce = undefined;
  assert.equal(ready.state, "AWAITING_APPROVAL", ready.error ?? "");
  const back = partsOf(ready.id).find((p) => p.project_id === "nue-backend")!;
  assert.ok((back.data.clarifications ?? []).some((c: any) => c.by === "the lead engineer"), "answered by the lead");
  assert.equal(sent.filter((x) => x.kind === "needs_info").length, questionsBefore, "the user was not asked");
  assert.ok(mock.calls.some((c) => c.agent === "coordinator"));
});

test("tests that cannot run on this computer don't stop the work; Teams and the PR say 'not tested locally'", async () => {
  // the backend's test command fails because its database is unreachable – an environment problem, not a code problem
  upsertProject(normaliseProject({ id: "nue-backend", ...common, github: { repo: "acme/nue-backend", baseBranch: "main" },
    local: { path: be.repo, testCommand: "node -e \"console.error('ConnectionRefusedError: [Errno 10061] Connect call failed'); process.exit(1)\"" } }));
  try {
    issues = [issue("KAN-45", "Add rate limit to the export API endpoint", "The export endpoint must reject more than 5 requests per minute per user and store counters in the cache.")];
    await pollJira(); await tick();
    await settle("KAN-45", ["AWAITING_APPROVAL"]);
    await decideAndApply("KAN-45", "approved", "Sneha", "claude-code");
    const ready = await settle("KAN-45", ["AWAITING_APPROVAL", "FAILED", "PAUSED"], 90_000);
    assert.equal(ready.state, "AWAITING_APPROVAL", ready.error ?? "");
    const part = partsOf(ready.id)[0];
    assert.match(part.data.testsUnavailable.reason, /test database or service is not reachable/);
    assert.equal(part.data.tests.ran, false);
    const msg = sent.filter((x) => x.kind === "approval_needed" && x.taskRef === "KAN-45").at(-1)!;
    assert.match(msg.body, /NOT run on this computer/);
    assert.match(part.data.report.body, /not run locally/);
    // the QA reviewer was told to check extra carefully
    assert.ok(mock.calls.some((c) => c.agent.startsWith("reviewer:") && /could NOT be run on this computer/.test(c.prompt)));
  } finally {
    upsertProject(normaliseProject({ id: "nue-backend", ...common, github: { repo: "acme/nue-backend", baseBranch: "main" }, local: { path: be.repo, testCommand: "node -e \"process.exit(0)\"" } }));
  }
});

test("re-polling the same ticket does not create duplicate tasks", async () => {
  issues = issues.map((i) => ({ ...i, updated: new Date(Date.UTC(2026, 10, 10, 9, 0, n++)).toISOString() }));
  await pollJira();
  assert.equal(listTasks({}).filter((x) => x.source_ref === "KAN-43").length, 1);
});

test("upgrade: an unstarted per-repository pair becomes one lead task", async () => {
  delMeta("migrate.lead.v1");
  const mk = (repo: string, extra: Record<string, any>) => {
    const t = createTask({ projectId: repo, source: "jira", sourceId: repo === "nue-backend" ? "id-KAN-90" : "id-KAN-90#nue-frontend", sourceRef: `KAN-90@${repo}`, title: "Old pair", kind: "assigned",
      state: "TRIAGED", data: { ticket: { key: "KAN-90", title: "Old pair", description: "x" }, targets: ["nue-backend", "nue-frontend"], ...extra } });
    updateTask(t.id, { playbook: "dev-feature", size: "L" });
    return transition(t.id, "AWAITING_START", "old");
  };
  const a = mk("nue-backend", {});
  const b = mk("nue-frontend", { siblingOf: a.id, waitFor: a.id });
  assert.equal(migrateToLeadTasks(), 1);
  const lead = getTask("KAN-90")!;
  assert.equal(lead.id, a.id);
  assert.equal(lead.playbook, "dev-lead");
  assert.equal(lead.state, "AWAITING_START");
  assert.equal(getTask(b.id)!.state, "CANCELLED");
  assert.equal(migrateToLeadTasks(), 0, "runs once");
  void db;
});
