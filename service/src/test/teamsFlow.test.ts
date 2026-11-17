import { makeRepo, waitFor, testHome } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { db, setMeta } from "../core/db.js";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, loadSettings } from "../core/config.js";
import { normaliseQuestions, formatQuestions, resolveReply } from "../core/questions.js";
import { clients, connect } from "../connectors/registry.js";
import type { JiraClient } from "../connectors/jira.js";
import type { GitHubClient } from "../connectors/github.js";
import type { WorkItem } from "../connectors/types.js";
import { setTeamsPersonalClient, type TeamsPersonalClient, type TpMessage } from "../connectors/teamsPersonal.js";
import { setRunner, MockRunner, type AgentRequest } from "../agents/runner.js";
import { notify, flushNotifications } from "../notify/router.js";
import { splitMessage } from "../notify/channels.js";
import { maybeSendCheckup } from "../notify/checkup.js";
import { pollTeamsCommands, needsNaturalHandling } from "../intake/teamsCommands.js";
import { ruleIntent } from "../intake/teamsIntent.js";
import { setEngineRole, tick, decideAndApply, answerTask } from "../engine/engine.js";
import { getTask, type Task } from "../engine/tasks.js";
import { latestApproval } from "../approvals/approvals.js";
import { projectForPath } from "../engine/requests.js";
import { taskDetail, statusText } from "../api/ops.js";

// ---------------------------------------------------------------- fakes: Jira, GitHub, the Teams bot chat, the model

const OWNER = "8:live:owner";
const issues: WorkItem[] = [{
  provider: "jira", id: "id-PAY-7", key: "PAY-7", projectKey: "PAY", title: "Refund limit for support agents",
  description: "Support agents can refund orders. Large refunds must be limited so mistakes cannot cost much money. Add tests for the limit.",
  status: "To Do", statusCategory: "new", assignee: "me", priority: "High", labels: [], url: "https://acme.atlassian.net/browse/PAY-7",
  updated: new Date().toISOString(), comments: [],
}];
const fakeJira: JiraClient = {
  site: "https://acme.atlassian.net", myself: async () => ({ accountId: "me", displayName: "Me" }),
  search: async () => [], getIssue: async (k) => issues.find((i) => i.key === k), addComment: async () => {},
};
const prs: any[] = [];
const fakeGitHub: GitHubClient = {
  user: async () => ({ login: "me" }), repo: async () => ({ defaultBranch: "main", private: true }),
  findOpenPr: async (_r, b) => prs.find((p) => p.head === b),
  createPr: async (_r, p) => { const pr = { number: 300 + prs.length, url: `https://github.com/acme/shop/pull/${300 + prs.length}`, ...p }; prs.push(pr); return pr; },
  updatePr: async (_r, n, p) => { const pr = prs.find((x) => x.number === n); Object.assign(pr, p); return pr; },
  failedRuns: async () => [], failedJobLog: async () => "", gitAuthHeader: () => "AUTHORIZATION: basic dGVzdA==",
  recentPrBases: async () => [], prActivity: async () => [],
};

const sent: string[] = [];                    // everything the bot posted in the chat
let chat: TpMessage[] = [];
let teamsDown = false;
const fakeTeams: TeamsPersonalClient = {
  hasSavedLogin: () => true, startLogin: async () => ({ userCode: "X", verificationUrl: "https://x", expiresAt: Date.now() + 1e6 }),
  waitForLogin: async () => {}, logout: () => {}, whoAmI: async () => ({ mri: "8:live:bot", region: "emea" }),
  listChats: async () => [], findChats: async () => [],
  getChatMembers: async () => [{ mri: "8:live:bot", name: "Bot", isMe: true }, { mri: OWNER, name: "Owner", isMe: false }],
  sendMessage: async (_c, text) => { if (teamsDown) throw new Error("teams unreachable"); sent.push(text); return { sent: true }; },
  getMessages: async (_c, since) => chat.filter((m) => !since || m.time > since),
};

const { repo, origin } = makeRepo("shop");
process.env.AIW_GIT_PUSH_URL = origin;
clients.jira = () => fakeJira;
clients.github = () => fakeGitHub;
setTeamsPersonalClient(fakeTeams);
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Owner", workingHours: "11:00-22:00", roles: ["backend-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "teams-personal", fallback: ["desktop", "inbox"] },
});
upsertProject(normaliseProject({
  id: "shop", jira: { site: "acme.atlassian.net", keys: ["PAY"] }, github: { repo: "acme/shop", baseBranch: "main" },
  local: { path: repo, testCommand: "node -e \"process.exit(0)\"" }, roles: ["backend-developer"], autonomy: "prepare",
}));
setEngineRole("daemon");

// The implementer hits a business-rule question on PAY-7 the first time, and finishes once it has the answer.
const runner = new MockRunner({
  implementer: (req: AgentRequest) => {
    // only the PAY-7 ticket itself (the Brain's memory of PAY-7 also appears in later tasks' context)
    if (req.prompt.includes('<untrusted source="ticket:PAY-7">') && !req.prompt.includes("Clarifications from the assignee")) {
      return { summary: "Started the refund limit", filesChanged: [], testsAdded: [], questions: [{ question: "Should refunds above 1000 need a manager's approval?", options: ["Yes, above 1000", "No limit for managers"] }] };
    }
    fs.appendFileSync(path.join(req.cwd!, "CHANGE.md"), `change ${Date.now()}\n`);
    return { summary: "Implemented the change", filesChanged: ["CHANGE.md"], testsAdded: ["refund limit test"], questions: [] };
  },
});
setRunner(runner);

let clock = Date.now();
/** The owner types a message in the Teams chat; the service reads it. Returns what the bot answered. */
async function say(text: string): Promise<string> {
  clock += 1000;
  chat.push({ id: `m${clock}`, conversationId: OWNER, from: "Owner", fromId: OWNER, isMine: false, time: new Date(clock).toISOString(), text });
  const before = sent.length;
  await pollTeamsCommands(true);
  return sent.slice(before).join("\n---\n");
}
/** Let the background engine run until the task reaches one of the states. */
async function drive(ref: string, states: string[]): Promise<Task> {
  return waitFor(() => { void tick(); const t = getTask(ref); return t && states.includes(t.state) ? t : undefined; }, 60_000, 100);
}
const lastMessage = () => sent.at(-1) ?? "";

// ---------------------------------------------------------------- questions with options

test("questions: options are numbered with the recommended one first; replies map to options", () => {
  const qs = normaliseQuestions([{ question: "Upload limit?", options: ["10 MB", "25 MB", "50 MB"] }, "Plain question?"]);
  assert.equal(qs[1].options.length, 0, "plain strings still work");
  const text = formatQuestions([qs[0]]);
  assert.match(text, /❓ \*\*Question\*\*\nUpload limit\?\n\n1️⃣  10 MB   ⭐ recommended\n\n2️⃣  25 MB\n\n3️⃣  50 MB/);
  assert.match(text, /Reply with a number, or write your own answer\./);
  assert.deepEqual(resolveReply([qs[0]], "2"), { ok: true, answer: "Upload limit? → 25 MB" });
  assert.deepEqual(resolveReply([qs[0]], "50 mb"), { ok: true, answer: "Upload limit? → 50 MB" });
  assert.deepEqual(resolveReply([qs[0]], "use 15 MB"), { ok: true, answer: "Upload limit? → use 15 MB" });
  assert.equal(resolveReply([qs[0]], "7").ok, false, "a number that matches no option is never guessed");
  const two = [qs[0], { question: "Who?", options: ["Buyers", "Admins"] }];
  assert.deepEqual(resolveReply(two, "1, 2"), { ok: true, answer: "Upload limit? → 10 MB\nWho? → Admins" });
  assert.equal(resolveReply(two, "1").ok, false, "two questions need two numbers");
});

test("long Teams messages are split on line boundaries, nothing is cut off", () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const parts = splitMessage(text, 3500);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 3500 + 12));
  assert.match(parts[0], /^\(1\/\d+\)\n\n/);
  assert.equal(parts.map((p) => p.replace(/^\(\d+\/\d+\)\n\n/, "")).join("\n"), text);
});

// ---------------------------------------------------------------- understanding plain chat messages

test("plain-language rules: start, status, yes/numbers only when unambiguous", () => {
  const task = (ref: string) => ({ id: `t-${ref}`, source_ref: ref, title: ref, data: {} }) as any as Task;
  const appr = (ref: string, action = "implement_plan") => ({ task: task(ref), approval: { action, state: "pending" } as any });
  const none = { approvals: [], questions: [], starts: [] };
  const one = { approvals: [appr("KAN-42")], questions: [], starts: [] };
  const two = { approvals: [appr("KAN-42"), appr("KAN-37", "create_pr")], questions: [], starts: [] };
  const asked = { approvals: [], questions: [task("KAN-50")], starts: [] };

  assert.deepEqual(ruleIntent("plan for KAN-42", none), { intent: { intent: "start_ticket", ref: "KAN-42" } });
  assert.deepEqual(ruleIntent("can you pick up KAN-42?", none), { intent: { intent: "start_ticket", ref: "KAN-42" } });
  assert.deepEqual(ruleIntent("what's the status of KAN-42?", none), { intent: { intent: "status", ref: "KAN-42" } });
  assert.deepEqual(ruleIntent("status?", none), { intent: { intent: "status" } });
  assert.equal(ruleIntent("which KAN tickets are in progress?", none), undefined, "wider questions go to the assistant");

  assert.deepEqual(ruleIntent("yes", one), { intent: { intent: "approve", ref: "KAN-42" } });
  assert.deepEqual(ruleIntent("looks good!", one), { intent: { intent: "approve", ref: "KAN-42" } });
  assert.deepEqual(ruleIntent("1", one), { option: { ref: "KAN-42", action: "implement_plan", n: 1 } });
  assert.deepEqual(ruleIntent("2", one), { option: { ref: "KAN-42", action: "implement_plan", n: 2 } });
  assert.deepEqual(ruleIntent("no, use the existing validator", one), { intent: { intent: "reject", ref: "KAN-42", text: "use the existing validator" } });
  assert.deepEqual(ruleIntent("no", one), { option: { ref: "KAN-42", action: "implement_plan", n: 2 } }, "a bare no asks what to change");
  assert.match((ruleIntent("yes", two) as any).reply, /Several things are waiting/, "never guesses between two items");
  assert.match((ruleIntent("1", two) as any).reply, /KAN-42 – plan approval\n• KAN-37 – raise the PR\?/);
  assert.match((ruleIntent("yes", none) as any).reply, /Nothing is waiting/);
  assert.deepEqual(ruleIntent("2", asked), { intent: { intent: "answer", ref: "KAN-50", text: "2" } });
  assert.equal(ruleIntent("why did you choose that?", one, true), undefined, "a question is not a decision");

  assert.equal(needsNaturalHandling({ cmd: "approve" }), true, "a bare 'approve' is a reply, not a command");
  assert.equal(needsNaturalHandling({ cmd: "approve", ref: "KAN-42@x" }), false);
  assert.equal(needsNaturalHandling({ cmd: "run", ref: "the" }), true, "'run the tests' is plain language");
});

// ---------------------------------------------------------------- the full flow in Teams

test("Teams connects as the two-way bot chat", async () => {
  const r = await connect("teams-personal", { mode: "bot", chatId: OWNER, chatTitle: "Owner", ownerId: OWNER, ownerName: "Owner" });
  assert.equal(r.ok, true);
  setMeta("teams_personal.cursor", new Date(clock).toISOString());
});

test("ticket from Teams: plan approval -> question while building -> PR approval -> PR link, all in Teams", async () => {
  // 1. "plan for PAY-7" in plain words
  const started = await say("can you plan for PAY-7 please");
  assert.match(started, /On it – \*\*PAY-7\*\*/);

  // 2. the full plan arrives with numbered choices; no code is written before approval
  const planWait = await drive("PAY-7", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"]);
  assert.equal(planWait.state, "AWAITING_APPROVAL", planWait.error ?? "");
  assert.equal(latestApproval(planWait.id)!.action, "implement_plan", "the plan is approved first, even in 'prepare' autonomy");
  assert.match(lastMessage(), /Plan ready – PAY-7/);
  assert.match(lastMessage(), /Steps\*\*\n1\. /);
  assert.match(lastMessage(), /1️⃣  Approve the plan and build it\n\n2️⃣  Change something \(tell me what\)\n\n3️⃣  Cancel this task/);
  assert.equal(runner.calls.filter((c) => c.agent === "implementer").length, 0, "nothing is implemented before the plan is approved");
  assert.deepEqual(runner.calls.find((c) => c.agent === "planner")?.lookup, { repo: "acme/shop", codeRepos: ["shop"] }, "the planner may look up linked tickets, PRs and designs");
  assert.deepEqual(runner.calls.find((c) => c.agent === "analyst")?.lookup, { repo: "acme/shop", codeRepos: ["shop"] });
  assert.equal(runner.calls.find((c) => c.agent.startsWith("plan-reviewer"))?.lookup, undefined, "reviewers judge only what they are given");

  // approvals are Teams-only
  const fromClaude = await decideAndApply("PAY-7", "approved", "Owner", "claude-code");
  assert.equal(fromClaude.ok, false);
  assert.match(fromClaude.message, /happen in Teams/);
  assert.equal(latestApproval(planWait.id)!.state, "pending");

  // 3. "1" approves the plan
  assert.match(await say("1"), /Approved the plan for PAY-7 – building and testing now/);

  // 4. the implementer has a doubt: it asks in Teams with options instead of guessing
  const q = await drive("PAY-7", ["NEEDS_INFO", "AWAITING_APPROVAL", "FAILED", "PAUSED"]);
  assert.equal(q.state, "NEEDS_INFO", q.error ?? "");
  assert.match(lastMessage(), /While implementing \(attempt 1 of 3\)/);
  assert.match(lastMessage(), /Should refunds above 1000 need a manager's approval\?\n\n1️⃣  Yes, above 1000   ⭐ recommended\n\n2️⃣  No limit for managers/);
  // Claude Code can see where it is (status), but cannot answer
  assert.match(taskDetail("PAY-7")!.now, /asked you a question/);
  assert.equal(taskDetail("PAY-7")!.waitingFor, "your answer in Teams");
  assert.equal((await answerTask("PAY-7", "1", "Owner", "claude-code")).ok, false);

  // 5. the answer by number
  assert.match(await say("1"), /PAY-7 continues with your answer/);
  assert.equal(getTask("PAY-7")!.data.clarifications.at(-1).answer, "Should refunds above 1000 need a manager's approval? → Yes, above 1000");

  // 6. built and tested -> "raise the PR?" with the result
  const ready = await drive("PAY-7", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"]);
  assert.equal(ready.state, "AWAITING_APPROVAL", ready.error ?? "");
  assert.equal(latestApproval(ready.id)!.action, "create_pr");
  assert.match(lastMessage(), /PAY-7 Built and tested – raise the PR\?/);
  assert.match(lastMessage(), /Tests:\*\* ✅ passed/);
  assert.match(lastMessage(), /Changed files/);
  assert.match(lastMessage(), /1️⃣  Raise the PR/);
  assert.match(statusText("PAY-7")!, /Waiting for:\*\* your OK to raise the PR in Teams/);

  // 7. "go ahead" raises the PR and the link comes to Teams
  assert.match(await say("go ahead"), /Approved PAY-7 – raising the PR now/);
  const done = await drive("PAY-7", ["DONE", "FAILED", "PAUSED", "FAILED_PUBLISH"]);
  assert.equal(done.state, "DONE", done.error ?? "");
  assert.equal(prs.length, 1);
  assert.equal(prs[0].draft, false);
  assert.match(sent.find((m) => /PR #300 raised/.test(m)) ?? "", /https:\/\/github\.com\/acme\/shop\/pull\/300/);

  // every message went to Teams only
  const channels = (db().prepare("SELECT DISTINCT channel FROM notifications WHERE channel != 'inbox'").all() as any[]).map((r) => r.channel);
  assert.deepEqual(channels, ["teams-personal"]);
});

test("work without a ticket: requirements interview in Teams -> confirm -> plan -> PR", async () => {
  const started = await say("add a CSV export button to the orders page");
  assert.match(started, /Got it – TASK-1/);

  const asked = await drive("TASK-1", ["NEEDS_INFO", "FAILED", "PAUSED"]);
  assert.equal(asked.state, "NEEDS_INFO", asked.error ?? "");
  assert.match(lastMessage(), /Before I plan this, I need to understand it fully/);
  assert.match(lastMessage(), /Who will use this\?\n\n1️⃣  All buyers   ⭐ recommended\n\n2️⃣  Admins only/);
  assert.match(await say("2"), /TASK-1 continues with your answer/);

  const confirm = await drive("TASK-1", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"]);
  assert.equal(confirm.state, "AWAITING_APPROVAL", confirm.error ?? "");
  assert.equal(latestApproval(confirm.id)!.action, "confirm_requirements");
  assert.match(lastMessage(), /TASK-1: is this what you want\?/);
  assert.match(lastMessage(), /Done when:/);
  assert.match(lastMessage(), /1️⃣  Confirm and plan it/);
  assert.match(await say("yes"), /Requirements for TASK-1 confirmed/);

  const plan = await drive("TASK-1", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"]);
  assert.equal(plan.state, "AWAITING_APPROVAL", plan.error ?? "");
  assert.equal(latestApproval(plan.id)!.action, "implement_plan", "a confirmed request goes through plan approval like a ticket");
  assert.equal(plan.kind, "assigned");
  assert.deepEqual(plan.data.clarifications, [], "interview answers do not use up the task's question rounds");
  assert.equal(plan.data.interview.length, 1);
  assert.match(await say("TASK-1 1"), /Approved the plan for TASK-1/);

  const pr = await drive("TASK-1", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"]);
  assert.equal(pr.state, "AWAITING_APPROVAL", pr.error ?? "");
  assert.equal(latestApproval(pr.id)!.action, "create_pr");
  assert.match(await say("1"), /raising the PR now/);
  const done = await drive("TASK-1", ["DONE", "FAILED", "PAUSED", "FAILED_PUBLISH"]);
  assert.equal(done.state, "DONE", done.error ?? "");
  const created = prs.at(-1);
  assert.ok(!created.title.startsWith("TASK-1"), "no made-up ticket key in the PR title");
  assert.match(created.body, /Requirements \(agreed before implementation\)/);
});

test("rejecting with '2' asks what to change; the answer re-plans", async () => {
  issues.push({ ...issues[0], id: "id-PAY-8", key: "PAY-8", title: "Show refund reason on receipts", url: "https://acme.atlassian.net/browse/PAY-8" });
  await say("plan for PAY-8");
  await drive("PAY-8", ["AWAITING_APPROVAL"]);
  const plannerCalls = runner.calls.filter((c) => c.agent === "planner").length;
  assert.match(await say("2"), /What should I change for PAY-8\?/);
  assert.match(await say("keep the receipt layout, add the reason as a footer"), /re-planning PAY-8 with your feedback/);
  await drive("PAY-8", ["AWAITING_APPROVAL"]);
  assert.ok(runner.calls.filter((c) => c.agent === "planner").length > plannerCalls);
  assert.ok(runner.calls.filter((c) => c.agent === "planner").at(-1)!.prompt.includes("add the reason as a footer"));
  // "3" cancels, after a confirmation
  assert.match(await say("3"), /Cancel PAY-8/);
  assert.match(await say("yes"), /Cancelled PAY-8/);
  assert.equal(getTask("PAY-8")!.state, "CANCELLED");
});

// ---------------------------------------------------------------- Teams only, 24 h, daily check-up

test("Teams only: no desktop copy, no quiet hours, failed messages are retried on Teams only", async () => {
  assert.equal(loadSettings().notifications.quietHours, "off");
  const night = await notify({ kind: "approval_needed", title: "Night approval", body: "b", dedupeKey: "n1", approvalId: "a_n" }, new Date(2026, 10, 12, 2, 30));
  assert.deepEqual(night.delivered, ["teams-personal"], "delivered at 02:30 – no quiet hours");
  assert.deepEqual(night.held, []);
  teamsDown = true;
  const down = await notify({ kind: "failed", title: "While Teams is down", body: "b", dedupeKey: "d1" });
  assert.deepEqual(down.delivered, [], "no fallback to desktop");
  teamsDown = false;
  assert.ok((await flushNotifications()) >= 1, "retried on Teams");
  assert.ok(sent.some((m) => /While Teams is down/.test(m)));
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE channel='desktop'").get() as any).n, 0);
});

test("daily check-up at 10:00, once a day, caught up if the computer was off", async () => {
  setMeta("checkup.date", "");
  assert.equal(await maybeSendCheckup(new Date(2026, 10, 13, 9, 59)), false, "not before 10:00");
  assert.equal(await maybeSendCheckup(new Date(2026, 10, 13, 10, 0)), true);
  assert.match(lastMessage(), /Daily check-up – 2026-11-13/);
  assert.match(lastMessage(), /Connections: /);
  assert.equal(await maybeSendCheckup(new Date(2026, 10, 13, 15, 0)), false, "only once a day");
  assert.equal(await maybeSendCheckup(new Date(2026, 10, 14, 21, 30)), true, "computer was off at 10:00 -> sent when it is on");
});

// ---------------------------------------------------------------- Claude Code: hand over only in AI Workforce projects

test("Claude Code hook: hands work to AI Workforce in its projects, silent elsewhere", () => {
  assert.equal(projectForPath(path.join(repo, "src", "services"))?.id, "shop");
  assert.equal(projectForPath(os.tmpdir()), undefined);
  const hook = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "hooks", "user-prompt.js");
  const run = (input: object) => execFileSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, AIW_HOME: testHome } });
  const inside = run({ prompt: "work on PAY-9", cwd: path.join(repo, "src") });
  assert.match(inside, /aiw_run_ticket/);
  assert.match(inside, /aiw_start_request/);
  assert.match(inside, /ONLY in Teams/);
  assert.equal(run({ prompt: "work on PAY-9", cwd: fs.mkdtempSync(path.join(os.tmpdir(), "other-")) }).trim(), "", "other projects work normally");
  assert.equal(run({ prompt: "/aiw-status", cwd: repo }).trim(), "", "slash commands are left alone");
});

// ---------------------------------------------------------------- several tickets at once + the PDF on request

test("several tickets in one message: each gets its own task, plan approval and replies; PDF of a finished ticket on request", async () => {
  issues.push(
    { ...issues[0], id: "id-PAY-11", key: "PAY-11", title: "Export refunds as CSV", url: "https://acme.atlassian.net/browse/PAY-11" },
    { ...issues[0], id: "id-PAY-12", key: "PAY-12", title: "Show the refund reason", url: "https://acme.atlassian.net/browse/PAY-12" },
  );
  const started = await say("please work on PAY-11 and pay-12");
  assert.match(started, /Starting 2 of 2 tickets/);
  assert.match(started, /PAY-11\*\* – Export refunds as CSV \(new\)/);
  assert.match(started, /PAY-12\*\* – Show the refund reason \(new\)/);

  // both plan side by side and each asks for its own plan approval
  const a = await drive("PAY-11", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"]);
  const b = await drive("PAY-12", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"]);
  assert.equal(a.state, "AWAITING_APPROVAL", a.error ?? "");
  assert.equal(b.state, "AWAITING_APPROVAL", b.error ?? "");
  assert.equal(latestApproval(a.id)?.action, "implement_plan");
  assert.equal(latestApproval(b.id)?.action, "implement_plan");
  assert.ok(sent.some((m) => /Plan ready – PAY-11/.test(m)) && sent.some((m) => /Plan ready – PAY-12/.test(m)), "one plan message per ticket");

  // a reply with the ticket goes to that ticket only
  assert.match(await say("PAY-12 1"), /Approved the plan for PAY-12/);
  const b2 = await waitFor(() => { void tick(); const t = getTask("PAY-12"); return t && t.state === "AWAITING_APPROVAL" && latestApproval(t.id)?.action === "create_pr" ? t : undefined; }, 60_000, 100);
  assert.ok(b2, "PAY-12 built and waits for its PR approval");
  assert.equal(latestApproval(getTask("PAY-11")!.id)?.action, "implement_plan", "PAY-11 still waits for its own plan approval");

  // the PDF: a finished ticket gets it on request, an unfinished one says when it comes
  assert.match(await say("send the report of PAY-11"), /PAY-11 has no PR yet/);
  assert.match(await say("give me the pdf of PAY-7"), /Making the report for \*\*PAY-7\*\*|PAY-7 – report/);
  await waitFor(() => sent.some((m) => /PAY-7 – report( \(PDF\))? ready/.test(m)), 30_000);
});
