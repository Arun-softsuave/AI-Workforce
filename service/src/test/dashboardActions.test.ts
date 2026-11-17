import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../core/db.js";
import { saveSettings, DEFAULT_SETTINGS } from "../core/config.js";
import { createTask, getTask, mergeData, type Task } from "../engine/tasks.js";
import { actionsFor, runDashboardAction, alreadyDecided, dashboardMessage } from "../api/actions.js";
import { itemTimeline, needsYou } from "../api/dashboardData.js";

// The dashboard offers the same next steps as Teams, runs the same code, and tells Teams what it did.

saveSettings({ ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" } } as any);

let n = 0;
const item = (state: string, data: Record<string, any> = {}): Task => {
  const key = `KAN-${900 + ++n}`;
  return createTask({ projectId: "shop", source: "jira", sourceId: `id-${key}`, sourceRef: key, title: `Ticket ${key}`, kind: "assigned", state: state as any,
    data: { ticket: { key, title: `Ticket ${key}` }, ...data } });
};
const keys = (t: Task) => actionsFor(getTask(t.id)!).map((a) => (a.body as any).action);
const sentTitles = () => (db().prepare("SELECT title FROM notifications ORDER BY id").all() as { title: string }[]).map((r) => r.title);

test("every state gets the same next steps Teams offers", () => {
  assert.deepEqual(keys(item("AWAITING_START")), ["start", "cancel"]);
  assert.deepEqual(keys(item("PAUSED")), ["resume", "takeover", "cancel"]);
  assert.deepEqual(keys(item("STALE")), ["refresh", "takeover", "cancel"]);
  assert.deepEqual(keys(item("QUEUED")), ["pause", "cancel"]);
  assert.deepEqual(keys(item("DONE")), ["review"]);
  assert.deepEqual(keys(item("PR_OPEN")), ["rebase", "fix_ci", "resolve_comments", "takeover", "pause"]);
  const q = item("NEEDS_INFO", { questions: [{ question: "Show cancelled orders?", options: ["Hide them", "Show them"] }] });
  assert.deepEqual(keys(q), ["option", "option", "answer", "you_decide"]);
  assert.deepEqual(actionsFor(getTask(q.id)!).slice(0, 2).map((a) => a.label), ["Hide them", "Show them"]);
});

test("a PR with an open conflict puts 'Resolve conflicts myself' first, with an 'are you sure?' and the files in the drawer", () => {
  const t = item("PR_OPEN", { pr: { number: 131, repo: "o/r" }, conflict: { state: "open", num: 131, base: "dev", files: ["a.py", "b.py"], at: new Date().toISOString() } });
  const acts = actionsFor(getTask(t.id)!);
  assert.equal((acts[0].body as any).action, "resolve_conflicts");
  assert.match(acts[0].confirm!, /before anything is pushed/);
  const tl = itemTimeline(t.id)!;
  assert.deepEqual(tl.conflict?.files, ["a.py", "b.py"]);
  assert.equal(tl.conflict?.state, "open");
  assert.equal((tl.actions[0].body as any).action, "resolve_conflicts", "the drawer shows the same buttons");
});

test("Needs you uses the same buttons (stuck work: Resume, Take over, Cancel)", () => {
  const t = item("PAUSED");
  const need = needsYou().find((x) => x.taskId === t.id)!;
  assert.deepEqual(need.options.map((o) => (o.body as any)?.action), ["resume", "takeover", "cancel"]);
});

test("an action on the dashboard runs the Teams code, is remembered, and Teams gets one line", async () => {
  const t = item("QUEUED");
  const before = sentTitles().length;
  const r = await runDashboardAction({ id: t.id, action: "pause", who: "Sneha" });
  assert.equal(r.ok, true, r.message);
  assert.equal(getTask(t.id)!.state, "PAUSED");
  assert.equal(getTask(t.id)!.data.lastAction?.channel, "dashboard");
  const titles = sentTitles().slice(before);
  assert.ok(titles.some((x) => x === `✅ From the dashboard – ${t.source_ref}: you paused`), titles.join(" | "));
});

test("a late '1' in Teams for something already decided on the dashboard is answered, not acted on twice", async () => {
  const t = item("QUEUED");
  await runDashboardAction({ id: t.id, action: "pause", who: "Sneha" });
  const line = alreadyDecided("1", t.source_ref!);
  assert.match(line!, /already paused on the dashboard/);
  assert.equal(alreadyDecided("resume KAN-1 please", t.source_ref!), undefined, "a real sentence goes the normal way");
  // still waiting for you, or decided in Teams: nothing special
  const w = item("NEEDS_INFO", { questions: [{ question: "?", options: ["a"] }] });
  mergeData(w.id, { lastAction: { what: "answered", channel: "dashboard", at: new Date().toISOString() } });
  assert.equal(alreadyDecided("1", w.source_ref!), undefined);
});

test("Cancel and Resume from the dashboard behave like the Teams commands", async () => {
  const t = item("AWAITING_START");
  const c = await runDashboardAction({ id: t.id, action: "cancel", who: "Sneha" });
  assert.equal(c.ok, true, c.message);
  assert.equal(getTask(t.id)!.state, "CANCELLED");
  const p = item("QUEUED");
  await runDashboardAction({ id: p.id, action: "pause", who: "Sneha" });
  const r = await runDashboardAction({ id: p.id, action: "resume", who: "Sneha" });
  assert.equal(r.ok, true, r.message);
  assert.notEqual(getTask(p.id)!.state, "PAUSED");
});

test("the message box is handled like a Teams message and kept in the conversation", async () => {
  const r = await dashboardMessage("thanks", "Sneha");
  assert.equal(r.ok, true);
  assert.ok(r.reply.length > 0);
  const rows = db().prepare("SELECT direction, kind, text FROM chat_log WHERE kind='dashboard' ORDER BY id").all() as any[];
  assert.deepEqual(rows.slice(-2).map((x) => [x.direction, x.text === "thanks" ? "thanks" : "reply"]), [["in", "thanks"], ["out", "reply"]]);
  assert.ok(sentTitles().some((x) => x === "🖥️ From the dashboard: \"thanks\""), "Teams sees the exchange");
  assert.equal((await dashboardMessage("   ", "Sneha")).ok, false);
});

test("KAN-52 case: a two-repo lead the old engine ended at DONE shows PR buttons for each repository's open PR", async () => {
  const lead = item("DONE");
  db().prepare("UPDATE tasks SET playbook='dev-lead' WHERE id=?").run(lead.id);
  const mkPart = (repo: string, state: string, data: Record<string, any>) => {
    const p = createTask({ projectId: repo, source: "jira", sourceId: `${lead.id}-${repo}`, sourceRef: `${lead.source_ref}@${repo}`, title: "part", kind: "part", state: state as any, data: { leadId: lead.id, ...data } });
    return p;
  };
  const back = mkPart("nue-backend", "PR_OPEN", { pr: { number: 131, repo: "o/back" }, conflict: { state: "open", files: ["a.py"], base: "dev", at: new Date().toISOString() } });
  const front = mkPart("nue-frontend", "DONE", { pr: { number: 90, repo: "o/front" } });
  mkPart("nue-merged", "DONE", { pr: { number: 7, repo: "o/m", merged: true } });
  const acts = actionsFor(getTask(lead.id)!);
  const labels = acts.map((a) => a.label);
  assert.equal(labels[0], "Resolve conflicts myself – nue-backend PR #131");
  assert.ok(labels.includes("Bring the base branch in – nue-frontend PR #90"));
  assert.ok(!labels.some((l) => /nue-merged/.test(l)), "a merged PR gets no buttons");
  assert.ok(!labels.includes("Review this work"));
  // the buttons act on the repository's part, not on the lead
  assert.equal((acts.find((a) => a.label === "Bring the base branch in – nue-frontend PR #90")!.body as any).id, front.id);
  assert.equal((acts[0].body as any).id, back.id);
});
