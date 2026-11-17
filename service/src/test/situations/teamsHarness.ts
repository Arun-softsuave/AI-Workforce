import { makeRepo, testHome } from "../helpers.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, setMeta } from "../../core/db.js";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../../core/config.js";
import { clients, connect } from "../../connectors/registry.js";
import type { WorkItem } from "../../connectors/types.js";
import { setTeamsPersonalClient, type TeamsPersonalClient, type TpMessage } from "../../connectors/teamsPersonal.js";
import { setRunner, MockRunner, type AgentRequest } from "../../agents/runner.js";
import { setChatTurn } from "../../chat/assistant.js";
import { pollTeamsCommands } from "../../intake/teamsCommands.js";
import { createTask, getTask, transition, mergeData, type Task } from "../../engine/tasks.js";
import { requestApproval } from "../../approvals/approvals.js";
import { setCloner } from "../../conductor/tools.js";

/**
 * Shared set-up for the Teams situation tests (§12c): a fake Teams bot chat, a fake Jira with a few tickets, two
 * projects (one not cloned yet), and a scripted Conductor. Every message goes through the real poller.
 * Import this module FIRST in a situation test (it imports ../helpers.js, which isolates the test's data).
 */
export const OWNER = "8:live:owner";

export const tickets: Record<string, { title: string; assignee?: string }> = {
  "KAN-45": { title: "Send invite email when a teammate is added" },
  "KAN-47": { title: "Refund limit for support agents" },
  "KAN-48": { title: "Export orders as CSV" },
  "KAN-60": { title: "Billing page shows wrong currency", assignee: "Priya" },
  "KAN-61": { title: "Login rate limit" },
  "KAN-63": { title: "Avatar upload size limit" },
  "KAN-64": { title: "Avatar crop on upload" },
  "ADM-3": { title: "Admin audit log" },
};
const issue = (key: string): WorkItem | undefined => tickets[key] ? {
  provider: "jira", id: `id-${key}`, key, projectKey: key.split("-")[0], title: tickets[key].title,
  description: `${tickets[key].title}. Acceptance: works as described and is covered by tests.`, status: "To Do", statusCategory: "new",
  assignee: tickets[key].assignee ? "acc-other" : "me", assigneeName: tickets[key].assignee ?? "Me", priority: "Medium", labels: [],
  url: `https://acme.atlassian.net/browse/${key}`, updated: new Date().toISOString(), comments: [],
} as WorkItem : undefined;
clients.jira = () => ({ site: "https://acme.atlassian.net", myself: async () => ({ accountId: "me", displayName: "Me" }), search: async () => [], getIssue: async (k: string) => issue(k), addComment: async () => {} }) as any;
clients.github = () => ({ user: async () => ({ login: "me" }) }) as any;

export const sent: string[] = [];
export const chat: TpMessage[] = [];
let msgNo = 0;
const fakeTeams: TeamsPersonalClient = {
  hasSavedLogin: () => true, startLogin: async () => ({ userCode: "X", verificationUrl: "https://x", expiresAt: Date.now() + 1e6 }),
  waitForLogin: async () => {}, logout: () => {}, whoAmI: async () => ({ mri: "8:live:bot", region: "emea" }),
  listChats: async () => [], findChats: async () => [],
  getChatMembers: async () => [{ mri: "8:live:bot", name: "Bot", isMe: true }, { mri: OWNER, name: "Owner", isMe: false }],
  sendMessage: async (_c, text) => { sent.push(text); return { sent: true, id: `bot-${++msgNo}` }; },
  getMessages: async (_c, since) => chat.filter((m) => !since || m.time > since),
};
setTeamsPersonalClient(fakeTeams);

export const { repo } = makeRepo("shop");
export const adminPath = path.join(testHome, "clones", "admin");
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Owner", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "claude-login" },          // a real-model setting: the Conductor (scripted below) reads messages
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "teams-personal", fallback: ["inbox"] },
  team: { me: { github: "me" }, members: [{ name: "Eric", github: "eric-dev" }, { name: "Sam", github: "sam-k" }] },
});
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" }, local: { path: repo },
  roles: ["backend-developer"], autonomy: "prepare", reviewers: { from: "list", logins: ["eric-dev", "sam-k"] } }));
upsertProject(normaliseProject({ id: "admin", jira: { site: "acme.atlassian.net", keys: ["ADM"] }, github: { repo: "acme/admin", baseBranch: "main" }, local: { path: adminPath },
  roles: ["backend-developer"], autonomy: "prepare" }));
setMeta("tickets.index", JSON.stringify(Object.entries(tickets).map(([key, v]) => ({ key, title: v.title, status: "To Do", mine: !v.assignee, assignee: v.assignee, updated: new Date().toISOString() }))));
export const cloned: string[] = [];
setCloner((url, dir) => { cloned.push(url); fs.mkdirSync(dir, { recursive: true }); });
setChatTurn(async () => ({ ok: true, text: "Refunds go through src/services/refund.ts.", tokens: 100, costUsd: 0 }));

// ---------------------------------------------------------------- the scripted Conductor

export type Script = { calls: { tool: string; args: Record<string, unknown> }[]; reply?: string; needResults?: boolean };
const scripts = new Map<string, Script | ((req: AgentRequest) => Script)>();
export const conductorCalls: AgentRequest[] = [];
export const ownerMessage = (req: AgentRequest) => /OWNER MESSAGE:\n([\s\S]*)$/.exec(req.prompt)?.[1]?.trim() ?? "";
setRunner(new MockRunner({
  conductor: (req) => {
    conductorCalls.push(req);
    const s = scripts.get(ownerMessage(req));
    if (!s) throw new Error(`no script for: ${ownerMessage(req)}`);
    const r = typeof s === "function" ? s(req) : s;
    return { reply: r.reply ?? "", calls: r.calls, needResults: r.needResults ?? false };
  },
}));
export const script = (msg: string, s: Script | ((req: AgentRequest) => Script)) => scripts.set(msg, s);

let clock = Date.now();
export async function connectBot(): Promise<void> {
  assert.ok(await connect("teams-personal", { mode: "bot", chatId: OWNER, chatTitle: "Owner", ownerId: OWNER, ownerName: "Owner" }));
  setMeta("teams_personal.cursor", new Date(clock).toISOString());
}
export async function say(text: string): Promise<string> {
  clock += 1000;
  chat.push({ id: `m${clock}`, conversationId: OWNER, from: "Owner", fromId: OWNER, isMine: false, time: new Date(clock).toISOString(), text });
  const before = sent.length;
  await pollTeamsCommands(true);
  return sent.slice(before).join("\n---\n");
}
/** A message that must stay on the fast path (no model call). */
export async function sayFast(text: string): Promise<string> {
  const n = conductorCalls.length;
  const r = await say(text);
  assert.equal(conductorCalls.length, n, `"${text}" must stay on the fast path`);
  return r;
}
/** A message the Conductor reads (its answer is scripted). */
export async function sayModel(text: string, s: Script | ((req: AgentRequest) => Script)): Promise<string> {
  script(text, s);
  const n = conductorCalls.length;
  const r = await say(text);
  assert.ok(conductorCalls.length > n, `"${text}" must reach the Conductor`);
  return r;
}

/** A ticket item in a given state (plan approval waiting, a question waiting, running, done with a PR). */
export function item(key: string, state: "RUNNING" | "NEEDS_INFO" | "AWAITING_APPROVAL" | "DONE", data: Record<string, any> = {}): Task {
  let t = createTask({ projectId: "shop", source: "jira", sourceId: `id-${key}`, sourceRef: key, title: `Ticket ${key}`, kind: "assigned", state: "TRIAGED",
    data: { ticket: { key, title: `Ticket ${key}`, description: "Some work" }, ...data } });
  db().prepare("UPDATE tasks SET playbook='dev-feature', size='M' WHERE id=?").run(t.id);
  t = transition(t.id, "QUEUED", "test");
  t = transition(t.id, "RUNNING", "test");
  if (state === "NEEDS_INFO") { t = transition(t.id, "NEEDS_INFO", "test"); mergeData(t.id, { questions: [{ question: data.q ?? "Which option?", options: data.options ?? ["A", "B"] }], needInfoFrom: "step" }); }
  if (state === "AWAITING_APPROVAL") { requestApproval(t.id, "implement_plan", {}); t = transition(t.id, "AWAITING_APPROVAL", "test"); }
  if (state === "DONE") { t = transition(t.id, "AWAITING_APPROVAL", "t"); t = transition(t.id, "PUBLISHING", "t"); t = transition(t.id, "DONE", "t"); }
  return getTask(t.id)!;
}
export const stateOf = (ref: string) => getTask(ref)?.state;
