import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, setMeta, delMeta } from "../core/db.js";
import { DEFAULT_SETTINGS } from "../core/config.js";
import { newId, nowIso } from "../core/util.js";
import type { State } from "../engine/tasks.js";
import {
  activeJob, clearMailbox, enqueue, enqueueJob, getJob, mailboxOf, nextForItem, onJobEnd, startJob,
} from "../kernel/mailbox.js";
import {
  areasOverlap, decide, limitsFrom, loadSnapshot, pickRunnable,
  type SchedItem, type SchedulerSnapshot,
} from "../kernel/scheduler.js";
import { DEFAULT_LIMITS, type Edge, type Job, type JobType, type KernelEvent, type Reaction } from "../kernel/types.js";

// ------------------------------------------------------------------ helpers

function addItem(ref: string, o: { state?: State; project?: string; areas?: string[]; priority?: number; due?: string } = {}): string {
  const id = newId("t");
  const now = nowIso();
  db().prepare(`INSERT INTO tasks (id, project_id, source, source_ref, title, kind, state, priority, areas, due, data, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, o.project ?? "repo-a", "jira", ref, ref, "ticket", o.state ?? "QUEUED", o.priority ?? 3,
    JSON.stringify(o.areas ?? []), o.due ?? null, "{}", now, now);
  return id;
}

let evN = 0;
function ev(type: string, payload: Record<string, any> = {}): KernelEvent {
  evN++;
  return { id: `ev_${evN}`, type, idem_key: `k${evN}`, item_id: null, project_id: null, source_ref: null, payload, handled_by: null,
    received_at: new Date(Date.UTC(2026, 10, 17, 10, 0, evN)).toISOString(), processed_at: null };
}

const ciFix: Reaction = { on: "ci_failed", job: "ci_fix", recipe: "ci-fix" };

let jn = 0;
function job(itemId: string, o: Partial<Job> = {}): Job {
  jn++;
  return { id: `j${jn}`, item_id: itemId, type: "build", recipe: "dev", state: "queued", step_index: 0, attempts: 0, priority: 3,
    trigger_event: null, data: {}, error: null, agent: null, activity: null, progress: null, activity_at: null,
    created_at: `2026-11-17T10:00:${String(jn % 60).padStart(2, "0")}.000Z`, updated_at: "2026-11-17T10:00:00.000Z", ...o };
}
function item(id: string, o: Partial<SchedItem> = {}): SchedItem {
  return { id, project_id: "repo-a", state: "QUEUED", priority: 3, due: null, areas: [], source_ref: id, ...o };
}
const edge = (from: string, to: string, type: Edge["type"]): Edge => ({ from, to, type, created_at: "x" });
function snap(o: Partial<Omit<SchedulerSnapshot, "items">> & { items: SchedItem[] }): SchedulerSnapshot {
  return { queued: o.queued ?? [], active: o.active ?? [], edges: o.edges ?? [], paused: o.paused, now: o.now ?? new Date("2026-11-17T12:00:00Z"),
    items: Object.fromEntries(o.items.map((i) => [i.id, i])) };
}
const L = { ...DEFAULT_LIMITS };
const ids = (js: Job[]) => js.map((j) => j.id);
const reasonOf = (d: ReturnType<typeof decide>, jobId: string) => d.waiting.find((w) => w.jobId === jobId)?.reason;

// ------------------------------------------------------------------ mailbox

test("mailbox: enqueue merges a duplicate queued job of the same type and keeps the newest trigger", () => {
  const it = addItem("KAN-1", { state: "PR_OPEN" });
  const e1 = ev("ci_failed", { check: "lint" }), e2 = ev("ci_failed", { check: "unit" });
  const a = enqueue(it, ciFix, e1)!;
  assert.equal(a.merged, false);
  assert.equal(a.job.state, "queued");
  assert.equal(a.job.trigger_event, e1.id);
  const b = enqueue(it, { ...ciFix, priority: 1 }, e2)!;
  assert.equal(b.merged, true);
  assert.equal(b.job.id, a.job.id);
  assert.equal(b.job.trigger_event, e2.id, "newest trigger kept");
  assert.equal(b.job.priority, 1, "more urgent priority kept");
  assert.deepEqual(b.job.data.events.map((e: any) => e.payload.check), ["lint", "unit"]);
  // the same event twice is folded once
  enqueue(it, ciFix, e2);
  assert.equal(getJob(a.job.id)!.data.events.length, 2);
  assert.equal(mailboxOf(it).length, 1);
  // another type is a separate job
  enqueue(it, { on: "comment_added", job: "comment_fix", recipe: "comment-fix" }, ev("comment_added"));
  assert.deepEqual(mailboxOf(it).map((m) => m.type), ["ci_fix", "comment_fix"]);
});

test("mailbox: merge modes queue and drop, and job 'none' adds nothing", () => {
  const it = addItem("KAN-2");
  assert.equal(enqueue(it, { on: "x", job: "none", recipe: "" }, ev("x")), undefined);
  enqueue(it, { on: "review_requested", job: "review", recipe: "pr-review", merge: "queue" }, ev("review_requested"));
  enqueue(it, { on: "review_requested", job: "review", recipe: "pr-review", merge: "queue" }, ev("review_requested"));
  assert.equal(mailboxOf(it).length, 2, "queue adds another job");
  const it2 = addItem("KAN-3");
  assert.ok(enqueue(it2, { on: "pr_conflict", job: "rebase", recipe: "rebase", merge: "drop" }, ev("pr_conflict")));
  assert.equal(enqueue(it2, { on: "pr_conflict", job: "rebase", recipe: "rebase", merge: "drop" }, ev("pr_conflict")), undefined);
  assert.equal(mailboxOf(it2).length, 1);
});

test("mailbox: only one active job per item; onJobEnd hands over the next by priority then age", () => {
  const it = addItem("KAN-4", { state: "PR_OPEN" });
  const low = enqueueJob({ itemId: it, type: "review", recipe: "pr-review", priority: 5 })!.job;
  const fix = enqueueJob({ itemId: it, type: "ci_fix", recipe: "ci-fix", priority: 2 })!.job;
  const qa = enqueueJob({ itemId: it, type: "qa", recipe: "qa", priority: 2 })!.job;
  assert.deepEqual(mailboxOf(it).map((m) => m.job_id), [fix.id, qa.id, low.id]);
  assert.equal(nextForItem(it)!.id, fix.id);
  assert.equal(startJob(fix.id)!.state, "running");
  assert.equal(activeJob(it)!.id, fix.id);
  assert.equal(nextForItem(it), undefined, "busy item: nothing next");
  assert.equal(startJob(qa.id), undefined, "a second active job is refused");
  assert.equal(getJob(qa.id)!.state, "queued");
  // a waiting job also occupies the item
  db().prepare("UPDATE jobs SET state='waiting' WHERE id=?").run(fix.id);
  assert.equal(startJob(qa.id), undefined);
  const next = onJobEnd(fix.id, "done");
  assert.equal(getJob(fix.id)!.state, "done");
  assert.equal(next!.id, qa.id);
  assert.equal(startJob(qa.id)!.state, "running");
  assert.equal(startJob(qa.id), undefined, "not queued any more");
  assert.equal(onJobEnd(qa.id, "failed", "tests failed")!.id, low.id);
  assert.equal(getJob(qa.id)!.error, "tests failed");
});

test("mailbox: clearMailbox cancels queued jobs, and the active one only when asked", () => {
  const it = addItem("KAN-5");
  const a = enqueueJob({ itemId: it, type: "build", recipe: "dev" })!.job;
  enqueueJob({ itemId: it, type: "ci_fix", recipe: "ci-fix" });
  enqueueJob({ itemId: it, type: "qa", recipe: "qa" });
  startJob(a.id);
  assert.equal(clearMailbox(it, { reason: "ticket cancelled" }), 2);
  assert.equal(mailboxOf(it).length, 0);
  assert.equal(activeJob(it)!.id, a.id);
  assert.equal(clearMailbox(it, { includeActive: true }), 1);
  assert.equal(activeJob(it), undefined);
  assert.equal(getJob(a.id)!.state, "cancelled");
});

// ------------------------------------------------------------------ scheduler (pure)

test("scheduler: slots limit and start order (priority, item priority, due, age)", () => {
  const items = [item("A"), item("B", { priority: 1 }), item("C", { due: "2026-11-20" }), item("D", { due: "2026-11-18" }), item("E"), item("F", { project_id: "repo-b" })];
  const jA = job("A", { type: "review" }), jB = job("B", { type: "review" }), jC = job("C", { type: "review" }), jD = job("D", { type: "review" });
  const jE = job("E", { type: "review", priority: 0 }), jF = job("F", { type: "review" });
  const d = decide({ ...L, slots: 4 }, snap({ items, queued: [jA, jB, jC, jD, jE, jF] }));
  assert.deepEqual(ids(d.start), [jE.id, jB.id, jD.id, jC.id]);
  assert.equal(reasonOf(d, jA.id), "all slots busy (4 of 4)");
  assert.equal(d.held.find((h) => h.job.id === jA.id)!.reason, "slots");
  // running jobs use slots; waiting ones do not
  const run = job("X", { state: "running", type: "review" }), wait = job("Y", { state: "waiting", type: "review" });
  const d2 = decide({ ...L, slots: 2 }, snap({ items: [...items, item("X"), item("Y")], queued: [jA, jF], active: [run, wait] }));
  assert.deepEqual(ids(d2.start), [jA.id]);
  assert.equal(reasonOf(d2, jF.id), "all slots busy (2 of 2)");
});

test("scheduler: at most N build jobs per repo; reading jobs are not limited by the repo", () => {
  const items = [item("A"), item("B"), item("C"), item("D"), item("E", { project_id: "repo-b" })];
  const running = job("A", { state: "running", type: "build" });
  const jB = job("B", { type: "ci_fix" }), jC = job("C", { type: "build" }), jD = job("D", { type: "review" }), jE = job("E", { type: "build" });
  const d = decide({ ...L, buildsPerRepo: 2 }, snap({ items, queued: [jB, jC, jD, jE], active: [running] }));
  assert.deepEqual(ids(d.start).sort(), [jB.id, jD.id, jE.id].sort());
  assert.equal(reasonOf(d, jC.id), "repo limit (2 builds in repo-a)");
  assert.equal(d.held[0].reason, "repo_busy");
});

test("scheduler: area locks between items whose areas overlap (running or started in the same pass)", () => {
  assert.ok(areasOverlap(["src/pay/**"], ["src/pay/refund.ts"]));
  assert.ok(areasOverlap(["./src/pay/"], ["src/pay"]));
  assert.ok(areasOverlap(["**"], ["web/x.ts"]));
  assert.ok(!areasOverlap(["src/pay/**"], ["src/payments/**"]));
  assert.ok(!areasOverlap(["src/a.ts"], ["src/b.ts"]));
  const items = [
    item("A", { source_ref: "KAN-52", areas: ["web/screens/checkout/**"] }),
    item("B", { source_ref: "KAN-53", areas: ["web/screens/checkout/Pay.tsx"] }),
    item("C", { source_ref: "KAN-54", areas: ["api/**"] }),
    item("D", { source_ref: "KAN-55", areas: ["api/orders.ts"] }),
    item("E", { source_ref: "KAN-56", areas: ["web/screens/checkout/**"] }),
    item("F", { source_ref: "KAN-57" }), item("G", { source_ref: "KAN-58" }),
  ];
  const runA = job("A", { state: "running", type: "build" });
  const jB = job("B"), jC = job("C", { priority: 1 }), jD = job("D"), jE = job("E", { type: "review" });
  const jF = job("F"), jG = job("G");
  const d = decide({ ...L, buildsPerRepo: 9, slots: 9 }, snap({ items, queued: [jB, jC, jD, jE, jF, jG], active: [runA], edges: [edge("G", "F", "same_area")] }));
  assert.equal(reasonOf(d, jB.id), "waiting for KAN-52 (same area)");
  assert.equal(reasonOf(d, jD.id), "waiting for KAN-54 (same area)", "C started first in this pass, D waits for it");
  assert.equal(reasonOf(d, jG.id), "waiting for KAN-57 (same area)", "a same_area edge locks too");
  assert.deepEqual(ids(d.start).sort(), [jC.id, jE.id, jF.id].sort(), "a review only reads: no area lock");
  assert.equal(d.held.find((h) => h.job.id === jB.id)!.reason, "area_lock");
  // switched off
  const off = decide({ ...L, areaLocks: false, buildsPerRepo: 9, slots: 9 }, snap({ items, queued: [jB], active: [runA] }));
  assert.deepEqual(ids(off.start), [jB.id]);
});

test("scheduler: waves – an unmet depends_on edge waits; merged/done or stacked on an open PR may start", () => {
  const items = [
    item("P", { source_ref: "KAN-50", state: "RUNNING" }), item("Q", { source_ref: "KAN-51", state: "MERGED" }),
    item("R", { source_ref: "KAN-60", state: "PR_OPEN" }),
    item("A"), item("B"), item("C"), item("D"),
  ];
  const jA = job("A"), jB = job("B"), jC = job("C"), jD = job("D");
  const edges = [edge("A", "P", "depends_on"), edge("A", "Q", "depends_on"), edge("B", "Q", "depends_on"),
    edge("C", "R", "depends_on"), edge("C", "R", "stacks_on"), edge("D", "R", "depends_on")];
  const d = decide({ ...L, buildsPerRepo: 9, slots: 9 }, snap({ items, queued: [jA, jB, jC, jD], edges }));
  assert.equal(reasonOf(d, jA.id), "waiting for KAN-50 (needs it first)");
  assert.equal(reasonOf(d, jD.id), "waiting for KAN-60 (needs it first)");
  assert.deepEqual(ids(d.start).sort(), [jB.id, jC.id].sort());
  assert.equal(d.held.find((h) => h.job.id === jA.id)!.reason, "depends_on");
  const off = decide({ ...L, honourEdges: false, buildsPerRepo: 9, slots: 9 }, snap({ items, queued: [jA], edges }));
  assert.deepEqual(ids(off.start), [jA.id]);
});

test("scheduler: item states, pause, retry and one job per item give plain reasons", () => {
  const items = [
    item("A", { state: "BLOCKED", error: "Jira is disconnected" }), item("B", { state: "BLOCKED" }),
    item("C", { state: "AWAITING_START" }), item("D", { state: "NEEDS_INFO" }), item("E", { state: "PAUSED" }),
    item("F", { state: "CANCELLED" }), item("G"), item("H", { state: "PR_OPEN" }),
  ];
  const q = {
    A: job("A"), B: job("B"), C: job("C"), D: job("D"), E: job("E"), F: job("F"),
    G: job("G", { data: { retryAt: "2026-11-17T13:30:00Z" } }), H1: job("H", { type: "ci_fix" }), H2: job("H", { type: "comment_fix" }),
    Z: job("missing"),
  };
  const d = decide(L, snap({ items, queued: Object.values(q) }));
  assert.equal(reasonOf(d, q.A.id), "blocked: Jira is disconnected");
  assert.equal(reasonOf(d, q.B.id), "blocked");
  assert.equal(reasonOf(d, q.C.id), "needs your start");
  assert.equal(reasonOf(d, q.D.id), "waiting for your answer");
  assert.equal(reasonOf(d, q.E.id), "paused");
  assert.equal(reasonOf(d, q.F.id), "item is closed");
  assert.equal(reasonOf(d, q.G.id), "retrying at 13:30");
  assert.equal(reasonOf(d, q.H2.id), "waiting for its current job", "a PR_OPEN item runs one job at a time");
  assert.equal(reasonOf(d, q.Z.id), "item not found");
  assert.deepEqual(ids(d.start), [q.H1.id]);
  assert.equal(d.held.find((h) => h.job.id === q.A.id)!.reason, "connector");
  assert.equal(d.held.find((h) => h.job.id === q.G.id)!.reason, "retry_later");
  // an item with a waiting job (asked you something) holds other work, with the reason shown …
  const w = decide(L, snap({ items: [item("H", { state: "PR_OPEN" })], queued: [q.H2], active: [job("H", { state: "waiting", type: "comment_fix" })] }));
  assert.equal(reasonOf(w, q.H2.id), "waiting behind comment fix (it waits for you)");
  // … but never silently blocks keeping the PR healthy: a rebase or CI fix runs beside it (its own folder)
  const rb = job("H", { type: "rebase" });
  const w2 = decide(L, snap({ items: [item("H", { state: "PR_OPEN" })], queued: [rb, q.H2], active: [job("H", { state: "waiting", type: "comment_fix" })] }));
  assert.deepEqual(ids(w2.start), [rb.id]);
  // a RUNNING job still keeps everything else waiting, repair jobs included
  const w3 = decide(L, snap({ items: [item("H", { state: "PR_OPEN" })], queued: [job("H", { type: "ci_fix" })], active: [job("H", { state: "running", type: "comment_fix" })] }));
  assert.deepEqual(w3.start, []);
  // retry time passed → starts
  const later = decide(L, snap({ items, queued: [q.G], now: new Date("2026-11-17T14:00:00Z") }));
  assert.deepEqual(ids(later.start), [q.G.id]);
  // everything paused
  const p = decide(L, snap({ items, queued: [q.H1], paused: true }));
  assert.deepEqual(p.start, []);
  assert.equal(reasonOf(p, q.H1.id), "paused");
  assert.equal(d.held.length, d.waiting.length);
});

test("scheduler: limitsFrom reads settings.limits", () => {
  // slots are dynamic (kernel/slots.ts): never above the cap, at least 1; the repo limit comes straight from settings
  const d = limitsFrom(DEFAULT_SETTINGS);
  assert.ok(d.slots >= 1 && d.slots <= DEFAULT_SETTINGS.limits.maxParallel, String(d.slots));
  assert.deepEqual({ buildsPerRepo: d.buildsPerRepo, honourEdges: d.honourEdges, areaLocks: d.areaLocks }, { buildsPerRepo: DEFAULT_SETTINGS.limits.maxPerProject, honourEdges: true, areaLocks: true });
  const s = structuredClone(DEFAULT_SETTINGS);
  s.limits.maxParallel = 1; s.limits.maxPerProject = 1;
  assert.deepEqual({ ...limitsFrom(s) }, { slots: 1, buildsPerRepo: 1, honourEdges: true, areaLocks: true });
});

// ------------------------------------------------------------------ scheduler with the database

test("scheduler: pickRunnable loads jobs, items (areas JSON) and edges from the database", () => {
  db().exec("UPDATE jobs SET state='cancelled' WHERE state IN ('queued','running','waiting')");   // earlier tests' jobs out of the way
  const dep = addItem("KAN-70", { state: "RUNNING" });
  const a = addItem("KAN-71", { areas: ["src/pay/**"] });
  const b = addItem("KAN-72", { areas: ["src/pay/refund.ts"] });
  const c = addItem("KAN-73");
  const s = addItem("KAN-74", { state: "AWAITING_START" });
  db().prepare("INSERT INTO edges (from_id, to_id, type, created_at) VALUES (?,?,?,?)").run(c, dep, "depends_on", nowIso());
  const depJob = enqueueJob({ itemId: dep, type: "build", recipe: "dev" })!.job;
  startJob(depJob.id);
  const ja = enqueueJob({ itemId: a, type: "build", recipe: "dev", priority: 1 })!.job;
  const jb = enqueueJob({ itemId: b, type: "build", recipe: "dev" })!.job;
  const jc = enqueueJob({ itemId: c, type: "build", recipe: "dev" })!.job;
  const js = enqueueJob({ itemId: s, type: "build" as JobType, recipe: "dev" })!.job;
  const snapDb = loadSnapshot();
  assert.deepEqual(snapDb.items[a].areas, ["src/pay/**"]);
  assert.equal(snapDb.active.length, 1);
  const d = pickRunnable({ ...L, buildsPerRepo: 5 }, []);
  assert.deepEqual(ids(d.start), [ja.id]);
  assert.equal(reasonOf(d, jb.id), "waiting for KAN-71 (same area)");
  assert.equal(reasonOf(d, jc.id), "waiting for KAN-70 (needs it first)");
  assert.equal(reasonOf(d, js.id), "needs your start");
  // the repo limit counts the running build of KAN-70
  const d2 = pickRunnable({ ...L, buildsPerRepo: 1 }, []);
  assert.equal(reasonOf(d2, ja.id), "repo limit (1 build in repo-a)");
  // everything paused (aiw pause)
  setMeta("paused_until", "indefinite");
  try { assert.equal(reasonOf(pickRunnable(L, []), ja.id), "paused"); } finally { delMeta("paused_until"); }
});
