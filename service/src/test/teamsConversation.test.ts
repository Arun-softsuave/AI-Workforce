import { makeRepo } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { db, setMeta } from "../core/db.js";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../core/config.js";
import { connect } from "../connectors/registry.js";
import { setTeamsPersonalClient, type TeamsPersonalClient, type TpMessage } from "../connectors/teamsPersonal.js";
import { setRunner, MockRunner, type AgentRequest } from "../agents/runner.js";
import { setChatTurn } from "../chat/assistant.js";
import { pollTeamsCommands } from "../intake/teamsCommands.js";
import { askUser, DELEGATED_ANSWER } from "../engine/engine.js";
import { createTask, getTask, transition, mergeData, type Task } from "../engine/tasks.js";
import { requestApproval } from "../approvals/approvals.js";
import { getFocus, clearFocus, recentChat } from "../notify/chatLog.js";

/**
 * Teams remembers the conversation: a short reply goes to the item it was just asked about, "you decide" leaves the
 * decision to the agent, an unclear message gets one short question, and the assistant's findings can be sent to a
 * waiting task with one "yes".
 */
// This suite covers the older intent model, kept behind the Conductor switch as the rollback path
// (settings conductor.enabled: false). The Conductor (the default) has the same situations in w3-conductor.test.ts
// and test/situations/*.
process.env.AIW_CONDUCTOR = "0";
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
const { repo } = makeRepo("shop");
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Owner", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  // a real-model setting so the conversation model path is used; every model call is faked below
  models: { ...DEFAULT_SETTINGS.models, provider: "claude-login" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "teams-personal", fallback: ["inbox"] },
});
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, local: { path: repo }, roles: ["backend-developer"], autonomy: "prepare" }));
// engine role stays "client": answered tasks are not run here, only routed

const intentCalls: AgentRequest[] = [];
setRunner(new MockRunner({
  intent: (req) => {
    intentCalls.push(req);
    const msg = /<untrusted source="teams-message">\n([\s\S]*?)\n<\/untrusted>/.exec(req.prompt)?.[1] ?? "";
    if (/what does the backend return/i.test(msg)) return { intent: "question", ref: "", text: "", project: "", delegated: false };
    if (/implement it correctly and raise the pr|you check the codes/i.test(msg)) return { intent: "answer", ref: "", text: msg, project: "", delegated: true };
    // one message, two actions
    if (/approve the plan of KAN-90 and for KAN-91/i.test(msg)) return { intent: "approve", ref: "KAN-90", text: "", project: "", delegated: false,
      more: [{ intent: "answer", ref: "KAN-91", text: "use the old validator", refs: [], delegated: false }] };
    if (/that plan for KAN-92 looks fine to me/i.test(msg)) return { intent: "approve", ref: "KAN-92", text: "", project: "", delegated: false };
    return { intent: "unclear", ref: "", text: "", project: "", delegated: false };
  },
}));
setChatTurn(async () => ({ ok: true, text: "The backend returns questions[] and chips[] – there is no reason field yet.\nSUGGESTED ANSWER: Use questions[] and chips[]; add a reason field to the backend response.", tokens: 1000, costUsd: 0 }));

let clock = Date.now();
async function say(text: string): Promise<string> {
  clock += 1000;
  chat.push({ id: `m${clock}`, conversationId: OWNER, from: "Owner", fromId: OWNER, isMine: false, time: new Date(clock).toISOString(), text });
  const before = sent.length;
  await pollTeamsCommands(true);
  return sent.slice(before).join("\n---\n");
}

function waitingTask(key: string, question: string, options: string[]): Task {
  let t = createTask({ projectId: "shop", source: "jira", sourceId: `id-${key}`, sourceRef: key, title: `Ticket ${key}`, kind: "assigned", state: "TRIAGED",
    data: { ticket: { key, title: `Ticket ${key}`, description: "Some work" } } });
  db().prepare("UPDATE tasks SET playbook='dev-feature', size='M' WHERE id=?").run(t.id);
  t = transition(t.id, "QUEUED", "test");
  t = transition(t.id, "RUNNING", "test");
  t = transition(t.id, "NEEDS_INFO", "test");
  mergeData(t.id, { questions: [{ question, options }], needInfoFrom: "step" });
  return getTask(t.id)!;
}
const ask = async (t: Task) => askUser(t, t.data.questions, "While analysing the requirements", `q:${t.id}:${Date.now()}`);

test("setup: Teams bot chat connected", async () => {
  const r = await connect("teams-personal", { mode: "bot", chatId: OWNER, chatTitle: "Owner", ownerId: OWNER, ownerName: "Owner" });
  assert.ok(r);
  setMeta("teams_personal.cursor", new Date(clock).toISOString());
});

test("a short reply goes to the item the conversation is about, even when several wait", async () => {
  const a = waitingTask("KAN-35", "Which page shows the banner?", ["Home", "Checkout"]);
  const b = waitingTask("KAN-52", "Does the backend already return the reason?", ["Yes, use the existing fields", "No, the backend adds it", "Derive it in the frontend"]);
  await ask(a);
  await ask(b);
  assert.equal(getFocus(), "KAN-52", "the last question asked is the focus");
  const reply = await say("2");
  assert.match(reply, /KAN-52 continues/);
  assert.equal(getTask(b.id)!.state, "QUEUED");
  assert.match(getTask(b.id)!.data.clarifications[0].answer, /No, the backend adds it/);
  assert.equal(getTask(a.id)!.state, "NEEDS_INFO", "the other question is untouched");
});

test("'I don't know, you check the code' leaves the decision to the agent", async () => {
  const c = waitingTask("KAN-60", "Should the chips include 'Not sure'?", ["Yes", "No"]);
  await ask(c);
  const reply = await say("I dont know you check the codes and come up with better implementation plan");
  assert.match(reply, /I'll check the code and decide for KAN-60/);
  const cl = getTask(c.id)!.data.clarifications[0];
  assert.equal(cl.delegated, true);
  assert.equal(cl.answer, DELEGATED_ANSWER);
  assert.equal(getTask("KAN-35")!.state, "NEEDS_INFO");
});

test("the conversation model sees the history and the focus; 'implement it correctly' is a delegated answer", async () => {
  const d = waitingTask("KAN-61", "Which field holds the reason?", ["reason", "why"]);
  await ask(d);
  const reply = await say("Okay according to this ticket with your better plan implement it correctly and raise the PR");
  // the rules already recognise "your better plan" – no model needed
  assert.match(reply, /decide for KAN-61/);
  assert.equal(getTask(d.id)!.data.clarifications[0].delegated, true);
});

test("an unclear message gets one short question, not a long list", async () => {
  clearFocus();
  waitingTask("KAN-62", "Limit per user?", ["10", "20"]);
  const reply = await say("hmm what about the other thing");
  assert.match(reply, /^Do you mean (KAN-\d+) \(question: .*\) or/);
  assert.ok(reply.split("\n").length <= 2, "one short question");
  const prompt = intentCalls.at(-1)!.prompt;
  assert.match(prompt, /Recent conversation/);
  assert.match(prompt, /I dont know you check the codes/, "the history is part of the prompt");
});

test("a question about a waiting task: the assistant answers and offers to send its answer", async () => {
  const e = waitingTask("KAN-63", "Does the backend return chips?", ["Yes", "No"]);
  await ask(e);
  const reply = await say("what does the backend return for this?");
  assert.match(reply, /questions\[\] and chips\[\]/);
  assert.match(reply, /Send this to KAN-63 as your answer\?/);
  assert.equal(getTask(e.id)!.state, "NEEDS_INFO", "nothing is sent without a yes");
  const yes = await say("yes");
  assert.match(yes, /KAN-63 continues/);
  assert.match(getTask(e.id)!.data.clarifications[0].answer, /add a reason field/);
});

test("'KAN-60 i want to finish this ticket' starts a ticket that is waiting to start", async () => {
  const { ruleIntent, pendingItems } = await import("../intake/teamsIntent.js");
  let t = createTask({ projectId: "shop", source: "jira", sourceId: "id-KAN-70", sourceRef: "KAN-70", title: "Ticket KAN-70", kind: "assigned", state: "TRIAGED" });
  t = transition(t.id, "AWAITING_START", "test");
  assert.deepEqual(ruleIntent("KAN-70 i want to finish this ticket", pendingItems()), { intent: { intent: "approve", ref: "KAN-70" } });
  assert.deepEqual(ruleIntent("KAN-70 what is this about?", pendingItems()), undefined, "a question is not a start");
});

test("'/aiw resume kan-52@nue-backend' (slash, lowercase) is the resume command", async () => {
  const { interpret } = await import("../intake/teamsCommands.js");
  const a: any = interpret("/aiw resume kan-52@nue-backend", true), b: any = interpret("resume kan-52", true);
  assert.equal(a.kind, "command"); assert.equal(a.cmd.cmd, "resume"); assert.equal(a.cmd.ref, "KAN-52@nue-backend");
  assert.equal(b.cmd.cmd, "resume"); assert.equal(b.cmd.ref, "KAN-52");
});

test("an older ticket split in two halves: lowercase status shows both, plain 'resume' resumes the paused half", async () => {
  const a = waitingTask("KAN-80", "Which field?", ["a", "b"]);
  db().prepare("UPDATE tasks SET source_ref='KAN-80@shop-frontend' WHERE id=?").run(a.id);
  let b = createTask({ projectId: "shop", source: "jira", sourceId: "id-KAN-80#b", sourceRef: "KAN-80@shop-backend", title: "Ticket KAN-80", kind: "assigned", state: "TRIAGED",
    data: { ticket: { key: "KAN-80", title: "Ticket KAN-80", description: "x" } } });
  db().prepare("UPDATE tasks SET playbook='dev-feature', size='M' WHERE id=?").run(b.id);
  b = transition(b.id, "QUEUED", "t"); b = transition(b.id, "RUNNING", "t"); b = transition(b.id, "PAUSED", "Stopped after repeated errors: 403");
  const status = await say("what is the status of kan-80 whether the plan is ready?");
  assert.match(status, /KAN-80@shop-frontend/);
  assert.match(status, /KAN-80@shop-backend[\s\S]*paused/);
  const resumed = await say("resume");
  assert.match(resumed, /Resumed KAN-80@shop-backend/);
  assert.equal(getTask(b.id)!.state, "QUEUED");
  assert.match(await say("/aiw resume kan-80@shop-backend"), /isn't paused/);
});

test("the conversation is stored in both directions", () => {
  const lines = recentChat(200);
  assert.ok(lines.some((l) => l.direction === "in" && /I dont know/.test(l.text)));
  assert.ok(lines.some((l) => l.direction === "out" && l.kind === "needs_info" && l.task_ref === "KAN-52"));
  assert.ok(lines.some((l) => l.direction === "out" && l.kind === "chat" && /continues/.test(l.text)));
});

// ---------------------------------------------------------------- Claude reads long / multi-action messages; decisions are read back first

function waitingPlan(key: string): Task {
  let t = createTask({ projectId: "shop", source: "jira", sourceId: `id-${key}`, sourceRef: key, title: `Ticket ${key}`, kind: "assigned", state: "TRIAGED",
    data: { ticket: { key, title: `Ticket ${key}`, description: "Some work" } } });
  db().prepare("UPDATE tasks SET playbook='dev-feature', size='M' WHERE id=?").run(t.id);
  t = transition(t.id, "QUEUED", "test");
  t = transition(t.id, "RUNNING", "test");
  requestApproval(t.id, "implement_plan", {});
  return transition(t.id, "AWAITING_APPROVAL", "test");
}

test("one message with two actions: Claude splits it, reads it back, and does both after 'yes'", async () => {
  const plan = waitingPlan("KAN-90");
  const q = waitingTask("KAN-91", "Which validator?", ["The new one", "The old one"]);
  const before = intentCalls.length;
  const reply = await say("approve the plan of KAN-90 and for KAN-91 use the old validator");
  assert.ok(intentCalls.length > before, "read by the conversation model, not by word-matching");
  assert.match(reply, /Here's what I understood – 2 things/);
  assert.match(reply, /1\. Approve \*\*KAN-90\*\* – plan approval/);
  assert.match(reply, /2\. Answer \*\*KAN-91\*\*: "use the old validator"/);
  assert.equal(getTask(plan.id)!.state, "AWAITING_APPROVAL", "nothing is done before the yes");
  const done = await say("yes");
  assert.match(done, /Approved the plan for KAN-90/);
  assert.equal(getTask(plan.id)!.state, "QUEUED");
  assert.equal(getTask(q.id)!.state, "QUEUED");
  assert.match(getTask(q.id)!.data.clarifications.at(-1).answer, /old validator/);
});

test("an approval Claude understood from free text is read back; 'no' does nothing", async () => {
  const plan = waitingPlan("KAN-92");
  const reply = await say("ok so that plan for KAN-92 looks fine to me, I think we can go with it now");
  assert.match(reply, /Here's what I understood[\s\S]*Approve \*\*KAN-92\*\*/);
  assert.match(await say("no"), /nothing was done/);
  assert.equal(getTask(plan.id)!.state, "AWAITING_APPROVAL");
});

test("short exact replies are still instant (no model call)", async () => {
  waitingPlan("KAN-93");
  const before = intentCalls.length;
  const r = await say("KAN-93 1");
  assert.equal(intentCalls.length, before);
  assert.match(r, /Approved the plan for KAN-93/);
});
