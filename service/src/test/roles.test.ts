import { makeRepo, waitFor } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { db } from "../core/db.js";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../core/config.js";
import { clients } from "../connectors/registry.js";
import type { WorkItem } from "../connectors/types.js";
import { setRunner, MockRunner } from "../agents/runner.js";
import { setSenders, inbox } from "../notify/router.js";
import { pollJira, pollCi, scheduleDigests } from "../intake/intake.js";
import { setEngineRole, tick, decideAndApply } from "../engine/engine.js";
import { getTask } from "../engine/tasks.js";

const { repo } = makeRepo("roles-repo");
const comments: string[] = [];
let issues: WorkItem[] = [];
let n = 0;
const issue = (key: string, o: Partial<WorkItem> = {}): WorkItem => ({
  provider: "jira", id: `id-${key}`, key, projectKey: "QA", title: `Checkout ${key}`,
  description: "Customers can pay with saved cards. Acceptance: card list shows last 4 digits; expired cards hidden.",
  status: "In Progress", statusCategory: "indeterminate", assignee: "someone", labels: [], url: `https://acme.atlassian.net/browse/${key}`,
  updated: new Date(Date.UTC(2026, 10, 10, 8, 0, n++)).toISOString(), ...o,
});
clients.jira = () => ({
  site: "x", myself: async () => ({ accountId: "me", displayName: "Me" }), search: async () => issues,
  getIssue: async (k) => issues.find((i) => i.key === k), addComment: async (k, t) => { comments.push(`${k}:${t}`); },
});
clients.github = () => ({
  user: async () => ({ login: "me" }), repo: async () => ({ defaultBranch: "main", private: true }), findOpenPr: async () => undefined,
  createPr: async () => ({ number: 1, url: "u" }), updatePr: async () => ({ number: 1, url: "u" }), gitAuthHeader: () => "",
  recentPrBases: async () => [], prActivity: async () => [],
  failedRuns: async () => [{ id: "991", repo: "acme/shop", branch: "main", workflow: "CI", conclusion: "failure", url: "https://github.com/acme/shop/actions/runs/991", headSha: "abc", updated: new Date().toISOString() }],
  failedJobLog: async () => "## Job: test\nFailed steps: npm test\nError: expected 200 got 500 at checkout.test.ts:42",
});
setSenders({ desktop: { send: async () => undefined } });
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS), profile: { name: "QA", workingHours: "00:00-23:59", roles: [] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" }, limits: { ...DEFAULT_SETTINGS.limits, askBeforeStart: [] },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off", digestTime: "00:00" },
});
upsertProject(normaliseProject({
  id: "shop", jira: { site: "x", keys: ["QA"] }, github: { repo: "acme/shop", baseBranch: "main" }, local: { path: repo },
  roles: ["qa-engineer", "devops-engineer", "project-manager", "business-analyst"], autonomy: "prepare",
}));
setEngineRole("daemon");
setRunner(new MockRunner({ analyser: () => ({ summary: "artefact", items: ["TC-1 | saved card list | open checkout | last 4 digits shown | high"] }) }));
const settle = (ref: string, states: string[]) => waitFor(() => { const t = getTask(ref); return t && states.includes(t.state) ? t : undefined; }, 30_000);

test("QA: 'Ready for QA' produces a test plan and posts it to Jira only after approval", async () => {
  issues = [issue("QA-7")];
  await pollJira();
  issues = [issue("QA-7", { status: "Ready for QA" })];
  await pollJira(); await tick();
  const t = await settle("QA-7", ["AWAITING_APPROVAL", "FAILED"]);
  assert.equal(t.playbook, "qa-test-plan");
  assert.ok(fs.readFileSync(t.data.artefact.file, "utf8").includes("TC-1"));
  assert.equal(comments.length, 0, "nothing posted before approval");
  await decideAndApply("QA-7", "approved", "QA", "claude-code");
  await settle("QA-7", ["DONE"]);
  assert.equal(comments.length, 1);
});

test("BA: a new epic becomes proposed user stories", async () => {
  issues = [issue("QA-20", { issueType: "Epic", title: "Saved cards" })];
  await pollJira(); await tick();
  const t = await settle("QA-20", ["AWAITING_APPROVAL", "FAILED"]);
  assert.equal(t.playbook, "ba-stories");
});

test("DevOps: a failed CI run is analysed from the failing log section only", async () => {
  const created = await pollCi();
  assert.equal(created.length, 1);
  assert.equal((await pollCi()).length, 0, "same CI run is not processed twice");
  await tick();
  const t = await settle(created[0].source_ref!, ["DONE", "FAILED"]);
  assert.equal(t.state, "DONE", t.error ?? "");
  assert.match(t.data.ciLog, /expected 200 got 500/);
  assert.ok(inbox(true).some((i) => i.title.includes("CI failure analysis")));
});

test("PM: daily digest is scheduled once per day", async () => {
  const first = scheduleDigests();
  assert.equal(first.length, 1);
  assert.equal(scheduleDigests().length, 0);
  await tick();
  const t = await settle(first[0].source_ref!, ["DONE", "FAILED"]);
  assert.equal(t.state, "DONE", t.error ?? "");
  assert.equal(t.data.artefact.kind, "pm_digest");
  assert.ok((db().prepare("SELECT COUNT(*) AS n FROM steps WHERE task_id=?").get(t.id) as any).n >= 3);
});
