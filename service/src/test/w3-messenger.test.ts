import "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, setMeta } from "../core/db.js";
import { DEFAULT_SETTINGS, saveSettings, type Settings } from "../core/config.js";
import { notify, setSenders, flushNotifications, inbox } from "../notify/router.js";
import { maybeSendCheckup } from "../notify/checkup.js";
import type { Notice } from "../notify/channels.js";
import { shortBody, isRoutine, TEMPLATES } from "../messenger/templates.js";
import { parseDetailsCommand, detailsReply, detailsFor } from "../messenger/details.js";
import { buildDigest } from "../messenger/digest.js";
import { _setMessengerClock } from "../messenger/clock.js";
import { addEdge } from "../kernel/items.js";
import { createDoc } from "../knowledge/designDoc.js";

const sent: Notice[] = [];
const desk: Notice[] = [];
setSenders({
  "teams-personal": { send: async (n) => { sent.push(n); return undefined; } },
  desktop: { send: async (n) => { desk.push(n); return undefined; } },
});

let clock = Date.parse("2026-11-17T10:00:00Z");
_setMessengerClock(() => clock);
const tick = (ms: number) => { clock += ms; };

function settings(patch: Partial<Settings["notifications"]> & { messenger?: boolean } = {}): void {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.models = { ...s.models, provider: "mock" } as any;
  s.notifications = { ...s.notifications, primary: "teams-personal", exclusive: true, quietHours: "off", ...patch } as any;
  saveSettings(s);
}

let seq = 0;
function task(ref: string, state: string, extra: { updated?: string; owner?: string; kind?: string; level?: string; priority?: number } = {}): string {
  const id = `t_${ref.replace(/\W/g, "_")}_${++seq}`;
  const at = extra.updated ?? new Date(clock).toISOString();
  db().prepare("INSERT INTO tasks (id, project_id, source, source_ref, title, kind, state, priority, owner, level, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "shop", "jira", ref, `Work on ${ref}`, extra.kind ?? "ticket", state, extra.priority ?? 3, extra.owner ?? "me", extra.level ?? "ticket", at, at);
  return id;
}

const LONG_PLAN = [
  "Add refunds above a limit that need a manager's approval.",
  "**✅ Done when**\n• refunds above 1000 wait for a manager\n• the manager sees a list\n• the user is told",
  "**🛠️ Steps**\n1. Add the limit setting\n2. Check the limit in refund()\n3. Add the approval queue\n4. Add the manager list endpoint\n5. Notify the user",
  "**📄 Files**\n• src/services/refund.ts\n• src/services/approvals.ts\n• src/app.ts\n• src/config.ts",
  "**🧪 Tests**\n• refund under limit\n• refund over limit\n• manager approves",
  "**⚠️ Risks**\n• existing refunds in flight",
  "💰 so far $0.12",
].join("\n\n");
const nonBlank = (s: string) => s.split("\n").filter((l) => l.trim()).length;

beforeEach(() => {
  sent.length = 0; desk.length = 0;
  db().exec("DELETE FROM notifications; DELETE FROM tasks; DELETE FROM edges; DELETE FROM connections;");
  settings();
});

test("migration: notifications has item_id, merge_key and details_ref", () => {
  const cols = (db().prepare("PRAGMA table_info(notifications)").all() as any[]).map((c) => c.name);
  for (const c of ["item_id", "merge_key", "details_ref"]) assert.ok(cols.includes(c), c);
});

test("templates: every kind sent today has a template; short bodies stay as they are", () => {
  for (const k of ["info", "picked_up", "approval_needed", "needs_info", "pr_created", "failed", "paused", "stale", "burst", "connector_problem", "pr_comment", "pr_changes_requested", "report_ready", "checkup"]) assert.ok(TEMPLATES[k], k);
  assert.deepEqual(shortBody("one\ntwo", "KAN-1"), { body: "one\ntwo", shortened: false });
  const r = shortBody(LONG_PLAN, "KAN-45");
  assert.ok(r.shortened);
  assert.ok(nonBlank(r.body) <= 10, r.body);
  assert.match(r.body, /Reply "details KAN-45" for the full text\.$/);
  assert.match(r.body, /Steps\*\*\n1\. Add the limit setting/, "the steps stay a list");
  assert.match(r.body, /\*\*📄 Files\*\* \(4\): src\/services\/refund\.ts; /, "other lists become one line");
  assert.ok(isRoutine({ kind: "info", taskRef: "KAN-1", title: "x", body: "" }));
  assert.ok(!isRoutine({ kind: "info", taskRef: "KAN-1", title: "x", body: "", approvalId: "a" }), "never a message with choices");
  assert.ok(!isRoutine({ kind: "info", title: "x", body: "" }), "needs an item");
});

test("a long plan goes out as ≤ 10 lines; \"details KAN-45\" returns the full text; the inbox keeps it whole", async () => {
  const id = task("KAN-45", "AWAITING_APPROVAL");
  const r = await notify({ kind: "approval_needed", taskId: id, taskRef: "KAN-45", approvalId: "ap1", approvalAction: "implement_plan", dedupeKey: "ap1", title: "📋 Plan ready – KAN-45", body: LONG_PLAN });
  assert.deepEqual(r.delivered, ["teams-personal"]);
  const msg = sent.at(-1)!;
  assert.ok(nonBlank(msg.body) <= 10);
  assert.equal(msg.approvalId, "ap1", "the choices still come with it");
  assert.equal(parseDetailsCommand("details kan-45"), "KAN-45");
  assert.equal(parseDetailsCommand("show details for KAN-45?"), "KAN-45");
  assert.equal(parseDetailsCommand("details please"), undefined);
  assert.equal(parseDetailsCommand("details KAN-45 and merge it"), undefined, "only the plain request");
  assert.equal(detailsFor("KAN-45")?.text, LONG_PLAN);
  assert.match(detailsReply("details KAN-45")!, /Add the manager list endpoint/);
  assert.equal(inbox().find((i) => i.task_id === id)?.notice.body, LONG_PLAN);
  const row = db().prepare("SELECT item_id, details_ref FROM notifications WHERE channel='teams-personal'").get() as any;
  assert.deepEqual({ ...row }, { item_id: id, details_ref: "KAN-45" });
  assert.match(detailsReply("details KAN-999")!, /no details for KAN-999/);
});

test("a plan with a design document: the document summary, and details returns the document", async () => {
  const id = task("KAN-46", "AWAITING_APPROVAL");
  createDoc(id, { title: "Refund limit", sections: { "Problem and goal": "Large refunds need a manager.", "Approach": "Check a limit in refund()." } });
  await notify({ kind: "approval_needed", taskId: id, taskRef: "KAN-46", approvalId: "ap2", approvalAction: "implement_plan", dedupeKey: "ap2", title: "📋 Plan ready – KAN-46", body: LONG_PLAN });
  const msg = sent.at(-1)!;
  assert.match(msg.body, /Goal: Large refunds need a manager\./);
  assert.match(msg.body, /details KAN-46/);
  assert.ok(nonBlank(msg.body) <= 10);
  assert.match(detailsFor("KAN-46")!.text, /Check a limit in refund\(\)/);
});

test("questions are never shortened", async () => {
  const id = task("KAN-47", "NEEDS_INFO");
  await notify({ kind: "needs_info", taskId: id, taskRef: "KAN-47", dedupeKey: "q1", title: "🤔 KAN-47 · questions", body: LONG_PLAN });
  assert.equal(sent.at(-1)!.body, LONG_PLAN);
});

test("routine updates for one item within 60 s go out as one message; others are not held", async () => {
  const id = task("KAN-50", "RUNNING");
  await notify({ kind: "info", taskId: id, taskRef: "KAN-50", dedupeKey: "1", title: "KAN-50: tests pass", body: "" });
  tick(5_000);
  const second = await notify({ kind: "info", taskId: id, taskRef: "KAN-50", dedupeKey: "2", title: "KAN-50: review done", body: "2 small notes" });
  assert.deepEqual(second.held, ["teams-personal"], "kept for merging");
  tick(5_000);
  await notify({ kind: "picked_up", taskId: id, taskRef: "KAN-50", dedupeKey: "3", title: "KAN-50: lint fixed", body: "" });
  await notify({ kind: "info", taskRef: "KAN-51", dedupeKey: "x", title: "KAN-51: started", body: "" });
  await notify({ kind: "approval_needed", taskId: id, taskRef: "KAN-50", approvalId: "ap3", dedupeKey: "ap3", title: "KAN-50 ready – raise the PR?", body: "b" });
  assert.deepEqual(sent.map((n) => n.title), ["KAN-50: tests pass", "KAN-51: started", "KAN-50 ready – raise the PR?"], "other items and approvals go at once");
  assert.equal(await flushNotifications(), 0, "window not over yet");
  tick(55_000);
  assert.equal(await flushNotifications(), 1);
  const merged = sent.at(-1)!;
  assert.equal(merged.title, "KAN-50: 2 updates");
  assert.match(merged.body, /• KAN-50: review done – 2 small notes\n• KAN-50: lint fixed/);
  assert.equal(await flushNotifications(), 0, "sent once");
  assert.equal((db().prepare("SELECT COUNT(*) n FROM notifications WHERE status='merged'").get() as any).n, 2);
  // after the window a new update goes at once again
  tick(61_000);
  const later = await notify({ kind: "info", taskId: id, taskRef: "KAN-50", dedupeKey: "4", title: "KAN-50: done", body: "" });
  assert.deepEqual(later.delivered, ["teams-personal"]);
});

test("one update waiting to merge is sent as itself", async () => {
  await notify({ kind: "info", taskRef: "KAN-52", dedupeKey: "1", title: "KAN-52: a", body: "" });
  await notify({ kind: "info", taskRef: "KAN-52", dedupeKey: "2", title: "KAN-52: b", body: "" });
  tick(61_000);
  await flushNotifications();
  assert.deepEqual(sent.map((n) => n.title), ["KAN-52: a", "KAN-52: b"]);
});

test("quiet hours: non-urgent messages wait; one catch-up after, then each question on its own; urgent goes at once", async () => {
  settings({ quietHours: "22:00-07:00" });
  const night = new Date(2026, 10, 17, 23, 0);
  await notify({ kind: "info", taskRef: "KAN-60", dedupeKey: "1", title: "KAN-60: tests pass", body: "" }, night);
  await notify({ kind: "info", taskRef: "KAN-60", dedupeKey: "2", title: "KAN-60: PR raised", body: "" }, night);
  await notify({ kind: "pr_created", taskRef: "KAN-61", dedupeKey: "3", title: "🚀 KAN-61 PR #12 raised", body: "" }, night);
  await notify({ kind: "approval_needed", taskRef: "KAN-62", approvalId: "ap9", dedupeKey: "ap9", title: "KAN-62 ready – raise the PR?", body: "b" }, night);
  const urgent = await notify({ kind: "connector_problem", title: "Jira login expired", body: "reconnect", urgent: true }, night);
  assert.deepEqual(urgent.delivered, ["teams-personal"]);
  assert.equal(sent.length, 1);
  assert.equal(await flushNotifications(new Date(2026, 10, 18, 3, 0)), 0, "still quiet");
  await flushNotifications(new Date(2026, 10, 18, 8, 0));
  const after = sent.slice(1);
  assert.equal(after.length, 2, "one catch-up + the approval");
  assert.equal(after[0].kind, "catch_up");
  assert.equal(after[0].title, "While you were away: 3 updates");
  assert.match(after[0].body, /• KAN-60: 2 updates, last: KAN-60: PR raised\n• KAN-61: 🚀 KAN-61 PR #12 raised\n1 thing needs your answer – sent next\./);
  assert.equal(after[1].approvalId, "ap9");
  assert.equal(await flushNotifications(new Date(2026, 10, 18, 8, 5)), 0, "nothing sent twice");
});

test("desktop and the messenger switched off: bodies are not changed", async () => {
  settings({ primary: "desktop" });
  await notify({ kind: "approval_needed", taskRef: "KAN-70", approvalId: "a70", dedupeKey: "a70", title: "Plan ready – KAN-70", body: LONG_PLAN });
  assert.equal(desk.at(-1)!.body, LONG_PLAN);
  settings({ messenger: false });
  await notify({ kind: "approval_needed", taskRef: "KAN-71", approvalId: "a71", dedupeKey: "a71", title: "Plan ready – KAN-71", body: LONG_PLAN });
  assert.equal(sent.at(-1)!.body, LONG_PLAN);
  await notify({ kind: "info", taskRef: "KAN-71", dedupeKey: "i1", title: "KAN-71: a", body: "" });
  await notify({ kind: "info", taskRef: "KAN-71", dedupeKey: "i2", title: "KAN-71: b", body: "" });
  assert.deepEqual(sent.slice(-2).map((n) => n.title), ["KAN-71: a", "KAN-71: b"], "no merging when off");
});

test("morning digest: ≤ 10 lines with done / in progress / waiting / blocked / merge next / connections", async () => {
  const now = new Date(clock);
  task("KAN-1", "DONE");
  task("KAN-2", "DONE", { updated: "2026-11-01T00:00:00Z" });
  task("KAN-3", "RUNNING");
  task("KAN-3@shop-web", "RUNNING", { kind: "part" });
  task("KAN-4", "AWAITING_APPROVAL");
  task("KAN-5", "BLOCKED");
  task("KAN-6", "PAUSED");
  const a = task("KAN-7", "PR_OPEN");
  const b = task("KAN-8", "PR_OPEN", { priority: 1 });
  addEdge(b, a, "depends_on");                     // KAN-8 merges after KAN-7
  task("KAN-9", "RUNNING", { owner: "teammate" });
  task("EPIC-1", "RUNNING", { level: "epic" });
  db().prepare("INSERT INTO connections (provider, status, updated_at) VALUES ('jira','connected','x'), ('github','expired','x')").run();
  const d = buildDigest(now);
  assert.ok(d.lines.length <= 10);
  assert.match(d.body, /✅ Done: 3 – KAN-8, KAN-1, KAN-7/);
  assert.match(d.body, /⚙️ In progress: 1 – KAN-3\n/);
  assert.match(d.body, /⏳ Waiting on you: 1 – KAN-4/);
  assert.match(d.body, /⚠️ Blocked: 2 – KAN-5, KAN-6/);
  assert.match(d.body, /🔀 Merge next: KAN-7, KAN-8/);
  assert.match(d.body, /🔌 Connections: github expired/);

  setMeta("checkup.date", "");
  assert.equal(await maybeSendCheckup(new Date(2026, 10, 17, 10, 30)), true);
  const msg = sent.at(-1)!;
  assert.match(msg.title, /Daily check-up – 2026-11-17/);
  assert.match(msg.body, /Connections: /);
  assert.ok(nonBlank(msg.body) <= 10);
  assert.match(detailsReply("details digest")!, /Waiting for you \(1\)/, "the full check-up is behind details");
});
