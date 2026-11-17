import { makeRepo, waitFor } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { db, getMeta, setMeta } from "../core/db.js";
import { saveSettings, loadSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, engineVersion, type EngineVersion } from "../core/config.js";
import { paths } from "../core/paths.js";
import { clients } from "../connectors/registry.js";
import type { JiraClient } from "../connectors/jira.js";
import type { GitHubClient } from "../connectors/github.js";
import type { WorkItem } from "../connectors/types.js";
import { setRunner, MockRunner, type AgentRequest, type AgentResult, type Runner } from "../agents/runner.js";
import { setSenders } from "../notify/router.js";
import { pollJira } from "../intake/intake.js";
import { setEngineRole, tick, decideAndApply, recoverInterrupted } from "../engine/engine.js";
import { getTask, createTask, updateTask, type Task } from "../engine/tasks.js";
import { onboardProject } from "../brain/brain.js";
import { emit } from "../kernel/events.js";
import { routeEvents } from "../kernel/reactions.js";
import { startJob, onJobEnd, getJob, rowToJob } from "../kernel/mailbox.js";
import { pickRunnable, limitsFrom } from "../kernel/scheduler.js";
import { resetKernelRuntime } from "../kernel/runner.js";
import { getItem } from "../kernel/items.js";
import type { Job } from "../kernel/types.js";

// This file sets the engine itself (v1 for the reference ticket, v2 for the rest), whatever AIW_ENGINE says.
delete process.env.AIW_ENGINE;

// ---------------------------------------------------------------- fakes (as e2e.test.ts)
let issues: WorkItem[] = [];
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
  addComment: async () => {},
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
  requestReviewers: async (_r, _n, w) => ({ requested: [...w.users, ...w.teams] }),
};

const { repo, origin } = makeRepo();
process.env.AIW_GIT_PUSH_URL = origin;
clients.jira = () => fakeJira;
clients.github = () => fakeGitHub;
const sent: { kind: string; ref?: string; title: string }[] = [];
setSenders({ desktop: { send: async (n) => { sent.push({ kind: n.kind, ref: n.taskRef, title: n.title }); return undefined; } } });
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Tester", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  limits: { ...DEFAULT_SETTINGS.limits, askBeforeStart: [], burstThreshold: 3 },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off" },
  workflow: { ...DEFAULT_SETTINGS.workflow, planApproval: "autonomy" },
  engine: { version: "v1" },
});
upsertProject(normaliseProject({
  id: "payment-service", jira: { site: "acme.atlassian.net", keys: ["PAY"] }, github: { repo: "acme/pay", baseBranch: "main" },
  local: { path: repo, testCommand: "node -e \"process.exit(0)\"" }, roles: ["backend-developer"], autonomy: "prepare",
  reviewers: { from: "list", logins: ["eric"] },
}));
db().prepare("INSERT INTO connections (provider, account, status, meta, updated_at) VALUES ('jira','me','connected','{\"site\":\"acme.atlassian.net\",\"email\":\"me@x\"}', datetime())").run();
setEngineRole("daemon");

/**
 * MockRunner that counts calls and can hang one agent's next call forever (a service that stopped mid-step).
 */
class CountingRunner implements Runner {
  mock = new MockRunner();
  hang: string | undefined;
  hung = 0;
  calls: AgentRequest[] = [];
  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    if (this.hang && req.agent === this.hang) { this.hang = undefined; this.hung++; return new Promise<AgentResult>(() => {}); }
    return this.mock.run(req);
  }
  count(agent: string, ref?: string) { return this.calls.filter((c) => c.agent === agent && (!ref || c.prompt.includes(ref))).length; }
}
const runner = new CountingRunner();
setRunner(runner);

function setEngine(v: EngineVersion): void {
  const s = loadSettings();
  saveSettings({ ...s, engine: { version: v } });
  assert.equal(engineVersion(), v);
}
async function settle(ref: string, states: string[]): Promise<Task> {
  return waitFor(() => { const t = getTask(ref); return t && states.includes(t.state) ? t : undefined; }, 60_000);
}
const jobsOf = (itemId: string): Job[] => (db().prepare("SELECT * FROM jobs WHERE item_id=? ORDER BY created_at, rowid").all(itemId) as any[]).map(rowToJob);
const activeCount = (itemId: string) => (db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE item_id=? AND state IN ('running','waiting') AND type<>'ci_watch'").get(itemId) as any).n as number;
const kindsFor = (ref: string) => sent.filter((s) => s.ref === ref).map((s) => s.kind);
const approvalsOf = (taskId: string) => (db().prepare("SELECT action, state FROM approvals WHERE task_id=? ORDER BY requested_at").all(taskId) as any[]).map((a) => `${a.action}:${a.state}`);

/** Run one M ticket from Jira to its PR; returns the task when its work has ended. */
async function runTicket(ref: string, end: string[]): Promise<Task> {
  issues = [issue(ref)];
  const r = await pollJira();
  assert.equal(r.tasks.length, 1);
  await tick();
  const waiting = await settle(ref, ["AWAITING_APPROVAL", "FAILED", "PAUSED"]);
  assert.equal(waiting.state, "AWAITING_APPROVAL", waiting.error ?? "");
  assert.equal(waiting.size, "M");
  assert.equal(waiting.playbook, "dev-feature");
  const res = await decideAndApply(ref, "approved", "Tester", "claude-code");
  assert.equal(res.ok, true, res.message);
  const done = await settle(ref, [...end, "FAILED", "PAUSED"]);
  assert.ok(end.includes(done.state), `${ref}: ${done.state} ${done.error ?? ""}`);
  return done;
}

test("onboarding builds the Brain", async () => {
  const r = await onboardProject("payment-service");
  assert.ok(r.map.files.length >= 3);
});

let v1Task: Task, v2Task: Task;

test("v1 reference: an M ticket runs to DONE with one PR (engine v1 unchanged)", async () => {
  assert.equal(engineVersion(), "v1");
  v1Task = await runTicket("PAY-1", ["DONE"]);
  assert.equal(prs.length, 1);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM jobs").get() as any).n, 0, "v1 creates no jobs");
  // rows the v2 data migration must convert (they are PAUSED / waiting, so v1 does not run them)
  const lead = createTask({ projectId: "payment-service", source: "jira", sourceId: "id-PAY-90", sourceRef: "PAY-90", kind: "assigned", state: "PAUSED", data: {} });
  createTask({ projectId: "payment-service", source: "lead", sourceId: "id-PAY-90#part", sourceRef: "PAY-90@payment-service", kind: "part", state: "PAUSED", data: { leadId: lead.id } });
  const fix = createTask({ projectId: "payment-service", source: "teams-personal", sourceId: `fix:acme/pay#${prs[0].number}`, sourceRef: `FIX-${prs[0].number}@payment-service`, kind: "pr_fix",
    state: "AWAITING_APPROVAL", data: { fix: { repo: "acme/pay", num: prs[0].number, by: "Tester", via: "teams-personal", mode: "comments" } } });
  updateTask(fix.id, { playbook: "pr-fix", step_index: 3 });
});

test("v2 vertical slice: the same ticket flow ends PR_OPEN with the same approvals and messages as v1", async () => {
  setEngine("v2");
  v2Task = await runTicket("PAY-2", ["PR_OPEN"]);
  assert.equal(prs.length, 2);
  // the build job finishes the rest of the recipe (ticket report, memory) while the item stays PR_OPEN
  const build = await waitFor(() => jobsOf(v2Task.id).find((j) => j.type === "build" && ["done", "failed"].includes(j.state)), 60_000);
  assert.equal(build.state, "done", build.error ?? "");
  assert.equal(build.recipe, "dev-feature");
  assert.equal(getTask("PAY-2")!.state, "PR_OPEN");
  assert.equal(jobsOf(v2Task.id).filter((j) => j.type === "build").length, 1, "one build job for the whole run");
  // same approvals, same messages, in the same order
  assert.deepEqual(approvalsOf(v2Task.id), approvalsOf(v1Task.id));
  assert.deepEqual(approvalsOf(v2Task.id), ["create_pr:approved"]);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(kindsFor("PAY-2"), kindsFor("PAY-1"));
  assert.ok(kindsFor("PAY-2").includes("pr_created"));
  // every step row of the run belongs to the job; v2 step rows keep the usage split
  const steps = db().prepare("SELECT name, job_id, status FROM steps WHERE task_id=? AND idx >= 0").all(v2Task.id) as any[];
  assert.ok(steps.length >= 10);
  assert.ok(steps.every((s) => s.job_id === build.id));
  assert.ok(steps.every((s) => s.status === "ok" || s.status === "await_approval"));
});

test("v2 data migration ran once: backup, parts under their lead, fix task as a pr item with a job, CI watches as ci_watch jobs", async () => {
  assert.ok(getMeta("kernel.migrated.v2"));
  assert.ok(fs.existsSync(`${paths.db()}.bak-v2-migrate`), "the database was copied before migrating");
  const lead = getItem("PAY-90")!;
  const part = getItem("PAY-90@payment-service")!;
  assert.equal(part.parent_id, lead.id);
  assert.equal(part.root_id, lead.id);
  assert.equal(part.level, "part");
  const fix = getItem(`FIX-${prs[0].number}@payment-service`)!;
  assert.equal(fix.level, "pr");
  assert.equal(fix.parent_id, v1Task.id, "under the ticket that raised the PR");
  const fj = jobsOf(fix.id);
  assert.equal(fj.length, 1);
  assert.equal(fj[0].type, "comment_fix");
  assert.equal(fj[0].state, "waiting");
  assert.equal(fj[0].step_index, 3);
  // the v1 ticket's PR was in fix.ciwatch: it got a ci_watch job (ended, because the ticket is DONE)
  assert.ok(jobsOf(v1Task.id).some((j) => j.type === "ci_watch"));
  // the v2 ticket's PR is watched as a passive job that never blocks its item
  await waitFor(() => jobsOf(v2Task.id).find((j) => j.type === "ci_watch" && j.state === "waiting"));
  // running the migration again changes nothing
  const { migrateToKernel } = await import("../kernel/migrate.js");
  assert.equal(migrateToKernel(), undefined);
  // events v1 handled are never routed again
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM events WHERE handled_by IS NULL").get() as any).n, 0);
});

test("v2: a restart mid-step resumes that step without repeating finished model calls", async () => {
  runner.hang = "reviewer:security";
  issues = [issue("PAY-3")];
  await pollJira();
  await tick();
  // the security reviewer never answers (the service stops); the code and QA reviewers have answered
  await waitFor(() => runner.hung === 1 && runner.count("reviewer:code", "PAY-3") === 1 && runner.count("reviewer:qa", "PAY-3") === 1 ? true : undefined, 60_000);
  await waitFor(() => (db().prepare("SELECT COUNT(*) AS n FROM agent_cache WHERE agent IN ('reviewer:code','reviewer:qa')").get() as any).n >= 2 ? true : undefined);
  const before = Object.fromEntries(["triage", "analyst", "planner", "plan-reviewer", "implementer", "reviewer:code", "reviewer:qa", "reviewer:security"].map((a) => [a, runner.count(a, "PAY-3")]));
  assert.equal(before.implementer, 1);

  // restart: the in-process run is forgotten, the service recovers
  resetKernelRuntime();
  recoverInterrupted();
  const t0 = getTask("PAY-3")!;
  assert.equal(t0.state, "QUEUED");
  assert.equal(jobsOf(t0.id)[0].state, "queued");
  assert.ok((db().prepare("SELECT COUNT(*) AS n FROM steps WHERE task_id=? AND name='reviews' AND status='interrupted'").get(t0.id) as any).n === 1);

  await tick();
  const t = await settle("PAY-3", ["AWAITING_APPROVAL", "FAILED", "PAUSED"]);
  assert.equal(t.state, "AWAITING_APPROVAL", t.error ?? "");
  // finished steps were not re-run; inside the resumed step only the unfinished call went to the model again
  for (const a of ["triage", "analyst", "planner", "plan-reviewer", "implementer", "reviewer:code", "reviewer:qa"]) {
    assert.equal(runner.count(a, "PAY-3"), before[a], `${a} was not called again`);
  }
  assert.equal(runner.count("reviewer:security", "PAY-3"), before["reviewer:security"] + 1, "only the unfinished call ran again");
  assert.equal(jobsOf(t.id).filter((j) => j.type === "build").length, 1, "the same job continued");
});

test("v2: two events for the same item never run two jobs at once", async () => {
  const item = getItem("PAY-2")!;
  assert.equal(item.state, "PR_OPEN");
  const e1 = emit({ type: "ci_failed", idemKey: "t:ci:1", itemId: item.id, payload: { ours: true, round: 1, repo: "acme/pay", num: prs[1].number } })!;
  const e2 = emit({ type: "changes_requested", idemKey: "t:cr:1", itemId: item.id, payload: { ours: true, repo: "acme/pay", num: prs[1].number } })!;
  assert.ok(e1 && e2);
  routeEvents(loadSettings());
  const queued = jobsOf(item.id).filter((j) => j.state === "queued");
  assert.deepEqual(queued.map((j) => j.type).sort(), ["ci_fix", "comment_fix"]);
  // the scheduler starts only one of them; the mailbox refuses a second while one is active
  const d = pickRunnable(limitsFrom(loadSettings()), []);
  assert.equal(d.start.filter((j) => j.item_id === item.id).length, 1);
  assert.ok(d.waiting.some((w) => w.itemId === item.id && w.reason === "waiting for its current job") || d.start.length === 1);
  const first = startJob(d.start.find((j) => j.item_id === item.id)!.id)!;
  assert.equal(first.type, "ci_fix", "CI fix first (more urgent)");
  const other = queued.find((j) => j.id !== first.id)!;
  assert.equal(startJob(other.id), undefined);
  assert.equal(onJobEnd(first.id, "cancelled", "test")?.id, other.id, "the next job of the item is the other one");

  // and through the real tick: watch the item while its jobs run (they fail: the fake GitHub cannot read PRs)
  emit({ type: "ci_failed", idemKey: "t:ci:2", itemId: item.id, payload: { ours: true, round: 1, repo: "acme/pay", num: prs[1].number } });
  routeEvents(loadSettings());
  let max = 0;
  const watch = setInterval(() => { max = Math.max(max, activeCount(item.id)); }, 2);
  await tick();
  await waitFor(() => jobsOf(item.id).every((j) => !["queued", "running"].includes(j.state) || j.type === "ci_watch") ? true : undefined, 30_000);
  clearInterval(watch);
  assert.ok(max <= 1, `at most one active job (saw ${max})`);
  const ran = jobsOf(item.id).filter((j) => j.state === "failed" && /GitHub is not connected/.test(j.error ?? ""));
  assert.ok(ran.length >= 2, `both queued jobs really ran, one after the other (${jobsOf(item.id).map((j) => `${j.type}:${j.state}:${j.error}`).join(" | ")})`);
  assert.equal(getTask("PAY-2")!.state, "PR_OPEN", "a failed fix leaves the PR item open");
});

test("v2: a ci_failed event on a PR_OPEN item creates exactly one ci_fix job", async () => {
  const item = getItem("PAY-2")!;
  setMeta("paused_until", "indefinite");               // nothing starts while we look at the mailbox
  const before = jobsOf(item.id).filter((j) => j.type === "ci_fix").length;
  const a = emit({ type: "ci_failed", idemKey: "t:ci:sha-a", itemId: item.id, payload: { ours: true, round: 1, sha: "a" } });
  assert.ok(a);
  assert.equal(emit({ type: "ci_failed", idemKey: "t:ci:sha-a", itemId: item.id, payload: { ours: true, round: 1, sha: "a" } }), undefined, "the same event twice is one event");
  emit({ type: "ci_failed", idemKey: "t:ci:sha-b", itemId: item.id, payload: { ours: true, round: 1, sha: "b" } });
  routeEvents(loadSettings());
  await tick();
  const fixes = jobsOf(item.id).filter((j) => j.type === "ci_fix");
  assert.equal(fixes.length - before, 1, "one ci_fix job");
  const job = fixes.at(-1)!;
  assert.equal(job.state, "queued");
  assert.equal(job.recipe, "ci_fix");
  assert.equal(job.data.events.length, 2, "the second failure was merged into it");
  const handled = db().prepare("SELECT handled_by FROM events WHERE idem_key IN ('t:ci:sha-a','t:ci:sha-b')").all() as any[];
  assert.ok(handled.every((h) => h.handled_by === job.id));
  assert.equal(getJob(job.id)!.item_id, item.id);
  setMeta("paused_until", "");
  db().prepare("DELETE FROM meta WHERE key='paused_until'").run();
});
