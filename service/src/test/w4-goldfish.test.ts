import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../core/db.js";
import { saveSettings, loadSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, getProject } from "../core/config.js";
import { setRunner, MockRunner, type AgentRequest } from "../agents/runner.js";
import { AGENTS } from "../agents/catalog.js";
import { createTask, getTask, mergeData, type Task } from "../engine/tasks.js";
import { buildStepCtx } from "../engine/stepRun.js";
import * as DD from "../knowledge/designDoc.js";
import {
  goldfishProfile, goldfishPrompt, namedFiles, significantQuestions, setAskDesk, applyFeedbackToDoc, applyContractChange, GOLDFISH_AGENTS, type AskDeskRequest,
} from "../knowledge/goldfish.js";
import { DOC_READINESS_STEPS } from "../engine/steps/doc_readiness.js";
import { writeUnderstanding, writePlan, writeContract, docBlock, planSummary, syncDocFromItem } from "../engine/steps/design_doc.js";

/**
 * W5a – design document and goldfish checks: size table, fresh-session input (document + named files only),
 * questions → ask-desk → answers INTO the document → a new goldfish, round limits, "fix the doc not the chat".
 */
const s = structuredClone(DEFAULT_SETTINGS);
s.models.provider = "mock";
saveSettings(s);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aiw-gf-"));
fs.mkdirSync(path.join(repo, "src", "services"), { recursive: true });
fs.writeFileSync(path.join(repo, "src", "services", "refund.ts"), "export async function refund(paymentId: string) {\n  return { id: paymentId, status: 'ok' }; // REFUND-FILE-CONTENT\n}\n");
fs.writeFileSync(path.join(repo, ".env"), "SECRET=do-not-show\n");
upsertProject(normaliseProject({ id: "gf", jira: { site: "x", keys: ["KAN"] }, github: { repo: "acme/gf", baseBranch: "main" }, local: { path: repo }, roles: ["backend-developer"] }));

// one mock runner; each test sets how the goldfish answer
let readiness: (req: AgentRequest) => any = () => ({ ready: true, understanding: "ok", questions: [] });
let critic: (req: AgentRequest) => any = () => ({ pass: true, issues: [] });
let knowledge: (req: AgentRequest) => any = () => ({ answer: "", confidence: "low", kind: "fact", evidence: [], options: [], recommended: "" });
const runner = new MockRunner({ "goldfish-readiness": (r) => readiness(r), "goldfish-critic": (r) => critic(r), knowledge: (r) => knowledge(r) });
setRunner(runner);
const gfCalls = (agent?: string) => runner.calls.filter((c) => (agent ? c.agent === agent : c.agent.startsWith("goldfish-")));

let n = 0;
function item(size: string, data: Record<string, any> = {}, playbook = "dev-feature"): Task {
  const key = `KAN-${700 + ++n}`;
  const t = createTask({ projectId: "gf", source: "jira", sourceId: `gf-${n}`, sourceRef: key, title: `Refund ${n}`, kind: "assigned", state: "RUNNING",
    data: { ticket: { key, title: `Refund ${n}`, description: "Refund a payment." }, ...data } });
  db().prepare("UPDATE tasks SET size=?, playbook=? WHERE id=?").run(size, playbook, t.id);
  return getTask(t.id)!;
}
const ctxOf = (t: Task) => buildStepCtx({ task: getTask(t.id)!, project: getProject("gf")!, settings: loadSettings(), runner, params: {} });
const PLAN = { summary: "Add a refund endpoint", steps: ["Add route", "Call refund()"], files: ["src/services/refund.ts – return the refund reason", "src/app.ts – new route"], tests: ["refund returns reason"], risks: [] };
const REQ = { requirements: ["Refund a payment from the order page"], acceptanceCriteria: ["Refund shows the reason"], openQuestions: [] };

test("size table: S readiness 1 round; M readiness 2 rounds; L and two-repo readiness + critic; scopes on the scope doc; parts none", () => {
  // quality first (18 Nov): a small change gets one readiness round
  assert.deepEqual([goldfishProfile({ size: "S" }).checks, goldfishProfile({ size: "S" }).maxRounds], [["readiness"], 1]);
  assert.deepEqual(goldfishProfile({ size: "M" }), { row: "M", checks: ["readiness"], maxRounds: 2, reason: "size M" });
  assert.deepEqual(goldfishProfile({ size: null }).checks, ["readiness"], "unknown size counts as M");
  assert.deepEqual(goldfishProfile({ size: "L" }).checks, ["readiness", "critic"]);
  assert.equal(goldfishProfile({ size: "M", data: { targets: ["be", "fe"] } }).row, "two-repo");
  assert.equal(goldfishProfile({ size: "S", playbook: "dev-lead" }).row, "two-repo", "two repos outrank size S");
  assert.equal(goldfishProfile({ level: "epic" } as any).row, "scope");
  assert.deepEqual(goldfishProfile({ level: "sprint" } as any).checks, ["readiness", "critic"]);
  assert.equal(goldfishProfile({ size: "L", kind: "part", data: { leadId: "t1" } }).row, "none");
});

test("agent definitions: medium tier, medium effort, no tools, registered in the catalog", () => {
  for (const k of ["goldfish-readiness", "goldfish-critic"]) {
    assert.equal(GOLDFISH_AGENTS[k].tier, "medium");
    assert.equal(GOLDFISH_AGENTS[k].effort, "medium");
    assert.deepEqual(GOLDFISH_AGENTS[k].tools, []);
    assert.ok(AGENTS[k], `${k} registered`);
    assert.match(GOLDFISH_AGENTS[k].system, /NO history/);
  }
});

test("S runs one readiness round (quality first) – no critic", async () => {
  const t = item("S", { requirements: REQ, plan: PLAN });
  const before = gfCalls().length;
  const r = await DOC_READINESS_STEPS.doc_readiness(ctxOf(t));
  assert.equal(r.status, "ok");
  assert.match((r as any).note, /^S: readiness/);
  assert.ok(gfCalls().length > before, "the readiness goldfish ran");
});

test("goldfish prompt holds only the document and the named files – no planner, chat or ticket history", async () => {
  setAskDesk(null);
  const t = item("M", {
    requirements: REQ, plan: PLAN,
    contextPack: "PLANNER-CONTEXT-MARKER", planIssues: [{ description: "PLANNER-CONVERSATION-MARKER" }],
    chatLog: ["CHAT-HISTORY-MARKER"], ticket: { key: "KAN-X", title: "Refund", description: "Refund", comments: [{ author: "pm", body: "TICKET-THREAD-MARKER" }] },
  });
  DD.updateSection(t.id, "How the system works today", "- `src/services/refund.ts:1` – refund() returns status only\n- `.env` – settings", "test");
  readiness = () => ({ ready: true, understanding: "Adds a refund endpoint.", questions: [] });
  const before = gfCalls().length;
  const r = await DOC_READINESS_STEPS.doc_readiness(ctxOf(t));
  assert.equal(r.status, "ok");
  const calls = gfCalls().slice(before);
  assert.equal(calls.length, 1, "one fresh goldfish for M");
  const req = calls[0];
  for (const m of ["PLANNER-CONTEXT-MARKER", "PLANNER-CONVERSATION-MARKER", "CHAT-HISTORY-MARKER", "TICKET-THREAD-MARKER", "do-not-show"]) assert.ok(!req.prompt.includes(m), `prompt must not contain ${m}`);
  assert.match(req.prompt, /Add a refund endpoint/, "the document's approach");
  assert.match(req.prompt, /REFUND-FILE-CONTENT/, "the named file's content");
  assert.match(req.prompt, /src\/app\.ts\n\(new file/, "a named file that does not exist yet");
  assert.match(req.prompt, /\.env\n\(not shown: a secrets file\)/);
  assert.match(req.prompt, /<untrusted source="design-doc:/, "the document is fenced data");
  assert.equal(req.tier, "medium");
  assert.equal(req.effort, "medium");
  assert.deepEqual(req.tools, []);
  assert.equal(req.lookup, undefined, "no lookup tools");
  // the prompt builder itself only takes the document
  assert.equal(goldfishPrompt(t.id, "readiness", [{ path: repo }]), req.prompt);
  assert.match(DD.docVersions(t.id)[0].readiness ?? "", /readiness: ready/);
});

test("M: at most 2 rounds; fact answers from ask-desk land in the document; leftovers listed for the plan message", async () => {
  const asked: AskDeskRequest[] = [];
  setAskDesk(async (q) => { asked.push(q); return { answer: `Fact ${asked.length}: reuse refund()`, confidence: asked.length === 1 ? "high" : "medium", evidence: "src/services/refund.ts:1", kind: "fact" }; });
  const t = item("M", { requirements: REQ, plan: PLAN });
  let round = 0;
  readiness = () => ({ ready: false, understanding: "x", questions: [{ question: `Which helper do I call (round ${++round})?`, kind: "fact", section: "Approach", options: [] }, { question: "Rename var?", kind: "nit", section: "Approach", options: [] }] });
  const before = gfCalls().length;
  const r = await DOC_READINESS_STEPS.doc_readiness(ctxOf(t));
  assert.equal(r.status, "ok");
  assert.equal(gfCalls().length - before, 2, "max 2 rounds");
  assert.equal(asked.length, 2, "nits never go to the ask-desk");
  const doc = DD.readDoc(t.id)!;
  assert.match(doc.sections.Decisions, /Which helper do I call \(round 1\)\? → Fact 1: reuse refund\(\) \(ask-desk, high: src\/services\/refund\.ts:1\)/);
  assert.match(doc.sections.Approach, /Fact 2: reuse refund\(\)/, "the answer is written into its section");
  const after = getTask(t.id)!;
  assert.equal(after.data.goldfish.checks.readiness.rounds, 2);
  assert.ok(after.data.assumptions.some((a: string) => /round 2/.test(a)), "a medium-confidence answer is listed as an assumption");
  setAskDesk(null);
});

test("L two-repo: missing contract field caught → owner question → answer lands in the doc → next goldfish passes", async () => {
  setAskDesk(async () => ({ answer: "Not sure", confidence: "low", kind: "product" }));
  const contract = { summary: "Refund API", items: [{ name: "GET /api/refunds/:id", kind: "endpoint", producer: "be", consumer: "fe", details: "returns { id: string, status: string }" }], errors: [], notes: [] };
  const t = item("L", { requirements: REQ, plan: PLAN, contract, targets: ["gf", "fe"] }, "dev-lead");
  const Q = "Does GET /api/refunds/:id return the refund reason the page shows?";
  readiness = (req) => /reason/.test(/## Contract\n([\s\S]*?)(?:\n## |$)/.exec(req.prompt)?.[1] ?? "")
    ? { ready: true, understanding: "Refund with reason.", questions: [] }
    : { ready: false, understanding: "Refund.", questions: [{ question: Q, kind: "product", section: "Contract", options: ["Yes, reason: string | null", "No"] }] };
  critic = () => ({ pass: true, issues: [{ severity: "minor", kind: "nit", section: "Tests", description: "naming", question: "" }] });
  const b0 = gfCalls("goldfish-readiness").length;
  const r1 = await DOC_READINESS_STEPS.doc_readiness(ctxOf(t));
  assert.equal(r1.status, "need_info");
  assert.deepEqual((r1 as any).questions, [{ question: Q, options: ["Yes, reason: string | null", "No"] }]);
  assert.deepEqual(DD.openQuestions(t.id), [Q], "the question is open in the document, not only in the chat");
  assert.match(DD.readDoc(t.id)!.sections.Contract, /returns \{ id: string, status: string \}/, "contract written from the item");

  // the owner answers (engine.answerTask stores "question → answer")
  mergeData(t.id, { clarifications: [...(getTask(t.id)!.data.clarifications ?? []), { questions: [Q], answer: `${Q} → Yes, reason: string | null`, by: "Owner", at: new Date().toISOString() }] });
  const r2 = await DOC_READINESS_STEPS.doc_readiness(ctxOf(t));
  assert.equal(r2.status, "ok", (r2 as any).note);
  const doc = DD.readDoc(t.id)!;
  assert.match(doc.sections.Contract, /Yes, reason: string \| null/, "answer written into the contract section");
  assert.match(doc.sections.Decisions, /return the refund reason the page shows\? → Yes, reason: string \| null \(Owner\)/);
  assert.deepEqual(DD.openQuestions(t.id), [], "open question removed");
  assert.equal(gfCalls("goldfish-readiness").length - b0, 2, "a NEW goldfish checked after the answer");
  const st = getTask(t.id)!.data.goldfish;
  assert.equal(st.checks.readiness.status, "ready");
  assert.equal(st.checks.critic.status, "ready", "critic ran (minor/nit issues don't block)");
  critic = () => ({ pass: true, issues: [] });
  setAskDesk(null);
});

test("real ask-desk (W11): a fact answered by the knowledge agent lands in the doc once; a product question reaches the owner", async () => {
  setAskDesk(undefined);                       // load knowledge/askDesk.js
  const t = item("M", { requirements: REQ, plan: PLAN });
  const FQ = "Which function performs the refund?";
  const PQ = "Should a refund need a manager's OK?";
  let k = 0;
  readiness = () => (k++ === 0
    ? { ready: false, understanding: "x", questions: [{ question: FQ, kind: "fact", section: "How the system works today", options: [] }, { question: PQ, kind: "product", section: "Acceptance criteria", options: ["No", "Yes, above 100"] }] }
    : { ready: true, understanding: "x", questions: [] });
  knowledge = (req) => (req.prompt.includes(FQ)
    ? { answer: "refund() in src/services/refund.ts", confidence: "high", kind: "fact", evidence: [{ source: "code", ref: "src/services/refund.ts:1" }], options: [], recommended: "" }
    : { answer: "", confidence: "low", kind: "product", evidence: [], options: [], recommended: "" });
  const kb = runner.calls.filter((c) => c.agent === "knowledge").length;
  const r1 = await DOC_READINESS_STEPS.doc_readiness(ctxOf(t));
  assert.equal(r1.status, "need_info");
  assert.deepEqual((r1 as any).questions.map((q: any) => q.question), [PQ], "only the product question reaches the owner, once");
  assert.equal(runner.calls.filter((c) => c.agent === "knowledge").length - kb, 1, "a product question skips the knowledge agent");
  let doc = DD.readDoc(t.id)!;
  assert.equal(doc.sections.Decisions.split(FQ).length - 1, 1, "the fact's decision line is written once");
  assert.match(doc.sections["How the system works today"], /refund\(\) in src\/services\/refund\.ts/);
  assert.deepEqual(DD.openQuestions(t.id), [PQ]);
  mergeData(t.id, { clarifications: [{ questions: [PQ], answer: `${PQ} → No`, by: "Owner", at: new Date().toISOString() }] });
  const r2 = await DOC_READINESS_STEPS.doc_readiness(ctxOf(t));
  assert.equal(r2.status, "ok");
  doc = DD.readDoc(t.id)!;
  assert.match(doc.sections.Decisions, /manager's OK\? → No \(Owner\)/);
  assert.deepEqual(DD.openQuestions(t.id), []);
  setAskDesk(null);
});

test("no_questions directive: product questions are assumed with the recommended option and noted", async () => {
  setAskDesk(null);
  const t = item("M", { requirements: REQ, plan: PLAN, directives: { no_questions: true } });
  let k = 0;
  readiness = () => (k++ === 0 ? { ready: false, understanding: "x", questions: [{ question: "Partial refunds allowed?", kind: "product", section: "Acceptance criteria", options: ["No – full only", "Yes"] }] } : { ready: true, understanding: "x", questions: [] });
  const r = await DOC_READINESS_STEPS.doc_readiness(ctxOf(t));
  assert.equal(r.status, "ok");
  assert.match(DD.readDoc(t.id)!.sections.Decisions, /Partial refunds allowed\? → No – full only \(assumed\) \(assumed – no questions rule\)/);
  assert.ok(getTask(t.id)!.data.assumptions.some((a: string) => /Partial refunds/.test(a)));
});

test("significantQuestions drops nits and minor critic points", () => {
  assert.equal(significantQuestions("readiness", { questions: [{ question: "a?", kind: "nit" }, { question: "b?", kind: "fact" }] }).length, 1);
  assert.equal(significantQuestions("critic", { issues: [{ severity: "minor", description: "x" }, { severity: "major", kind: "fact", description: "y", question: "y?" }] })[0].question, "y?");
  assert.deepEqual(significantQuestions("readiness", undefined), []);
});

test("fix the doc, not the chat: plan feedback and contract changes go into the document and bump its version", () => {
  const t = item("M", {});
  writeContract(t, { summary: "API", items: [{ name: "GET /a", kind: "endpoint", producer: "be", consumer: "fe", details: "{ id }" }] });
  const v0 = DD.readDoc(t.id)!.version;
  const f = applyFeedbackToDoc(t, { text: "Use the existing Stripe client", by: "Owner" });
  assert.ok(f.changed && f.version > v0);
  assert.match(DD.readDoc(t.id)!.sections.Decisions, /Change asked for the plan → Use the existing Stripe client \(Owner\)/);
  const c = applyContractChange(t, { change: "GET /a also returns reason", from: "fe" });
  assert.ok(c.changed && c.version > f.version);
  assert.match(DD.readDoc(t.id)!.sections.Contract, /\(agreed while building, asked by fe\) GET \/a also returns reason/);
  const same = applyContractChange(t, { change: "GET /a also returns reason", from: "fe" });
  assert.equal(same.changed, false, "the same change twice records nothing new");
  const full = applyContractChange(t.id, { summary: "API v2", items: [{ name: "GET /b", kind: "endpoint", producer: "be", consumer: "fe", details: "{ id, reason }" }] });
  assert.ok(full.changed);
  assert.match(DD.readDoc(t.id)!.sections.Contract, /API v2[\s\S]*GET \/b/);
});

test("design_doc writers: understand + plan fill the sections; docBlock is fenced; planSummary is the doc summary", () => {
  const t = item("M", {});
  writeUnderstanding(t, { requirements: REQ, findings: { summary: "Refund lives in services", repos: [{ repo: "gf", relevant: [{ file: "src/services/refund.ts", line: 1, symbol: "refund", why: "does the refund" }] }] } });
  const w = writePlan(t, PLAN);
  assert.ok(w.changed);
  assert.equal(writePlan(t, PLAN).changed, false, "idempotent");
  const doc = DD.readDoc(t.id)!;
  assert.match(doc.sections["Problem and goal"], /Refund a payment/);
  assert.match(doc.sections["Acceptance criteria"], /- Refund shows the reason/);
  assert.match(doc.sections["How the system works today"], /`src\/services\/refund\.ts:1` \(refund\) – does the refund/);
  assert.match(doc.sections["Files to change and why"], /- `src\/services\/refund\.ts` – return the refund reason/);
  assert.deepEqual(namedFiles(doc), ["src/services/refund.ts", "src/app.ts"]);
  assert.match(docBlock(t, "implement_test"), /^## Design document \(v\d+\)[\s\S]*<untrusted source="design-doc:/);
  assert.equal(docBlock("no-such-item", "review"), "");
  const sum = planSummary(t);
  assert.ok(sum.split("\n").length <= 10);
  assert.match(sum, /Approach: Add a refund endpoint/);
  // a lead plan with parts
  const lead = item("L", { plan: { summary: "Both sides", parts: [{ repo: "be", summary: "API", steps: ["route"], files: ["src/api.ts"], tests: ["api test"] }, { repo: "fe", summary: "UI", steps: ["button"], files: ["web/Order.tsx"], tests: [] }] } }, "dev-lead");
  const ld = syncDocFromItem(lead);
  assert.match(ld.sections["Files to change and why"], /`be:src\/api\.ts`[\s\S]*`fe:web\/Order\.tsx`/);
  assert.match(ld.sections.Approach, /\*\*fe\*\*: UI/);
});
