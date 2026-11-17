import "../helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../../core/db.js";
import { saveSettings, loadSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, getProject } from "../../core/config.js";
import { MockRunner } from "../../agents/runner.js";
import { buildStepCtx, runWithAskDesk } from "../../engine/stepRun.js";
import { stackBaseOf, type StepCtx, type StepResult } from "../../engine/steps.js";
import { getTask } from "../../engine/tasks.js";
import { parseScopeTarget, textDependencies, planWaves, previewScope, prBodyWithMergeOrder } from "../../engine/steps/scope.js";
import { queueQuestion } from "../../knowledge/askDesk.js";
import { wantsAudit } from "../../conductor/tools.js";

/**
 * Wave 4 scenario rows that are decided in code (no model): B8 / L2 / F8 (dependencies, same files, stacking),
 * B9 / B10 / B12 (what "all my tickets", an epic and a sprint mean), B15 / B18 (not built yet: an honest question, never a
 * blind start), C3 (all of an item's questions in ONE message, recommended first), H4–H7 routing of a review request
 * to the audit. The full flows of these rows run in w4-scopes, w4-auditadopt, w4-knowledge and w4-integration.
 */

delete process.env.ANTHROPIC_API_KEY;
saveSettings({ ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "inbox", fallback: [], quietHours: "off" } });
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" },
  local: { path: process.cwd() }, roles: ["backend-developer"] }));
const runner = new MockRunner();
const now = new Date().toISOString();
const insert = (id: string, ref: string, data: Record<string, unknown> = {}, level = "ticket", parent: string | null = null) =>
  db().prepare("INSERT INTO tasks (id, project_id, source, source_ref, title, kind, state, level, parent_id, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "shop", "jira", ref, ref, level === "ticket" ? "assigned" : "scope", "RUNNING", level, parent, JSON.stringify(data), now, now);

test("B8: KAN-47 uses KAN-45's API → KAN-47 waits for KAN-45 (wave 2); independent tickets run in wave 1", () => {
  const issues = [
    { key: "KAN-45", title: "Refund API", description: "Add POST /refunds." },
    { key: "KAN-46", title: "Copy change", description: "Fix the footer text." },
    { key: "KAN-47", title: "Refund button", description: "Call the refund API from KAN-45." },
  ];
  const edges = textDependencies(issues);
  assert.deepEqual(edges.map((e) => `${e.from}>${e.to}:${e.type}`), ["KAN-47>KAN-45:depends_on"]);
  assert.deepEqual(planWaves(issues.map((i) => i.key), edges).waves, [["KAN-45", "KAN-46"], ["KAN-47"]]);
});

test("L2: two tickets that name each other change the same area – an overlap, never a dependency loop", () => {
  const edges = textDependencies([
    { key: "KAN-60", title: "Orders table", description: "Shares the table component with KAN-61." },
    { key: "KAN-61", title: "Orders filter", description: "Changes the same table as KAN-60." },
  ]);
  assert.deepEqual(edges.map((e) => e.type), ["same_area"]);
  assert.equal(planWaves(["KAN-60", "KAN-61"], edges).cycle, undefined, "no cycle: same_area does not order them");
});

test("F8: a child that depends on an unmerged PR branches from the parent's branch and its PR carries the merge order", async () => {
  insert("f8", "KAN-47", { stackBase: { branch: "feat/KAN-45/refund-api", parentId: "x" } });
  assert.equal(await stackBaseOf(getTask("f8")!), "feat/KAN-45/refund-api");
  insert("f8b", "KAN-48");
  assert.equal(await stackBaseOf(getTask("f8b")!), undefined, "a plain ticket uses the base branch");
  const body = prBodyWithMergeOrder("## Summary\nThe change.", "Merge 2 of 2 – after #140 (KAN-45).");
  assert.match(body, /## Summary\nThe change\./);
  assert.match(body, /Merge 2 of 2 – after #140 \(KAN-45\)\./);
  assert.equal(prBodyWithMergeOrder(body, "Merge 2 of 2 – after #140 (KAN-45)."), body, "written once (idempotent)");
});

test("B9 / B10 / B12: 'all my tickets', an epic key and a sprint are scopes (the sprint and 'all my tickets' always ask once)", () => {
  assert.equal(parseScopeTarget("do all my tickets")?.kind, "all_mine");
  assert.equal(parseScopeTarget("build the KAN-40 epic")?.kind, "epic");
  const s = parseScopeTarget("build sprint 14, no approvals");
  assert.equal(s?.kind, "sprint");
  assert.equal(s?.target, "14");
  assert.equal(s?.noApprovals, true);
  assert.equal(parseScopeTarget("do KAN-45, KAN-47 and KAN-48")?.kind, "batch");
});

test("B15 / B18 (not built yet): a PRD link or a vague 'rebuild the dashboard' is never started blind – one plain question", async () => {
  for (const text of ["rebuild the dashboard", "build this https://www.notion.so/acme/Seller-onboarding-PRD-1234"]) {
    const r = await previewScope(text, "you");
    assert.equal(r.ok, false);
    assert.match(r.reply, /Which sprint, epic or tickets\?/);
    assert.equal(r.itemId, undefined, "nothing was created");
  }
});

test("C3: every question of an item goes out in ONE message – the step's questions plus the ones agents queued, recommended first", async () => {
  insert("c3", "KAN-70");
  queueQuestion("c3", { question: "Which currency should partial refunds use?", options: ["Original payment currency", "Account currency"], recommended: "Original payment currency" });
  const step = async (): Promise<StepResult> => ({ status: "need_info", questions: [{ question: "May a refund exceed 1000 without a manager?", options: ["No", "Yes"] }] });
  const ctx: StepCtx = buildStepCtx({ task: getTask("c3")!, project: getProject("shop")!, settings: loadSettings(), runner });
  const r = await runWithAskDesk(step, ctx);
  assert.equal(r.status, "need_info");
  const qs = (r as any).questions as { question: string; options: string[] }[];
  assert.deepEqual(qs.map((q) => q.question), ["May a refund exceed 1000 without a manager?", "Which currency should partial refunds use?"]);
  assert.equal(qs[1].options[0], "Original payment currency", "the recommended option comes first");
  // the queue is emptied: asking again does not repeat the queued question
  const again = await runWithAskDesk(step, buildStepCtx({ task: getTask("c3")!, project: getProject("shop")!, settings: loadSettings(), runner }));
  assert.equal((again as any).questions.length, 1);
});

test("H4–H7: review requests about old work, a branch, a commit range, an epic or a feature QA go to the audit; a PR review does not", () => {
  insert("h4", "KAN-12");
  db().prepare("UPDATE tasks SET state='DONE' WHERE id='h4'").run();
  assert.ok(wantsAudit("review KAN-12", "KAN-12"), "H4: a merged ticket");
  assert.ok(wantsAudit("review branch feat/KAN-80/limits"), "H5: a branch");
  assert.ok(wantsAudit("review a1b2c3d..e4f5a6b please"), "H5: a commit range");
  assert.ok(wantsAudit("is the KAN-40 epic complete?"), "H6: an epic");
  assert.ok(wantsAudit("QA the refunds feature KAN-12"), "H7: a feature QA");
  assert.ok(!wantsAudit("review PR 140", undefined), "an open PR is a normal review");
});
