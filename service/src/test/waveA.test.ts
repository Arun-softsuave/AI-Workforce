import "./helpers.js";
import { makeRepo, sh } from "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { db } from "../core/db.js";
import { saveSettings, upsertProject, normaliseProject, DEFAULT_SETTINGS, type Settings, type ProjectConfig } from "../core/config.js";
import { createTask } from "../engine/tasks.js";
import { setDirective, effective } from "../policy/directives.js";
import { scopeRules, scopeViolations, repoExcluded, scopePrompt } from "../policy/scopeGuard.js";
import { envTestEnvironment } from "../engine/localStack.js";
import { extraAgentCommands, missingDocstrings, addedDependencies, dependencyFiles } from "../engine/standardsGuard.js";
import "../engine/steps.js";
import { strayFiles } from "../engine/steps.js";
import { shortenReply, moreReply } from "../messenger/details.js";
import { templateFor, TEMPLATES } from "../messenger/templates.js";

// Wave A (1.0.6): your stated requirements – directives enforced, the .env test database, standards, short messages.

saveSettings({ ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" } } as Settings);
const owner = { channel: "teams", owner: true };
const projects = [{ id: "nue-backend" }, { id: "nue-frontend" }];

test("B20: 'only backend' leaves the frontend repository out; 'don't touch tests' keeps test files out of the change", () => {
  assert.equal(repoExcluded({ id: "nue-frontend" }, { only: "backend" }, projects), true);
  assert.equal(repoExcluded({ id: "nue-backend" }, { only: "backend" }, projects), false);
  assert.equal(repoExcluded({ id: "nue-frontend" }, { only: "src/api" }, projects), false, "a folder rule is not about repositories");
  assert.equal(repoExcluded({ id: "shop" }, { only: "backend" }, [{ id: "shop" }]), false, "one repository only: never excluded");

  const files = ["app/api/orders.py", "tests/test_orders.py", "src/components/Order.test.tsx", "migrations/0042_add.py", "README.md"];
  assert.deepEqual(scopeViolations(files, { dontTouch: "tests" }).map((v) => v.file), ["tests/test_orders.py", "src/components/Order.test.tsx"]);
  assert.deepEqual(scopeViolations(files, { dontTouch: "migrations and docs" }).map((v) => v.file), ["migrations/0042_add.py", "README.md"]);
  assert.deepEqual(scopeViolations(files, { only: "app/api" }).map((v) => v.file), ["tests/test_orders.py", "src/components/Order.test.tsx", "migrations/0042_add.py", "README.md"]);
  assert.deepEqual(scopeViolations(files, { only: "backend" }), [], "a repository word does not limit files inside the repository");
  assert.match(scopePrompt({ only: "backend", dontTouch: "tests" }), /Change ONLY: backend[\s\S]*Do NOT change: tests/);
  assert.equal(scopePrompt({}), "");
});

test("B20: a rule given before the ticket exists is kept under its key and applies once it arrives (also to its repo parts)", () => {
  const r = setDirective({ scope: "item", scopeId: "KAN-990", rule: "dont_touch", value: "migrations" }, owner);
  assert.equal(r.ok, true, (r as any).message);
  const t = createTask({ projectId: "nue-backend", source: "jira", sourceId: "id-990", sourceRef: "KAN-990", title: "x", kind: "assigned", state: "QUEUED" as any, data: {} });
  assert.equal(effective(t.id, "dont_touch").value, "migrations");
  const part = createTask({ projectId: "nue-backend", source: "jira", sourceId: "id-990-b", sourceRef: "KAN-990@nue-backend", title: "x", kind: "part", state: "QUEUED" as any, data: {} });
  assert.deepEqual(scopeRules(part.id), { only: undefined, dontTouch: "migrations" });
});

test("R-DB: tests use the project's .env database, with background work switched off; an unreachable one is said plainly", async () => {
  const { repo } = makeRepo("envdb");
  const server = net.createServer(() => {}).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    fs.writeFileSync(path.join(repo, ".env"), `DATABASE_URL=postgresql://dev:pw@127.0.0.1:${port}/nue_dev\n`);
    const p = normaliseProject({ id: "envdb", local: { path: repo }, roles: ["fullstack-developer"],
      qa: { profile: { language: "python", database: { engine: "postgres", urlVars: ["DATABASE_URL"], syncUrlVars: [] }, quietEnv: [{ name: "CELERY_TASK_ALWAYS_EAGER", value: "1", why: "no workers" }] } } } as any) as ProjectConfig;
    upsertProject(p);
    const te = await envTestEnvironment(p, repo);
    assert.ok(!("error" in te), JSON.stringify(te));
    if (!("error" in te)) {
      assert.match(te.where, /the \.env database \(nue_dev\), background work off \(CELERY_TASK_ALWAYS_EAGER\)/);
      assert.equal(te.env.CELERY_TASK_ALWAYS_EAGER, "1");
      assert.equal(te.env.DATABASE_URL, undefined, "the app reads its own .env – nothing is pointed elsewhere");
    }
    fs.writeFileSync(path.join(repo, ".env"), "DATABASE_URL=postgresql://dev:pw@127.0.0.1:1/nue_dev\n");
    const off = await envTestEnvironment(p, repo);
    assert.match((off as any).error, /the \.env database \(postgresql:\/\/\*\*\*@127\.0\.0\.1:1\/nue_dev\) is not reachable/);
  } finally { server.close(); }
});

test("R-STD: stray files (debug scripts, logs, .env, tests outside the layout) are found; existing and real files are kept", () => {
  const { repo } = makeRepo("stray");
  const base = sh(repo, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  for (const [f, t] of [["src/orders.ts", "export const x = 1;\n"], ["debug_orders.py", "print(1)\n"], ["server.log", "x\n"], [".env.local", "A=1\n"], ["tests/test_orders.py", "def test_x(): pass\n"], ["scratch/try.ts", "1\n"]]) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), t);
  }
  sh(repo, "add", "-A", "-f"); sh(repo, "commit", "-q", "-m", "work");
  const ctx: any = { task: { data: { baseSha: base } }, project: { conventions: { standards: { tests: { dirs: ["tests/"], patterns: ["test_*.py"], count: 3 } } } } };
  const out = strayFiles(ctx, repo).map((x) => x.file).sort();
  assert.deepEqual(out, [".env.local", "debug_orders.py", "scratch/try.ts", "server.log"]);
});

test("E5 / E10: the agent may run the repository's lint-fix command and its package manager (lock file kept right)", () => {
  const { repo } = makeRepo("tools");
  fs.writeFileSync(path.join(repo, "uv.lock"), "");
  const cmds = extraAgentCommands({ local: { path: repo }, conventions: { checks: ["uv run ruff check {py}", "uv run ruff format --check {py}"] } } as any);
  assert.ok(cmds.includes("uv run ruff check --fix"), cmds.join(" | "));
  assert.ok(cmds.includes("uv run ruff format"), cmds.join(" | "));
  assert.ok(cmds.includes("uv add") && cmds.includes("uv lock"));
  assert.ok(!cmds.some((c) => /^npm /.test(c)), "no package manager the repository doesn't use");
  const diff = "+++ b/pyproject.toml\n@@ -1,3 +1,4 @@\n+    \"httpx>=0.27\",\n+++ b/package.json\n@@ -1 +1,2 @@\n+    \"zod\": \"^3.23.0\",\n";
  assert.deepEqual(addedDependencies(diff).sort(), ["httpx", "zod"]);
  assert.deepEqual(dependencyFiles(["src/a.ts", "uv.lock", "pyproject.toml"]), ["uv.lock", "pyproject.toml"]);
});

test("E6: new public functions without the team's doc comment are found (private ones and documented ones are not)", () => {
  const { repo } = makeRepo("docs");
  fs.mkdirSync(path.join(repo, "app"), { recursive: true });
  fs.writeFileSync(path.join(repo, "app", "svc.py"), [
    "def refund(order_id: int,", "           amount: int) -> None:", "    return None", "",
    "def documented() -> int:", '    """Return one."""', "    return 1", "",
    "def _private():", "    pass",
  ].join("\n"));
  const diff = "+++ b/app/svc.py\n@@ -0,0 +1,10 @@\n+def refund(order_id: int,\n+           amount: int) -> None:\n+    return None\n+\n+def documented() -> int:\n+    \"\"\"Return one.\"\"\"\n+    return 1\n+\n+def _private():\n+    pass\n";
  const rules = [{ language: "python", style: "google", coverage: 0.8, sampled: 40 }] as any;
  assert.deepEqual(missingDocstrings(repo, diff, rules).map((m) => m.name), ["refund"]);
  assert.deepEqual(missingDocstrings(repo, diff, [{ language: "python", style: "none", coverage: 0.1, sampled: 40 }] as any), [], "a team that writes none is left alone");
});

test("R-MSG: notices are at most 6 lines (questions never cut); a long chat reply is cut and the rest comes on 'more'", () => {
  for (const [k, t] of Object.entries(TEMPLATES)) if (t.maxLines) assert.ok(t.maxLines <= 6, `${k}: ${t.maxLines}`);
  assert.equal(templateFor("needs_info").maxLines, 0);
  const long = ["**Status**", ...Array.from({ length: 30 }, (_, i) => `- KAN-${i}: building`)].join("\n");
  const short = shortenReply(long);
  assert.ok(short.split("\n").length <= 15, short);
  assert.match(short, /say "more"/);
  const rest = moreReply("more")!;
  assert.match(rest, /KAN-2\d/);
  assert.equal(shortenReply("Reply 1 to approve\n" + Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")).includes("say \"more\""), false, "a reply with choices is never cut");
  db().prepare("DELETE FROM meta WHERE key='chat.moreText'").run();
  assert.equal(moreReply("more"), undefined);
});

test("prepublish (real git): a file your rule keeps out is put back, a stray debug script is left out, both are listed", async () => {
  const { STEPS, makeAgentCaller } = await import("../engine/steps.js");
  const { loadSettings } = await import("../core/config.js");
  const { repo } = makeRepo("prepub");
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  fs.writeFileSync(path.join(repo, "tests", "test_old.py"), "def test_old(): pass\n");
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "a test on the base"); sh(repo, "push", "-q", "origin", "HEAD:main");
  const base = sh(repo, "rev-parse", "HEAD");
  const base2 = base;
  sh(repo, "checkout", "-q", "-b", "feat/KAN-991-x");
  fs.writeFileSync(path.join(repo, "tests", "test_old.py"), "def test_old(): assert True\n");     // changed – but "don't touch tests"
  fs.writeFileSync(path.join(repo, "src", "refund.ts"), "export const refund = 1;\n");         // the real change
  fs.writeFileSync(path.join(repo, "debug_refund.py"), "print('x')\n");                         // a stray script
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "work");
  void base;
  const t = createTask({ projectId: "prepub", source: "jira", sourceId: "id-991", sourceRef: "KAN-991", title: "Refund", kind: "assigned", state: "IMPLEMENTING" as any, data: { baseSha: base2 } });
  setDirective({ scope: "item", scopeId: "KAN-991", rule: "dont_touch", value: "tests" }, owner);
  const p = normaliseProject({ id: "prepub", local: { path: repo }, roles: ["fullstack-developer"], github: { repo: "o/prepub", baseBranch: "main" } } as any) as ProjectConfig;
  upsertProject(p);
  const ctx: any = { task: { ...t, worktree: repo, branch: "feat/KAN-991-x", data: { ...t.data, baseSha: base2, testsUnavailable: { reason: "test" } } }, project: { ...p, github: undefined }, settings: loadSettings(),
    runner: undefined, params: {}, usage: { tokensIn: 0, tokensOut: 0, cost: 0, agents: [] },
    save: (patch: any) => { ctx.task = { ...ctx.task, data: { ...ctx.task.data, ...patch } }; return ctx.task; } };
  ctx.agent = makeAgentCaller(() => ctx);
  const r = await STEPS.prepublish(ctx);
  assert.equal(r.status, "ok", JSON.stringify(r));
  const changed = sh(repo, "diff", "--name-only", base2, "HEAD").split("\n").filter(Boolean).sort();
  assert.deepEqual(changed, ["src/refund.ts"], "only the real change is left");
  assert.equal(fs.readFileSync(path.join(repo, "tests", "test_old.py"), "utf8").replace(/\r\n/g, "\n"), "def test_old(): pass\n");
  const warnings: string[] = ctx.task.data.prepublishWarnings;
  assert.ok(warnings.some((w) => /Left out of the PR: debug_refund\.py \((scratch \/ |ad-hoc )debug script\)/.test(w)), warnings.join(" | "));
  assert.ok(warnings.some((w) => /Put back as they were.*tests\/test_old\.py – you said don't touch tests/.test(w)), warnings.join(" | "));
});
