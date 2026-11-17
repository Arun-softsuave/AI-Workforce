import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type Settings } from "../core/config.js";
import "../engine/steps.js";   // load the STEPS registry first (prFix.js and steps.js import each other)
import { isLegacyCiPlan, type FixItem } from "../engine/prFix.js";
import { parseWorkflow } from "../brain/ciPipeline.js";
import { classifyCheck, dependencyFix, toolOf } from "../engine/steps/ciClass.js";
import { routeEvents, type RouteDeps } from "../kernel/reactions.js";
import { createItem, getItem } from "../kernel/items.js";
import { reopenForOpenPr } from "../kernel/prs.js";
import { db } from "../core/db.js";
import type { Item, Job, KernelEvent, Reaction } from "../kernel/types.js";

// PR #131 (nue-backend): a lint job with an "eval" helper step, a regression replay, a pip-audit failure,
// conflicts on a ticket the old engine had ended at DONE.

const CI_YML = `
name: CI
on: [pull_request]
jobs:
  lint:
    name: Lint & Format
    steps:
      - name: Run ruff lint
        run: uv run ruff check .
      - name: Run ruff format check
        run: uv run ruff format --check .
      - name: Check eval scenarios have not leaked into prompts
        run: python scripts/check_leaks.py
      - name: Run mypy
        run: uv run mypy app/
  replay:
    name: Regression replay (synthetic catalogue)
    steps:
      - run: uv run python scripts/run_regression.py --replay
  deps:
    name: Dependency Vulnerability Scan
    steps:
      - run: uv export --no-emit-project > req.txt && uvx pip-audit -r req.txt
`;

const PIP_AUDIT = `Found 1 known vulnerability, ignored 3 in 1 package
Name      Version ID              Fix Versions
--------- ------- --------------- ------------
dnspython 2.9.0   CVE-2026-128089 2.9.2

Name  Skip Reason
----- ---------------------------------------
torch Dependency not found on PyPI
##[error]Process completed with exit code 1.`;

test("a lint job is not 'needs a person' because a helper step mentions an eval; a replay job is", () => {
  const jobs = parseWorkflow("ci.yml", CI_YML);
  const by = (n: string) => jobs.find((j) => j.name === n)!;
  assert.equal(by("Lint & Format").fixable, "auto");
  assert.equal(by("Lint & Format").localCommand, "uv run ruff check .");
  assert.equal(by("Regression replay (synthetic catalogue)").fixable, "human");
  assert.equal(by("Dependency Vulnerability Scan").fixable, "careful");
});

test("a vulnerable dependency is fixed by the package manager when the repo has its lock file", () => {
  assert.deepEqual(dependencyFix(PIP_AUDIT, ["uv.lock"]), { packages: ["dnspython"], command: "uv lock --upgrade-package dnspython" });
  assert.deepEqual(dependencyFix(PIP_AUDIT, ["poetry.lock"]), { packages: ["dnspython"], command: "poetry update dnspython" });
  assert.equal(dependencyFix(PIP_AUDIT, []), undefined, "requirements pins are left to the code agent");
  assert.equal(dependencyFix("all good", ["uv.lock"]), undefined);
  assert.equal(toolOf("uv lock --upgrade-package dnspython"), "uv");

  const ci = { files: ["ci.yml"], jobs: parseWorkflow("ci.yml", CI_YML), detectedAt: "" };
  const dep = classifyCheck({ check: { name: "Dependency Vulnerability Scan", conclusion: "failure" }, log: PIP_AUDIT, ci, lockfiles: ["uv.lock"] });
  assert.equal(dep.cls, "auto");
  assert.equal(dep.fixCommand, "uv lock --upgrade-package dnspython");
  assert.deepEqual(dep.dependency, ["dnspython"]);
  const replay = classifyCheck({ check: { name: "Regression replay (synthetic catalogue)", conclusion: "failure" }, log: "ALT-02 FAIL -> FAIL changed", ci });
  assert.equal(replay.cls, "human");
  assert.match(replay.needs!, /baseline must be re-recorded by a person/);
});

test("a fix planned before the CI rules existed is recognised and looked at again", () => {
  const old: FixItem[] = [{ n: 1, kind: "check", id: "c:1", check: "Regression replay", author: "CI", body: "" }];
  const now: FixItem[] = [{ n: 1, kind: "check", id: "c:1", check: "Lint", author: "CI", body: "", ciClass: "auto" }];
  assert.equal(isLegacyCiPlan(old), true);
  assert.equal(isLegacyCiPlan(now), false);
  assert.equal(isLegacyCiPlan([{ n: 1, kind: "thread", id: "t1", author: "a", body: "" }]), false);
  assert.equal(isLegacyCiPlan(undefined), false);
});

// ------------------------------------------------------------------ routing

const settings = (): Settings => { const s: Settings = structuredClone(DEFAULT_SETTINGS); s.team = { me: { github: "arun" }, members: [] }; return s; };
let n = 0;
const ev = (type: string, payload: Record<string, any> = {}, itemId = "i1"): KernelEvent => ({
  id: `e${++n}`, type, idem_key: `k${n}`, item_id: itemId, project_id: "p", source_ref: null, payload, handled_by: null,
  received_at: new Date().toISOString(), processed_at: null,
} as KernelEvent);
const item = (patch: Partial<Item> = {}): Item => ({
  id: "i1", project_id: "p", source: "jira", source_id: "KAN-52", source_ref: "KAN-52@nue-backend", title: "t", kind: "part", role: null, size: "M",
  playbook: "dev-part", state: "DONE", priority: 3, step_index: 0, run_no: 1, tokens_used: 0, cost_usd: 0, worktree: null, branch: null,
  data: { pr: { number: 131, repo: "o/r" } }, error: null, created_at: "", updated_at: "",
  level: "part", parent_id: null, root_id: "i1", areas: [], owner: "me", due: null, ...patch,
} as Item);
const job = (): Job => ({ id: "job1", item_id: "i1", type: "rebase", recipe: "rebase", state: "queued", step_index: 0, attempts: 0, priority: 2,
  trigger_event: null, data: {}, error: null, agent: null, activity: null, progress: null, activity_at: null, created_at: "", updated_at: "" } as Job);

test("a conflict on a ticket the old engine ended at DONE reopens it (PR open) and starts a rebase job", () => {
  let it = item();
  const handled: Record<string, string> = {};
  const enq: string[] = [];
  const told: string[] = [];
  const e = ev("pr_conflict", { repo: "o/r", num: 131, base: "dev", ours: true });
  const deps: RouteDeps = {
    pendingEvents: () => [e],
    markHandled: (id, by) => { handled[id] = by; },
    getItem: () => it,
    enqueue: (_id, r: Reaction) => { enq.push(r.job); return { job: job(), merged: false }; },
    setItemState: () => {},
    reopenForOpenPr: () => (it = { ...it, state: "PR_OPEN" }),
    tell: (x) => { told.push(x.type); },
  };
  assert.equal(routeEvents(settings(), deps), 1);
  assert.deepEqual(enq, ["rebase"]);
  assert.equal(handled[e.id], "job1");
  assert.deepEqual(told, []);
});

test("a conflict no job can take is never silent: you get one line", () => {
  const it = item({ state: "CANCELLED" });
  const handled: Record<string, string> = {};
  const told: string[] = [];
  const e = ev("pr_conflict", { repo: "o/r", num: 131, base: "dev", ours: true });
  const deps: RouteDeps = {
    pendingEvents: () => [e], markHandled: (id, by) => { handled[id] = by; }, getItem: () => it,
    enqueue: () => { throw new Error("no job expected"); }, tell: (x, i) => { told.push(`${x.type}:${i?.state}`); },
  };
  assert.equal(routeEvents(settings(), deps), 0);
  assert.equal(handled[e.id], "none:notify");
  assert.deepEqual(told, ["pr_conflict:CANCELLED"]);
});

test("reopenForOpenPr: DONE with an open PR → PR_OPEN; merged or no PR stays DONE", () => {
  const mk = (ref: string, data: Record<string, any>) => {
    const it = createItem({ projectId: "nue-backend", source: "jira", kind: "part", sourceId: ref, sourceRef: ref, title: ref, data } as any);
    db().prepare("UPDATE tasks SET state='DONE' WHERE id=?").run(it.id);
    return it.id;
  };
  const open = mk("KAN-52@b", { pr: { number: 131, repo: "o/r" } });
  const merged = mk("KAN-40@b", { pr: { number: 134, repo: "o/r", merged: true } });
  const none = mk("KAN-9@b", {});
  assert.equal(reopenForOpenPr(open)?.state, "PR_OPEN");
  assert.equal(getItem(open)?.state, "PR_OPEN");
  assert.equal(reopenForOpenPr(merged)?.state, "DONE");
  assert.equal(reopenForOpenPr(none)?.state, "DONE");
});
