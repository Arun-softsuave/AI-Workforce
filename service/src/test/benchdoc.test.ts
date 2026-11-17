import { testHome } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "../core/db.js";
import {
  baselineReport, renderBaseline, recordBenchmark, benchmarkRows, compareRuns, renderComparison, benchmarkPlan, runBenchmark,
  listBenchmarkRuns, markAccepted, fmtTokens,
} from "../bench/benchmark.js";
import {
  createDoc, readDoc, updateSection, addDecision, addInput, addOpenQuestion, openQuestions, summary, sectionsFor, sectionsForRole,
  docVersions, docPath, SECTIONS, sectionName,
} from "../knowledge/designDoc.js";

// ------------------------------------------------------------------ benchmark

function seedTask(id: string, ref: string, ticketKey?: string) {
  const now = new Date().toISOString();
  db().prepare("INSERT INTO tasks (id, project_id, source, source_ref, kind, state, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "p1", "jira", ref, "ticket", "DONE", JSON.stringify(ticketKey ? { ticket: { key: ticketKey } } : {}), now, now);
}
function seedStep(taskId: string, name: string, agent: string, tin: number, tout: number, cost: number, split?: [number, number, number]) {
  db().prepare("INSERT INTO steps (task_id, run_no, idx, name, agent, status, tokens_in, tokens_out, cost_usd, fresh_in, cache_read, cache_write, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(taskId, 1, 0, name, agent, "done", tin, tout, cost, split?.[0] ?? 0, split?.[1] ?? 0, split?.[2] ?? 0, new Date().toISOString());
}

test("baseline groups by step and agent, splits only filled rows, lists costliest steps with ticket", () => {
  seedTask("t1", "KAN-40@repo-a", "KAN-40");
  seedTask("t2", "KAN-52@repo-b");
  seedStep("t1", "implement_test", "developer", 1_800_000, 20_000, 6);
  seedStep("t1", "understand", "analyst", 1_250_000, 8_000, 3, [250_000, 900_000, 100_000]);
  seedStep("t2", "implement_test", "developer", 1_000_000, 10_000, 4, [200_000, 700_000, 100_000]);
  seedStep("t2", "report", "reporter", 500_000, 3_000, 1);
  seedStep("t2", "plan", "planner", 0, 0, 0);   // nothing recorded: ignored

  const r = baselineReport();
  assert.equal(r.totals.runs, 4);
  assert.equal(r.totals.cost, 14);
  const impl = r.byStep.find((g) => g.key === "implement_test")!;
  assert.equal(impl.runs, 2);
  assert.equal(impl.tokensIn, 2_800_000);
  assert.equal(impl.splitRuns, 1);
  assert.equal(impl.freshIn, 200_000);
  assert.equal(impl.cacheRead, 700_000);
  assert.equal(impl.avgCost, 5);
  assert.equal(r.byStep[0].key, "implement_test");   // costliest first
  assert.equal(r.byAgent.find((g) => g.key === "developer")!.runs, 2);
  assert.equal(r.top.length, 4);
  assert.deepEqual(r.top.map((t) => t.ticket), ["KAN-40", "KAN-52", "KAN-40", "KAN-52"]);

  const text = renderBaseline(r);
  assert.match(text, /By step/);
  assert.match(text, /By agent/);
  assert.match(text, /Costliest steps/);
  assert.match(text, /KAN-40/);
  assert.match(text, /\$14\.00/);
  assert.match(text, /200k\/700k\/100k/);
  assert.ok(text.split("\n").every((l) => l.length < 120), "short table lines");
  assert.equal(fmtTokens(1_250_000), "1.3M");
});

test("benchmark rows are recorded, compared per ticket and in total", () => {
  recordBenchmark({ runId: "base", ticket: "KAN-40", version: "0.7.0", freshIn: 5_000_000, cacheRead: 20_000_000, tokensOut: 100_000, costUsd: 20, questions: 3, reviewRounds: 2, ciFirstGreen: false, prAcceptedUnchanged: true });
  recordBenchmark({ runId: "base", ticket: "KAN-52", version: "0.7.0", costUsd: 8, questions: 1, reviewRounds: 1, ciFirstGreen: true });
  recordBenchmark({ runId: "v08", ticket: "KAN-40", version: "0.8.0", freshIn: 1_000_000, cacheRead: 4_000_000, tokensOut: 60_000, costUsd: 5, questions: 4, reviewRounds: 1, ciFirstGreen: true, prAcceptedUnchanged: true });
  recordBenchmark({ runId: "v08", ticket: "FIX-131", version: "0.8.0", costUsd: 2 });

  const rows = benchmarkRows("base");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ciFirstGreen, 0);

  const c = compareRuns("base", "v08");
  const k40 = c.tickets.find((t) => t.ticket === "KAN-40")!;
  assert.equal(k40.delta.costUsd, -15);
  assert.equal(k40.delta.questions, 1);
  assert.equal(k40.delta.ciFirstGreen, 1);
  assert.deepEqual(k40.worse, ["questions"]);
  assert.equal(c.tickets.find((t) => t.ticket === "KAN-52")!.b, undefined);
  assert.equal(c.tickets.find((t) => t.ticket === "FIX-131")!.a, undefined);
  assert.equal(c.total.costUsd, -15);          // only tickets in both runs
  assert.deepEqual(c.worse, ["questions"]);
  const text = renderComparison(c);
  assert.match(text, /-\$15\.00/);
  assert.match(text, /FIX-131 \(new\)/);
  assert.match(text, /KAN-52 \(missing\)/);
  assert.match(text, /Worse than base on: questions/);

  assert.ok(markAccepted("v08", "FIX-131", false));
  assert.equal(benchmarkRows("v08").find((r) => r.ticket === "FIX-131")!.prAcceptedUnchanged, 0);
  assert.ok(listBenchmarkRuns().some((r) => r.runId === "v08" && r.tickets === 2));
});

test("benchmark plan states the throwaway-branch rule", () => {
  const p = benchmarkPlan(["KAN-40", "KAN-52"]);
  assert.match(p.text, /2 tickets: KAN-40, KAN-52/);
  assert.match(p.text, /thrown away/);
  assert.match(p.text, /Nothing is pushed/);
  assert.match(p.text, /Teams/);
  assert.match(p.text, /Jira/);
  assert.doesNotMatch(p.text, /\bAI\b|Claude/);
  assert.match(benchmarkPlan([]).text, /No tickets/);
});

test("runBenchmark calls the injected isolated runner and records every ticket, failures included", async () => {
  const called: string[] = [];
  const res = await runBenchmark(["S-1", "S-2", "S-3"], {
    version: "0.8.0", runId: "run-x",
    runTicketIsolated: async (t) => {
      called.push(t);
      if (t === "S-2") throw new Error("checks failed to start");
      return { freshIn: 1000, cacheRead: 5000, tokensOut: 300, costUsd: 0.4, questions: 0, reviewRounds: 1, ciFirstGreen: true };
    },
  });
  assert.deepEqual(called, ["S-1", "S-2", "S-3"]);
  assert.deepEqual(res.ok, ["S-1", "S-3"]);
  assert.equal(res.failed[0].ticket, "S-2");
  const rows = benchmarkRows("run-x");
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.ticket === "S-1")!.costUsd, 0.4);
  assert.match(rows.find((r) => r.ticket === "S-2")!.notes!, /failed: checks failed to start/);
  assert.equal(rows.find((r) => r.ticket === "S-2")!.costUsd, null);
});

// ------------------------------------------------------------------ design document

test("design doc is created with fixed sections under AIW_HOME and versioned", () => {
  const doc = createDoc("KAN-45", { title: "KAN-45: refund button", sections: { problem: "Users cannot refund a payment from the order page." } });
  assert.equal(doc.path, path.join(testHome, "items", "KAN-45", "design.md"));
  assert.ok(fs.existsSync(doc.path));
  for (const s of SECTIONS) assert.match(doc.text, new RegExp(`## ${s}`));
  assert.equal(doc.version, 1);
  assert.equal(doc.sections["Problem and goal"], "Users cannot refund a payment from the order page.");
  assert.equal(doc.sections["Approach"], "");
  assert.equal(createDoc("KAN-45").version, 1, "second create returns the existing doc");
  assert.throws(() => docPath("../evil"), /Invalid item id/);
  assert.equal(sectionName("files"), "Files to change and why");
  assert.throws(() => sectionName("nonsense"));
});

test("updateSection versions into docs with sha and open question count; no-op when unchanged", () => {
  const v = updateSection("KAN-45", "Open questions", "- Should partial refunds be allowed?\n- Who can refund?", "readiness check");
  assert.deepEqual(v, { version: 2, changed: true });
  assert.deepEqual(updateSection("KAN-45", "Open questions", "- Should partial refunds be allowed?\n- Who can refund?", "again"), { version: 2, changed: false });
  updateSection("KAN-45", "approach", "Add a refund endpoint and a button on the order page.\nReuse the existing Stripe client.", "plan");
  updateSection("KAN-45", "Files to change and why", "- `src/services/refund.ts` – add partial amount\n- `src/app.ts` – new route\n- `web/Order.tsx` – button\n- `web/api.ts` – client call", "plan");
  updateSection("KAN-45", "Tests", "- refund full amount\n- refund partial amount", "plan");
  const vers = docVersions("KAN-45");
  assert.equal(vers[0].version, 5);
  assert.equal(vers.find((x) => x.version === 2)!.openQuestions, 2);
  assert.equal(vers.find((x) => x.version === 2)!.reason, "readiness check");
  assert.match(vers[0].sha, /^[0-9a-f]{64}$/);
  const row = db().prepare("SELECT path, sha FROM docs WHERE item_id='KAN-45' ORDER BY version DESC LIMIT 1").get() as { path: string; sha: string };
  assert.equal(row.path, docPath("KAN-45"));
  assert.deepEqual(openQuestions("KAN-45"), ["Should partial refunds be allowed?", "Who can refund?"]);
});

test("addDecision logs question, answer and who; closes the matching open question; addInput appends", () => {
  addDecision("KAN-45", "Should partial refunds be allowed?", "Yes, up to the paid amount", "you");
  const doc = readDoc("KAN-45")!;
  assert.match(doc.sections["Decisions"], /- Should partial refunds be allowed\? → Yes, up to the paid amount \(you\)/);
  assert.deepEqual(openQuestions("KAN-45"), ["Who can refund?"]);
  assert.equal(docVersions("KAN-45")[0].openQuestions, 1);
  addInput("KAN-45", "Screenshot of the order page: inputs/order.png");
  addInput("KAN-45", "Use the red button style");
  assert.equal(readDoc("KAN-45")!.sections["Inputs from you"], "- Screenshot of the order page: inputs/order.png\n- Use the red button style");
  addOpenQuestion("KAN-45", "Who can refund?");   // duplicate ignored
  assert.equal(openQuestions("KAN-45").length, 1);
  addDecision("KAN-45", "Who can refund?", "Admins only", "product owner");
  assert.deepEqual(openQuestions("KAN-45"), []);
});

test("summary is at most 10 short lines and names the details command", () => {
  updateSection("KAN-45", "Contract", "POST /payments/:id/refund { amount? } -> 200 { refundId }", "contract");
  const s = summary("KAN-45");
  const lines = s.split("\n");
  assert.ok(lines.length <= 10, `got ${lines.length} lines`);
  assert.equal(lines[0], "KAN-45: refund button");
  assert.match(s, /Goal: Users cannot refund/);
  assert.match(s, /Approach: Add a refund endpoint/);
  assert.match(s, /Files \(4\): src\/services\/refund\.ts, src\/app\.ts, web\/Order\.tsx, …/);
  assert.match(s, /Tests: 2/);
  assert.match(s, /Decisions: 2/);
  assert.match(s, /Open questions: none/);
  assert.match(s, /details KAN-45/);
  assert.ok(lines.every((l) => l.length <= 160));
  assert.match(summary("NOPE-1"), /No design document/);
});

test("sectionsFor gives each agent only what it needs", () => {
  const impl = sectionsFor("KAN-45", "implement_test");
  assert.match(impl, /## Approach/);
  assert.match(impl, /## Files to change and why/);
  assert.match(impl, /## Inputs from you/);
  assert.doesNotMatch(impl, /## Alternatives rejected/);
  assert.doesNotMatch(impl, /## Open questions/);
  const rep = sectionsFor("KAN-45", "reporter");
  assert.doesNotMatch(rep, /## How the system works today/);
  assert.doesNotMatch(rep, /## Files to change/);
  assert.match(rep, /## Decisions/);
  assert.deepEqual(sectionsForRole("goldfish"), SECTIONS);
  assert.deepEqual(sectionsForRole("something-new"), SECTIONS);
  assert.equal(sectionsFor("NOPE-1", "plan"), "");
});
