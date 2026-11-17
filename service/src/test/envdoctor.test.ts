import "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkEnvironment, envReport, satisfies, requiredPython, requiredNode, pythonPackages, composeServices, databaseTarget, clearEnvCache, type ExecFn } from "../engine/envDoctor.js";
import { freePort } from "../engine/localStack.js";

const win = process.platform === "win32";
function tmpRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiw-env-"));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
}
/** A fake shell: answers by the first matching pattern; records every command. */
function fakeExec(rules: [RegExp, { code: number; output: string }][]): ExecFn & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (cmd: string) => { calls.push(cmd); for (const [re, r] of rules) if (re.test(cmd)) return r; return { code: 1, output: "not found" }; }) as unknown as ExecFn & { calls: string[] };
  f.calls = calls;
  return f;
}
const neverUp = async () => false;
const byName = (r: { checks: { name: string }[] }, n: string) => (r.checks as any[]).find((c) => c.name === n);

test("versions: common requirement forms", () => {
  assert.equal(satisfies("3.11.4", "3.11"), true);
  assert.equal(satisfies("3.12.1", "3.11"), false);
  assert.equal(satisfies("3.11.4", ">=3.10,<3.13"), true);
  assert.equal(satisfies("3.13.0", ">=3.10,<3.13"), false);
  assert.equal(satisfies("3.11.2", "~=3.11"), true);
  assert.equal(satisfies("4.0.0", "~=3.11"), false);
  assert.equal(satisfies("3.12.0", "^3.11"), true);
  assert.equal(satisfies("v22.1.0", ">=18 <21"), false);
  assert.equal(satisfies("v20.11.0", ">= 18 < 21"), true);
  assert.equal(satisfies("v18.2.0", "16 || 18"), true);
  assert.equal(satisfies("v20.0.0", "18.x"), false);
  assert.equal(satisfies("v20.5.0", "v20"), true);
  assert.equal(satisfies("v20.5.0", "lts/*"), undefined);
  const py = tmpRepo({ "pyproject.toml": "[project]\nname='x'\nrequires-python = \">=3.10\"\ndependencies = [\"fastapi>=0.110\", \"PyYAML\", 'sqlalchemy[asyncio]']\n" });
  assert.deepEqual(requiredPython(py), { spec: ">=3.10", from: "pyproject.toml" });
  assert.deepEqual(pythonPackages(py), ["fastapi", "PyYAML", "sqlalchemy"]);
  const nd = tmpRepo({ "package.json": JSON.stringify({ engines: { node: ">=20" } }), ".nvmrc": "v18.19.0\n" });
  assert.deepEqual(requiredNode(nd), { spec: "v18.19.0", from: ".nvmrc" });
});

test("node repo without node_modules: blocked with the install command", async () => {
  const repo = tmpRepo({ "package.json": JSON.stringify({ name: "web", engines: { node: ">=20" }, dependencies: { react: "^18" } }), "package-lock.json": "{}" });
  const exec = fakeExec([[/^node --version/, { code: 0, output: "v22.3.0" }]]);
  const r = await checkEnvironment(repo, { exec, connect: neverUp, envNames: [] });
  assert.equal(r.ok, false);
  assert.equal(byName(r, "Node version").ok, true);
  assert.equal(byName(r, "Node packages").ok, false);
  assert.match(byName(r, "Node packages").detail, /node_modules is missing/);
  const text = envReport(r);
  assert.match(text, /^Tests can't run: node_modules is missing\. Fix: Run `npm ci`\.$/);

  // installed → ready; a wrong Node version is caught
  fs.mkdirSync(path.join(repo, "node_modules", "react"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "react", "package.json"), "{}");
  const ok = await checkEnvironment(repo, { exec, connect: neverUp, envNames: [], force: true });
  assert.equal(ok.ok, true, envReport(ok));
  assert.equal(envReport(ok), "Ready");
  const old = await checkEnvironment(repo, { exec: fakeExec([[/^node --version/, { code: 0, output: "v18.0.0" }]]), connect: neverUp, envNames: [], force: true });
  assert.equal(byName(old, "Node version").ok, false);
  assert.match(envReport(old), /Node 18\.0\.0 is installed, but package\.json engines asks for >=20/);
});

test("python repo without a venv: blocked; with a venv whose Python is broken: blocked; healthy: ready", async () => {
  const repo = tmpRepo({ "requirements.txt": "# deps\nfastapi==0.110\npython-dotenv>=1\n-r dev.txt\n", ".python-version": "3.11\n" });
  const exec = fakeExec([[/--version$/, { code: 0, output: "Python 3.11.9" }], [/ -c /, { code: 0, output: "MISSING:fastapi,python-dotenv" }]]);
  const r = await checkEnvironment(repo, { exec, connect: neverUp, envNames: [] });
  assert.equal(r.ok, false);
  assert.equal(byName(r, "Python version").ok, true);
  assert.equal(byName(r, "Python environment").ok, false);
  assert.match(envReport(r), /No virtual environment \(\.venv\) found\. Fix: Run `python -m venv \.venv` then .*pip install -r requirements\.txt`/);
  // the import check asked for the right import names
  assert.ok(exec.calls.some((c) => / fastapi:fastapi python-dotenv:dotenv$/.test(c)), exec.calls.join("\n"));

  const py = path.join(repo, ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(py, "");
  const broken = await checkEnvironment(repo, { exec: fakeExec([[/--version$/, { code: 1, output: "No Python at 'C:\\old\\python.exe'" }]]), connect: neverUp, envNames: [], force: true });
  assert.equal(byName(broken, "Python version").ok, false);
  assert.match(byName(broken, "Python version").detail, /The project's Python \(\.venv\) does not start/);

  const missingPkg = await checkEnvironment(repo, { exec: fakeExec([[/--version$/, { code: 0, output: "Python 3.11.9" }], [/ -c /, { code: 0, output: "MISSING:fastapi" }]]), connect: neverUp, envNames: [], force: true });
  assert.equal(byName(missingPkg, "Python packages").ok, false);
  assert.match(byName(missingPkg, "Python packages").detail, /Missing or broken: fastapi/);

  const wrongVer = await checkEnvironment(repo, { exec: fakeExec([[/--version$/, { code: 0, output: "Python 3.12.1" }], [/ -c /, { code: 0, output: "MISSING:" }]]), connect: neverUp, envNames: [], force: true });
  assert.equal(byName(wrongVer, "Python version").ok, false);
  assert.match(byName(wrongVer, "Python version").detail, /\.python-version asks for 3\.11/);

  const good = await checkEnvironment(repo, { exec: fakeExec([[/--version$/, { code: 0, output: "Python 3.11.9" }], [/ -c /, { code: 0, output: "MISSING:" }]]), connect: neverUp, envNames: [], force: true });
  assert.equal(good.ok, true, envReport(good));
});

test(".env: missing keys are listed by name, values never appear", async () => {
  const repo = tmpRepo({ ".env.example": "APP_NAME=\nSECRET_KEY=\nSTRIPE_KEY=changeme\n", ".env": "APP_NAME=very-private-value-123\n" });
  const r = await checkEnvironment(repo, { exec: fakeExec([]), connect: neverUp, envNames: [] });
  const c = byName(r, ".env");
  assert.equal(c.ok, false);
  assert.equal(c.detail, "Missing in .env: SECRET_KEY, STRIPE_KEY.");
  const all = JSON.stringify(r) + envReport(r);
  assert.ok(!all.includes("very-private-value-123") && !all.includes("changeme"));
  // set in the environment counts as present
  const r2 = await checkEnvironment(repo, { exec: fakeExec([]), connect: neverUp, envNames: ["SECRET_KEY", "STRIPE_KEY"], force: true });
  assert.equal(byName(r2, ".env").ok, true);
  // no .env at all
  const none = tmpRepo({ ".env.example": "A=1\n" });
  const r3 = await checkEnvironment(none, { exec: fakeExec([]), connect: neverUp, envNames: [] });
  assert.match(envReport(r3), /No \.env file\. Fix: Copy \.env\.example to \.env/);
});

test("database: a closed port blocks the tests; the login is never shown", async () => {
  const port = await freePort();                                      // nothing listens there now
  const repo = tmpRepo({
    ".env": `DATABASE_URL=postgresql+asyncpg://nue:hunter2pw@localhost:${port}/market\n`,
    "docker-compose.yml": `services:\n  db:\n    image: postgres:16\n    ports: ["${port}:5432"]\n  cache:\n    image: redis:7\n    ports:\n      - "127.0.0.1:6390:6379"\n  search:\n    image: opensearchproject/opensearch:2\n    ports: ["9205:9200"]\n  api:\n    build: .\n    ports: ["8000:8000"]\n`,
  });
  assert.deepEqual(composeServices(repo).map((s) => `${s.name}:${s.port}`), [`db:${port}`, "cache:6390", "search:9205"]);
  assert.deepEqual(databaseTarget(repo), { from: "DATABASE_URL", host: "localhost", port, engine: "postgres" });
  const r = await checkEnvironment(repo, { exec: fakeExec([]), envNames: [] });   // the real TCP check
  const c = byName(r, "Database");
  assert.equal(c.ok, false);
  assert.equal(c.detail, `The database (DATABASE_URL) does not answer at localhost:${port}.`);
  assert.equal(c.fix, "Start it: `docker compose up -d db`.");
  assert.equal(byName(r, "Service cache").ok, false);                 // a cache the tests need
  assert.equal(byName(r, "Service search").ok, true);                 // other services: a note only
  assert.equal(byName(r, "Service search").warn, true);
  assert.equal(byName(r, "Service api"), undefined);                  // the app itself is not a service the tests need
  assert.equal(byName(r, `Service db`), undefined);                   // already checked as the database
  const all = JSON.stringify(r) + envReport(r);
  assert.ok(!all.includes("hunter2pw") && !all.includes("nue:"));

  // DB_HOST / DB_PORT names, reachable through the injected connect
  const r2 = tmpRepo({ ".env": "DB_HOST=db.internal\nDB_PORT=6543\nDB_PASSWORD=zzz-secret\n" });
  const seen: string[] = [];
  const up = await checkEnvironment(r2, { exec: fakeExec([]), connect: async (h, p, ms) => { seen.push(`${h}:${p}:${ms}`); return true; }, envNames: [] });
  assert.deepEqual(seen, ["db.internal:6543:2000"]);
  assert.equal(up.ok, true);
  assert.ok(!JSON.stringify(up).includes("zzz-secret"));
});

test("cache: one hour per repository, force and the clock decide", async () => {
  const repo = tmpRepo({ "package.json": JSON.stringify({ name: "lib" }) });
  const exec = fakeExec([[/^node --version/, { code: 0, output: "v22.3.0" }]]);
  let now = Date.parse("2026-11-17T10:00:00Z");
  const opts = { exec, connect: neverUp, envNames: [], now: () => now };
  const a = await checkEnvironment(repo, opts);
  assert.equal(a.ok, true);
  assert.equal(a.cached, undefined);
  assert.equal(exec.calls.length, 1);
  now += 30 * 60_000;
  const b = await checkEnvironment(repo, opts);
  assert.equal(b.cached, true);
  assert.equal(exec.calls.length, 1);
  await checkEnvironment(repo, { ...opts, force: true });
  assert.equal(exec.calls.length, 2);
  now += 61 * 60_000;
  const d = await checkEnvironment(repo, opts);
  assert.equal(d.cached, undefined);
  assert.equal(exec.calls.length, 3);
  clearEnvCache(repo);
  await checkEnvironment(repo, opts);
  assert.equal(exec.calls.length, 4);
});

test("smoke test: runs only when everything else passes; its failure blocks", async () => {
  const repo = tmpRepo({ "package.json": JSON.stringify({ name: "lib" }) });
  const exec = fakeExec([[/^node --version/, { code: 0, output: "v22.3.0" }]]);
  let ran = 0;
  const bad = await checkEnvironment(repo, { exec, connect: neverUp, envNames: [], smoke: async () => { ran++; return { ok: false, detail: "1 test could not be collected.", fix: "Run `npm ci`." } } });
  assert.equal(ran, 1);
  assert.equal(bad.ok, false);
  assert.equal(envReport(bad), "Tests can't run: 1 test could not be collected. Fix: Run `npm ci`.");
  const broken = tmpRepo({ "package.json": JSON.stringify({ dependencies: { x: "1" } }) });
  await checkEnvironment(broken, { exec, connect: neverUp, envNames: [], smoke: async () => { ran++; return { ok: true, detail: "" }; } });
  assert.equal(ran, 1);                                               // not run: node_modules is missing
  // the default Python smoke check collects tests only
  const py = tmpRepo({ "requirements.txt": "", "tests/test_a.py": "" });
  const pyExec = fakeExec([[/--version$/, { code: 0, output: "Python 3.12.0" }], [/pytest --collect-only/, { code: 0, output: "3 tests collected in 0.1s" }]]);
  const vpy = path.join(py, ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
  fs.mkdirSync(path.dirname(vpy), { recursive: true }); fs.writeFileSync(vpy, "");
  const s = await checkEnvironment(py, { exec: pyExec, connect: neverUp, envNames: [], smoke: true });
  assert.equal(s.ok, true, envReport(s));
  assert.match(byName(s, "Smoke test").detail, /finds 3 tests/);
});

test("missing folder", async () => {
  const r = await checkEnvironment(path.join(os.tmpdir(), "aiw-no-such-repo-xyz"), { exec: fakeExec([]), connect: neverUp });
  assert.equal(r.ok, false);
  assert.match(envReport(r), /Folder not found/);
});
