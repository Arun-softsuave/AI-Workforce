import { makeRepo, sh } from "../helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../core/db.js";
import { saveSettings, loadSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, getProject } from "../../core/config.js";
import { clients } from "../../connectors/registry.js";
import { setRunner, MockRunner } from "../../agents/runner.js";
import { setSenders } from "../../notify/router.js";
import type { Notice } from "../../notify/channels.js";
import { createTask, getTask, transition, updateTask, type Task } from "../../engine/tasks.js";
import { STEPS } from "../../engine/steps.js";
import { buildStepCtx, pause } from "../../engine/stepRun.js";
import { resumeTask } from "../../engine/engine.js";
import { requestApproval, decide } from "../../approvals/approvals.js";
import { stateLabel } from "../../api/dashboardData.js";
import * as G from "../../git/git.js";

/**
 * E13 – an agent is stuck after its round limit: ONE message (what failed, what it tried, retry / take over / cancel),
 * the item pauses (resume retries) and the dashboard shows "Stuck".
 * F9 – a push GitHub refuses (branch protection, no write access): a clear message with what access is needed.
 */
const { repo, origin } = makeRepo("shop");
process.env.AIW_GIT_PUSH_URL = origin;
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Owner", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off" },
  limits: { ...DEFAULT_SETTINGS.limits, implementLoops: 2 },
});
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" },
  local: { path: repo, testCommand: "node -e \"console.log('FAIL refund > rejects amounts above the payment'); process.exit(1)\"" }, roles: ["backend-developer"], autonomy: "prepare" }));
const sent: Notice[] = [];
setSenders({ desktop: { send: async (n) => { sent.push(n); return undefined; } } });
const runner = new MockRunner();
setRunner(runner);
clients.github = () => ({ gitAuthHeader: () => "AUTHORIZATION: basic dGVzdA==", findOpenPr: async () => undefined, createPr: async () => ({ number: 1, url: "x" }) }) as any;

function running(key: string, data: Record<string, any> = {}): Task {
  let t = createTask({ projectId: "shop", source: "jira", sourceId: `id-${key}`, sourceRef: key, title: `Ticket ${key}`, kind: "assigned", state: "TRIAGED",
    data: { ticket: { key, title: `Ticket ${key}`, description: "Refunds never exceed the payment." }, plan: { summary: "Add the limit" }, ...data } });
  db().prepare("UPDATE tasks SET playbook='dev-feature', size='M' WHERE id=?").run(t.id);
  t = transition(t.id, "QUEUED", "t");
  return transition(t.id, "RUNNING", "t");
}
const ctxOf = (t: Task, params: Record<string, any> = {}) => buildStepCtx({ task: getTask(t.id)!, project: getProject("shop")!, settings: loadSettings(), runner, params });

test("E13: tests still red after the round limit → stuck: one message with what failed, what was tried and the options", async () => {
  const wt = path.join(path.dirname(repo), "wt-e13");
  sh(repo, "worktree", "add", "-q", "-b", "feat/KAN-13/limit", wt);
  const t = running("KAN-13");
  updateTask(t.id, { worktree: wt, branch: "feat/KAN-13/limit" });
  db().prepare("UPDATE tasks SET data=json_set(data,'$.baseSha',?) WHERE id=?").run(sh(repo, "rev-parse", "HEAD"), t.id);
  const r = await STEPS.implement_test(ctxOf(t));
  assert.equal(r.status, "pause", "stuck pauses (resume retries) – it does not fail the ticket");
  const reason = (r as any).reason as string;
  assert.match(reason, /^Stuck: .*FAIL refund > rejects amounts above the payment/);
  assert.match(reason, /Tried: 2 attempts to make the tests and checks pass/);
  assert.match(reason, /"resume KAN-13" to retry, "take over KAN-13" to finish it yourself, or "cancel KAN-13"/);
  assert.equal(runner.calls.filter((c) => c.agent.startsWith("implementer")).length, 2, "exactly the round limit");
  const before = sent.length;
  await pause(getTask(t.id)!, reason);
  const msgs = sent.slice(before);
  assert.equal(msgs.length, 1, "one message");
  assert.equal(msgs[0].title, "🛑 KAN-13 is stuck");
  assert.match(msgs[0].body, /^Failed: /);
  const now = getTask(t.id)!;
  assert.equal(now.state, "PAUSED");
  assert.equal(stateLabel(now), "Stuck", "the dashboard shows Stuck");
  assert.equal(now.data.stuck.tried, "2 attempts to make the tests and checks pass");
  const resumed = resumeTask("KAN-13")!;
  assert.equal(resumed.state, "QUEUED", "resume = retry");
  assert.equal(getTask(t.id)!.data.stuck, null);
});

test("F9: a push refused by branch protection → a clear message with what is needed, nothing forced", async () => {
  // the "GitHub" remote refuses every push the way GitHub's branch protection does
  fs.writeFileSync(path.join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'error: GH006: Protected branch update failed for refs/heads/feat/KAN-14/limit.' >&2\nexit 1\n");
  fs.chmodSync(path.join(origin, "hooks", "pre-receive"), 0o755);
  const wt = path.join(path.dirname(repo), "wt-f9");
  sh(repo, "worktree", "add", "-q", "-b", "feat/KAN-14/limit", wt);
  const base = sh(wt, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(wt, "src", "limit.ts"), "export const LIMIT = 1;\n");
  sh(wt, "add", "-A"); sh(wt, "-c", "user.email=dev@example.com", "-c", "user.name=Dev", "commit", "-q", "-m", "KAN-14 limit");
  const t = running("KAN-14", { baseSha: base, report: { title: "KAN-14: limit", body: "Adds the limit." } });
  updateTask(t.id, { worktree: wt, branch: "feat/KAN-14/limit" });
  const ap = requestApproval(t.id, "create_pr", { repo: "acme/shop", branch: "feat/KAN-14/limit", baseSha: base, headSha: G.headSha(wt), diffHash: G.diffHash(wt, base) });
  decide(ap.id, "approved", "Owner", "teams-personal");
  const r = await STEPS.publish(ctxOf(t));
  assert.equal(r.status, "pause");
  const reason = (r as any).reason as string;
  assert.match(reason, /^Can't push to shop: branch protection blocks it on feat\/KAN-14\/limit\./);
  assert.match(reason, /Ask a repo admin/);
  assert.equal(getTask(t.id)!.data.pushRefused.repo, "acme/shop");
  const before = sent.length;
  await pause(getTask(t.id)!, reason);
  assert.equal(sent.slice(before)[0].title, "⚠️ KAN-14: can't push");
});

test("F9: no write access names the permission that is missing", () => {
  const e = new Error("remote: Permission to acme/shop.git denied to dev-bot.\nfatal: unable to access 'https://github.com/acme/shop.git/': The requested URL returned error: 403");
  assert.match(G.pushRefusal(e, "acme/shop")!, /^Can't push to shop: needs write access\. .*"Contents: write" on acme\/shop/);
  assert.equal(G.pushRefusal(new Error("Could not resolve host: github.com"), "acme/shop"), undefined, "a network error is not an access problem");
});
