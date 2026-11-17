import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../core/db.js";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, type Settings } from "../core/config.js";
import { createItem } from "../kernel/items.js";
import { addUsage, getTask, mergeData } from "../engine/tasks.js";
import {
  setDirective, clearDirective, activeDirectives, effective, echoDirective, normaliseValue, describeInForce, RAIL_REFUSAL,
} from "../policy/directives.js";
import {
  checkRails, needsApproval, canPush, canCreatePr, canComment, canCreateIssue, canMerge, canCreateTicket, isProtectedBranch, protectedHits, forbiddenHits,
} from "../policy/gate.js";
import {
  requestApproval, latestApproval, decideWithChange, changeOf, pendingChanges, markChangesApplied, approveByPolicy,
} from "../approvals/approvals.js";
import { budgetText, budgetState, checkScopeBudget, markBudgetWarned, budgetLines } from "../engine/budget.js";

const base = (patch: (s: Settings) => void = () => {}) => { const s = structuredClone(DEFAULT_SETTINGS); s.models.provider = "mock"; patch(s); saveSettings(s); return s; };
base();
upsertProject(normaliseProject({ id: "pol", jira: { site: "x", keys: ["KAN"] }, github: { repo: "acme/pol", baseBranch: "dev" }, local: { path: "." }, roles: ["backend-developer"] }));

let n = 0;
const mk = (o: Partial<Parameters<typeof createItem>[0]> = {}) =>
  createItem({ projectId: "pol", source: "jira", kind: "ticket", sourceId: `w3p${++n}`, sourceRef: `KAN-${100 + n}`, title: `T${n}`, ...o });
const OWNER = { channel: "teams", owner: true };

test("directives: precedence item > batch > epic > sprint > global > settings", () => {
  const sprint = mk({ level: "sprint", title: "Sprint 12" });
  const epic = mk({ level: "epic", parentId: sprint.id });
  const batch = mk({ level: "batch", parentId: epic.id });
  const t = mk({ parentId: batch.id });
  const part = mk({ parentId: t.id, level: "part" });
  const other = mk();

  assert.equal(effective(t.id, "plan_approval").source, "settings");
  assert.equal(effective(t.id, "plan_approval").value, "ask");

  assert.ok(setDirective({ scope: "global", rule: "plan_approval", value: "skip" }, OWNER).ok);
  assert.equal(effective(t.id, "plan_approval").value, "skip");
  assert.equal(effective(other.id, "plan_approval").value, "skip");
  assert.ok(setDirective({ scope: "sprint", scopeId: sprint.id, rule: "plan_approval", value: "ask" }, OWNER).ok);
  assert.equal(effective(t.id, "plan_approval").scope, "sprint");
  assert.equal(effective(t.id, "plan_approval").value, "ask");
  assert.ok(setDirective({ scope: "epic", scopeId: epic.id, rule: "plan_approval", value: "skip" }, OWNER).ok);
  assert.equal(effective(t.id, "plan_approval").scope, "epic");
  assert.ok(setDirective({ scope: "batch", scopeId: batch.id, rule: "plan_approval", value: "ask" }, OWNER).ok);
  assert.equal(effective(t.id, "plan_approval").scope, "batch");
  assert.equal(effective(t.id, "plan_approval").value, "ask");
  // item by its ref (KAN-x) wins; a part inherits its ticket's item rule
  assert.ok(setDirective({ scope: "item", scopeId: t.source_ref, rule: "plan_approval", value: "no" }, OWNER).ok);
  assert.equal(effective(t.id, "plan_approval").scope, "item");
  assert.equal(effective(t.id, "plan_approval").value, "skip");
  assert.equal(effective(part.id, "plan_approval").value, "skip");
  assert.equal(effective(other.id, "plan_approval").value, "skip", "other items still follow global");

  // clearing the item rule falls back to the batch
  const c = clearDirective({ scope: "item", scopeId: t.id, rule: "plan_approval" }, OWNER);
  assert.ok(c.ok);
  if (c.ok) assert.equal(c.echo, `Back to normal for ${t.source_ref}: ask before the plan.`);
  assert.equal(effective(t.id, "plan_approval").scope, "batch");

  // replace (J6): a new value for the same scope deactivates the old one
  const r = setDirective({ scope: "batch", scopeId: batch.id, rule: "plan_approval", value: "skip" }, OWNER);
  assert.ok(r.ok && r.replaced);
  assert.equal(activeDirectives("batch", batch.id).filter((d) => d.rule === "plan_approval").length, 1);
  assert.equal(effective(t.id, "plan_approval").value, "skip");

  for (const d of activeDirectives()) clearDirective(d.id, OWNER);
  assert.equal(effective(t.id, "plan_approval").source, "settings");
});

test("directives: echo text, expiry, refusals", () => {
  const t = mk();
  const r = setDirective({ scope: "item", scopeId: t.id, rule: "plan_approval", value: "skip" }, OWNER);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.echo, `From now on for ${t.source_ref}: no plan approval.`);
  const g = setDirective({ scope: "global", rule: "auto_resolve", value: "yes" }, OWNER);
  if (g.ok) assert.equal(g.echo, "From now on: fix review comments without asking.");
  assert.equal(echoDirective({ scope: "global", scope_id: null, rule: "pr_approval", value: "skip", until_at: "2026-11-20T12:00:00Z" }), "From now on: no PR approval (until 20 Nov).");
  assert.match(describeInForce(t.id), /no plan approval/);

  // expired directives don't count
  db().prepare("UPDATE directives SET until_at=? WHERE scope='global' AND rule='auto_resolve'").run("2000-01-01T00:00:00Z");
  assert.equal(effective(t.id, "auto_resolve").source, "settings");

  // outside text can't set rules; rails and unknown rules refused
  const outside = setDirective({ scope: "global", rule: "pr_approval", value: "skip" }, { channel: "jira", owner: false });
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.match(outside.message, /Only your own messages/);
  const rail = setDirective({ scope: "global", rule: "force_push", value: true }, OWNER);
  assert.deepEqual(rail, { ok: false, message: RAIL_REFUSAL });
  const merge = setDirective({ scope: "global", rule: "auto_merge", value: true }, OWNER);
  assert.equal(merge.ok, false);
  assert.equal(setDirective({ scope: "global", rule: "made_up", value: 1 }, OWNER).ok, false);
  assert.equal(setDirective({ scope: "item", rule: "plan_approval", value: "skip" }, OWNER).ok, false, "item scope needs an item");
  assert.equal(setDirective({ scope: "global", rule: "plan_approval", value: "maybe" }, OWNER).ok, false);
  assert.equal(normaliseValue("budget_tokens", "200k"), 200000);
  assert.equal(normaliseValue("budget_tokens", "1.5m"), 1_500_000);
  assert.equal(normaliseValue("budget_tokens", "lots"), undefined);
  assert.equal(clearDirective("dr_nope", OWNER).ok, false);
  for (const d of activeDirectives()) clearDirective(d.id, OWNER);
});

test("gate: hard rails never change", () => {
  assert.equal(canMerge().verdict, "deny");
  assert.equal(checkRails("force_push")!.verdict, "deny");
  assert.equal(checkRails("push", { branch: "feature/x", force: true })!.rule, "never_force_push");
  for (const b of ["main", "dev", "develop", "refs/heads/master", "origin/main", "release/1.2"]) assert.ok(isProtectedBranch(b), b);
  assert.ok(isProtectedBranch("qa-env", "qa-env"), "the project's base branch is protected too");
  assert.equal(isProtectedBranch("feature/KAN-1-x"), false);
  assert.equal(checkRails("push", { branch: "aiw/KAN-1", secrets: 2 })!.rule, "secrets");
  assert.equal(checkRails("push", { branch: "aiw/KAN-1", files: ["src/a.ts", ".env.local"] })!.rule, "secrets");
  assert.deepEqual(forbiddenHits([".env", ".env.example", "a/.env.sample", "k.pem", "src/env.ts"]), [".env", "k.pem"]);
  assert.equal(checkRails("push", { branch: "aiw/KAN-1", origin: { kind: "outside", source: "a PR comment" } })!.rule, "untrusted_order");
  assert.equal(checkRails("push", { branch: "aiw/KAN-1", files: ["src/a.ts"] }), null);
  assert.deepEqual(protectedHits([".github/workflows/ci.yml", "src/a.ts", "api/Dockerfile", "infra/main.tf"]), [".github/workflows/ci.yml", "api/Dockerfile", "infra/main.tf"]);

  // no directive can lift a rail
  const t = mk();
  setDirective({ scope: "global", rule: "pr_approval", value: "skip" }, OWNER);
  assert.equal(canPush(t, { branch: "main" }).verdict, "deny");
  assert.equal(canPush(t, { branch: "aiw/x", base: "dev", force: true }).verdict, "deny");
  assert.equal(canCreatePr(t, { branch: "dev", base: "dev" }).verdict, "deny");
  assert.equal(canCreatePr(t, { branch: "aiw/x", base: "dev", secrets: [{}] }).verdict, "deny");
  assert.equal(canCreatePr(t, { branch: "aiw/x", base: "dev", files: [".github/workflows/ci.yml"] }).verdict, "ask", "protected paths still ask");
  assert.equal(canCreatePr(t, { branch: "aiw/x", base: "dev", files: ["src/a.ts"] }).verdict, "allow");
  assert.equal(canCreatePr(t, { branch: "aiw/x", base: "dev", origin: { kind: "outside", source: "Jira" } }).verdict, "deny");
  assert.equal(canComment(t, { target: "teammate_pr", origin: { kind: "outside", source: "an image" } }).verdict, "deny");
  for (const d of activeDirectives()) clearDirective(d.id, OWNER);
});

test("gate: approvals follow directives then settings (D5, F2)", () => {
  base();
  const t = mk({ priority: 3 });
  db().prepare("UPDATE tasks SET size='L' WHERE id=?").run(t.id);
  assert.equal(needsApproval("plan", t.id).ask, true);
  assert.equal(needsApproval("pr", t.id).ask, true);
  assert.equal(needsApproval("start", t.id).ask, true, "size L asks before start by default");
  assert.equal(needsApproval("ci_fix", t.id).ask, false, "autoFixCi default");
  assert.equal(needsApproval("comment_fix", t.id).ask, true);
  assert.equal(canCreateIssue(t.id).verdict, "ask");
  assert.equal(canCreateTicket(t.id).verdict, "ask");
  assert.equal(canComment(t.id, { target: "jira" }).verdict, "deny", "Jira comments off by default");

  // D5: "no approval needed" for this ticket
  setDirective({ scope: "item", scopeId: t.id, rule: "plan_approval", value: "skip" }, OWNER);
  setDirective({ scope: "item", scopeId: t.id, rule: "start_approval", value: "skip" }, OWNER);
  const p = needsApproval("plan", t.id);
  assert.deepEqual([p.ask, p.by], [false, "directive"]);
  assert.equal(needsApproval("start", t.id).ask, false);
  // F2: no PR approval
  setDirective({ scope: "item", scopeId: t.id, rule: "pr_approval", value: "skip" }, OWNER);
  assert.equal(canCreatePr(t.id, { branch: "aiw/x", base: "dev" }).verdict, "allow");
  assert.equal(canPush(t.id, { branch: "aiw/x", base: "dev" }).verdict, "allow");
  // CI auto-fix turned off by a directive
  setDirective({ scope: "item", scopeId: t.id, rule: "auto_fix_ci", value: false }, OWNER);
  assert.equal(canPush(t.id, { branch: "aiw/x", purpose: "ci_fix" }).verdict, "ask");
  // a teammate's branch always asks
  const theirs = mk({ owner: "priya" });
  assert.equal(canPush(theirs.id, { branch: "priya/feat", purpose: "ci_fix" }).verdict, "ask");
  // owner-typed order allows (rails still apply)
  assert.equal(canPush(t.id, { branch: "aiw/x", purpose: "ci_fix", origin: { kind: "owner" } }).verdict, "allow");
  assert.equal(canPush(t.id, { branch: "main", origin: { kind: "owner" } }).verdict, "deny");

  // settings path
  base((s) => { s.workflow.planApproval = "skip"; s.workflow.prApproval = "skip"; s.pr.autoQaIssues = true; s.notifications.jiraComments = true; });
  const u = mk();
  assert.equal(needsApproval("plan", u.id).ask, false);
  assert.equal(needsApproval("pr", u.id).by, "settings");
  assert.equal(canCreateIssue(u.id).verdict, "allow");
  assert.equal(canComment(u.id, { target: "jira" }).verdict, "allow");
  // a directive beats settings in the other direction too ("actually ask me before the PR")
  setDirective({ scope: "item", scopeId: u.id, rule: "pr_approval", value: "ask" }, OWNER);
  assert.equal(canCreatePr(u.id, { branch: "aiw/u", base: "dev" }).verdict, "ask");
  base((s) => { s.workflow.planApproval = "autonomy"; });
  assert.equal(needsApproval("plan", mk().id).ask, false, "autonomy: project is 'prepare'");
  base();
  for (const d of activeDirectives()) clearDirective(d.id, OWNER);
});

test("approvals: action filter and approve-with-change (D4)", () => {
  const t = mk();
  const pr = requestApproval(t.id, "create_pr", {});
  approveByPolicy(pr.id, "pr_approval");
  assert.equal(latestApproval(t.id)!.id, pr.id);
  assert.equal(latestApproval(t.id, "push_fixes"), undefined, "a ci_fix job doesn't see the create_pr approval");
  assert.equal(latestApproval(t.id, ["push_fixes", "create_pr"])!.state, "approved");

  const plan = requestApproval(t.id, "implement_plan", {});
  assert.equal(decideWithChange(plan.id, "   ", "me", "teams").ok, false);
  const d = decideWithChange(t.source_ref!, "skip the email part", "me", "teams");
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.equal(d.replan, true);
  assert.equal(d.approval.state, "approved");
  assert.equal(changeOf(d.approval), "skip the email part");
  assert.equal(getTask(t.id)!.data.replanPending, true);
  assert.deepEqual(pendingChanges(t.id).map((c) => c.change), ["skip the email part"]);
  markChangesApplied(t.id);
  assert.equal(pendingChanges(t.id).length, 0);
  assert.equal(getTask(t.id)!.data.replanPending, false);
  assert.equal(decideWithChange(plan.id, "again", "me", "teams").ok, false, "first decision wins");
  // a change on a PR approval is kept but doesn't re-plan
  const pr2 = requestApproval(t.id, "create_pr", {});
  const d2 = decideWithChange(pr2.id, "title: Refunds API", "me", "teams");
  assert.ok(d2.ok && !d2.replan);
  assert.equal(pendingChanges(t.id, "create_pr").length, 1);
});

test("budgets: 80% warning text, scope budgets, once per budget", () => {
  assert.equal(budgetState(79, 100), "ok");
  assert.equal(budgetState(80, 100), "warn");
  assert.equal(budgetState(100, 100), "over");
  assert.equal(budgetText("KAN-45", 490_000, 600_000), "KAN-45 has used 81% of its token budget (490k of 600k).");
  assert.equal(budgetText("KAN-45", 600_000, 600_000, true), "KAN-45 reached its token budget (600k). Paused – resume it to allow more.");
  assert.equal(budgetText("KAN-45", 700_000, 600_000, false), "KAN-45 went over its token budget (700k of 600k). Still running.");
  assert.equal(budgetText("KAN-45", 10, 600_000), "");

  const project = normaliseProject({ id: "pol", local: { path: "." }, roles: [] });
  const batch = mk({ level: "batch", title: "B" });
  const a = mk({ parentId: batch.id });
  const b = mk({ parentId: batch.id });
  setDirective({ scope: "batch", scopeId: batch.id, rule: "budget_tokens", value: "100k" }, OWNER);
  setDirective({ scope: "item", scopeId: a.id, rule: "budget_tokens", value: 50_000 }, OWNER);
  addUsage(a.id, 42_000, 0);
  addUsage(b.id, 40_000, 0);
  const lines = budgetLines(project, getTask(a.id)!);
  assert.deepEqual(lines.map((l) => [l.scope, l.used, l.limit, l.state]), [
    ["item", 42_000, 50_000, "warn"], ["batch", 82_000, 100_000, "warn"], ["day", 0, project.budget.dailyTokens, "ok"],
  ]);
  const c = checkScopeBudget(project, getTask(a.id)!);
  assert.equal(c.ok, true);
  assert.equal(c.warnings.length, 2);
  assert.match(c.text, new RegExp(`${a.source_ref} has used 84%`));
  assert.match(c.text, /batch .* has used 82%/);
  markBudgetWarned(a.id, c.warnings);
  assert.equal(checkScopeBudget(project, getTask(a.id)!).warnings.length, 0, "each warning once");

  addUsage(b.id, 20_000, 0);
  base((s) => { s.workflow.stopForBudget = true; });
  const stop = checkScopeBudget(project, getTask(a.id)!);
  assert.equal(stop.ok, false);
  assert.equal(stop.over!.scope, "batch");
  base();
  assert.equal(checkScopeBudget(project, getTask(a.id)!).ok, true, "default: report only, never stops");
  mergeData(a.id, {});
  for (const d of activeDirectives()) clearDirective(d.id, OWNER);
});
