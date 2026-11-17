import { makeRepo } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../core/db.js";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, getProject, loadSettings, type Settings } from "../core/config.js";
import { clients } from "../connectors/registry.js";
import type { GitHubClient } from "../connectors/github.js";
import { epicChildrenOf, findSprint, mapDevLinks, sprintIssuesOf, jqlString, type JiraClient } from "../connectors/jira.js";
import type { WorkItem } from "../connectors/types.js";
import { setRunner, MockRunner } from "../agents/runner.js";
import { setSenders } from "../notify/router.js";
import { getTask, transition } from "../engine/tasks.js";
import { STEPS } from "../engine/steps.js";
import { buildStepCtx } from "../engine/stepRun.js";
import { startAwaiting } from "../engine/engine.js";
import { loadRecipes, validateWith } from "../kernel/recipes.js";
import { getItem, childrenOf, edgesOf } from "../kernel/items.js";
import { createJob, rowToJob } from "../kernel/mailbox.js";
import { runJob, ensureJobs } from "../kernel/runner.js";
import { pickRunnable, limitsFrom } from "../kernel/scheduler.js";
import { decide, latestApproval } from "../approvals/approvals.js";
import { setDirective } from "../policy/directives.js";
import {
  SCOPE_STEPS, SCOPE_AGENTS, mockScopeAnswer, parseScopeTarget, planWaves, textDependencies, acceptanceCriteria, coverage, normalisePlan,
  prBodyWithMergeOrder, estimateSize, buildPreview, previewScope, startBatch, stackBaseFor, mergeNoteFor, wakeScopes, scopeDigest,
  collectScope, createScopeItem, type ScopeData,
} from "../engine/steps/scope.js";
import { scopes, scopeFilters, dependencyView, board, filterOf } from "../api/dashboardData.js";
import { runTool } from "../conductor/tools.js";
import type { Job } from "../kernel/types.js";

/**
 * Wave 4 – scopes (W7 batch, W8 epic / sprint, Phase 6): preview, scope plan, one approval, children with edges,
 * waves, stacked PRs, merge order in PRs / Teams / status, out-of-order warning, epic check, dashboard v2.
 * Engine v2, mock model, fake Jira and GitHub (no network).
 */

// the scope steps reach STEPS through engine/steps/index.ts after the integrator's hook-in; here they are added directly
Object.assign(STEPS, SCOPE_STEPS);
loadRecipes(true);

const { repo } = makeRepo("shop");

// ---------------------------------------------------------------- fake Jira
const issue = (key: string, title: string, description: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  provider: "jira", id: `id-${key}`, key, projectKey: key.split("-")[0], title, description, status: "To Do", statusCategory: "new", priority: "Medium",
  labels: [], issueType: "Story", url: `https://acme.atlassian.net/browse/${key}`, updated: "2026-11-17T10:00:00Z", assignee: "me", assigneeName: "Sneha", ...extra,
});
const issues: Record<string, WorkItem> = {
  "KAN-45": issue("KAN-45", "Refund API endpoint", "Add a POST /refunds endpoint that refunds part of a payment and stores the refund."),
  "KAN-46": issue("KAN-46", "Invite email template wording", "Change the wording of the invite email template for new sellers to the text in the attached copy deck."),
  "KAN-47": issue("KAN-47", "Refund button in admin", "Uses KAN-45's refund API to add a refund button on the admin payment page with a confirm dialog."),
  "KAN-48": issue("KAN-48", "Seller CSV export", "Export the seller list as CSV from the sellers page, with name, email and joined date columns."),
  "KAN-60": issue("KAN-60", "Payout schedule settings", "Let a seller pick a weekly or monthly payout schedule in their settings page."),
  "KAN-61": issue("KAN-61", "Payout history table", "Show past payouts in a table with date, amount and status on the payouts page."),
  "KAN-63": issue("KAN-63", "Payout email receipt", "Send the seller an email receipt after each payout with the amount and the date."),
  "KAN-62": issue("KAN-62", "Fraud rules tuning", "Tune the fraud rules thresholds for card payments based on last month's numbers.", { assignee: "priya", assigneeName: "Priya" }),
  "KAN-40": issue("KAN-40", "Seller onboarding", "Sellers can join the marketplace by themselves.\n\nAcceptance criteria:\n- Seller can upload ID documents\n- Seller sees onboarding progress\n- Admin can approve a seller account\n", { issueType: "Epic" }),
  "KAN-41": issue("KAN-41", "Upload ID documents for sellers", "Sellers upload ID documents during onboarding; files are checked for type and size."),
  "KAN-42": issue("KAN-42", "Seller onboarding progress bar", "Show the seller onboarding progress as steps at the top of the onboarding pages."),
};
const created: { summary: string; parentKey?: string }[] = [];
const jql: string[] = [];
const fakeJira: JiraClient = {
  site: "https://acme.atlassian.net",
  myself: async () => ({ accountId: "me", displayName: "Sneha" }),
  search: async (q) => {
    jql.push(q);
    if (/"Epic Link"/.test(q)) throw new Error("Field 'Epic Link' does not exist");
    if (/parent = KAN-40/.test(q)) return [issues["KAN-41"], issues["KAN-42"]];
    return [];
  },
  getIssue: async (k) => issues[k],
  addComment: async () => {},
  boards: async () => [{ id: 3, name: "KAN board", type: "scrum" }],
  sprints: async () => [{ id: 77, name: "KAN Sprint 14", state: "active" }, { id: 78, name: "KAN Sprint 15", state: "future" }],
  sprintIssues: async (id) => (id === 77 ? [issues["KAN-60"], issues["KAN-61"], issues["KAN-62"]] : []),
  createIssue: async (p) => { created.push({ summary: p.summary, parentKey: p.parentKey }); return { key: `KAN-${100 + created.length}`, id: `n${created.length}`, url: "x" }; },
};
clients.jira = () => fakeJira;

// ---------------------------------------------------------------- fake GitHub (PR bodies)
const bodies = new Map<number, string>([[140, "## Summary\nRefund endpoint."], [141, "## Summary\nRefund button."]]);
const updates: { num: number; body: string }[] = [];
const fakeGitHub = {
  prForReview: async (_r: string, n: number) => ({ number: n, body: bodies.get(n) ?? "" }),
  updatePr: async (_r: string, n: number, p: { body?: string }) => { if (p.body !== undefined) { bodies.set(n, p.body); updates.push({ num: n, body: p.body }); } return { number: n, url: "x" }; },
};
clients.github = () => fakeGitHub as unknown as GitHubClient;

const sent: { kind: string; ref?: string; title: string; body: string; approvalId?: string }[] = [];
setSenders({ desktop: { send: async (n) => { sent.push({ kind: n.kind, ref: n.taskRef, title: n.title, body: n.body, approvalId: n.approvalId }); return undefined; } } });

const AREAS: Record<string, string[]> = { "KAN-45": ["src/services/refund/**"], "KAN-46": ["templates/invite/**"], "KAN-47": ["src/admin/payments/**"], "KAN-48": ["src/sellers/**"],
  "KAN-60": ["src/payouts/settings/**"], "KAN-61": ["src/payouts/history/**"] };
const runner = new MockRunner({
  "overlap-checker": (req) => ({ tickets: (/TICKET KEYS: (.+)/.exec(req.prompt)?.[1] ?? "").split(",").map((k) => k.trim()).map((key) => ({ key, repo: "shop", areas: AREAS[key] ?? [], size: "M", dependsOn: [], contracts: [] })) }),
  "scope-planner": (req) => mockScopeAnswer("scope-planner", req.prompt),
  "scope-reviewer": () => ({ pass: true, issues: [] }),
});
setRunner(runner);

function settings(patch: (s: Settings) => void = () => {}): Settings {
  const s: Settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    profile: { name: "Sneha", workingHours: "00:00-23:59", roles: ["fullstack-developer"] },
    models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
    notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off" },
    team: { me: { github: "sneha" }, members: [] },
    engine: { version: "v2" },
  };
  patch(s);
  return s;
}
saveSettings(settings());
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" },
  local: { path: repo, testCommand: "node -e \"process.exit(0)\"" }, roles: ["fullstack-developer"], autonomy: "prepare" }));

const jobsOf = (itemId: string): Job[] => (db().prepare("SELECT * FROM jobs WHERE item_id=? ORDER BY created_at, rowid").all(itemId) as any[]).map(rowToJob);
/** Give the container its job (as the kernel tick does) and run it until it waits or ends. */
async function runScope(itemId: string): Promise<Job> {
  ensureJobs();
  const j = jobsOf(itemId).filter((x) => ["queued", "running"].includes(x.state)).at(-1);
  assert.ok(j, "the scope has a job");
  return runJob(j!.id);
}
/** Approve the scope's pending approval the way the engine does (approval → QUEUED), without ticking the whole engine. */
function approve(itemId: string): void {
  const a = latestApproval(itemId);
  assert.equal(a?.state, "pending", "an approval waits");
  decide(a!.id, "approved", "Sneha", "teams-personal");
  transition(itemId, "QUEUED", "approved");
}
const setState = (id: string, state: string, data: Record<string, any> = {}, branch?: string) => {
  const t = getTask(id)!;
  db().prepare("UPDATE tasks SET state=?, data=?, branch=COALESCE(?, branch) WHERE id=?").run(state, JSON.stringify({ ...t.data, ...data }), branch ?? null, id);
};
const kidByKey = (rootId: string, key: string) => childrenOf(rootId).find((k) => k.source_ref === key)!;

// ================================================================ pure parts

test("scope helpers: targets, sizes, text dependencies, waves, criteria, PR body", () => {
  assert.deepEqual(parseScopeTarget("build sprint 14")?.kind, "sprint");
  assert.equal(parseScopeTarget("build sprint 14")?.target, "14");
  assert.equal(parseScopeTarget("work through the current sprint")?.target, "current");
  assert.equal(parseScopeTarget("plan the whole sprint for me")?.target, "current");
  assert.equal(parseScopeTarget("let's do sprint planning"), undefined);
  assert.equal(parseScopeTarget("do all my tickets")?.kind, "all_mine");
  assert.equal(parseScopeTarget("do kan-45, KAN-47 and KAN-48, no approvals")?.kind, "batch");
  assert.ok(parseScopeTarget("do KAN-45 and KAN-47, no approvals")?.noApprovals);
  assert.equal(parseScopeTarget("build the KAN-40 epic")?.kind, "epic");
  assert.equal(parseScopeTarget("hello"), undefined);

  assert.equal(estimateSize({ title: "Fix typo", description: "typo in footer" }), "S");
  assert.equal(estimateSize({ title: "Payments", description: "A database migration of the ledger tables ".repeat(5) }), "L");

  const deps = textDependencies([
    { key: "AB-1", title: "API", description: "endpoint" },
    { key: "AB-2", title: "UI", description: "uses AB-1's API" },
    { key: "AB-3", title: "Schema", description: "blocks AB-1" },
    { key: "AB-4", title: "x", description: "see AB-5" }, { key: "AB-5", title: "y", description: "see AB-4" },
  ]);
  assert.ok(deps.some((e) => e.from === "AB-2" && e.to === "AB-1" && e.type === "depends_on"));
  assert.ok(deps.some((e) => e.from === "AB-1" && e.to === "AB-3" && e.type === "depends_on"), "'blocks A-1' turns it round");
  assert.ok(deps.some((e) => e.type === "same_area" && [e.from, e.to].sort().join() === "AB-4,AB-5"), "naming each other = overlap, not a loop");

  assert.deepEqual(planWaves(["a", "b", "c", "d"], [{ from: "c", to: "a", type: "depends_on" }, { from: "d", to: "c", type: "stacks_on" }]).waves, [["a", "b"], ["c"], ["d"]]);
  const loop = planWaves(["a", "b"], [{ from: "a", to: "b", type: "depends_on" }, { from: "b", to: "a", type: "depends_on" }]);
  assert.deepEqual(loop.cycle, ["a", "b"]);

  // the planner's loop is removed, a same-repo dependency is stacked, overlapping areas become same_area
  const plan = normalisePlan({ tickets: [
    { key: "A-1", repo: "shop", areas: ["src/a/**"], size: "M", dependsOn: [{ key: "A-2", why: "x" }] },
    { key: "A-2", repo: "shop", areas: ["src/b/**"], size: "M", dependsOn: [{ key: "A-3", why: "y" }] },
    { key: "A-3", repo: "shop", areas: ["src/a/x.ts"], size: "Z", dependsOn: [{ key: "A-1", why: "loop" }, { key: "NOPE-9", why: "invented" }] },
  ] }, { kind: "batch", issues: ["A-1", "A-2", "A-3"].map((key, rank) => ({ key, id: key, title: key, description: "", status: "", url: "", labels: [], rank })) },
  { repos: ["shop"], defaultRepo: () => "shop", by: "planner" });
  assert.equal(plan.waves.length, 3, "only the edge that closed the loop is dropped");
  assert.ok(plan.notes.some((n) => /circle/.test(n)));
  assert.ok(plan.edges.some((e) => e.type === "stacks_on"));
  assert.ok(plan.edges.some((e) => e.type === "same_area" && [e.from, e.to].includes("A-3")), "src/a/x.ts is inside src/a/**");
  assert.ok(!plan.edges.some((e) => e.to === "NOPE-9"), "invented keys are dropped");
  assert.equal(plan.tickets.find((t) => t.key === "A-3")!.size, "S", "a bad size falls back to the estimate");

  assert.deepEqual(acceptanceCriteria(issues["KAN-40"].description), ["Seller can upload ID documents", "Seller sees onboarding progress", "Admin can approve a seller account"]);
  const cov = coverage(acceptanceCriteria(issues["KAN-40"].description), [{ key: "KAN-41", text: `${issues["KAN-41"].title}\n${issues["KAN-41"].description}` }, { key: "KAN-42", text: `${issues["KAN-42"].title}\n${issues["KAN-42"].description}` }]);
  assert.deepEqual(cov.map((c) => c.covered), [true, true, false]);

  const once = prBodyWithMergeOrder("## Summary\nx", "Merge 2 of 3, after #140.");
  assert.match(once, /<!-- merge-order -->\n\*\*Merge order:\*\* Merge 2 of 3, after #140\.\n<!-- \/merge-order -->/);
  assert.equal(prBodyWithMergeOrder(once, "Merge 2 of 3, after #140."), once, "idempotent");
  assert.ok(!/Merge 2/.test(prBodyWithMergeOrder(once, "Merge 1 of 3.").replace("Merge 1 of 3.", "")), "replaced, not added twice");

  assert.ok(SCOPE_AGENTS["scope-planner"].tier === "large" && SCOPE_AGENTS["overlap-checker"].tier === "small");
});

test("Jira scopes: epic children (parent / Epic Link), sprint by number, development links", async () => {
  jql.length = 0;
  const kids = await epicChildrenOf(fakeJira, "KAN-40");
  assert.deepEqual(kids.map((k) => k.key), ["KAN-41", "KAN-42"]);
  assert.ok(jql.some((q) => /"Epic Link"/.test(q)), "both fields are tried; the one that errors is skipped");
  assert.equal((await findSprint(fakeJira, "KAN", "14"))?.id, 77);
  assert.equal((await findSprint(fakeJira, "KAN", "current"))?.id, 77);
  assert.equal((await findSprint(fakeJira, "KAN", "Sprint 15"))?.id, 78);
  const r = await sprintIssuesOf(fakeJira, "KAN", "14");
  assert.equal(r.issues.length, 3);
  // a client without the agile API falls back to JQL
  jql.length = 0;
  await sprintIssuesOf({ ...fakeJira, boards: undefined, sprints: undefined, sprintIssues: undefined }, "KAN", "14");
  assert.equal(jql[0], `project = KAN AND sprint = "Sprint 14" ORDER BY rank ASC`);
  assert.equal(jqlString('a"b'), '"a\\"b"');
  const links = mapDevLinks({ detail: [{ pullRequests: [{ id: "#7", name: "KAN-45 refund", url: "https://github.com/acme/shop/pull/7", status: "OPEN", source: { branch: "feat/KAN-45" }, destination: { branch: "main" } }] }] }, "pullrequest");
  assert.deepEqual(links[0], { kind: "pullrequest", name: "KAN-45 refund", url: "https://github.com/acme/shop/pull/7", status: "OPEN", repo: undefined, branch: "feat/KAN-45", base: "main" });
});

test("recipes plan_scope and batch load and every step exists", () => {
  const recipes = loadRecipes(true);
  assert.equal(recipes.get("plan_scope")?.job, "plan_scope");
  assert.equal(recipes.get("batch")?.job, "plan_scope");
  const mine = new Map([...recipes].filter(([n]) => n === "plan_scope" || n === "batch"));
  assert.deepEqual(validateWith(mine, new Set(Object.keys(STEPS))), []);
});

// ================================================================ W7: a 4-ticket batch with one dependency

let batchId = "";

test("W7 batch: 4 tickets, one dependency → waves, one approval, stacked PR, merge order in PRs, Teams and status", async () => {
  const r = await startBatch(["KAN-45", "KAN-46", "KAN-47", "KAN-48"], "Sneha");
  assert.ok(r.itemId && !r.ask, "a batch the owner asked for starts at once (one acknowledgement)");
  assert.match(r.reply, /4 tickets/);
  assert.match(r.reply, /KAN-47 needs KAN-45/);
  batchId = r.itemId!;
  const box = getItem(batchId)!;
  assert.equal(box.level, "batch");
  assert.equal(box.playbook, "batch");
  assert.equal(box.state, "QUEUED");

  // preview (already shown in the reply) → overlap check → ONE approval for the batch
  let job = await runScope(batchId);
  assert.equal(job.state, "waiting");
  assert.equal(getTask(batchId)!.state, "AWAITING_APPROVAL");
  assert.equal(runner.calls.filter((c) => c.agent === "overlap-checker").length, 1);
  assert.equal(runner.calls.find((c) => c.agent === "overlap-checker")!.tier, "small");
  assert.match(runner.calls.find((c) => c.agent === "overlap-checker")!.prompt, /<untrusted|content from jira:KAN-47/i, "Jira text goes in marked blocks");
  const ask = sent.filter((m) => m.kind === "approval_needed" && m.ref === box.source_ref);
  assert.equal(ask.length, 1, "one approval for the whole batch");
  assert.match(ask[0].body, /Wave 1: KAN-45 .*KAN-46 .*KAN-48/);
  assert.match(ask[0].body, /Wave 2: KAN-47/);
  assert.match(ask[0].body, /Stacked PRs: KAN-47 on KAN-45/);
  assert.match(ask[0].body, /Merge order: KAN-45, KAN-46, KAN-48, KAN-47/);
  assert.ok(!sent.some((m) => m.ref === box.source_ref && /planning it/.test(m.title)), "no second preview message");

  approve(batchId);
  job = await runScope(batchId);
  assert.equal(job.state, "waiting", "waits for its children");
  assert.equal(getTask(batchId)!.state, "WAITING_CHILDREN");

  // children: parent / root, wave, areas, child plans as information, edges
  const kids = childrenOf(batchId);
  assert.deepEqual(kids.map((k) => k.source_ref).sort(), ["KAN-45", "KAN-46", "KAN-47", "KAN-48"]);
  for (const k of kids) {
    assert.equal(k.parent_id, batchId);
    assert.equal(k.root_id, batchId);
    assert.equal(k.state, "DETECTED", "each child runs W5 (triage first)");
    assert.equal(k.data.directives.start_approval, "skip");
    assert.equal(k.data.directives.plan_approval, "skip", "child plans come as information (D7)");
  }
  const k45 = kidByKey(batchId, "KAN-45"), k47 = kidByKey(batchId, "KAN-47");
  assert.deepEqual(k47.areas, ["src/admin/payments/**"]);
  assert.equal(k47.data.scopeNote.wave, 2);
  const out47 = edgesOf(k47.id, "out").map((e) => `${e.type}:${getItem(e.to)!.source_ref}`).sort();
  assert.deepEqual(out47, ["depends_on:KAN-45", "stacks_on:KAN-45"]);
  assert.ok(!kids.some((k) => edgesOf(k.id).some((e) => e.type === "same_area")), "different areas: no same_area edge");
  const sc: ScopeData = getTask(batchId)!.data.scope;
  assert.deepEqual(sc.plan!.waves, [["KAN-45", "KAN-46", "KAN-48"], ["KAN-47"]]);

  // waves in the scheduler: KAN-47 waits for KAN-45 …
  const j47 = createJob({ itemId: k47.id, type: "build", recipe: "dev-feature" });
  let d = pickRunnable(limitsFrom(loadSettings()), []);
  assert.match(d.waiting.find((w) => w.jobId === j47.id)?.reason ?? "", /waiting for KAN-45/);
  // … and is stacked on KAN-45's branch once its PR is open (no wait for the merge)
  setState(k45.id, "PR_OPEN", { pr: { number: 140, url: "https://github.com/acme/shop/pull/140", repo: "acme/shop" } }, "feat/KAN-45/refund-api");
  d = pickRunnable(limitsFrom(loadSettings()), []);
  assert.ok(!d.waiting.some((w) => w.jobId === j47.id && w.code === "depends_on"), "a stacks_on edge to an open PR is enough");
  db().prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(j47.id);
  assert.deepEqual(stackBaseFor(k47.id), { parentId: k45.id, parentRef: "KAN-45", branch: "feat/KAN-45/refund-api", pr: 140 });

  // KAN-47's PR opens (stacked): the batch wakes, merge order goes into both PR bodies and to Teams
  setState(k47.id, "PR_OPEN", { pr: { number: 141, url: "https://github.com/acme/shop/pull/141", repo: "acme/shop" } }, "feat/KAN-47/refund-button");
  assert.equal(wakeScopes(), 1);
  job = await runScope(batchId);
  assert.equal(job.state, "waiting");
  assert.match(bodies.get(140)!, /\*\*Merge order:\*\* Merge 1 of 4 in Batch/);
  assert.match(bodies.get(141)!, /Merge 4 of 4 in Batch .*, after #140 \(KAN-45\)\. Stacked on #140 – it moves to main after that merges\./);
  assert.match(bodies.get(141)!, /^## Summary\nRefund button\./, "the rest of the body is kept");
  assert.match(mergeNoteFor(k47.id)!, /after #140/);
  const order = sent.filter((m) => /Merge order – Batch/.test(m.title)).at(-1)!;
  assert.match(order.body, /1\. KAN-45 \(#140\) – PR open/);
  assert.match(order.body, /4\. KAN-47 \(#141\) – PR open \(stacked on #140\)/);
  assert.deepEqual(getTask(batchId)!.data.scope.mergeOrder, ["KAN-45", "KAN-46", "KAN-48", "KAN-47"], "status carries the order");
  const before = updates.length;
  assert.equal(wakeScopes(), 0, "nothing changed: the batch keeps sleeping");
  assert.equal(updates.length, before);

  // status: the scope digest names what merges next
  const dg = scopeDigest(batchId)!;
  assert.ok(dg.lines.some((l) => /Merge next: KAN-45 \(#140\)/.test(l)));

  // out of order: KAN-47 merged while KAN-45 is still open → one warning
  setState(k47.id, "MERGED", { mergedAt: new Date().toISOString() });
  assert.equal(wakeScopes(), 1);
  await runScope(batchId);
  const warn = sent.filter((m) => /Merged out of order/.test(m.title));
  assert.equal(warn.length, 1);
  assert.match(warn[0].body, /KAN-47 \(#141\) was merged before KAN-45 \(#140\)/);
});

test("dashboard v2: scope tree with waves, merge order, stacked PRs, dependency arrows, filters", () => {
  const list = scopes();
  const s = list.find((x) => x.id === batchId)!;
  assert.ok(s, "the batch is listed");
  assert.equal(s.levelLabel, "Batch");
  assert.deepEqual(s.waves.map((w) => w.items.map((i) => i.ref)), [["KAN-45", "KAN-46", "KAN-48"], ["KAN-47"]]);
  assert.deepEqual(s.mergeOrder.map((m) => m.ref), ["KAN-45", "KAN-46", "KAN-48", "KAN-47"]);
  assert.equal(s.stacked[0].ref, "KAN-47");
  assert.equal(s.stacked[0].onPr, "#140");
  assert.ok(s.edges.some((e) => e.from === "KAN-47" && e.to === "KAN-45" && e.type === "depends_on"));
  assert.equal(s.warnings, 1);
  // filters: by scope and by repository
  assert.equal(scopes({ scope: getTask(batchId)!.source_ref! }).length, 1);
  assert.equal(scopes({ repo: "nope" }).filter((x) => x.id === batchId).length, 0);
  assert.equal(scopes({ sprint: batchId }).length, 0, "a batch is not a sprint");
  assert.ok(scopeFilters().batches.some((b) => b.id === batchId));
  assert.deepEqual(filterOf(new URL("http://x/api/scopes?repo=shop&sprint=<script>")), { sprint: undefined, epic: undefined, scope: undefined, repo: "shop" });
  // the board shows the tickets, not the container, and can keep one batch
  const cards = board(14, { scope: batchId }).stages.flatMap((x) => x.items);
  assert.equal(cards.length, 4);
  assert.ok(!board().stages.flatMap((x) => x.items).some((c) => c.id === batchId));
  assert.equal(cards.find((c) => c.ref === "KAN-47")!.scope!.id, batchId);
  // the drawer: what KAN-47 needs, and its merge position
  const dep = dependencyView(kidByKey(batchId, "KAN-47").id)!;
  assert.deepEqual(dep.needs.map((n: any) => `${n.ref}:${n.type}`).sort(), ["KAN-45:depends_on", "KAN-45:stacks_on"]);
  assert.equal(dep.scope?.id, batchId);
  assert.match(dep.mergeNote ?? "", /Merge 4 of 4/);
});

// ================================================================ W8: a sprint preview is shown once, even under "no approvals"

test("W8 sprint: preview asks once under 'no approvals'; the plan is then sent as information only", async () => {
  for (const rule of ["plan_approval", "pr_approval", "start_approval"]) assert.ok(setDirective({ scope: "global", rule, value: "skip" }, { channel: "teams", owner: true }).ok);
  try {
    const sentBefore = sent.length;
    const r = await runTool({ tool: "preview_scope", args: { text: "sprint 14" } } as any, { who: "Sneha", original: "build sprint 14" });
    assert.ok(r.ask, "a sprint always asks once – even under 'no approvals'");
    assert.match(r.reply, /Sprint 14: 2 tickets/);
    assert.match(r.reply, /Skipped: KAN-62 \(Priya's\)/);
    assert.equal(r.ask!.calls![0].tool, "decide");
    const box = getTask(r.ask!.calls![0].args.ref!)!;
    assert.equal(box.state, "AWAITING_START");
    assert.equal(sent.length, sentBefore, "the preview is the reply – nothing else is sent");
    // asking again does not make a second sprint
    const again = await previewScope("build sprint 14", "Sneha");
    assert.equal(again.itemId, box.id);

    // the owner's "yes" (decide → start) – the recipe does not show the preview again
    startAwaiting(box.source_ref!);
    const job = await runScope(box.id);
    assert.equal(job.state, "waiting");
    assert.equal(getTask(box.id)!.state, "WAITING_CHILDREN");
    const mine = sent.slice(sentBefore).filter((m) => m.ref === box.source_ref);
    assert.ok(!mine.some((m) => /start\?/.test(m.title)), "no second preview");
    assert.equal(mine.filter((m) => /plan \(starting now\)/.test(m.title)).length, 1, "the plan comes as information");
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id=?").get(box.id) && (db().prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id=?").get(box.id) as any).n, 0, "no approval asked");
    assert.ok(runner.calls.some((c) => c.agent === "scope-planner" && c.tier === "large" && c.effort === "high"), "the scope planner is large tier, high effort");
    assert.deepEqual(childrenOf(box.id).map((k) => k.source_ref).sort(), ["KAN-60", "KAN-61"]);

    // a sprint started without the Conductor (no preview yet): the recipe asks exactly once
    const c = await collectScope({ kind: "sprint", target: "15", keys: [] }, { ...fakeJira, sprintIssues: async () => [issues["KAN-63"]] });
    const box2 = createScopeItem({ ...c, sourceId: "scope:sprint:78-test", sourceRef: "SPRINT-78" }, { who: "Sneha", state: "QUEUED" });
    let j2 = await runScope(box2.id);
    assert.equal(j2.state, "waiting");
    const asks = () => sent.filter((m) => m.ref === "SPRINT-78" && /start\?/.test(m.title));
    assert.equal(asks().length, 1);
    approve(box2.id);
    j2 = await runScope(box2.id);
    assert.equal(asks().length, 1, "shown once");
    assert.equal(getTask(box2.id)!.state, "WAITING_CHILDREN");
  } finally {
    db().prepare("DELETE FROM directives WHERE scope='global'").run();
  }
});

// ================================================================ W8: epic check finds a missing criterion

test("W8 epic check: a missing acceptance criterion → proposed story, created only after your OK, one summary", async () => {
  const c = await collectScope({ kind: "epic", target: "KAN-40", keys: ["KAN-40"] }, fakeJira);
  assert.deepEqual(c.issues.map((i) => i.key), ["KAN-41", "KAN-42"]);
  const box = createScopeItem(c, { who: "Sneha", state: "QUEUED" });
  assert.equal(box.level, "epic");
  assert.equal(box.playbook, "plan_scope");
  // plan + children as the recipe makes them, then both children merged
  const project = getProject("shop")!;
  const ctxOf = () => buildStepCtx({ task: getTask(box.id)!, project, settings: loadSettings(), runner });
  assert.equal((await SCOPE_STEPS.scope_plan(ctxOf())).status, "ok");
  assert.equal((await SCOPE_STEPS.spawn_children(ctxOf())).status, "ok");
  for (const k of childrenOf(box.id)) setState(k.id, "DONE", { mergedAt: new Date().toISOString(), pr: { number: 200 + Number(k.source_ref!.split("-")[1]), url: "https://github.com/acme/shop/pull/1", repo: "acme/shop" } });
  assert.equal((await SCOPE_STEPS.merge_order(ctxOf())).status, "ok", "every child finished");

  const createdBefore = created.length;
  const r1 = await SCOPE_STEPS.epic_check(ctxOf());
  assert.equal(r1.status, "await_approval", "missing stories are created only after your OK");
  assert.equal(created.length, createdBefore, "nothing created in Jira yet");
  const check = getTask(box.id)!.data.scope.epicCheck;
  assert.deepEqual(check.criteria.map((x: any) => x.covered), [true, true, false]);
  assert.equal(check.proposals[0].title, "Admin can approve a seller account");
  const ask = sent.filter((m) => m.ref === "KAN-40" && /missing stor/.test(m.title));
  assert.equal(ask.length, 1);
  assert.match(ask[0].body, /Admin can approve a seller account/);
  assert.ok(runner.calls.some((x) => x.agent === "epic-checker" && /content from jira:KAN-40|untrusted/i.test(x.prompt)));

  // your OK → the story is created under the epic, then one summary
  const a = latestApproval(box.id, "create_tickets")!;
  decide(a.id, "approved", "Sneha", "teams-personal");
  const r2 = await SCOPE_STEPS.epic_check(ctxOf());
  assert.equal(r2.status, "ok");
  assert.deepEqual(created.slice(createdBefore), [{ summary: "Admin can approve a seller account", parentKey: "KAN-40" }]);
  const summary = sent.filter((m) => m.ref === "KAN-40" && /epic check/.test(m.title));
  assert.equal(summary.length, 1);
  assert.match(summary[0].body, /Shipped: 2\/2/);
  assert.match(summary[0].body, /Acceptance criteria covered: 2\/3/);
  assert.match(summary[0].body, /Not covered: Admin can approve a seller account/);
  assert.match(summary[0].body, /Created in Jira: KAN-\d+/);
  assert.match(summary[0].body, /Cost: /);
});

test("epic check with 'no' to the stories: nothing created, the summary says so", async () => {
  const c = await collectScope({ kind: "epic", target: "KAN-40", keys: ["KAN-40"] }, fakeJira);
  const box = createScopeItem({ ...c, sourceId: "scope:epic:test-2", sourceRef: "KAN-40-B" }, { state: "QUEUED" });
  const project = getProject("shop")!;
  const ctxOf = () => buildStepCtx({ task: getTask(box.id)!, project, settings: loadSettings(), runner });
  await SCOPE_STEPS.scope_plan(ctxOf());
  await SCOPE_STEPS.spawn_children(ctxOf());
  const createdBefore = created.length;
  assert.equal((await SCOPE_STEPS.epic_check(ctxOf())).status, "await_approval");
  decide(latestApproval(box.id, "create_tickets")!.id, "rejected", "Sneha", "teams-personal", "not now");
  assert.equal((await SCOPE_STEPS.epic_check(ctxOf())).status, "ok");
  assert.equal(created.length, createdBefore);
  assert.match(sent.filter((m) => m.ref === "KAN-40-B").at(-1)!.body, /not created \(you said no\)/);
});

test("preview text: sizes, repos, overlaps, rough cost and budget warning stay short", () => {
  const p = buildPreview({ title: "Sprint 9", kind: "sprint", skipped: [], issues: ["KAN-45", "KAN-47"].map((k, rank) => ({ ...issues[k], rank, labels: [] })) as any });
  assert.ok(p.lines.length <= 9);
  assert.match(p.lines.join("\n"), /Overlaps: KAN-47 needs KAN-45/);
  assert.match(p.lines.join("\n"), /Rough cost: ~\d+k tokens/);
});
