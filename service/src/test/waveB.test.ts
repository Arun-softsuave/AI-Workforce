import "./helpers.js";
import { makeRepo, sh } from "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, setMeta, delMeta } from "../core/db.js";
import { saveSettings, loadSettings, upsertProject, normaliseProject, DEFAULT_SETTINGS, type Settings, type ProjectConfig } from "../core/config.js";
import { createTask, getTask, type Task } from "../engine/tasks.js";
import { slotPlan, LIGHT_JOBS } from "../kernel/slots.js";
import { decide } from "../kernel/scheduler.js";
import { DEFAULT_LIMITS, type Job } from "../kernel/types.js";
import { parseUntil, untilLabel } from "../core/until.js";
import { areasFromFiles, overlappingItem, setAreas } from "../engine/overlap.js";
import "../engine/steps.js";
import { STEPS, makeAgentCaller, type StepCtx } from "../engine/steps.js";
import { recordDecision, findDecision } from "../knowledge/decisions.js";
import { adaptTicket, ADAPT } from "../engine/adapt.js";
import { runTool, toolPrefs } from "../conductor/tools.js";
import { ruleIntent } from "../intake/teamsIntent.js";
import { requestApproval } from "../approvals/approvals.js";
import { pushedByPlugin } from "../git/git.js";
import { lastReviewedSha, ownFindingsFor } from "../engine/prReview.js";
import type { Runner } from "../agents/runner.js";

// Wave B (1.0.7): dynamic slots, overlaps without trigger words, pause until a time, after-PR and understanding gaps.

const S = (patch: (s: Settings) => void = () => {}): Settings => {
  const s = { ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" } } as Settings;
  patch(s); return s;
};
saveSettings(S());
let n = 0;
const item = (o: { state?: string; project?: string; ref?: string; data?: Record<string, any> } = {}): Task => {
  const ref = o.ref ?? `KAN-${800 + ++n}`;
  return createTask({ projectId: o.project ?? "shop", source: "jira", sourceId: `id-${ref}-${n}`, sourceRef: ref, title: ref, kind: "assigned", state: (o.state ?? "QUEUED") as any, data: { ticket: { key: ref, title: ref }, ...(o.data ?? {}) } });
};

test("dynamic slots: cap from settings, halved after a rate limit, lowered by a busy computer – with the reason", () => {
  delMeta("model.rateLimitedAt");
  const big = { freeGb: 12, cpus: 12 };
  assert.deepEqual([slotPlan(S(), Date.now(), big).slots, slotPlan(S(), Date.now(), big).cap], [8, 8]);
  assert.equal(slotPlan(S((s) => { s.limits.maxParallel = 4; }), Date.now(), big).slots, 4);
  setMeta("model.rateLimitedAt", String(Date.now() - 60_000));
  const rl = slotPlan(S(), Date.now(), big);
  assert.equal(rl.slots, 4);
  assert.match(rl.limitedBy!, /rate limit/);
  assert.equal(slotPlan(S(), Date.now() + 11 * 60_000, big).slots, 8, "back to full after 10 minutes");
  delMeta("model.rateLimitedAt");
  const small = slotPlan(S(), Date.now(), { freeGb: 1.3, cpus: 12 });
  assert.equal(small.slots, 3);
  assert.match(small.limitedBy!, /this computer \(1\.3 GB free memory/);
  assert.equal(slotPlan(S(), Date.now(), { freeGb: 0.1, cpus: 1 }).slots, 2, "never fewer than 2 because of the computer");
});

test("git-only jobs (rebase, close-out) never take a slot", () => {
  const items = Object.fromEntries(["A", "B", "C", "D"].map((id) => [id, { id, state: "PR_OPEN", project_id: id === "D" ? "other" : "r", priority: 3, areas: [], data: {} } as any]));
  let j = 0;
  const job = (item: string, type: string, state = "queued"): Job => ({ id: `j${++j}`, item_id: item, type, recipe: type, state, step_index: 0, attempts: 0, priority: 3, data: {}, created_at: `2026-11-18T10:00:0${j}Z`, updated_at: "" } as any);
  const running = job("A", "ci_fix", "running");
  const d = decide({ ...DEFAULT_LIMITS, slots: 1 }, { items, queued: [job("B", "rebase"), job("C", "close"), job("D", "comment_fix")], active: [running], edges: [] } as any);
  assert.deepEqual(d.start.map((x) => x.type).sort(), ["close", "rebase"]);
  assert.ok(d.waiting.some((w) => /all slots busy \(1 of 1\)/.test(w.reason)));
  assert.ok(LIGHT_JOBS.includes("rebase") && !LIGHT_JOBS.includes("build"));
});

test("'use 4 slots' changes the cap (1–16) and can be undone", () => {
  const r = toolPrefs({ key: "slots", value: "4" } as any, { who: "Sneha", original: "use 4 slots" } as any);
  assert.match(r.reply, /at most 4 AI jobs at once/);
  assert.equal(loadSettings().limits.maxParallel, 4);
  assert.equal(toolPrefs({ key: "slots", value: "40" } as any, { who: "Sneha", original: "" } as any).ok, false);
  saveSettings(S());
});

test("J7: 'until Monday', 'for 2 hours', 'until 14:30', a date – real times; nonsense is not guessed", () => {
  const now = new Date(2026, 10, 18, 10, 0);   // Wednesday 18 Nov, 10:00 local
  assert.equal(new Date(parseUntil("Monday", now)!).getDay(), 1);
  assert.equal(new Date(parseUntil("until monday", now)!).getHours(), 9);
  assert.equal(new Date(parseUntil("for 2 hours", now)!).getTime() - now.getTime(), 2 * 3_600_000);
  assert.equal(new Date(parseUntil("14:30", now)!).getHours(), 14);
  assert.equal(new Date(parseUntil("tomorrow", now)!).getDate(), 19);
  assert.equal(new Date(parseUntil("next week", now)!).getDay(), 1);
  assert.equal(new Date(parseUntil("2026-11-24", now)!).getDate(), 24);
  assert.equal(parseUntil("whenever the moon is full", now), undefined);
  assert.match(untilLabel(parseUntil("Monday", now)!, now), /^Monday 09:00$/);
});

test("J7: pausing a batch pauses its tickets; resuming it brings them back", async () => {
  const batch = createTask({ projectId: "shop", source: "scope", sourceId: "b-1", sourceRef: "BATCH-77", title: "batch", kind: "scope", state: "WAITING_CHILDREN" as any, data: {} });
  db().prepare("UPDATE tasks SET level='batch' WHERE id=?").run(batch.id);
  const kids = [item({ state: "QUEUED" }), item({ state: "QUEUED" })];
  for (const k of kids) db().prepare("UPDATE tasks SET parent_id=?, root_id=? WHERE id=?").run(batch.id, batch.id, k.id);
  const p = await runTool({ tool: "control", args: { action: "pause", ref: "BATCH-77" } } as any, { who: "Sneha", original: "pause the batch" } as any);
  assert.match(p.reply, /Paused BATCH-77 and its 2 tickets/);
  for (const k of kids) assert.equal(getTask(k.id)!.state, "PAUSED");
  const r = await runTool({ tool: "control", args: { action: "resume", ref: "BATCH-77" } } as any, { who: "Sneha", original: "resume the batch" } as any);
  assert.match(r.reply, /Resumed/);
  for (const k of kids) assert.notEqual(getTask(k.id)!.state, "PAUSED");
});

test("L2 / B8: a ticket that changes the same files as one being built waits for it – said once, with the reason", async () => {
  const { repo } = makeRepo("ovl");
  upsertProject(normaliseProject({ id: "ovl", local: { path: repo }, roles: ["fullstack-developer"] } as any));
  assert.deepEqual(areasFromFiles(["src/payments/refund.ts", "[ovl] src/payments/x.ts", "README.md", "n/a"]), ["src/payments/**", "README.md"]);
  const first = item({ project: "ovl", state: "RUNNING" });
  setAreas(first.id, ["src/payments/**"]);
  const second = item({ project: "ovl", state: "RUNNING", data: { plan: { files: ["src/payments/limits.ts"] } } });
  assert.equal(overlappingItem(getTask(second.id)! as any, ["src/payments/**"])?.ref, first.source_ref);
  assert.equal(overlappingItem(getTask(second.id)! as any, ["src/web/**"]), undefined);
  const base = sh(repo, "rev-parse", "HEAD");
  const ctx = { task: { ...getTask(second.id)!, worktree: repo, data: { ...getTask(second.id)!.data, baseSha: base } }, project: { id: "ovl", local: { path: repo } }, settings: S(),
    runner: undefined, params: {}, usage: { tokensIn: 0, tokensOut: 0, cost: 0, agents: [] }, save: (p: any) => { ctx.task = { ...ctx.task, data: { ...ctx.task.data, ...p } }; return ctx.task; } } as any as StepCtx;
  ctx.agent = makeAgentCaller(() => ctx);
  const r = await STEPS.implement_test(ctx);
  assert.equal(r.status, "later");
  assert.match((r as any).reason, new RegExp(`waiting for ${first.source_ref} – it is changing the same files`));
});

test("O4: a re-worded question that was answered before is not asked again", () => {
  const t = item();
  recordDecision({ scope: "item", scopeId: t.id, question: "Should cancelled orders be shown in the orders list?", answer: "Hide them", source: "user" });
  assert.equal(findDecision(t.id, "Show cancelled orders in the list?")?.answer, "Hide them");
  assert.equal(findDecision(t.id, "Which currency should refunds use?"), undefined);
});

test("C5: when the ticket, PRD and design disagree, the analyst's claims become ONE question with the recommended source first", async () => {
  const t = item();
  const runner: Runner = { async run(r) {
    const data = r.agent === "analyst" ? { requirements: ["x"], acceptanceCriteria: ["y"], openQuestions: [],
      sourceClaims: [{ topic: "Max refund", source: "ticket", value: "500" }, { topic: "Max refund", source: "prd", value: "1000" }, { topic: "Button colour", source: "figma", value: "blue" }] } : {};
    return { ok: true, text: "{}", data, tokensIn: 1, tokensOut: 1, costUsd: 0, model: "m" } as any;
  } };
  const ctx = { task: getTask(t.id)!, project: { id: "shop", local: { path: process.cwd() } }, settings: S(), runner, params: {}, usage: { tokensIn: 0, tokensOut: 0, cost: 0, agents: [] },
    save: (p: any) => { ctx.task = { ...ctx.task, data: { ...ctx.task.data, ...p } }; return ctx.task; } } as any as StepCtx;
  ctx.agent = makeAgentCaller(() => ctx);
  const r: any = await STEPS.analyse(ctx);
  assert.equal(r.status, "need_info");
  assert.equal(r.questions.length, 1);
  assert.match(r.questions[0].question, /Max refund: the ticket says 500, the PRD says 1000\. Which is right\? \(I'd follow the ticket/);
  assert.deepEqual(r.questions[0].options.slice(0, 2), ["500 (ticket)", "1000 (prd)"]);
});

test("C7: 'adapt KAN-x' – before the PR it re-plans from the new ticket text; after the PR it updates the PR", async () => {
  assert.equal(ADAPT.exec("adapt KAN-45")?.[1], "KAN-45");
  const b = item({ state: "RUNNING", data: { pendingTicket: { key: "x", title: "x", description: "new text\nsend an email" }, ticket: { key: "x", title: "x", description: "new text" } } });
  db().prepare("UPDATE tasks SET playbook='dev-feature', step_index=8 WHERE id=?").run(b.id);
  assert.match(await adaptTicket(b.source_ref!, "Sneha"), /Re-planning .* with the changed ticket/);
  assert.equal(getTask(b.id)!.state, "QUEUED");
  assert.equal(getTask(b.id)!.data.ticket.description, "new text\nsend an email");
  assert.equal(getTask(b.id)!.step_index, 1, "back to reading the ticket and code (context_pack)");
  const a = item({ state: "PR_OPEN", data: { pr: { number: 9 }, pendingTicket: { title: "y", description: "b" }, ticket: { title: "y", description: "a" } } });
  assert.match(await adaptTicket(a.source_ref!, "Sneha"), /Adapting .*'s PR to the changed ticket/);
  const ev = db().prepare("SELECT payload FROM events WHERE type='user_command' AND item_id=? ORDER BY received_at DESC LIMIT 1").get(a.id) as any;
  assert.equal(JSON.parse(ev.payload).command, "adapt");
  assert.match(await adaptTicket(item({ state: "RUNNING" }).source_ref!, "Sneha"), /no change from Jira/);
});

test("D4: 'yes but skip the email part' is an approval WITH a change (the Conductor decides), never a reject", () => {
  const t = item({ state: "AWAITING_APPROVAL" });
  requestApproval(t.id, "implement_plan", {});
  assert.equal(ruleIntent("yes but skip the email part"), undefined);
  assert.equal((ruleIntent("yes") as any)?.intent?.intent, "approve");
  db().prepare("UPDATE tasks SET state='CANCELLED' WHERE id=?").run(t.id);
  db().prepare("UPDATE approvals SET state='expired' WHERE task_id=?").run(t.id);
});

test("I2: a commit the plugin pushed is known; any other head on our branch is someone's own push", () => {
  const { repo, origin } = makeRepo("pushed");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "a");
  const mod = require_git();
  mod.git(repo, ["push", "--quiet", origin, "HEAD:refs/heads/main"]);
  assert.equal(pushedByPlugin(sh(repo, "rev-parse", "HEAD")), true);
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "b"); sh(repo, "push", "-q", "origin", "HEAD:main");   // pushed by hand
  assert.equal(pushedByPlugin(sh(repo, "rev-parse", "HEAD")), false);
});
import * as gitMod from "../git/git.js";
function require_git() { return gitMod; }

test("H3 / H8: the last reviewed head of a PR and the findings of a review of your own PR are found", () => {
  const r1 = createTask({ projectId: "shop", source: "teams", sourceId: "rv-1", sourceRef: "PR-31@shop", title: "r", kind: "pr_review", state: "DONE" as any, data: { review: { repo: "acme/shop", num: 31 }, reviewSha: "abc123" } });
  assert.equal(lastReviewedSha("acme/shop", 31), "abc123");
  assert.equal(lastReviewedSha("acme/shop", 31, r1.id), undefined);
  createTask({ projectId: "shop", source: "teams", sourceId: "rv-2", sourceRef: "PR-32@shop", title: "r", kind: "pr_review", state: "DONE" as any,
    data: { review: { repo: "acme/shop", num: 32 }, ownFindings: ["src/a.ts:3 – Missing check: amount can be negative"], ownFindingsAt: new Date().toISOString() } });
  assert.deepEqual(ownFindingsFor("ACME/shop", 32), ["src/a.ts:3 – Missing check: amount can be negative"]);
  assert.equal(ownFindingsFor("acme/shop", 33), undefined);
});
