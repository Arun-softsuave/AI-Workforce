import "./helpers.js";
import { makeRepo, sh } from "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, setMeta, delMeta, getMeta } from "../core/db.js";
import { saveSettings, loadSettings, upsertProject, normaliseProject, getProject, DEFAULT_SETTINGS, type Settings, type ProjectConfig } from "../core/config.js";
import { clients } from "../connectors/registry.js";
import { setSenders } from "../notify/router.js";
import { createTask, getTask, type Task } from "../engine/tasks.js";
import "../engine/steps.js";
import { STEPS, makeAgentCaller, planDetails, noDesignNote, type StepCtx } from "../engine/steps.js";
import { runTool, costSummary } from "../conductor/tools.js";
import { backingOff, noteRateLimited } from "../intake/intake.js";
import { catchUp } from "../daemon/upkeep.js";
import { mergeKeyOf } from "../messenger/merge.js";
import { buildPreview } from "../engine/steps/scope.js";
import { epicSummaryIfDone } from "../engine/steps/close.js";
import { addRepo, setRepoCloner } from "../conductor/addRepo.js";
import type { Runner } from "../agents/runner.js";

// Wave D (1.1.0): the remaining situations.

const S = (patch: (s: Settings) => void = () => {}): Settings => {
  const s = { ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" }, notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: [], quietHours: "off" } } as Settings;
  patch(s); return s;
};
saveSettings(S());
const sent: { title: string; body: string }[] = [];
setSenders({ desktop: { send: async (n: any) => { sent.push({ title: n.title, body: n.body }); return undefined; } } } as any);
const { repo: shopRepo } = makeRepo("shopD");
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" }, local: { path: shopRepo }, roles: ["backend-developer"] } as any));
upsertProject(normaliseProject({ id: "shop-web", group: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop-web", baseBranch: "main" }, local: { path: shopRepo }, roles: ["frontend-developer"] } as any));
let n = 0;
const task = (o: { project?: string; ref?: string; state?: string; kind?: string; data?: Record<string, any> } = {}): Task => {
  const ref = o.ref ?? `KAN-${600 + ++n}`;
  return createTask({ projectId: o.project ?? "shop", source: "jira", sourceId: `d-${ref}-${n}`, sourceRef: ref, title: ref, kind: (o.kind ?? "assigned") as any, state: (o.state ?? "QUEUED") as any, data: { ticket: { key: ref, title: ref }, ...(o.data ?? {}) } });
};
const ctxOf = (t: Task, runner?: Runner, settings = S()): StepCtx => {
  const ctx = { task: t, project: getProject(t.project_id)!, settings, runner: runner as any, params: {}, usage: { tokensIn: 0, tokensOut: 0, cost: 0, agents: [] },
    save: (p: any) => { ctx.task = { ...ctx.task, data: { ...ctx.task.data, ...p } }; return ctx.task; } } as any as StepCtx;
  ctx.agent = makeAgentCaller(() => ctx);
  return ctx;
};

test("C9 / C11 / C6: the plan names a migration risk, the work outside the repos, and a UI change without a design", () => {
  const t = task({ data: { plan: { summary: "Add a refund limit", steps: ["Part 1: model", "Part 2: API"], files: ["alembic/versions/0042_limit.py", "app/api/refund.py"], tests: [], risks: [], outsideWork: ["Set REFUND_LIMIT in the production config"] } } });
  const msg = planDetails(getTask(t.id)!);
  assert.match(msg, /Database migration – I never run it on a shared database/);
  assert.match(msg, /Outside these repositories \(for a person\)[\s\S]*REFUND_LIMIT/);
  assert.equal(noDesignNote(getTask(t.id)!), undefined, "a backend change needs no design note");
  const ui = task({ project: "shop-web", data: { ticket: { key: "KAN-1", title: "New badge", description: "Show a badge" } } });
  assert.match(noDesignNote(getTask(ui.id)!)!, /No design was given/);
  const withFigma = task({ project: "shop-web", data: { ticket: { key: "KAN-2", title: "x", description: "see https://www.figma.com/design/abc/x?node-id=1-2" } } });
  assert.equal(noDesignNote(getTask(withFigma.id)!), undefined);
});

test("E12: at 80 % of the budget you are told once and the work goes on (it only stops at 100 % under budget stops)", async () => {
  const s = S((x) => { x.workflow.stopForBudget = true; });
  const t = task();
  db().prepare("UPDATE tasks SET tokens_used=?, size='S' WHERE id=?").run(Math.ceil(getProject("shop")!.budget.perTaskTokens.S * 0.85), t.id);
  const runner: Runner = { async run() { return { ok: true, text: "{}", data: {}, tokensIn: 1, tokensOut: 1, costUsd: 0, model: "m" } as any; } };
  saveSettings(s);
  const ctx = ctxOf(getTask(t.id)!, runner, s);
  const before = sent.length;
  await ctx.agent("analyst", "x");                                    // no BudgetPause thrown
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(sent.slice(before).some((m) => /80% of its token budget used/.test(m.title)), sent.map((m) => m.title).join(" | "));
  saveSettings(S());
});

test("L4: a 429 from GitHub or Jira makes its polls wait (retry-after, else 15 minutes); other errors don't", () => {
  delMeta("backoff.github");
  assert.equal(noteRateLimited("github", { status: 500, message: "boom" }), false);
  assert.equal(backingOff("github"), false);
  assert.equal(noteRateLimited("github", { status: 403, message: "API rate limit exceeded for user" }), true);
  assert.equal(backingOff("github"), true);
  assert.equal(backingOff("github", Date.now() + 16 * 60_000), false, "back after the wait");
  noteRateLimited("jira", { status: 429, retryAfterMs: 120_000 });
  assert.equal(backingOff("jira", Date.now() + 60_000), true);
  assert.equal(backingOff("jira", Date.now() + 130_000), false);
  delMeta("backoff.github"); delMeta("backoff.jira");
});

test("A7: after being off for a while, ONE catch-up message; never after a short gap or a first start", async () => {
  const before = sent.length;
  assert.equal(await catchUp(0, 0), false);
  assert.equal(await catchUp(Date.now() - 5 * 60_000, 0), false);
  assert.equal(await catchUp(Date.now() - 3 * 3_600_000, 2), true);
  const m = sent.slice(before).find((x) => /I'm back – I was off for 3 hours/.test(x.title));
  assert.ok(m, sent.slice(before).map((x) => x.title).join(" | "));
  assert.match(m!.body, /2 pieces of work picked up again/);
});

test("J9: 'how much did we spend this week' – totals by project and day, and the most expensive tickets", () => {
  const t = task({ ref: "KAN-690" });
  db().prepare("INSERT INTO steps (task_id, run_no, idx, name, status, tokens_in, tokens_out, cost_usd, started_at) VALUES (?,?,?,?,?,?,?,?,?)").run(t.id, 1, 0, "plan", "ok", 1000, 100, 1.25, new Date().toISOString());
  const s = costSummary(7);
  assert.match(s, /\$1\.25\*\* in the last 7 days/);
  assert.match(s, /By project: shop \$1\.25/);
  assert.match(s, /Most: KAN-690 \$1\.25/);
});

test("L3: 'CI green' on several PRs merges into one message; other updates merge per ticket", () => {
  assert.equal(mergeKeyOf({ kind: "info", title: "✅ CI green on PR #7 · KAN-1", body: "" } as any), "group:ci-green");
  assert.equal(mergeKeyOf({ kind: "info", taskRef: "KAN-1", title: "🔀 merged main in", body: "" } as any), "item:KAN-1");
});

test("B12: a sprint is fitted to the working days and budget left – in rank order; the rest is named", () => {
  const issues = ["KAN-1", "KAN-2", "KAN-3", "KAN-4"].map((key, rank) => ({ key, id: key, title: `Build the whole ${key} area with many screens`, description: "x".repeat(3000), status: "To Do", url: "u", labels: [], rank }));
  const tight = S();
  upsertProject({ ...getProject("shop")!, budget: { ...getProject("shop")!.budget, dailyTokens: 400_000 } });
  const p = buildPreview({ title: "Sprint 14", kind: "sprint", issues, skipped: [], sprint: { name: "Sprint 14", endDate: new Date(Date.now() + 2 * 86_400_000).toISOString() } } as any, tight);
  assert.ok(p.fit && p.fit.length < 4, JSON.stringify(p.fit));
  assert.deepEqual(p.fit, issues.slice(0, p.fit!.length).map((i) => i.key), "the first by rank");
  assert.ok(p.lines.some((l) => /Fits the \d+ working days? left .* after them:/.test(l)), p.lines.join("\n"));
  upsertProject({ ...getProject("shop")!, budget: { ...getProject("shop")!.budget, dailyTokens: DEFAULT_SETTINGS.limits ? 4_000_000 : 4_000_000 } });
});

test("O2: the last ticket of an epic worked one by one sends ONE epic summary (once)", async () => {
  const kids = [{ key: "KAN-701", title: "Signup", statusCategory: "done" }, { key: "KAN-702", title: "Verify email", statusCategory: "indeterminate" }];
  const old = clients.jira;
  clients.jira = (() => ({ search: async () => kids, epicChildren: async () => kids })) as any;
  try {
    const a = task({ ref: "KAN-702", state: "DONE", data: { ticket: { key: "KAN-702", title: "Verify email", parentKey: "KAN-700", parentType: "Epic" }, pr: { number: 5, url: "https://github.com/acme/shop/pull/5" } } });
    const before = sent.length;
    assert.equal(await epicSummaryIfDone(getTask(a.id)!), true);
    const m = sent.slice(before).find((x) => /Epic KAN-700 is complete/.test(x.title));
    assert.ok(m);
    assert.match(m!.body, /KAN-702 Verify email – https:\/\/github\.com\/acme\/shop\/pull\/5/);
    assert.match(m!.body, /KAN-701 Signup \(done outside the plugin\)/);
    assert.equal(await epicSummaryIfDone(getTask(a.id)!), false, "once per epic");
  } finally { clients.jira = old; }
});

test("N1 / B14 / B15: a test plan, a bug and a PRD link from Teams each start the right work", async () => {
  const old = clients.jira;
  const createdIssues: any[] = [];
  clients.jira = (() => ({ getIssue: async (k: string) => ({ key: k, id: `id-${k}`, projectKey: "KAN", title: "Refunds", description: "Refund a payment", status: "Done", labels: [], url: "u", updated: "" }), search: async () => [],
    createIssue: async (p: any) => { createdIssues.push(p); return { key: "KAN-999", id: "9", url: "u" }; } })) as any;
  try {
    const qa = await runTool({ tool: "start", args: { ref: "KAN-45", role: "qa_plan" } } as any, { who: "Sneha", original: "test plan for KAN-45" } as any);
    assert.match(qa.reply, /Writing the test plan for KAN-45-QA/);
    assert.equal(getTask("KAN-45-QA")!.kind, "ready_for_qa");
    const bug = await runTool({ tool: "start", args: { text: "login fails with 500 since today", role: "bug", project: "shop" } } as any, { who: "Sneha", original: "login fails with 500 since today" } as any);
    assert.match(bug.reply, /reproduce the bug with a failing test first[\s\S]*create a Jira bug for ([A-Z]+-\d+)/);
    const req = /create a Jira bug for ([A-Z]+-\d+)/.exec(bug.reply)![1];
    assert.equal(getTask(req)!.data.triage.type, "bug");
    const jb = await runTool({ tool: "start", args: { text: `create a Jira bug for ${req}` } } as any, { who: "Sneha", original: `create a Jira bug for ${req}` } as any);
    assert.match(jb.reply, /Logged [A-Z]+-\d+ in Jira as KAN-999/);
    assert.equal(createdIssues.at(-1).issueType, "Bug");
    const prd = await runTool({ tool: "preview_scope", args: { text: "build this https://www.notion.so/acme/Seller-onboarding-PRD-1234", project: "shop" } } as any, { who: "Sneha", original: "build this https://www.notion.so/acme/Seller-onboarding-PRD-1234" } as any);
    assert.match(prd.reply, /Got it – [A-Z]+-\d+/, "the linked document becomes new work with a short interview first");
  } finally { clients.jira = old; }
});

test("A2: 'add the admin-panel repo, github acme/admin-panel' – cloned next to the others, joined to the product group", async () => {
  setRepoCloner((_url, dir) => { fs.mkdirSync(dir, { recursive: true }); sh(path.dirname(dir), "init", "-q", path.basename(dir)); });
  const r = await addRepo({ github: "https://github.com/acme/admin-panel" }, "Sneha", { background: true });
  assert.equal(r.ok, true, r.reply);
  const p = getProject("admin-panel")!;
  assert.equal(p.github?.repo, "acme/admin-panel");
  assert.equal(p.group ?? "", getProject("shop")!.group ?? "shop");
  assert.deepEqual(p.jira?.keys, ["KAN"]);
  assert.ok(fs.existsSync(p.local.path));
  assert.equal((await addRepo({ github: "acme/admin-panel" }, "Sneha")).ok, false, "never twice");
  assert.equal((await addRepo({ github: "not a repo" }, "Sneha")).ok, false);
});

test("E8: before the PR, a small conflict with the moved base is resolved by the coding agent – not a pause", async () => {
  const { repo, origin } = makeRepo("e8");
  upsertProject(normaliseProject({ id: "e8", local: { path: repo }, github: { repo: "acme/e8", baseBranch: "main" }, roles: ["backend-developer"] } as any));
  fs.writeFileSync(path.join(repo, "src", "limit.ts"), "export const LIMIT = 100;\n");
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "limit"); sh(repo, "push", "-q", "origin", "HEAD:main");
  const base = sh(repo, "rev-parse", "HEAD");
  sh(repo, "checkout", "-q", "-b", "feat/KAN-800");
  fs.writeFileSync(path.join(repo, "src", "limit.ts"), "export const LIMIT = 500;\n");
  sh(repo, "commit", "-q", "-am", "raise the limit");
  // meanwhile on main: the same line changed
  const other = fs.mkdtempSync(path.join(path.dirname(repo), "e8-other-"));
  sh(path.dirname(other), "clone", "-q", origin, path.basename(other));
  fs.writeFileSync(path.join(other, "src", "limit.ts"), "export const LIMIT = 200; // reviewed\n");
  sh(other, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-am", "main change"); sh(other, "push", "-q", "origin", "HEAD:main");
  const runner: Runner = { async run(r: any) {
    if (r.agent === "implementer") fs.writeFileSync(path.join(r.cwd, "src", "limit.ts"), "export const LIMIT = 500; // reviewed\n");
    return { ok: true, text: "{}", data: {}, tokensIn: 1, tokensOut: 1, costUsd: 0, model: "m" } as any;
  } };
  const t = task({ project: "e8", ref: "KAN-800", data: { baseSha: base, testsUnavailable: { reason: "test" } } });
  const ctx = ctxOf({ ...getTask(t.id)!, worktree: repo, branch: "feat/KAN-800", data: { ...getTask(t.id)!.data, baseSha: base, testsUnavailable: { reason: "test" } } } as any, runner);
  const r = await STEPS.prepublish(ctx);
  assert.equal(r.status, "ok", JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(repo, "src", "limit.ts"), "utf8").replace(/\r\n/g, "\n"), "export const LIMIT = 500; // reviewed\n");
  assert.deepEqual(ctx.task.data.baseConflictResolved, ["src/limit.ts"]);
  assert.equal(sh(repo, "status", "--porcelain"), "", "committed");
});
