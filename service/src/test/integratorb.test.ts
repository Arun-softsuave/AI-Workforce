import { makeRepo } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { db, setMeta } from "../core/db.js";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../core/config.js";
import { connect } from "../connectors/registry.js";
import { setTeamsPersonalClient, type TeamsPersonalClient, type TpMessage } from "../connectors/teamsPersonal.js";
import { setRunner, MockRunner } from "../agents/runner.js";
import { pollTeamsCommands } from "../intake/teamsCommands.js";
import { askUser } from "../engine/engine.js";
import { createTask, getTask, transition, mergeData, type Task } from "../engine/tasks.js";
import { getFocus } from "../notify/chatLog.js";
import { startApiServer } from "../api/server.js";
import { resumeEnvironmentBlockedTasks } from "../engine/envResume.js";
import { main } from "../cli/main.js";
import { listInputs } from "../knowledge/inputs.js";

/**
 * Integration (W1 wave, integrator B): Teams quotes and attachments through the real poller, sent-message ids,
 * the live dashboard served by the API server, environment auto-resume and the new CLI commands.
 */
const OWNER = "8:live:owner";
const sent: { id: string; text: string }[] = [];
let chat: TpMessage[] = [];
let nextId = 1;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const fakeTeams: TeamsPersonalClient = {
  hasSavedLogin: () => true, startLogin: async () => ({ userCode: "X", verificationUrl: "https://x", expiresAt: Date.now() + 1e6 }),
  waitForLogin: async () => {}, logout: () => {}, whoAmI: async () => ({ mri: "8:live:bot", region: "emea" }),
  listChats: async () => [], findChats: async () => [],
  getChatMembers: async () => [{ mri: "8:live:bot", name: "Bot", isMe: true }, { mri: OWNER, name: "Owner", isMe: false }],
  sendMessage: async (_c, text) => { const id = `srv-${nextId++}`; sent.push({ id, text }); return { sent: true, id, messageId: id, clientmessageid: `c-${id}` }; },
  getMessages: async (_c, since) => chat.filter((m) => !since || m.time > since),
  readAttachment: async (_c, _m, index) => (index === 0 ? { bytes: PNG, mimeType: "image/png" } : { bytes: new Uint8Array([0x4d, 0x5a, 1, 2]), name: "tool.exe" }),
};
setTeamsPersonalClient(fakeTeams);
const { repo } = makeRepo("shop");
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Owner", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "teams-personal", fallback: ["inbox"] },
});
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, local: { path: repo }, roles: ["backend-developer"], autonomy: "prepare" }));
const described: string[] = [];
setRunner(new MockRunner({
  "image-describer": (req) => { described.push(req.prompt); return { summary: "A checkout page showing a 500 error.", errorText: "500 Internal Server Error", kind: "screenshot" }; },
}));

let clock = Date.now();
async function say(text: string, extra: Partial<TpMessage> = {}): Promise<string> {
  clock += 1000;
  chat.push({ id: `m${clock}`, conversationId: OWNER, from: "Owner", fromId: OWNER, isMine: false, time: new Date(clock).toISOString(), text, ...extra });
  const before = sent.length;
  await pollTeamsCommands(true);
  return sent.slice(before).map((s) => s.text).join("\n---\n");
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
  assert.ok(await connect("teams-personal", { mode: "bot", chatId: OWNER, chatTitle: "Owner", ownerId: OWNER, ownerName: "Owner" }));
  setMeta("teams_personal.cursor", new Date(clock).toISOString());
});

test("sent notifications keep their Teams id, item and question key", async () => {
  const a = waitingTask("KAN-35", "Which page shows the banner?", ["Home", "Checkout"]);
  await ask(a);
  const msg = sent.find((s) => /KAN-35/.test(s.text));
  assert.ok(msg, "the question was sent");
  const row = db().prepare("SELECT msg_id, item_id, question_key FROM chat_log WHERE direction='out' AND msg_id=?").get(msg!.id) as any;
  assert.ok(row, "chat_log row has the server id");
  assert.equal(row.item_id, "KAN-35");
  assert.match(String(row.question_key), /^q:/);
});

test("a quoted bot message sends the reply to that item, even when a newer question is in focus", async () => {
  const b = waitingTask("KAN-52", "Does the backend already return the reason?", ["Yes", "No, the backend adds it"]);
  await ask(b);
  assert.equal(getFocus(), "KAN-52");
  const q35 = sent.find((s) => /KAN-35/.test(s.text))!;
  const reply = await say("1", { replyTo: { messageId: q35.id, from: "AI Workforce", preview: q35.text.slice(0, 60) } });
  assert.match(reply, /KAN-35/);
  const a = getTask("KAN-35")!;
  assert.notEqual(a.state, "NEEDS_INFO", "KAN-35 was answered");
  assert.match(a.data.clarifications[0].answer, /Home/);
  assert.equal(getTask("KAN-52")!.state, "NEEDS_INFO", "the newer question is untouched");
  // the reply itself was recorded with its Teams id
  const last = sent[sent.length - 1];
  assert.ok(db().prepare("SELECT 1 FROM chat_log WHERE msg_id=?").get(last.id), "reply id recorded");
});

test("quoting an already answered question says so instead of answering twice", async () => {
  const q35 = sent.find((s) => /KAN-35/.test(s.text))!;
  const reply = await say("2", { replyTo: { messageId: q35.id, from: "AI Workforce", preview: q35.text.slice(0, 60) } });
  assert.match(reply, /KAN-35 was already answered/);
});

test("a picture-only message is saved on the focus item with a one-line confirmation", async () => {
  const reply = await say("", { attachments: [{ index: 0, kind: "image", name: "image" }], images: [{ index: 0, name: "image" }] });
  assert.match(reply, /Added screenshot to KAN-35/);   // the quote above moved the focus to KAN-35
  assert.equal(reply.split("\n").length, 1, "one short line");
  const rows = listInputs("KAN-35");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "image");
  assert.equal(described.length, 1, "described once");
});

test("a program sent as a file is refused and never downloaded as an input", async () => {
  const reply = await say("", { attachments: [{ index: 1, kind: "file", name: "tool.exe", ext: "exe" }], files: [{ name: "tool.exe", index: 1 }] });
  assert.match(reply, /Did not save tool\.exe/);
  assert.equal(listInputs("KAN-35").length, 1);
});

test("the API server serves the live dashboard, its files, the stream and the data routes", async () => {
  const token = "test-token-123";
  const { server, port } = await startApiServer(0, token);
  try {
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/?t=${token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(token), "token put into the page");
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'; script-src 'self'/);
    assert.equal((await fetch(`${base}/?t=wrong`)).status, 401);
    const js = await fetch(`${base}/web/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.equal((await fetch(`${base}/web/../src/api/server.ts`)).status, 404);
    const css = await fetch(`${base}/web/app.css`);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    const connectPage = await fetch(`${base}/connect/jira?t=${token}`);
    assert.equal(connectPage.status, 200);
    const h = { "X-AIW-Token": token };
    const ov = await fetch(`${base}/api/overview`, { headers: h });
    assert.equal(ov.status, 200);
    assert.ok((await ov.json()).top, "overview shape");
    assert.equal((await fetch(`${base}/api/overview`)).status, 401);
    assert.equal((await fetch(`${base}/api/items/nope/timeline`, { headers: h })).status, 404);
    assert.equal((await fetch(`${base}/api/stream`)).status, 401);
    const ctrl = new AbortController();
    const st = await fetch(`${base}/api/stream?t=${token}`, { signal: ctrl.signal });
    assert.equal(st.status, 200);
    assert.match(st.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = st.body!.getReader();
    let got = "";
    while (!got.includes("event: snapshot")) { const { value, done } = await reader.read(); if (done) break; got += Buffer.from(value!).toString("utf8"); }
    assert.match(got, /event: snapshot/);
    ctrl.abort();
    const bench = await fetch(`${base}/api/bench`, { headers: h });
    assert.equal(bench.status, 200);
  } finally {
    (await import("../api/stream.js")).closeAllStreams();
    server.close();
  }
});

test("a task blocked by the environment resumes by itself when the setup is fixed", async () => {
  let t = createTask({ projectId: "shop", source: "jira", sourceId: "id-KAN-70", sourceRef: "KAN-70", title: "Ticket KAN-70", kind: "assigned", state: "TRIAGED", data: {} });
  t = transition(t.id, "QUEUED", "test");
  t = transition(t.id, "RUNNING", "test");
  t = transition(t.id, "PAUSED", "Blocked: environment");
  mergeData(t.id, { blocked: { reason: "environment", report: "No virtual environment", at: new Date().toISOString() } });
  const still = await resumeEnvironmentBlockedTasks(async () => ({ ok: false, checks: [], summary: "no", checkedAt: "" }));
  assert.equal(still, 0);
  assert.equal(getTask(t.id)!.state, "PAUSED");
  const n = await resumeEnvironmentBlockedTasks(async () => ({ ok: true, checks: [], summary: "ok", checkedAt: "" }));
  assert.equal(n, 1);
  const after = getTask(t.id)!;
  assert.equal(after.state, "QUEUED");
  assert.equal(after.data.blocked, null);
  assert.ok(db().prepare("SELECT 1 FROM notifications WHERE title LIKE 'KAN-70: environment fixed%'").get(), "one short message");
});

test("aiw bench and aiw doctor <project>", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    assert.equal(await main(["bench"]), 0);
    assert.equal(await main(["bench", "compare"]), 1);
    assert.equal(await main(["doctor", "no-such-project"]), 1);
    assert.match(logs.join("\n"), /No project "no-such-project"/);
    const code = await main(["doctor", "shop", "--json"]);
    const r = JSON.parse(logs[logs.length - 1]);
    assert.equal(typeof r.ok, "boolean");
    assert.equal(code, r.ok ? 0 : 1);
  } finally { console.log = orig; }
});
