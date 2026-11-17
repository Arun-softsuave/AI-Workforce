import "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { saveSettings, DEFAULT_SETTINGS } from "../core/config.js";
import { setMeta } from "../core/db.js";
import { setTeamsPersonalClient, NOTES_CHAT, AIW_PREFIX, type TeamsPersonalClient, type TpMessage } from "../connectors/teamsPersonal.js";
import { connect, isConnected, connectionMeta, disconnect } from "../connectors/registry.js";
import { notify } from "../notify/router.js";
import { parseCommand, pollTeamsCommands } from "../intake/teamsCommands.js";
import { createTask, transition, getTask } from "../engine/tasks.js";
import { requestApproval, latestApproval } from "../approvals/approvals.js";
import { setEngineRole } from "../engine/engine.js";

const sent: { chat: string; text: string }[] = [];
let inbox: TpMessage[] = [];
let loggedOut = false;
const fake: TeamsPersonalClient = {
  hasSavedLogin: () => !loggedOut,
  startLogin: async () => ({ userCode: "ABC123", verificationUrl: "https://microsoft.com/devicelogin", expiresAt: Date.now() + 900_000 }),
  waitForLogin: async () => {},
  logout: () => { loggedOut = true; },
  whoAmI: async () => ({ mri: "8:live:testuser", region: "emea" }),
  listChats: async () => [{ id: NOTES_CHAT, title: "Notes (self chat)" }],
  findChats: async () => [],
  getChatMembers: async () => [{ mri: "8:live:bot", name: "You", isMe: true }, { mri: "8:live:testuser", name: "Test User", isMe: false }],
  sendMessage: async (chat, text) => { sent.push({ chat, text }); return { sent: true }; },
  getMessages: async (_chat, since) => inbox.filter((m) => !since || m.time > since),
};
setTeamsPersonalClient(fake);
setEngineRole("client");
saveSettings({ ...structuredClone(DEFAULT_SETTINGS), profile: { name: "Arun", workingHours: "00:00-23:59", roles: [] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "teams-personal", fallback: ["inbox"], quietHours: "off" } });

const msg = (id: string, text: string, isMine = true, secondsAgo = 0): TpMessage =>
  ({ id, conversationId: NOTES_CHAT, from: isMine ? "You" : "Someone", fromId: isMine ? "8:live:testuser" : "8:live:other", isMine, time: new Date(Date.now() - secondsAgo * 1000).toISOString(), text });

test("command parsing", () => {
  assert.deepEqual(parseCommand("aiw approve KAN-42@nue-backend"), { cmd: "approve", ref: "KAN-42@nue-backend", reason: undefined });
  assert.deepEqual(parseCommand('aiw reject KAN-42@nue-backend "use the existing validator"'), { cmd: "reject", ref: "KAN-42@nue-backend", reason: "use the existing validator" });
  assert.equal(parseCommand("AIW inbox")?.cmd, "inbox");
  assert.equal(parseCommand("please approve KAN-42"), undefined, "plain chat text is never a command");
});

test("connect records the Notes chat and sends a confirmation there", async () => {
  const r = await connect("teams-personal", {});
  assert.equal(r.ok, true);
  assert.ok(isConnected("teams-personal"));
  assert.equal(connectionMeta("teams-personal").chatId, NOTES_CHAT);
  assert.ok(sent.at(-1)!.text.startsWith(AIW_PREFIX) && sent.at(-1)!.chat === NOTES_CHAT);
});

test("notifications are posted as Teams messages with reply instructions", async () => {
  const r = await notify({ kind: "approval_needed", taskRef: "KAN-42@nue-backend", approvalId: "a_x", approvalAction: "implement_plan", dedupeKey: "t1", title: "Plan ready – KAN-42@nue-backend", body: "1. Validate input" });
  assert.deepEqual(r.delivered, ["teams-personal"], "Teams only – no desktop copy");
  const last = sent.at(-1)!.text;
  assert.match(last, /Plan ready – KAN-42@nue-backend/);
  assert.match(last, /1️⃣  Approve the plan and build it\n\n2️⃣  Change something \(tell me what\)\n\n3️⃣  Cancel this task/, "numbered choices like Claude Code");
  assert.match(last, /start your reply with KAN-42@nue-backend/);
});

test("only the user's own 'aiw' messages are executed – once each", async () => {
  const t = createTask({ projectId: "p", source: "jira", sourceId: "i-42", sourceRef: "KAN-42@nue-backend", kind: "assigned", data: { ticket: { key: "KAN-42" } } });
  for (const s of ["TRIAGED", "QUEUED", "RUNNING", "AWAITING_APPROVAL"] as const) transition(t.id, s);
  requestApproval(t.id, "implement_plan", {});
  setMeta("teams_personal.cursor", new Date(Date.now() - 60_000).toISOString());
  inbox = [
    msg("m1", "aiw approve KAN-42@nue-backend", false, 30),            // someone else – ignored
    msg("m2", `${AIW_PREFIX}\nPlan ready – reply aiw approve KAN-42@nue-backend`, true, 25), // our own notification – ignored
    msg("m3", "lunch at 1?", true, 20),                                  // normal chat – ignored
    msg("m4", "aiw inbox", true, 10),
    msg("m5", "aiw approve KAN-42@nue-backend", true, 5),
  ];
  const before = sent.length;
  assert.equal(await pollTeamsCommands(true), 2);
  assert.equal(latestApproval(t.id)!.state, "approved");
  assert.equal(latestApproval(t.id)!.channel, "teams-personal");
  assert.equal(getTask(t.id)!.state, "QUEUED");
  const replies = sent.slice(before).map((s) => s.text);
  assert.equal(replies.length, 2);
  assert.match(replies[1], /Approved the plan for KAN-42@nue-backend/);
  assert.equal(await pollTeamsCommands(true), 0, "already-handled messages are not executed again");
});

test("bot mode: messages come from the bot, only the owner can command", async () => {
  const r = await connect("teams-personal", { mode: "bot", chatId: "8:live:testuser", chatTitle: "Test User", ownerId: "8:live:testuser", ownerName: "Test User" });
  assert.equal(r.ok, true);
  assert.equal(connectionMeta("teams-personal").mode, "bot");
  assert.match(sent.at(-1)!.text, /Hi Test User! I'm your AI Workforce assistant/);
  assert.equal(sent.at(-1)!.chat, "8:live:testuser");
  const bad = await connect("teams-personal", { mode: "bot", chatId: NOTES_CHAT });
  assert.equal(bad.ok, false, "bot mode needs the owner's 1:1 chat");
  await connect("teams-personal", { mode: "bot", chatId: "8:live:testuser", ownerId: "8:live:testuser", ownerName: "Test User" });
  setMeta("teams_personal.cursor", new Date(Date.now() - 60_000).toISOString());
  const fromOwner = (id: string, text: string, s: number): TpMessage => ({ ...msg(id, text, false, s), fromId: "8:live:testuser", from: "Test User" });
  inbox = [
    msg("b1", "aiw status", true, 30),                   // the bot's own message – never a command
    { ...msg("b2", "aiw status", false, 20), fromId: "8:live:stranger" },  // someone else
    fromOwner("b3", "aiw status", 10),                   // the owner – accepted
  ];
  const before = sent.length;
  assert.equal(await pollTeamsCommands(true), 1);
  assert.match(sent.slice(before)[0].text, /^AIW:/, "bot replies without the robot prefix");
  // any other message from the owner in the bot chat is a question for the assistant
  inbox = [fromOwner("b4", "which KAN tickets are in progress?", 5)];
  setMeta("teams_personal.cursor", new Date(Date.now() - 8_000).toISOString());
  const b2 = sent.length;
  assert.equal(await pollTeamsCommands(true), 1);
  assert.match(sent.slice(b2)[0].text, /No projects are set up yet|offline mode/);
});

test("own Notes chat: plain notes are ignored, 'aiw <question>' is a question, 'aiw new' is a command", async () => {
  const { interpret } = await import("../intake/teamsCommands.js");
  assert.equal(interpret("buy milk", false), undefined);
  assert.deepEqual(interpret("aiw which tickets are in progress?", false), { kind: "question", text: "which tickets are in progress?" });
  assert.equal(interpret("aiw approve KAN-1", false)?.kind, "command");
  assert.deepEqual(interpret("where is input validated?", true), { kind: "question", text: "where is input validated?" });
  assert.equal((interpret("aiw new", true) as any).cmd.cmd, "new");
  // bot chat: commands work without "aiw"; own Notes chat still needs it
  assert.deepEqual(interpret("approve KAN-42@nue-backend", true), { kind: "command", cmd: { cmd: "approve", ref: "KAN-42@nue-backend", reason: undefined } });
  assert.equal((interpret("start all", true) as any).cmd.cmd, "start");
  assert.equal((interpret("help", true) as any).cmd.cmd, "help");
  assert.equal(interpret("approve KAN-42@nue-backend", false), undefined);
  assert.equal(interpret("starting tomorrow we should look at KAN-42", true)?.kind, "question", "only exact command words count");
});

test("disconnect signs out of Teams", () => {
  disconnect("teams-personal");
  assert.equal(isConnected("teams-personal"), false);
});
