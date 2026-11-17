import { makeRepo, waitFor } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../core/config.js";
import { setRunner, MockRunner, type AgentRequest } from "../agents/runner.js";
import { setSenders, inbox } from "../notify/router.js";
import { setEngineRole, tick, answerTask } from "../engine/engine.js";
import { createTask, getTask } from "../engine/tasks.js";
import { executeCommand, interpret } from "../intake/teamsCommands.js";

const { repo } = makeRepo("clarify-repo");
setSenders({ desktop: { send: async () => undefined } });
saveSettings({ ...structuredClone(DEFAULT_SETTINGS), profile: { name: "Arun", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" }, limits: { ...DEFAULT_SETTINGS.limits, askBeforeStart: [] },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off" },
  workflow: { ...DEFAULT_SETTINGS.workflow, questionRounds: 2 } });
upsertProject(normaliseProject({ id: "clar", jira: { site: "x", keys: ["CLR"] }, local: { path: repo, testCommand: "node -e \"process.exit(0)\"" }, roles: ["backend-developer"], autonomy: "plan" }));
setEngineRole("daemon");

const answered = (r: AgentRequest) => r.prompt.includes("Clarifications from the assignee");
let analystAlwaysAsks = false;
const runner = new MockRunner({
  triage: (r) => ({ type: "feature", size: "M", clear: answered(r), questions: answered(r) ? [] : ["What is the maximum input length?"], summary: "x" }),
  analyst: (r) => ({
    requirements: ["Validate buyer input"], acceptanceCriteria: ["Long input is rejected"],
    openQuestions: analystAlwaysAsks || !r.prompt.includes("2000") ? ["Should the limit count characters or words?"] : [],
  }),
});
setRunner(runner);
const settle = (id: string, states: string[]) => waitFor(() => { const t = getTask(id); return t && states.includes(t.state) ? t : undefined; }, 30_000);
const ticket = (key: string, description: string) => ({ ticket: { key, title: "Input guard", description, url: `https://x/browse/${key}` } });

test("unclear ticket: the agent asks, the user answers, the task continues with the answer", async () => {
  const t = createTask({ projectId: "clar", source: "jira", sourceId: "c1", sourceRef: "CLR-1", kind: "assigned", data: ticket("CLR-1", "Add an input guard for buyer requests.") });
  await tick();
  const asked = await settle(t.id, ["NEEDS_INFO"]);
  assert.equal(asked.data.needInfoFrom, "triage");
  const msg = inbox().find((i) => i.task_id === t.id && i.kind === "needs_info")!;
  assert.match(msg.notice.body, /maximum input length/);
  assert.match(msg.notice.body, /answer CLR-1 "your answer"/, "the message says how to answer");
  // only one task waits -> the reference can be omitted (Teams: "answer use 2000 characters")
  const parsed = interpret("answer use a 2000 character limit", true);
  assert.equal(parsed?.kind, "command");
  const reply = await executeCommand((parsed as any).cmd, "Arun");
  assert.match(reply, /continues with your answer/);
  const after = await settle(t.id, ["AWAITING_APPROVAL", "FAILED", "NEEDS_INFO"]);
  assert.equal(after.state, "AWAITING_APPROVAL", "triage passed with the answer and the plan is waiting for approval");
  assert.equal(after.data.clarifications[0].reply, "use a 2000 character limit");
  assert.equal(after.data.clarifications[0].answer, "What is the maximum input length? → use a 2000 character limit", "the answer records which question it answers");
  assert.ok(runner.calls.filter((c) => c.agent === "planner").some((c) => c.prompt.includes("2000 character")), "the planner saw the answer");
});

test("the analyst asks when something blocks implementation; answering re-runs that step", async () => {
  const t = createTask({ projectId: "clar", source: "jira", sourceId: "c2", sourceRef: "CLR-2", kind: "assigned",
    data: { ...ticket("CLR-2", "Reject buyer requests that are too long and tell the buyer what the limit is."), clarifications: [] } });
  // one earlier answer exists, so triage passes and the Analyst is the one asking here
  const { mergeData } = await import("../engine/tasks.js");
  mergeData(t.id, { clarifications: [{ questions: [], answer: "context", by: "Arun", at: "now" }] });
  await tick();
  const asked = await settle(t.id, ["NEEDS_INFO"]);
  assert.equal(asked.data.needInfoFrom, "step");
  assert.match(asked.data.questions[0].question, /characters or words/);
  const r = await answerTask("CLR-2", "characters – maximum 2000", "Arun");
  assert.equal(r.ok, true);
  const after = await settle(t.id, ["AWAITING_APPROVAL", "FAILED", "NEEDS_INFO"]);
  assert.equal(after.state, "AWAITING_APPROVAL");
});

test("questions are capped: after 2 rounds the task proceeds and states assumptions", async () => {
  analystAlwaysAsks = true;
  const t = createTask({ projectId: "clar", source: "jira", sourceId: "c3", sourceRef: "CLR-3", kind: "assigned",
    data: { ...ticket("CLR-3", "Guard the input."), clarifications: [{ questions: [], answer: "a", by: "Arun", at: "1" }] } });
  await tick();
  await settle(t.id, ["NEEDS_INFO"]);
  await answerTask("CLR-3", "second answer", "Arun");
  const after = await settle(t.id, ["AWAITING_APPROVAL", "FAILED", "NEEDS_INFO"]);
  assert.equal(after.state, "AWAITING_APPROVAL", "no third question");
  assert.deepEqual(after.data.assumptions, ["Should the limit count characters or words?"]);
  assert.ok(runner.calls.filter((c) => c.agent === "planner").at(-1)!.prompt.includes("choose a sensible assumption"));
  analystAlwaysAsks = false;
});

test("answer needs a target when several tasks wait", async () => {
  createTask({ projectId: "clar", source: "jira", sourceId: "c4", sourceRef: "CLR-4", kind: "assigned", state: "NEEDS_INFO" as any, data: ticket("CLR-4", "a") });
  createTask({ projectId: "clar", source: "jira", sourceId: "c5", sourceRef: "CLR-5", kind: "assigned", state: "NEEDS_INFO" as any, data: ticket("CLR-5", "b") });
  const r = await answerTask(undefined, "something", "Arun");
  assert.equal(r.ok, false);
  assert.match(r.message, /Several tasks need information: CLR-4, CLR-5/);
});
