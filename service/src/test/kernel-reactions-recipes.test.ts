import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type Settings } from "../core/config.js";
import { loadPlaybooks } from "../engine/playbooks.js";
import "../engine/steps.js";   // load the STEPS registry first (prFix.js and steps.js import each other)
import { MAX_CI_ROUNDS } from "../engine/prFix.js";
import type { Item, Job, KernelEvent, Reaction, Recipe } from "../kernel/types.js";
import { REACTIONS, reactionFor, match, routeEvents, validateReactions, CI_MAX_ROUNDS, type RouteDeps } from "../kernel/reactions.js";
import {
  loadRecipes, getRecipe, recipeFromPlaybook, nextStepIndex, advance, firstStepIndex, parseCondition, childSpecs, validate, validateWith, parseStep,
} from "../kernel/recipes.js";

const settings = (patch: (s: Settings) => void = () => {}): Settings => {
  const s: Settings = structuredClone(DEFAULT_SETTINGS);
  s.team = { me: { github: "arun" }, members: [] };
  patch(s);
  return s;
};

let n = 0;
const ev = (type: string, payload: Record<string, any> = {}, itemId: string | null = "i1"): KernelEvent => ({
  id: `e${++n}`, type, idem_key: `k${n}`, item_id: itemId, project_id: "p", source_ref: null, payload, handled_by: null,
  received_at: new Date().toISOString(), processed_at: null,
});

const item = (patch: Partial<Item> = {}): Item => ({
  id: "i1", project_id: "p", source: "jira", source_id: "KAN-1", source_ref: "KAN-1", title: "t", kind: "story", role: null, size: "M",
  playbook: "dev-feature", state: "PR_OPEN", priority: 3, step_index: 0, run_no: 1, tokens_used: 0, cost_usd: 0, worktree: null, branch: null,
  data: { pr: { number: 7, repo: "o/r" } }, error: null, created_at: "", updated_at: "",
  level: "ticket", parent_id: null, root_id: "i1", areas: [], owner: "me", due: null, ...patch,
});

const job = (data: Record<string, any> = {}): Job => ({
  id: "j1", item_id: "i1", type: "build", recipe: "x", state: "running", step_index: 0, attempts: 0, priority: 3, trigger_event: null,
  data, error: null, agent: null, activity: null, progress: null, activity_at: null, created_at: "", updated_at: "",
});

// ------------------------------------------------------------------ reactions: matching

test("reactions: each event type maps to the planned job", () => {
  const s = settings();
  const mine = item();
  const cases: [string, Record<string, any>, string, string][] = [
    ["ci_failed", {}, "ci_fix", "ci_fix"],
    ["ci_passed", {}, "none", "notify"],
    ["changes_requested", {}, "comment_fix", "comment_fix"],
    ["comment_added", {}, "none", "notify"],
    ["review_comment", {}, "none", "notify"],
    ["pr_conflict", {}, "rebase", "rebase"],
    ["new_commits", { by: "sneha" }, "rebase", "rebase"],
    ["ticket_changed", {}, "replan", "replan"],
    ["design_changed", {}, "replan", "replan"],
    ["pr_merged", {}, "close", "close"],
    ["pr_closed", {}, "none", "ask"],
    ["pr_approved", {}, "none", "notify"],
  ];
  for (const [type, payload, j, recipe] of cases) {
    const r = reactionFor(ev(type, payload), mine, s);
    assert.ok(r, `${type} has a reaction`);
    assert.equal(r!.job, j, type);
    assert.equal(r!.recipe, recipe, type);
  }
  // close-out moves PR_OPEN → MERGED → DONE itself (close_item, the recipe's last step), so the reaction sets no state
  assert.equal(reactionFor(ev("pr_merged"), mine, s)!.setState, undefined);
  assert.equal(reactionFor(ev("pr_closed"), mine, s)!.setState, "CLOSED");
  // no item needed
  assert.equal(reactionFor(ev("connector_down", { connector: "jira" }, null), undefined, s)!.recipe, "block");
  assert.equal(reactionFor(ev("connector_up", { connector: "jira" }, null), undefined, s)!.recipe, "resume");
  assert.equal(reactionFor(ev("teammate_pr_opened", { author: "sneha" }, null), undefined, s)!.recipe, "notify");
  // unknown event → ignored
  assert.equal(reactionFor(ev("something_new"), mine, s), undefined);
  assert.deepEqual(match(ev("something_new"), mine, s), []);
});

test("reactions: match returns job specs with defaults and the trigger event", () => {
  const e = ev("ci_failed");
  const specs = match(e, item(), settings());
  assert.equal(specs.length, 1);
  assert.deepEqual({ ...specs[0] }, { job: "ci_fix", recipe: "ci_fix", priority: 1, merge: "merge", setState: undefined, note: "CI failed → fix", itemId: "i1", triggerEvent: e.id });
  const t = match(ev("ticket_changed"), item({ state: "RUNNING" }), settings())[0];
  assert.equal(t.priority, 2);
  assert.equal(t.job, "replan");
});

// ------------------------------------------------------------------ reactions: guards

test("reactions guards: ci_fix only on our own open PR and within the round limit", () => {
  const s = settings();
  assert.equal(CI_MAX_ROUNDS, MAX_CI_ROUNDS, "same round limit as v1 prFix");
  // a teammate's item: nothing to fix
  assert.equal(reactionFor(ev("ci_failed"), item({ owner: "sneha" }), s), undefined);
  // the event says the PR is not ours
  assert.equal(reactionFor(ev("ci_failed", { ours: false }), item(), s), undefined);
  // the author is someone else
  assert.equal(reactionFor(ev("ci_failed", { author: "sneha" }), item(), s), undefined);
  // the author is me (case-insensitive) even without PR data on the item
  assert.equal(reactionFor(ev("ci_failed", { author: "Arun" }), item({ data: {} }), s)!.job, "ci_fix");
  // no PR raised here and no author: not ours
  assert.equal(reactionFor(ev("ci_failed"), item({ data: {} }), s), undefined);
  // no item at all
  assert.equal(reactionFor(ev("ci_failed", {}, null), undefined, s), undefined);
  // round limit: round 3 fixes, round 4 only tells you
  assert.equal(reactionFor(ev("ci_failed", { round: 3 }), item(), s)!.job, "ci_fix");
  const over = reactionFor(ev("ci_failed", { round: 4 }), item(), s)!;
  assert.equal(over.job, "none");
  assert.equal(over.recipe, "notify");
  assert.equal(reactionFor(ev("ci_failed"), item({ data: { pr: {}, fix: { ciRound: 5 } } }), s)!.job, "none");
  // a finished item starts no fix
  assert.equal(reactionFor(ev("ci_failed"), item({ state: "DONE" }), s)!.job, "none");
});

test("reactions guards: comments are fixed only when asked (command, directive or setting)", () => {
  assert.equal(reactionFor(ev("comment_added"), item(), settings())!.job, "none");
  assert.equal(reactionFor(ev("comment_added", { command: "resolve" }), item(), settings())!.job, "comment_fix");
  assert.equal(reactionFor(ev("comment_added"), item({ data: { pr: {}, directives: { auto_resolve: true } } }), settings())!.job, "comment_fix");
  assert.equal(reactionFor(ev("review_comment"), item(), settings((s) => { (s.pr as any).autoResolveComments = true; }))!.job, "comment_fix");
  // comments on a teammate's PR are not ours to fix or summarise
  assert.equal(reactionFor(ev("comment_added", { command: "resolve" }), item({ owner: "sneha" }), settings()), undefined);
  // changes requested on ours → fix (the gate still shows it first)
  assert.equal(reactionFor(ev("changes_requested"), item(), settings())!.job, "comment_fix");
});

test("reactions guards: review requests, teammates' new commits, own pushes, close-out", () => {
  assert.equal(reactionFor(ev("review_requested", {}, null), undefined, settings((s) => { s.pr.autoReview = false; }))!.job, "none");
  const r = reactionFor(ev("review_requested", {}, null), undefined, settings((s) => { s.pr.autoReview = true; }))!;
  assert.equal(r.job, "review");
  assert.equal(r.recipe, "pr-review");
  // new commits on a PR I reviewed → ask about a re-review
  assert.equal(reactionFor(ev("new_commits", { by: "sneha" }), item({ owner: "sneha" }), settings())!.recipe, "notify");
  // my own push to my PR → nothing
  assert.equal(reactionFor(ev("new_commits", { by: "arun" }), item(), settings()), undefined);
  // ticket changed on a cancelled item → nothing
  assert.equal(reactionFor(ev("ticket_changed"), item({ state: "CANCELLED" }), settings()), undefined);
  assert.equal(reactionFor(ev("ticket_changed"), undefined, settings()), undefined);
  // merged twice → the second is ignored
  assert.equal(reactionFor(ev("pr_merged"), item({ state: "MERGED" }), settings()), undefined);
});

test("reactions: every job row names a recipe that exists; table is plain data", () => {
  assert.deepEqual(validateReactions(loadRecipes(true).keys()), []);
  assert.deepEqual(validateReactions([]).length, REACTIONS.filter((r) => r.job !== "none").length);
  for (const r of REACTIONS) {
    assert.equal(typeof r.on, "string");
    assert.ok(r.note, `${r.on} has a note`);
  }
});

// ------------------------------------------------------------------ routing with fakes

test("routeEvents: enqueue → markHandled; none rows and ignored events; setState only on new jobs", () => {
  const items = new Map<string, Item>([["i1", item()], ["i2", item({ id: "i2", state: "PR_OPEN" })]]);
  const events = [ev("ci_failed", {}, "i1"), ev("ci_passed", {}, "i1"), ev("weird", {}, "i1"), ev("pr_conflict", {}, "missing"), ev("pr_merged", {}, "i2"), ev("pr_conflict", {}, "i1")];
  const handled: Record<string, string> = {};
  const enq: { itemId: string; r: Reaction }[] = [];
  const states: [string, string][] = [];
  let j = 0;
  const deps: RouteDeps = {
    pendingEvents: () => events,
    markHandled: (id, by) => { handled[id] = by; },
    getItem: (id) => items.get(id),
    enqueue: (itemId, r) => { enq.push({ itemId, r }); return r.job === "rebase" ? { job: job(), merged: true } : { job: { ...job(), id: `job${++j}` }, merged: false }; },
    setItemState: (id, to) => { states.push([id, to]); },
  };
  const count = routeEvents(settings(), deps);
  assert.equal(count, 3);
  assert.deepEqual(enq.map((x) => [x.itemId, x.r.job]), [["i1", "ci_fix"], ["i2", "close"], ["i1", "rebase"]]);
  assert.equal(handled[events[0].id], "job1");
  assert.equal(handled[events[1].id], "none:notify");
  assert.equal(handled[events[2].id], "ignored");
  assert.equal(handled[events[3].id], "ignored");
  assert.equal(handled[events[4].id], "job2");
  assert.equal(handled[events[5].id], "j1");
  assert.deepEqual(states, []);
  // a mailbox drop is marked ignored; an illegal state change does not stop routing
  const h2: Record<string, string> = {};
  const n2 = routeEvents(settings(), { ...deps, pendingEvents: () => [ev("pr_merged", {}, "i1"), ev("pr_closed", {}, "i1")], markHandled: (id, by) => { h2[id] = by; },
    enqueue: () => undefined, setItemState: () => { throw new Error("illegal"); } });
  assert.equal(n2, 0);
  assert.deepEqual(Object.values(h2), ["ignored", "none:ask"]);
  assert.throws(() => routeEvents(settings()), /useRouteDeps/);
});

// ------------------------------------------------------------------ recipes: playbook parity

test("recipes: every playbook loads as a recipe of the same name with the same steps and params", () => {
  const pbs = loadPlaybooks(true);
  const recipes = loadRecipes(true);
  assert.ok(pbs.size >= 13);
  for (const pb of pbs.values()) {
    const r = recipes.get(pb.id);
    assert.ok(r, `recipe for playbook ${pb.id}`);
    assert.equal(r!.title, pb.title);
    assert.deepEqual(r!.steps.map((s) => s.name), pb.steps.map((s) => s.name), pb.id);
    assert.deepEqual(r!.steps.map((s) => s.params), pb.steps.map((s) => s.params), pb.id);
    assert.ok(r!.steps.every((s) => s.when === undefined && s.goto === undefined && s.spawn_children === undefined), `${pb.id} has no branching`);
    assert.deepEqual(recipeFromPlaybook(pb), r);
    // all steps run in order: the walk visits exactly the playbook's steps
    const it = item({ size: "M" });
    const walked: string[] = [];
    for (let i = firstStepIndex(r!, job(), it); i !== -1; i = nextStepIndex(r!, i, job(), it)) walked.push(r!.steps[i].name);
    assert.deepEqual(walked, pb.steps.map((s) => s.name));
  }
  assert.equal(recipes.get("pr-fix")!.job, "comment_fix");
  assert.equal(recipes.get("pr-qa")!.job, "qa");
  assert.equal(recipes.get("pr-review")!.job, "review");
  assert.equal(recipes.get("dev-feature")!.job, "build");
  assert.equal(recipeFromPlaybook(pbs.get("dev-feature")!, "audit").job, "audit");
  assert.equal(getRecipe("dev-lead").name, "dev-lead");
  assert.throws(() => getRecipe("nope"), /Unknown recipe "nope"/);
});

test("recipes: yaml recipes load with their job types and reuse the existing FIX steps", () => {
  const recipes = loadRecipes(true);
  for (const [name, j] of [["ci_fix", "ci_fix"], ["comment_fix", "comment_fix"], ["rebase", "rebase"], ["close", "close"], ["replan", "replan"]]) {
    assert.equal(recipes.get(name)?.job, j, name);
  }
  const fixSteps = ["fix_prepare", "fix_plan", "fix_apply", "fix_review", "fix_gate", "fix_publish"];
  assert.deepEqual(getRecipe("ci_fix").steps.map((s) => s.name), fixSteps);
  assert.deepEqual(getRecipe("comment_fix").steps.map((s) => s.name), getRecipe("pr-fix").steps.map((s) => s.name));
  assert.deepEqual(getRecipe("ci_fix").steps[3].params, { reviewers: ["combined"] });
  const rp = getRecipe("replan");
  assert.equal(rp.steps.find((s) => s.name === "plan")!.when, "not_built");
});

// ------------------------------------------------------------------ recipes: when / goto / spawn_children

test("recipes: when skips steps on item size/data/state and job data; goto loops are bounded", () => {
  const r: Recipe = { name: "t", job: "build", steps: [
    parseStep("a"),
    parseStep({ name: "b", when: "size == S" }),
    parseStep({ name: "c", when: "size in [M, L]" }),
    parseStep({ name: "d", when: "!data.skipD" }),
    parseStep({ name: "e", when: "job.retry", goto: "c", max: 2 }),
    parseStep({ name: "f", when: "not_built" }),
    parseStep({ name: "g", spawn_children: "parts" }),
  ] };
  const walk = (it: Item, jb: Job) => {
    const seen: string[] = [];
    let data = { ...jb.data };
    for (let i = firstStepIndex(r, jb, it), guard = 0; i !== -1 && guard < 50; guard++) {
      seen.push(r.steps[i].name);
      const a = advance(r, i, { ...jb, data }, it);
      if (a.data) data = { ...data, ...a.data };
      i = a.next;
    }
    return seen;
  };
  assert.deepEqual(walk(item({ size: "S", data: {} }), job()), ["a", "b", "d", "f", "g"]);
  assert.deepEqual(walk(item({ size: "L", data: { skipD: true, implementation: {} } }), job()), ["a", "c", "g"]);
  // e runs (job.retry) and jumps back to c twice, then continues
  assert.deepEqual(walk(item({ size: "M", data: {} }), job({ retry: true })), ["a", "c", "d", "e", "c", "d", "e", "c", "d", "e", "f", "g"]);
  const a = advance(r, 4, job({ retry: true, gotos: { e: 1 } }), item());
  assert.equal(a.next, 2);
  assert.deepEqual(a.data, { gotos: { e: 2 } });
  assert.equal(nextStepIndex(r, 4, job({ retry: true, gotos: { e: 2 } }), item({ data: {} })), 5);
  assert.equal(nextStepIndex(r, 6, job(), item()), -1);
  // conditions
  assert.equal(parseCondition("state != DONE")!(item(), job()), true);
  assert.equal(parseCondition("data.pr.number == 7")!(item(), job()), true);
  assert.equal(parseCondition("level == 'ticket'")!(item(), job()), true);
  assert.equal(parseCondition("has_pr")!(item(), job()), true);
  assert.equal(parseCondition("bogus.path"), undefined);
  assert.equal(parseCondition("size >= M"), undefined);
  // spawn_children: the entries the runner makes children from
  assert.deepEqual(childSpecs(r.steps[6], job({ parts: [{ repo: "a" }, { repo: "b" }] })), [{ repo: "a" }, { repo: "b" }]);
  assert.deepEqual(childSpecs(r.steps[6], job()), []);
  assert.deepEqual(childSpecs(r.steps[0], job({ parts: [1] })), []);
});

// ------------------------------------------------------------------ validate()

test("validate: real recipes – only the new steps that STEPS does not have yet are reported", async () => {
  const problems = await validate(loadRecipes(true));
  const unknown = problems.filter((p) => p.problem.startsWith("unknown step")).map((p) => `${p.recipe}:${p.step}`).sort();
  // wave 3 built every after-PR step (rebase, re-plan, close-out), so no recipe names a missing step
  assert.deepEqual(unknown, []);
  const names = (r: string) => loadRecipes().get(r)!.steps.map((x) => x.name);
  for (const n of ["close_item", "clean_worktree", "retarget_stacked", "unblock_dependents"]) assert.ok(names("close").includes(n), `close has ${n}`);
  for (const n of ["rebase_prepare", "rebase_apply", "rebase_publish"]) assert.ok(names("rebase").includes(n), `rebase has ${n}`);
  for (const n of ["summarise_change", "ask_adapt"]) assert.ok(names("replan").includes(n), `replan has ${n}`);
  assert.deepEqual(problems.filter((p) => !p.problem.startsWith("unknown step")), []);
  // every playbook recipe is clean against the real STEPS
  const pbNames = new Set(loadPlaybooks().keys());
  assert.deepEqual(problems.filter((p) => pbNames.has(p.recipe)), []);
});

test("validate: reports bad conditions, goto targets, max, keys and job types", () => {
  const bad: Recipe = { name: "bad", job: "nonsense" as any, steps: [
    parseStep({ name: "a", when: "size >= M" }),
    parseStep({ name: "b", goto: "zzz", max: 0 }),
    parseStep({ name: "c", max: 2 }),
    parseStep({ name: "d", whne: "x" }),
    parseStep("mystery"),
  ] };
  const ps = validateWith(new Map([["bad", bad], ["empty", { name: "empty", job: "build", steps: [] }]]), new Set(["a", "b", "c", "d"]));
  const txt = ps.map((p) => `${p.recipe}:${p.step ?? ""}:${p.problem}`);
  for (const want of [
    'bad::unknown job type "nonsense"',
    'bad:a:unknown condition "size >= M"',
    'bad:b:goto "zzz" is not a step of this recipe',
    "bad:b:max must be a whole number of 1 or more",
    "bad:c:max without goto",
    "bad:d:unknown keys: whne",
    'bad:mystery:unknown step "mystery"',
    "empty::has no steps",
  ]) assert.ok(txt.includes(want), `missing: ${want}\n${txt.join("\n")}`);
  assert.throws(() => parseStep({ a: 1, b: 2 }), /Bad recipe step/);
});
