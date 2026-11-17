import { makeRepo, testHome } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, getProject } from "../core/config.js";
import { setSecret } from "../core/secrets.js";
import { readDotEnv, parseDbUrl, redactUrl, demoAccount, isPythonBackend, testEnvironment, tempDatabase, setTempDatabaseFactory, liveStackFor } from "../engine/localStack.js";
import { runTests, testCommandOf, type StepCtx } from "../engine/steps.js";
import type { Task } from "../engine/tasks.js";

/**
 * Local testing: test suites never reach the .env database (they drop tables) – they get a temporary one; the demo
 * login comes from the team's E2E account or one saved locally; without a safe database the tests are NOT run.
 */
saveSettings({ ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" } });

// a Python backend whose .env points at the developer's (or a shared) database
const { repo: api } = makeRepo("api");
fs.writeFileSync(path.join(api, "pyproject.toml"), "[project]\nname='api'\n");
fs.mkdirSync(path.join(api, "tests"));
fs.writeFileSync(path.join(api, ".env"), [
  "# local dev",
  "DATABASE_URL=postgresql+asyncpg://nue:secret@db.shared.example:5432/nue_market",
  "DATABASE_URL_SYNC=postgresql://nue:secret@db.shared.example:5432/nue_market",
  "VALKEY_URL=redis://127.0.0.1:1/0",
  "APP_ENV='development'  # comment",
].join("\n"));
// the "test command" records which database it was given
fs.writeFileSync(path.join(api, "record-db.js"), "require('fs').writeFileSync('db-used.txt', process.env.DATABASE_URL || 'none');\n");
const record = "node record-db.js";
upsertProject(normaliseProject({ id: "api", group: "shop", local: { path: api, testCommand: record }, roles: ["backend-developer"], autonomy: "prepare" }));
const { repo: web } = makeRepo("web");
upsertProject(normaliseProject({ id: "web", group: "shop", local: { path: web }, roles: ["frontend-developer"], autonomy: "prepare" }));

const ctxFor = (projectId: string): StepCtx => ({ task: { id: "t_local", data: {}, source_ref: "KAN-1" } as unknown as Task, project: getProject(projectId)!, settings: DEFAULT_SETTINGS, runner: undefined as any, params: {}, usage: { tokensIn: 0, tokensOut: 0, cost: 0, agents: [] }, agent: undefined as any, save: () => ({}) as any });

test(".env parsing and database URLs", () => {
  const env = readDotEnv(api);
  assert.equal(env.APP_ENV, "development");
  assert.equal(parseDbUrl(env.DATABASE_URL)?.host, "db.shared.example");
  assert.equal(parseDbUrl(env.DATABASE_URL)?.db, "nue_market");
  assert.equal(redactUrl(env.DATABASE_URL), "postgresql+asyncpg://***@db.shared.example:5432/nue_market");
  assert.ok(isPythonBackend(api));
  assert.ok(!isPythonBackend(web));
});

test("test suites get a TEMPORARY database – never the .env one – and it is removed afterwards", async () => {
  let dropped = 0;
  setTempDatabaseFactory(async () => ({ where: "local", asyncUrl: "postgresql+asyncpg://u:p@127.0.0.1:5432/qa_temp_1", syncUrl: "postgresql://u:p@127.0.0.1:5432/qa_temp_1", cleanup: () => { dropped++; } }));
  const ctx = ctxFor("api");
  const cmd = testCommandOf(ctx)!;
  const r = await runTests(ctx, cmd, api);
  assert.equal(r.code, 0, r.output);
  const used = fs.readFileSync(path.join(api, "db-used.txt"), "utf8");
  assert.equal(used, "postgresql+asyncpg://u:p@127.0.0.1:5432/qa_temp_1");
  assert.doesNotMatch(used, /nue_market|shared/);
  assert.equal(dropped, 1, "the temporary database is dropped");
  const te = await testEnvironment(getProject("api")!, api, "x");
  assert.ok(!("error" in te) && te.env.DATABASE_URL_SYNC === "postgresql://u:p@127.0.0.1:5432/qa_temp_1" && te.env.TEST_DATABASE_URL.includes("qa_temp_1"));
  if (!("error" in te)) te.cleanup();
});

test("no safe database (no local PostgreSQL, no Docker): the tests are NOT run at all", async () => {
  setTempDatabaseFactory(undefined);
  fs.rmSync(path.join(api, "db-used.txt"), { force: true });
  const ctx = ctxFor("api");
  const r = await runTests(ctx, testCommandOf(ctx)!, api);
  assert.ok(r.envError, "reported as an environment problem");
  assert.ok(!fs.existsSync(path.join(api, "db-used.txt")), "the test command never ran against the .env database");
  const direct = await tempDatabase(getProject("api")!, "y");
  assert.ok("error" in direct);
});

test("a frontend's tests are not touched (no database rewiring)", async () => {
  fs.writeFileSync(path.join(web, "x.txt"), "");
  const ctx = { ...ctxFor("web") };
  const r = await runTests(ctx, `node -e "process.exit(0)"`, web);
  assert.equal(r.code, 0);
  assert.equal(r.envError, undefined);
});

test("demo login: the team's E2E account from an env file, else one saved with aiw qa account; never asked in chat", async () => {
  assert.equal(demoAccount(getProject("web")!), undefined);
  const live = await liveStackFor(getProject("web")!, undefined, "t");
  assert.ok("reason" in live);
  fs.writeFileSync(path.join(web, ".env.local"), "E2E_EMAIL=buyer@example.com\nE2E_PASSWORD=pw-from-env\n");
  assert.deepEqual(demoAccount(getProject("web")!), { email: "buyer@example.com", password: "pw-from-env", source: "the team's test account (E2E_EMAIL)" });
  setSecret("qa.web.email", "qa-demo@example.com");
  setSecret("qa.web.password", "saved-pw");
  assert.equal(demoAccount(getProject("web")!)?.email, "qa-demo@example.com", "the account saved on this computer wins");
  assert.ok(fs.existsSync(testHome));
});

// ---------------------------------------------------------------- dynamic: every repository by its own profile

import { builtInProfile, profileOf, ensureProfile } from "../engine/testProfile.js";

test("built-in rules per stack: Django, Express + Postgres, a Next.js frontend", () => {
  const { repo: dj } = makeRepo("dj");
  fs.writeFileSync(path.join(dj, "requirements.txt"), "django\n"); fs.writeFileSync(path.join(dj, "manage.py"), "");
  const d = builtInProfile(normaliseProject({ id: "dj", local: { path: dj }, roles: [] }));
  assert.equal(d.start, "{python} manage.py runserver 127.0.0.1:{port} --noreload");
  assert.equal(d.migrate, "{python} manage.py migrate --noinput");
  const { repo: ex } = makeRepo("ex");
  fs.writeFileSync(path.join(ex, "package.json"), JSON.stringify({ scripts: { test: "jest", start: "node server.js" }, dependencies: { express: "4", pg: "8" } }));
  const e = builtInProfile(normaliseProject({ id: "ex", local: { path: ex }, roles: [] }));
  assert.deepEqual([e.role, e.database.engine, e.testCommand, e.testFiles], ["backend", "postgres", "npm test", "after-dashdash"]);
  const { repo: nx } = makeRepo("nx");
  fs.writeFileSync(path.join(nx, "package.json"), JSON.stringify({ dependencies: { next: "15", react: "19" } }));
  const n = builtInProfile(normaliseProject({ id: "nx", local: { path: nx }, roles: [] }));
  assert.deepEqual([n.role, n.build, n.start, n.frontend.backendUrlVar, n.database.engine], ["frontend", "npx next build", "npx next start -p {port}", "BACKEND_ORIGIN", "none"]);
});

test("the detected profile drives everything – e.g. a repository whose database variable is PG_URL", async () => {
  const { repo: node } = makeRepo("nodeapi");
  fs.writeFileSync(path.join(node, ".env"), "PG_URL=postgres://app:x@db.shared.example:5432/app\n");
  upsertProject(normaliseProject({ id: "nodeapi", local: { path: node, testCommand: "node t.js" }, roles: [] }));
  // what the profiler found in the repository (the agent is faked here)
  await ensureProfile(getProject("nodeapi")!, async () => ({ data: { role: "backend", language: "node", start: "node server.js --port {port}", database: { engine: "postgres", urlVars: ["PG_URL"], syncUrlVars: [] }, testCommand: "npm test", testFiles: "after-dashdash" } }));
  const p = profileOf(getProject("nodeapi")!);
  assert.equal(p.source, "detected");
  assert.deepEqual(p.database.urlVars, ["PG_URL"]);
  setTempDatabaseFactory(async () => ({ where: "local", asyncUrl: "postgres://u:p@127.0.0.1:5432/qa_tmp", syncUrl: "postgres://u:p@127.0.0.1:5432/qa_tmp", cleanup: () => {} }));
  const te = await testEnvironment(getProject("nodeapi")!, node, "z");
  assert.ok(!("error" in te));
  if (!("error" in te)) { assert.equal(te.env.PG_URL, "postgres://u:p@127.0.0.1:5432/qa_tmp"); assert.equal(te.env.DATABASE_URL, undefined); assert.equal(te.env.PYTHONPATH, undefined); }
  setTempDatabaseFactory(undefined);
  // projects.yaml wins over what was detected
  upsertProject({ ...getProject("nodeapi")!, qa: { profile: { health: "/status" } } });
  assert.equal(profileOf(getProject("nodeapi")!).health, "/status");
});

test("SQLite projects get a temporary database file, removed afterwards", async () => {
  const { repo: lite } = makeRepo("lite");
  upsertProject(normaliseProject({ id: "lite", local: { path: lite }, roles: [], qa: { profile: { database: { engine: "sqlite", urlVars: ["DATABASE_URL"], syncUrlVars: [] }, testCommand: "node t.js" } } }));
  const db = await tempDatabase(getProject("lite")!, "s");
  assert.ok(!("error" in db));
  if (!("error" in db)) {
    assert.equal(db.where, "file");
    assert.match(db.syncUrl, /^sqlite:\/\/\/.*qa_s_.*\.db$/);
    db.cleanup();
  }
});

import { testsForChange, onlyCoverageFailed } from "../engine/localStack.js";
import { execFileSync } from "node:child_process";

test("only the tests for the change run; a coverage minimum alone is not a test failure", () => {
  const { repo } = makeRepo("sel");
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "chat"), { recursive: true });
  for (const f of ["tests/test_refund.py", "tests/test_other.py", "src/chat/quick-chips.test.tsx", "src/chat/quick-chips.tsx"]) fs.writeFileSync(path.join(repo, f), "x");
  execFileSync("git", ["add", "-A"], { cwd: repo }); execFileSync("git", ["commit", "-q", "-m", "t"], { cwd: repo });
  assert.deepEqual(testsForChange(repo, ["src/services/refund.ts", "src/chat/quick-chips.tsx"]).sort(), ["src/chat/quick-chips.test.tsx", "tests/test_refund.py"]);
  assert.deepEqual(testsForChange(repo, ["README.md"]), [], "nothing matches → the whole suite");
  assert.equal(onlyCoverageFailed("12 passed in 3.1s\nERROR: Coverage failure: total of 43 is less than fail-under=80"), true);
  assert.equal(onlyCoverageFailed("1 failed, 11 passed in 3.1s\nERROR: Coverage failure: total of 43 is less than fail-under=80"), false);
  assert.equal(onlyCoverageFailed("1 error in 2.0s\nERROR: Coverage failure: total of 43 is less than fail-under=80"), false);
  assert.equal(onlyCoverageFailed("3 failed"), false);
});

import { withResults, testRunPassed } from "../engine/localStack.js";

test("exact pytest results from its result file – a coverage minimum alone never fails a passing run", () => {
  const r = withResults("python -m pytest -q tests/test_x.py");
  const file = /--junitxml="([^"]+)"/.exec(r.cmd)![1];
  fs.writeFileSync(file, '<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" skipped="1" tests="37" time="3.2"><testcase/></testsuite></testsuites>');
  const counts = r.read();
  assert.deepEqual(counts, { tests: 37, failures: 0, errors: 0 });
  const coverageOnly = { code: 1, output: ".....\nFAIL Required test coverage of 80% not reached. Total coverage: 43.21%" };
  assert.equal(testRunPassed(coverageOnly, counts), true);
  assert.equal(testRunPassed(coverageOnly, { tests: 37, failures: 1, errors: 0 }), false);
  assert.equal(testRunPassed({ code: 1, output: "boom" }, { tests: 0, failures: 0, errors: 0 }), false, "nothing ran → not passed");
  assert.equal(withResults("npm test").cmd, "npm test", "other runners are left alone");
});
