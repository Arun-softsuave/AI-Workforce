import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../core/db.js";
import { TransitionError } from "../engine/tasks.js";
import {
  createItem, getItem, childrenOf, treeOf, setItemState, updateItem, addEdge, removeEdge, edgesOf, openDependencies,
  areaConflicts, areasOverlap, pathsOverlap, mergeOrder, mergeOrderOf,
} from "../kernel/items.js";
import { emit, pendingEvents, markHandled, eventsFor, ignoreBacklog } from "../kernel/events.js";

let n = 0;
const mk = (o: Partial<Parameters<typeof createItem>[0]> = {}) =>
  createItem({ projectId: "p1", source: "jira", kind: "ticket", sourceId: `s${++n}`, sourceRef: `KAN-${n}`, title: `T${n}`, ...o });

test("items: create with levels, tree, children, root ids, dedupe", () => {
  const epic = mk({ level: "epic" });
  assert.equal(epic.level, "epic");
  assert.equal(epic.root_id, epic.id);
  assert.equal(epic.parent_id, null);
  assert.deepEqual(epic.areas, []);
  assert.equal(epic.owner, "me");

  const a = mk({ parentId: epic.id, areas: ["src/api/**"] });
  const b = mk({ parentId: epic.id });
  const a1 = mk({ parentId: a.id, level: "part", due: "2026-12-01" });
  assert.equal(a.root_id, epic.id);
  assert.equal(a1.root_id, epic.id);
  assert.equal(a1.parent_id, a.id);
  assert.equal(a1.due, "2026-12-01");
  assert.deepEqual(a.areas, ["src/api/**"]);

  assert.deepEqual(childrenOf(epic.id).map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(treeOf(epic.id).map((x) => x.id), [epic.id, a.id, a1.id, b.id]);
  assert.equal(getItem(a.source_ref!)!.id, a.id);   // by source_ref
  assert.equal(getItem("nope"), undefined);

  // same sourceId + kind while active -> the same item back
  const again = createItem({ projectId: "p1", source: "jira", kind: "ticket", sourceId: a.source_id!, sourceRef: "dup" });
  assert.equal(again.id, a.id);

  // cancelled children are hidden unless asked; treeOf keeps them
  setItemState(b.id, "CANCELLED", "test");
  assert.deepEqual(childrenOf(epic.id).map((x) => x.id), [a.id]);
  assert.equal(childrenOf(epic.id, { includeCancelled: true }).length, 2);
  assert.equal(treeOf(epic.id).length, 4);

  assert.throws(() => mk({ level: "galaxy" as any }), /Unknown item level/);
  assert.throws(() => mk({ parentId: "t_missing" }), /not found/);
});

test("items: state changes go through the legal transitions", () => {
  const it = mk();
  assert.equal(setItemState(it.id, "QUEUED").state, "QUEUED");
  assert.equal(setItemState(it.id, "RUNNING").state, "RUNNING");
  assert.equal(setItemState(it.id, "PR_OPEN").state, "PR_OPEN");
  assert.throws(() => setItemState(it.id, "RUNNING"), TransitionError);   // PR_OPEN -> RUNNING is illegal
  assert.equal(setItemState(it.id, "MERGED").state, "MERGED");
});

test("items: updateItem moves a subtree and re-roots it; refuses a parent loop", () => {
  const r1 = mk({ level: "batch" }), r2 = mk({ level: "batch" });
  const x = mk({ parentId: r1.id }), y = mk({ parentId: x.id, level: "part" });
  const moved = updateItem(x.id, { parent_id: r2.id, areas: ["lib"], priority: 1, owner: "teammate" });
  assert.equal(moved.root_id, r2.id);
  assert.deepEqual(moved.areas, ["lib"]);
  assert.equal(moved.priority, 1);
  assert.equal(moved.owner, "teammate");
  assert.equal(getItem(y.id)!.root_id, r2.id);
  assert.throws(() => updateItem(x.id, { parent_id: y.id }), /cannot be its parent/);
});

test("edges: add is idempotent, remove, list by direction, open dependencies", () => {
  const a = mk(), b = mk(), c = mk();
  addEdge(a.id, b.id, "depends_on");
  addEdge(a.id, b.id, "depends_on");
  addEdge(a.id, c.id, "same_area");
  addEdge(c.id, a.id, "stacks_on");
  assert.equal(edgesOf(a.id, "out").length, 2);
  assert.equal(edgesOf(a.id, "in").length, 1);
  assert.equal(edgesOf(a.id).length, 3);
  assert.deepEqual(openDependencies(a.id).map((x) => x.id), [b.id]);
  setItemState(b.id, "QUEUED"); setItemState(b.id, "RUNNING"); setItemState(b.id, "DONE");
  assert.deepEqual(openDependencies(a.id), []);
  removeEdge(a.id, c.id, "same_area");
  removeEdge(a.id, c.id, "same_area");
  assert.equal(edgesOf(a.id).length, 2);
  assert.throws(() => addEdge(a.id, a.id, "depends_on"), /itself/);
  assert.throws(() => addEdge(a.id, b.id, "blocks" as any), /Unknown edge type/);
});

test("areas: glob overlap rules", () => {
  assert.ok(pathsOverlap("src/api", "src/api/users.ts"));            // folder contains file
  assert.ok(pathsOverlap("src/api/users.ts", "src/api/users.ts"));
  assert.ok(!pathsOverlap("src/api", "src/apix/a.ts"));               // segment-aware
  assert.ok(pathsOverlap("src/api/**", "src/api/v1/users.ts"));
  assert.ok(pathsOverlap("src/**/*.ts", "src/web/app.ts"));
  assert.ok(!pathsOverlap("src/*.ts", "src/web/app.ts"));             // * does not cross folders
  assert.ok(!pathsOverlap("src/api/**", "src/web/**"));
  assert.ok(pathsOverlap("src/**", "src/web/**"));
  assert.ok(pathsOverlap("src", "src/**/*.css"));                     // folder vs glob inside it
  assert.ok(pathsOverlap("src/api", "src/a*/x.ts"));                  // the glob can reach into the folder
  assert.ok(!pathsOverlap("src/web", "src/a*/x.ts"));
  assert.ok(pathsOverlap(".\\src\\api\\x.ts", "src/api/**"));         // Windows separators
  assert.ok(pathsOverlap("src/{api,web}/**", "src/web/a.ts"));
  assert.ok(!pathsOverlap("src/{api,web}/*.ts", "src/lib/a.ts"));
  assert.ok(!areasOverlap([], ["src/**"]));                           // unknown areas never lock
  assert.ok(areasOverlap(["docs/**", "src/a.ts"], ["src/**"]));
});

test("areas: conflicts among active items only, excluding self", () => {
  db().prepare("UPDATE tasks SET areas='[]'").run();                  // isolate from earlier tests
  const a = mk({ areas: ["svc/pay/**"] });
  const b = mk({ areas: ["svc/pay/refund.ts"] });
  const c = mk({ areas: ["svc/web/**"] });
  const d = mk({ areas: ["svc/pay/**"] });
  setItemState(d.id, "CANCELLED");
  assert.deepEqual(areaConflicts(["svc/pay/**"], a.id).map((x) => x.id), [b.id]);
  assert.deepEqual(areaConflicts(["svc/**"]).map((x) => x.id).sort(), [a.id, b.id, c.id].sort());
  assert.deepEqual(areaConflicts([]), []);
});

test("merge order: topological, stable ties, priority first; cycle is reported", () => {
  const root = mk({ level: "batch" });
  const a = mk({ parentId: root.id, sourceRef: "A" });
  const b = mk({ parentId: root.id, sourceRef: "B" });
  const c = mk({ parentId: root.id, sourceRef: "C" });
  const d = mk({ parentId: root.id, sourceRef: "D", priority: 1 });
  // no edges: priority, then creation order
  assert.deepEqual(mergeOrder([a.id, b.id, c.id, d.id]).order, [d.id, a.id, b.id, c.id]);
  addEdge(a.id, c.id, "depends_on");      // A after C
  addEdge(d.id, b.id, "stacks_on");       // D after B
  assert.deepEqual(mergeOrder([a.id, b.id, c.id, d.id]), { order: [b.id, d.id, c.id, a.id] });   // D (priority 1) right after B
  assert.deepEqual(mergeOrderOf(root.id), [b.id, d.id, c.id, a.id]);   // container root left out
  // stable: same input -> same output
  assert.deepEqual(mergeOrder([a.id, b.id, c.id, d.id]).order, mergeOrder([a.id, b.id, c.id, d.id]).order);
  // edges to items outside the list are ignored
  assert.deepEqual(mergeOrder([a.id, b.id]).order, [a.id, b.id]);

  // cycle C -> A -> C (C now depends on A); B and D still order
  addEdge(c.id, a.id, "depends_on");
  const r = mergeOrder([a.id, b.id, c.id, d.id]);
  assert.deepEqual(r.order, [b.id, d.id]);
  assert.ok(r.cycle);
  assert.equal(r.cycle![0], r.cycle![r.cycle!.length - 1]);
  assert.deepEqual(new Set(r.cycle), new Set([a.id, c.id]));
  assert.throws(() => mergeOrderOf(root.id), (e: Error) => /Merge order has a cycle: (A -> C -> A|C -> A -> C)/.test(e.message));
});

test("merge order: a longer cycle lists every member", () => {
  const x = mk({ sourceRef: "X" }), y = mk({ sourceRef: "Y" }), z = mk({ sourceRef: "Z" }), w = mk({ sourceRef: "W" });
  addEdge(x.id, y.id, "depends_on"); addEdge(y.id, z.id, "stacks_on"); addEdge(z.id, x.id, "depends_on");
  addEdge(w.id, x.id, "depends_on");     // W waits behind the cycle but is not in it
  const r = mergeOrder([w.id, x.id, y.id, z.id]);
  assert.deepEqual(r.order, []);
  assert.equal(r.cycle!.length, 4);
  assert.deepEqual(new Set(r.cycle), new Set([x.id, y.id, z.id]));
});

test("events: emit dedupes on idem_key, pending, markHandled, per-item log", () => {
  db().prepare("DELETE FROM events").run();
  const it = mk();
  const e1 = emit({ type: "ci_failed", idemKey: "ci:1:failed", itemId: it.id, payload: { run: 1 } });
  assert.ok(e1);
  assert.equal(e1!.project_id, "p1");               // filled from the item
  assert.equal(e1!.source_ref, it.source_ref);
  assert.deepEqual(e1!.payload, { run: 1 });
  assert.equal(e1!.handled_by, null);
  assert.equal(emit({ type: "ci_failed", idemKey: "ci:1:failed", itemId: it.id }), undefined);   // duplicate

  // intake's own INSERT OR IGNORE on the same table is also deduped against emit
  const r = db().prepare("INSERT OR IGNORE INTO events (id, idem_key, type, project_id, source_ref, payload, received_at) VALUES (?,?,?,?,?,?,?)")
    .run("e_x", "ci:1:failed", "ci_failed", "p1", "x", "{}", new Date().toISOString());
  assert.equal(r.changes, 0);

  const e2 = emit({ type: "comment_added", idemKey: "c:9", itemId: it.id });
  const e3 = emit({ type: "connector_down", idemKey: "h:jira:1", projectId: "p1" });
  assert.deepEqual(pendingEvents().map((e) => e.id), [e1!.id, e2!.id, e3!.id]);
  assert.equal(pendingEvents(1).length, 1);

  markHandled(e1!.id, "j_123");
  markHandled(e3!.id, "ignored");
  assert.deepEqual(pendingEvents().map((e) => e.id), [e2!.id]);
  const log = eventsFor(it.id);
  assert.deepEqual(new Set(log.map((e) => e.id)), new Set([e1!.id, e2!.id]));
  const h = log.find((e) => e.id === e1!.id)!;
  assert.equal(h.handled_by, "j_123");
  assert.ok(h.processed_at);

  assert.equal(ignoreBacklog(), 1);
  assert.deepEqual(pendingEvents(), []);
  assert.throws(() => emit({ type: "x", idemKey: "" }), /idemKey/);
});
