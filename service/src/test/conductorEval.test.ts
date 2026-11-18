import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonical, matches, judge, fixturePath, type EvalCase } from "../bench/conductorEval.js";

// `aiw bench conductor`: the checker must be right before its numbers mean anything.

test("tool calls get the evaluator's names; refs are normalised (kan 52 → KAN-52, parts kept)", () => {
  assert.deepEqual(canonical("control", { action: "resume", ref: "kan-52@Nue-Backend" }), { name: "control:resume", ref: "KAN-52@nue-backend" });
  assert.deepEqual(canonical("decide", { ref: "KAN-54" }), { name: "decide:approve", ref: "KAN-54" });
  assert.deepEqual(canonical("fix_pr", { mode: "rebase", ref: "KAN-52" }), { name: "fix_pr:rebase", ref: "KAN-52" });
  assert.deepEqual(canonical("start", { refs: ["kan 40", "KAN-52"] }), { name: "start", ref: "KAN-40" });
});

test("a ref without @ matches the ticket's repo parts; with @ only that part", () => {
  assert.equal(matches("status KAN-52", { name: "status", ref: "KAN-52@nue-backend" }), true);
  assert.equal(matches("control:resume KAN-52@nue-backend", { name: "control:resume", ref: "KAN-52@nue-frontend" }), false);
  assert.equal(matches("prefs", { name: "prefs" }), true);
  assert.equal(matches("status KAN-40", { name: "status" }), false);
});

test("the verdict: first action, required calls, and 'only answer' cases", () => {
  const k = (o: Partial<EvalCase>): EvalCase => ({ id: "x", text: "x", ...o });
  assert.equal(judge(k({ expect: ["decide:approve KAN-54"] }), [{ name: "decide:approve", ref: "KAN-54" }]).pass, true);
  assert.equal(judge(k({ expect: ["decide:approve KAN-54"] }), [{ name: "decide:reject", ref: "KAN-54" }]).pass, false);
  assert.equal(judge(k({ expect: ["status KAN-40"] }), [{ name: "find" }, { name: "status", ref: "KAN-40" }]).pass, true, "lookups before the answer are fine");
  assert.equal(judge(k({ expect: ["control:undo", "start"], all: ["start KAN-76"] }), [{ name: "control:undo" }, { name: "start", ref: "KAN-76" }]).pass, true);
  assert.equal(judge(k({ noAction: true }), [{ name: "status" }, { name: "lookup" }]).pass, true);
  assert.equal(judge(k({ noAction: true }), [{ name: "control:cancel", ref: "KAN-1" }]).pass, false);
});

test("the evaluation set is complete: every case has a right answer, ids are unique, nothing secret is in it", () => {
  const f = JSON.parse(fs.readFileSync(fixturePath(), "utf8"));
  assert.ok(f.cases.length >= 50);
  assert.equal(new Set(f.cases.map((c: EvalCase) => c.id)).size, f.cases.length);
  for (const c of f.cases as EvalCase[]) assert.ok(c.noAction || c.expect?.length, `${c.id} has no answer`);
  assert.doesNotMatch(JSON.stringify(f), /NueMarketplaceInc|@[a-z0-9.-]+\.(com|org)|ghp_|sk-/i);
});
