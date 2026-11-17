import { makeRepo } from "../helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../../core/db.js";
import { saveSettings, loadSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, getProject } from "../../core/config.js";
import { setRunner, MockRunner, type AgentRequest } from "../../agents/runner.js";
import { setSenders } from "../../notify/router.js";
import type { Notice } from "../../notify/channels.js";
import { createTask, getTask, transition, mergeData, type Task } from "../../engine/tasks.js";
import { STEPS } from "../../engine/steps.js";
import { buildStepCtx } from "../../engine/stepRun.js";
import { requestApproval, decideWithChange, latestApproval, pendingChanges } from "../../approvals/approvals.js";
import { setDirective, effective } from "../../policy/directives.js";
import { canCreatePr, canPush, needsApproval } from "../../policy/gate.js";

/**
 * Directives in the engine's gates (wave 3): D5 "no approval needed" → the plan is sent as information and work goes
 * on; F2 "no PR approval" → the PR is raised straight away (protected paths still ask, rails still refuse);
 * D4 "yes but skip the email part" → the plan is redone with the change and building starts without another round.
 */
const { repo } = makeRepo("shop");
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Owner", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off" },
  workflow: { ...DEFAULT_SETTINGS.workflow, planApproval: "always", prApproval: "ask" },
});
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" }, local: { path: repo },
  roles: ["backend-developer"], autonomy: "prepare" }));
const sent: Notice[] = [];
setSenders({ desktop: { send: async (n) => { sent.push(n); return undefined; } } });
const plannerPrompts: string[] = [];
const runner = new MockRunner({
  planner: (req: AgentRequest) => { plannerPrompts.push(req.prompt); return { summary: /skip the email/i.test(req.prompt) ? "Add the teammate without the invite email" : "Add the teammate and send the invite email", steps: ["a", "b"], files: [], tests: [], risks: [] }; },
});
setRunner(runner);

function running(key: string, data: Record<string, any> = {}): Task {
  let t = createTask({ projectId: "shop", source: "jira", sourceId: `id-${key}`, sourceRef: key, title: `Ticket ${key}`, kind: "assigned", state: "TRIAGED",
    data: { ticket: { key, title: `Ticket ${key}`, description: "Add a teammate and send an invite email." }, plan: { summary: "Add the teammate", steps: ["a"] }, planAt: new Date().toISOString(), ...data } });
  db().prepare("UPDATE tasks SET playbook='dev-feature', size='M' WHERE id=?").run(t.id);
  t = transition(t.id, "QUEUED", "t");
  return transition(t.id, "RUNNING", "t");
}
const ctxOf = (t: Task, params: Record<string, any> = {}) => buildStepCtx({ task: getTask(t.id)!, project: getProject("shop")!, settings: loadSettings(), runner, params });

test("D5: without a rule the plan waits for approval (settings: always)", async () => {
  const t = running("KAN-1");
  const r = await STEPS.plan_gate(ctxOf(t));
  assert.equal(r.status, "await_approval");
  assert.equal(sent.at(-1)!.approvalAction, "implement_plan");
});

test("D5: 'no need to ask for approval' on the item → the plan is sent as information and work goes on", async () => {
  const t = running("KAN-2");
  const d = setDirective({ scope: "item", scopeId: t.id, rule: "plan_approval", value: "skip" }, { channel: "teams-personal", owner: true });
  assert.ok(d.ok);
  const before = sent.length;
  const r = await STEPS.plan_gate(ctxOf(t));
  assert.equal(r.status, "ok");
  assert.match((r as any).note, /your rule/);
  const info = sent.slice(before);
  assert.equal(info.length, 1);
  assert.equal(info[0].kind, "info", "information, not an approval");
  assert.equal(info[0].approvalId, undefined);
  assert.match(info[0].title, /KAN-2 – plan \(starting now\)/);
  assert.equal(latestApproval(t.id, "implement_plan"), undefined, "no approval was asked");
});

test("D5: a rule from outside text (a Jira comment) is refused", () => {
  const t = running("KAN-3");
  const r = setDirective({ scope: "item", scopeId: t.id, rule: "plan_approval", value: "skip" }, { channel: "jira", owner: false });
  assert.equal(r.ok, false);
  assert.equal(needsApproval("plan", t.id).ask, true);
});

test("F2: 'no PR approval' → the PR approval is given by the rule and the PR goes ahead", async () => {
  const t = running("KAN-4", { changedFiles: ["src/services/refund.ts"] });
  setDirective({ scope: "global", rule: "pr_approval", value: "skip" }, { channel: "teams-personal", owner: true });
  const before = sent.length;
  const r = await STEPS.request_approval(ctxOf(t, { action: "create_pr" }));
  assert.equal(r.status, "ok");
  const a = latestApproval(t.id, "create_pr")!;
  assert.equal(a.state, "approved");
  assert.match(a.approver ?? "", /^policy:/);
  assert.equal(sent.slice(before).filter((n) => n.approvalId).length, 0, "nothing asked");
});

test("F2: a change to a protected path still asks, even with 'no PR approval'", async () => {
  const t = running("KAN-5", { changedFiles: [".github/workflows/ci.yml", "src/app.ts"] });
  const r = await STEPS.request_approval(ctxOf(t, { action: "create_pr" }));
  assert.equal(r.status, "await_approval");
  assert.equal(sent.at(-1)!.approvalAction, "create_pr");
});

test("F2: hard rails cannot be lifted by any rule – secrets, protected branches, merge", () => {
  assert.equal(canCreatePr("KAN-4", { branch: "feat/KAN-4/x", files: ["a.ts"], secrets: 1 }).verdict, "deny");
  assert.equal(canPush("KAN-4", { branch: "main" }).verdict, "deny");
  assert.equal(canPush("KAN-4", { branch: "feat/x", force: true }).verdict, "deny");
  assert.equal(setDirective({ scope: "global", rule: "force_push", value: true }, { channel: "teams-personal", owner: true }).ok, false);
});

test("D4: approve with a change → re-planned with the change, building starts without asking again", async () => {
  const t = running("KAN-6");
  const ask = await STEPS.plan_gate(ctxOf(t));
  assert.equal(ask.status, "await_approval");
  const d = decideWithChange("KAN-6", "skip the email part for now", "Owner", "teams-personal");
  assert.ok(d.ok && d.replan);
  assert.equal(getTask(t.id)!.data.replanPending, true);
  const before = sent.length;
  const r = await STEPS.plan_gate(ctxOf(t));
  assert.equal(r.status, "ok", "no second approval round");
  assert.match(plannerPrompts.at(-1)!, /Changes the owner asked for when approving the plan[\s\S]*skip the email part for now/);
  assert.equal(getTask(t.id)!.data.plan.summary, "Add the teammate without the invite email");
  assert.deepEqual(pendingChanges(t.id), [], "the change is marked applied");
  assert.equal(getTask(t.id)!.data.replanPending, false);
  const msgs = sent.slice(before);
  assert.equal(msgs.filter((n) => n.approvalId).length, 0);
  assert.match(msgs.at(-1)!.title, /plan updated with your change \(building now\)/);
});

test("D4 through the Conductor (data.planChanges) reaches the later prompts as the owner's change", async () => {
  const t = running("KAN-7");
  mergeData(t.id, { planChanges: [{ text: "keep the old email copy", by: "Owner", at: new Date().toISOString() }] });
  await STEPS.plan(ctxOf(t));
  assert.match(plannerPrompts.at(-1)!, /Changes the owner asked for when approving the plan[\s\S]*keep the old email copy/);
  assert.equal(effective(t.id, "plan_approval").source, "settings", "a change is not a standing rule");
});
