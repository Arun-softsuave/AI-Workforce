import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { ProjectConfig } from "../core/config.js";
import { loadProjects } from "../core/config.js";
import { paths, ensureDir } from "../core/paths.js";
import { getSecret } from "../core/secrets.js";
import { getMeta, setMeta } from "../core/db.js";
import { logger } from "../core/log.js";
import * as G from "../git/git.js";
import { profileOf, type TestProfile } from "./testProfile.js";

/**
 * Testing on THIS computer, for ANY project – everything follows the repository's test profile (testProfile.ts:
 * detected from the repository itself), local first, Docker only when local is not possible:
 *
 *  The running app (QA's live checks, PR screenshots):
 *    1. the database in the project's .env (shared or local) – when its login really works
 *    2. otherwise a temporary database on this computer's database server (created, migrated, dropped afterwards)
 *    3. otherwise a temporary database in Docker (Docker Desktop is started when it is installed)
 *  Test suites NEVER use the .env database – they drop and recreate tables. They always get a temporary database
 *  (local server first, Docker second); without one they do not run at all.
 *  Ports: always free ones; the developer's own running servers are never touched.
 *  Demo login: the team's test account (the profile's login variables, e.g. E2E_EMAIL / E2E_PASSWORD) or the one
 *  saved with `aiw qa account <project>`. Real people's accounts are never used; no user is created in a login service.
 */

// ------------------------------------------------------------------ small helpers

export function readDotEnv(dir: string, files = [".env", ".env.local"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    let text = "";
    try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if (/^["']/.test(v)) v = v.replace(/^(["'])(.*)\1.*$/, "$2");
      else v = v.replace(/\s+#.*$/, "");
      out[m[1]] = v;
    }
  }
  return out;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

export function reachable(host: string, port: number, ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

interface DbUrl { scheme: string; user: string; password: string; host: string; port: number; db: string; query: string }
const DEFAULT_PORT: Record<string, number> = { postgres: 5432, mysql: 3306, mongo: 27017 };
export function parseDbUrl(u?: string): DbUrl | undefined {
  const m = /^([\w+]+):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?]+)(?::(\d+))?\/([^?]*)(\?.*)?$/.exec(u ?? "");
  if (!m) return undefined;
  const engine = /mongo/i.test(m[1]) ? "mongo" : /mysql|maria/i.test(m[1]) ? "mysql" : "postgres";
  return { scheme: m[1], user: decodeURIComponent(m[2] ?? ""), password: decodeURIComponent(m[3] ?? ""), host: m[4], port: Number(m[5] ?? DEFAULT_PORT[engine]), db: m[6], query: m[7] ?? "" };
}
const dbUrl = (d: DbUrl, over: Partial<DbUrl> = {}) => {
  const x = { ...d, ...over };
  return `${x.scheme}://${x.user ? `${encodeURIComponent(x.user)}${x.password ? `:${encodeURIComponent(x.password)}` : ""}@` : ""}${x.host}:${x.port}/${x.db}${x.query}`;
};
const isLocalHost = (h: string) => /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/i.test(h);
export const redactUrl = (u: string) => u.replace(/\/\/[^@/]*@/, "//***@");
const firstOf = (env: Record<string, string>, keys: string[]) => keys.map((k) => env[k]).find(Boolean);

// ------------------------------------------------------------------ the project (from its test profile)

/** Kept for callers that only need "is this a Python backend". */
export function isPythonBackend(dir: string): boolean {
  return ["pyproject.toml", "requirements.txt", "setup.py"].some((f) => fs.existsSync(path.join(dir, f))) && (fs.existsSync(path.join(dir, "tests")) || fs.existsSync(path.join(dir, "app")));
}

/**
 * Its test suite needs a database (so it must get a temporary one, never the .env one). True for any repository whose
 * profile names a database engine and a test command – Python, Node, Java, … alike.
 */
export function testsNeedDatabase(project: ProjectConfig): boolean {
  const p = profileOf(project);
  return p.database.engine !== "none" && !!p.testCommand;
}

/** The first Python of the project that can actually run (a broken .venv is skipped). */
export function findPython(dir: string): string | undefined {
  const win = process.platform === "win32";
  const cands = [".venv-local", ".venv", "venv", "env"].map((v) => path.join(dir, v, win ? "Scripts" : "bin", win ? "python.exe" : "python")).filter((p) => fs.existsSync(p));
  for (const py of [...cands, win ? "python" : "python3"]) {
    try { execFileSync(py, ["-c", "import sys; print(sys.version)"], { cwd: dir, stdio: "pipe", timeout: 20_000, windowsHide: true }); return py; } catch { /* try the next */ }
  }
  return undefined;
}

/** Fill {python} / {port} in a profile command; undefined when it needs a Python and none works. */
function fill(cmd: string, dir: string, port?: number): string | undefined {
  if (!cmd) return undefined;
  let out = cmd;
  if (out.includes("{python}")) { const py = findPython(dir); if (!py) return undefined; out = out.split("{python}").join(`"${py}"`); }
  if (port !== undefined) out = out.split("{port}").join(String(port));
  return out;
}

/** The project's test command (with its working Python filled in), plus the files to run when given. */
export function profileTestCommand(project: ProjectConfig, files: string[] = []): string | undefined {
  const p = profileOf(project);
  const cmd = fill(p.testCommand, project.local.path);
  if (!cmd) return undefined;
  if (!files.length || p.testFiles === "none") return cmd;
  // a few files never reach a whole-suite coverage minimum – that would fail a passing run
  const noCov = /pytest/.test(cmd) && /fail[-_ ]?under|--cov/i.test(p.notes) ? " --no-cov" : "";
  return `${cmd}${noCov} ${p.testFiles === "after-dashdash" ? "-- " : ""}${files.join(" ")}`;
}
/** @deprecated use profileTestCommand */
export const pythonTestCommand = profileTestCommand;

// ------------------------------------------------------------------ running SQL (whatever this computer has)

/** Run one SQL statement on a server: the project's Python drivers, else the server's own command-line tool. */
function execSql(project: ProjectConfig, engine: string, url: string, sql: string): void {
  const dir = project.local.path;
  const py = findPython(dir);
  const plain = url.replace(/^postgres(ql)?\+\w+:/, "postgresql:").replace(/^mysql\+\w+:/, "mysql:");
  if (py) {
    const script = path.join(ensureDir(path.join(paths.worktrees(), ".qa")), `sql-${process.pid}-${Date.now()}.py`);
    const pg = ["try:", "    import psycopg", "    with psycopg.connect(url, autocommit=True) as c: c.execute(sql)", "except ImportError:", "    try:", "        import psycopg2",
      "        c = psycopg2.connect(url); c.autocommit = True; c.cursor().execute(sql); c.close()", "    except ImportError:", "        import asyncio, asyncpg",
      "        async def run():", "            c = await asyncpg.connect(url)", "            try: await c.execute(sql)", "            finally: await c.close()", "        asyncio.run(run())"];
    const my = ["from urllib.parse import urlparse", "u = urlparse(url)", "try:", "    import pymysql as m", "except ImportError:", "    import MySQLdb as m",
      "c = m.connect(host=u.hostname, port=u.port or 3306, user=u.username or 'root', password=u.password or '', autocommit=True)", "c.cursor().execute(sql); c.close()"];
    fs.writeFileSync(script, ["import os", "url = os.environ['AIW_SQL_URL']; sql = os.environ['AIW_SQL']", ...(engine === "mysql" ? my : pg)].join("\n"));
    try { execFileSync(py, [script], { cwd: dir, stdio: "pipe", timeout: 60_000, windowsHide: true, env: { ...process.env, AIW_SQL_URL: plain, AIW_SQL: sql } }); return; }
    catch (e: any) { if (!/No module named/.test(String(e.stderr ?? ""))) throw e; }
    finally { fs.rmSync(script, { force: true }); }
  }
  // no driver in Python: the server's command-line client
  const bin = clientTool(engine);
  if (!bin) throw new Error(`no ${engine} client found (no Python driver and no ${engine === "mysql" ? "mysql" : "psql"} tool)`);
  if (engine === "mysql") {
    const u = parseDbUrl(plain)!;
    execFileSync(bin, ["-h", u.host, "-P", String(u.port), "-u", u.user || "root", "-e", sql], { stdio: "pipe", timeout: 60_000, windowsHide: true, env: { ...process.env, MYSQL_PWD: u.password } });
  } else {
    execFileSync(bin, [plain, "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: "pipe", timeout: 60_000, windowsHide: true });
  }
}

/** psql / mysql on PATH or in the usual install folders. */
function clientTool(engine: string): string | undefined {
  const name = engine === "mysql" ? "mysql" : "psql";
  try { execFileSync(name, ["--version"], { stdio: "pipe", timeout: 10_000, windowsHide: true }); return name; } catch { /* not on PATH */ }
  if (process.platform !== "win32") return undefined;
  const roots = engine === "mysql" ? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "MySQL")] : [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PostgreSQL")];
  for (const r of roots) {
    try {
      for (const v of fs.readdirSync(r).sort().reverse()) {
        const exe = path.join(r, v, "bin", `${name}.exe`);
        if (fs.existsSync(exe)) return exe;
      }
    } catch { /* not installed */ }
  }
  return undefined;
}

/** Does this login really work on this server (not just "the port is open")? */
async function loginWorks(project: ProjectConfig, engine: string, u: DbUrl): Promise<boolean> {
  if (!(await reachable(u.host, u.port))) return false;
  if (engine === "mongo") return true;                                   // no generic client – the app will tell
  try { execSql(project, engine, dbUrl({ ...u, query: "" }), "SELECT 1"); return true; } catch { return false; }
}

// ------------------------------------------------------------------ Docker (fallback only)

function docker(args: string[], timeout = 120_000): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, windowsHide: true }).trim();
}
async function dockerReady(): Promise<boolean> {
  if (process.env.AIW_NO_DOCKER === "1") return false;
  try { docker(["info", "--format", "{{.ServerVersion}}"], 20_000); return true; } catch { /* not running */ }
  // installed but not running: start Docker Desktop and wait (Windows / macOS)
  const desktop = process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe") : "/Applications/Docker.app";
  if (!fs.existsSync(desktop)) return false;
  try { spawn(process.platform === "win32" ? desktop : "open", process.platform === "win32" ? [] : ["-a", "Docker"], { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch { return false; }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try { docker(["info", "--format", "{{.ServerVersion}}"], 10_000); return true; } catch { /* still starting */ }
  }
  return false;
}

const IMAGES: Record<string, { image: string; port: number; env: (pw: string) => string[]; url: (pw: string, port: number) => DbUrl }> = {
  postgres: { image: "postgres:16-alpine", port: 5432, env: (pw) => ["-e", `POSTGRES_PASSWORD=${pw}`, "-e", "POSTGRES_DB=qa"], url: (pw, port) => ({ scheme: "postgresql", user: "postgres", password: pw, host: "127.0.0.1", port, db: "qa", query: "" }) },
  mysql: { image: "mysql:8", port: 3306, env: (pw) => ["-e", `MYSQL_ROOT_PASSWORD=${pw}`, "-e", "MYSQL_DATABASE=qa"], url: (pw, port) => ({ scheme: "mysql", user: "root", password: pw, host: "127.0.0.1", port, db: "qa", query: "" }) },
  mongo: { image: "mongo:7", port: 27017, env: () => [], url: (_pw, port) => ({ scheme: "mongodb", user: "", password: "", host: "127.0.0.1", port, db: "qa", query: "" }) },
  redis: { image: "valkey/valkey:8-alpine", port: 6379, env: () => [], url: (_pw, port) => ({ scheme: "redis", user: "", password: "", host: "127.0.0.1", port, db: "0", query: "" }) },
};

/** A throw-away server container on a free port. */
async function dockerServer(kind: keyof typeof IMAGES, tag: string, image?: string): Promise<{ url: DbUrl; cleanup: () => void } | undefined> {
  if (!(await dockerReady())) return undefined;
  const spec = { ...IMAGES[kind], image: image ?? IMAGES[kind].image };
  const port = await freePort();
  const name = `aiw-qa-${kind}-${tag}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 60);
  const pw = Math.random().toString(36).slice(2, 14);
  const rm = () => { try { docker(["rm", "-f", name], 60_000); } catch { /* gone */ } };
  try {
    rm();
    docker(["run", "-d", "--name", name, ...spec.env(pw), "-p", `127.0.0.1:${port}:${spec.port}`, spec.image], 10 * 60_000);
    for (let i = 0; i < 60 && !(await reachable("127.0.0.1", port)); i++) await new Promise((r) => setTimeout(r, 1000));
    await new Promise((r) => setTimeout(r, kind === "mysql" ? 15_000 : 3000));   // servers accept connections a moment after the port opens
    return { url: spec.url(pw, port), cleanup: rm };
  } catch (e: any) {
    logger.warn("docker server failed", { kind, error: e.message });
    rm();
    return undefined;
  }
}

// ------------------------------------------------------------------ databases

export interface TempDb { where: "local" | "docker" | "file"; asyncUrl: string; syncUrl: string; cleanup: () => void }

/** Tests replace the database factory (no database server or Docker needed). */
let tempDbOverride: ((project: ProjectConfig, tag: string) => Promise<TempDb | { error: string }>) | undefined;
export function setTempDatabaseFactory(f: typeof tempDbOverride): void { tempDbOverride = f; }

/**
 * A temporary, empty database for test suites (or for the app when no .env database works), for the project's engine:
 * this computer's server first (the login saved with `aiw qa database <project>`, else the .env login – LOCAL servers
 * only, never a shared one), Docker second. SQLite gets a temporary file.
 */
export async function tempDatabase(project: ProjectConfig, tag: string): Promise<TempDb | { error: string }> {
  if (tempDbOverride) return tempDbOverride(project, tag);
  const prof = profileOf(project);
  const engine = prof.database.engine;
  const env = readDotEnv(project.local.path);
  const appUrl = firstOf(env, prof.database.urlVars);
  const appScheme = parseDbUrl(appUrl)?.scheme;
  const name = `qa_${tag.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 20)}_${Date.now().toString(36)}`;
  if (engine === "none") return { error: "the project's tests use no database" };
  if (engine === "sqlite") {
    const f = path.join(ensureDir(path.join(paths.worktrees(), ".qa")), `${name}.db`);
    const scheme = /^sqlite\+\w+/.exec(appUrl ?? "")?.[0] ?? "sqlite";
    return { where: "file", syncUrl: `sqlite:///${f.replace(/\\/g, "/")}`, asyncUrl: `${scheme}:///${f.replace(/\\/g, "/")}`, cleanup: () => fs.rmSync(f, { force: true }) };
  }
  const errors: string[] = [];
  const base = parseDbUrl(firstOf(env, prof.database.syncUrlVars) ?? appUrl);
  if (engine === "postgres" || engine === "mysql") {
    const saved = parseDbUrl(getSecret(`qa.${project.id}.dbUrl`));
    const envLocal = base ? (isLocalHost(base.host) ? base : { ...base, host: "127.0.0.1", port: DEFAULT_PORT[engine] }) : undefined;
    const candidates = [saved, envLocal].filter((x): x is DbUrl => !!x && isLocalHost(x.host));
    for (const local of candidates) {
      if (!(await reachable(local.host, local.port))) { errors.push(`nothing listens on ${local.host}:${local.port}`); continue; }
      try {
        const admin = dbUrl({ ...local, query: "" }, { db: engine === "mysql" ? "" : "postgres" });
        execSql(project, engine, admin, engine === "mysql" ? `CREATE DATABASE \`${name}\`` : `CREATE DATABASE "${name}"`);
        const sync = dbUrl({ ...local, scheme: base?.scheme && !appScheme ? base.scheme : local.scheme, query: "" }, { db: name });
        return {
          where: "local", syncUrl: sync, asyncUrl: dbUrl({ ...local, scheme: appScheme ?? local.scheme, query: base?.query ?? "" }, { db: name }),
          cleanup: () => { try { execSql(project, engine, admin, engine === "mysql" ? `DROP DATABASE IF EXISTS \`${name}\`` : `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } catch (e: any) { logger.warn("drop temp db failed", { db: name, error: e.message }); } },
        };
      } catch (e: any) { errors.push(`local ${engine} (${local === saved ? "saved login" : ".env login"}): ${String(e.stderr ?? e.message).split("\n").filter(Boolean).pop()}`); }
    }
    if (!candidates.length) errors.push(`no local database login (run \`aiw qa database ${project.id}\` once)`);
  }
  // the profile says which extensions the schema needs (e.g. pgvector) – use an image that has them
  const image = engine === "postgres" && /pgvector|vector extension/i.test(`${prof.notes} ${JSON.stringify(prof.database)}`) ? "pgvector/pgvector:pg16" : undefined;
  const d = await dockerServer(engine as "postgres" | "mysql" | "mongo", name, image);
  if (d) {
    const sync = dbUrl(d.url);
    const asyncScheme = appScheme ?? d.url.scheme;
    return { where: "docker", syncUrl: sync, asyncUrl: dbUrl({ ...d.url, scheme: asyncScheme, query: /asyncpg/.test(asyncScheme) ? "?ssl=disable" : "" }), cleanup: d.cleanup };
  }
  errors.push("Docker is not available");
  return { error: `no temporary database could be created (${errors.join("; ")})` };
}

/** Cache (Redis/Valkey) for the app: the .env one if reachable, a local one, else Docker; none when not needed / possible. */
async function cacheFor(prof: TestProfile, env: Record<string, string>, tag: string): Promise<{ key?: string; url?: string; cleanup?: () => void }> {
  const key = prof.cache.urlVars.find((k) => env[k]) ?? prof.cache.urlVars[0];
  if (!key) return {};
  const cur = env[key];
  const m = /^rediss?:\/\/(?:[^@/]*@)?([^:/]+)(?::(\d+))?/.exec(cur ?? "");
  if (m && await reachable(m[1], Number(m[2] ?? 6379))) return { key, url: cur };
  if (!cur) return {};                                                    // the project does not configure one
  for (const port of [6379, 6380]) if (await reachable("127.0.0.1", port)) return { key, url: `redis://127.0.0.1:${port}/0` };
  const d = await dockerServer("redis", tag);
  return d ? { key, url: `redis://127.0.0.1:${d.url.port}/0`, cleanup: d.cleanup } : { key };
}

// ------------------------------------------------------------------ test suites with a safe database

/**
 * Environment for a project's test suite: every database variable of its profile points at a TEMPORARY database (never
 * the .env one), the code under test is the given folder, plus a cache when one is configured. Call cleanup() after.
 */
export async function testEnvironment(project: ProjectConfig, wt: string, tag: string): Promise<{ env: Record<string, string>; where: string; cleanup: () => void } | { error: string }> {
  const prof = profileOf(project);
  const db = await tempDatabase(project, tag);
  if ("error" in db) return db;
  const dotenv = readDotEnv(project.local.path);
  const cache = await cacheFor(prof, dotenv, tag);
  const env: Record<string, string> = { CI: "1" };
  if (prof.language === "python") env.PYTHONPATH = wt;
  if (dotenv.APP_ENV) env.APP_ENV = /prod/i.test(dotenv.APP_ENV) ? "test" : dotenv.APP_ENV;
  for (const k of prof.database.urlVars) env[k] = db.asyncUrl;
  for (const k of prof.database.syncUrlVars) env[k] = db.syncUrl;
  if (cache.key && cache.url) env[cache.key] = cache.url;
  return { env, where: `a ${db.where === "file" ? "temporary file" : `${db.where} temporary`} database${cache.key && !cache.url ? ", no cache" : ""}`, cleanup: () => { db.cleanup(); cache.cleanup?.(); } };
}

// ------------------------------------------------------------------ the running backend (QA live checks)

export interface Stack { api: string; origin: string; port: number; db: string; stop: () => Promise<void> }

/**
 * Start a backend (at a commit) on a free port, the way its profile says. Database: the .env one first (shared or
 * local) when its login works, otherwise a temporary one with the schema applied. stop() removes everything it created.
 */
export async function startBackend(project: ProjectConfig, sha: string, tag: string, log: (s: string) => void = () => {}): Promise<Stack | { error: string }> {
  const prof = profileOf(project);
  const repo = project.local.path;
  const port = await freePort();
  const startCmd = fill(prof.start, repo, port);
  if (!startCmd) return { error: prof.start ? `no working runtime to start ${project.id} (e.g. no working Python)` : `don't know how to start ${project.id} (set qa.profile.start in projects.yaml)` };
  const dotenv = readDotEnv(repo);
  const wt = path.join(ensureDir(path.join(paths.worktrees(), project.id)), `${tag}-api`);
  if (fs.existsSync(wt)) G.removeWorktree(repo, wt);
  G.git(repo, ["worktree", "add", "--detach", wt, sha]);
  const links = project.conventions?.env?.linkedDirs ?? [];
  for (const d of links) { const src = path.join(repo, d); if (fs.existsSync(src) && !fs.existsSync(path.join(wt, d))) { try { fs.symlinkSync(src, path.join(wt, d), "junction"); } catch { /* optional */ } } }
  const cleanups: (() => void)[] = [() => { try { G.removeWorktree(repo, wt); } catch { /* best effort */ } }];
  // secret settings for local testing (e.g. fresh cloud credentials), saved with `aiw qa env` – they win over .env
  let saved: Record<string, string> = {};
  try { saved = JSON.parse(getSecret(`qa.${project.id}.env`) ?? "{}"); } catch { /* none */ }
  const env: Record<string, string> = { ...dotenv, ...saved };
  if (prof.language === "python") env.PYTHONPATH = wt;
  let dbWhere = "no database";
  if (prof.database.engine !== "none") {
    const envDb = parseDbUrl(firstOf(dotenv, [...prof.database.syncUrlVars, ...prof.database.urlVars]));
    if (envDb && await loginWorks(project, prof.database.engine, envDb)) {
      dbWhere = `${isLocalHost(envDb.host) ? "the local" : "the shared"} database from .env (${envDb.db})`;
      // a shared database: no background workers / schedulers / real emails from this test copy (the profile says how)
      if (!isLocalHost(envDb.host)) for (const q of prof.quietEnv ?? []) if (q.name) env[q.name] = q.value;
      if (!isLocalHost(envDb.host) && (prof.quietEnv ?? []).length) dbWhere += `, background work off (${prof.quietEnv.map((q) => q.name).join(", ")})`;
    } else {
      const db = await tempDatabase(project, tag);
      if ("error" in db) { cleanups.forEach((c) => c()); return { error: db.error }; }
      cleanups.push(db.cleanup);
      for (const k of prof.database.urlVars) env[k] = db.asyncUrl;
      for (const k of prof.database.syncUrlVars) env[k] = db.syncUrl;
      dbWhere = `a ${db.where} temporary database`;
      const migrate = fill(prof.migrate, repo);
      if (migrate) {
        const m = await G.runCommand(migrate, wt, 10 * 60_000, env);
        if (m.code !== 0) { cleanups.forEach((c) => c()); return { error: `the database setup (${prof.migrate}) failed: ${m.output.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}` }; }
      }
    }
  }
  const cache = await cacheFor(prof, dotenv, tag);
  if (cache.key && cache.url) env[cache.key] = cache.url;
  if (cache.cleanup) cleanups.push(cache.cleanup);
  if (prof.build) { const b = await G.runCommand(fill(prof.build, repo, port)!, wt, 15 * 60_000, env); if (b.code !== 0) { cleanups.forEach((c) => c()); return { error: `the backend did not build: ${b.output.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}` }; } }
  log(`backend ${project.id}: ${prof.start} – ${dbWhere}`);
  const out: string[] = [];
  const child: ChildProcess = spawn(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/d", "/s", "/c", `"${startCmd}"`] : ["-c", startCmd],
    { cwd: wt, env: { ...process.env, ...env, PORT: String(port) }, windowsHide: true, windowsVerbatimArguments: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  const keep = (b: Buffer) => { out.push(b.toString()); if (out.length > 200) out.splice(0, out.length - 200); };
  child.stdout?.on("data", keep); child.stderr?.on("data", keep);
  let exited = false;
  child.on("exit", () => { exited = true; });
  const stop = async () => {
    try {
      if (process.platform === "win32" && child.pid) execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else child.kill("SIGTERM");
    } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 1500));
    cleanups.reverse().forEach((c) => c());
  };
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 180 && !exited; i++) {                             // models may warm up for a few minutes
    // a health check may be slow (e.g. it retries a cache) – give each try 10 s; any HTTP answer means it is up
    try { const r = await fetch(`${origin}${prof.health || "/"}`, { signal: AbortSignal.timeout(10_000) }); if (r.status < 500 || r.status === 503) return { api: origin, origin, port, db: dbWhere, stop }; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const tail = out.join("").split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
  await stop();
  return { error: `the backend did not start${tail ? `: ${tail.slice(0, 600)}` : ""}` };
}

// ------------------------------------------------------------------ the demo account

/** The QA demo login: saved with `aiw qa account`, else the team's test account (the profile's login variables). */
export function demoAccount(project: ProjectConfig): { email: string; password: string; source: string } | undefined {
  const group = loadProjects().filter((p) => p.id === project.id || (project.group && p.group === project.group));
  for (const p of group) {
    const saved = { email: getSecret(`qa.${p.id}.email`), password: getSecret(`qa.${p.id}.password`) };
    if (saved.email && saved.password) return { email: saved.email, password: saved.password, source: "saved with aiw qa account" };
  }
  const names = [...new Set(group.flatMap((p) => { const l = profileOf(p).login; return [[l.emailVar, l.passwordVar]]; }).concat([["E2E_EMAIL", "E2E_PASSWORD"], ["QA_EMAIL", "QA_PASSWORD"], ["TEST_USER_EMAIL", "TEST_USER_PASSWORD"]]).map((x) => x.join("|")))].map((x) => x.split("|"));
  const envs = [process.env as Record<string, string>, ...group.flatMap((p) => [readDotEnv(p.local.path, [".env", ".env.local", ".env.test", ".env.e2e"]), readDotEnv(path.join(p.local.path, "e2e"), [".env", ".env.local"])])];
  for (const e of envs) for (const [ev, pv] of names) {
    if (ev && pv && e[ev] && e[pv]) return { email: e[ev], password: e[pv], source: `the team's test account (${ev})` };
  }
  return undefined;
}

/** The backend of the same product as a frontend (by the profiles' roles). */
export function backendOf(frontend: ProjectConfig): ProjectConfig | undefined {
  if (!frontend.group) return undefined;
  return loadProjects().find((p) => p.id !== frontend.id && p.group === frontend.group && ["backend", "fullstack"].includes(profileOf(p).role) && !!profileOf(p).start);
}

// ------------------------------------------------------------------ a frontend with its real local backend

export interface Live { env: Record<string, string>; note: string; stop: () => Promise<void> }

/**
 * For a frontend: start its backend locally (the same ticket's backend change when there is one, else the latest base
 * branch) and give the env a built frontend needs to use it with the demo login. A reason when not possible – the
 * caller then uses fake API answers and says so.
 */
/**
 * Ask ONCE (per product, again after 7 days) in Teams for a way to sign in. The safe way is the hidden-input commands on
 * this computer; a token pasted in the bot chat also works but stays in the chat history.
 */
async function askForLogin(frontend: ProjectConfig, why: string): Promise<void> {
  const k = `qa.login.asked:${frontend.id}`;
  const last = getMeta(k);
  if (last && Date.now() - new Date(last).getTime() < 7 * 86_400_000) return;
  setMeta(k, new Date().toISOString());
  setMeta("qa.token.asked", frontend.id);
  const { notify } = await import("../notify/router.js");
  await notify({ kind: "info", taskRef: frontend.id, dedupeKey: `qa-login:${frontend.id}:${new Date().toISOString().slice(0, 10)}`, title: `🔑 QA can't sign in to the local ${frontend.id} app`,
    body: [
      `To test the real app on this computer (live screenshots and browser checks), QA needs a signed-in session. Right now: ${why}.`,
      "Until then the work continues, and those checks are marked **not tested in the live local app**.",
      `Any ONE of these, run on this computer (input is hidden, kept in the Windows credential vault):\n- \`aiw qa token ${frontend.id}\` – paste an access token (and refresh token) of a test session; it is renewed automatically\n- \`aiw qa account ${frontend.id} <demo email> --totp\` – a demo account with its authenticator secret, so MFA is answered automatically`,
      `Or reply here with: qa token <access token> [refresh token] – this works, but the token then stays in this chat's history.`,
    ].join("\n\n") }).catch(() => {});
}

export async function liveStackFor(frontend: ProjectConfig, ticketKey: string | undefined, tag: string, partSha?: string): Promise<Live | { reason: string }> {
  const backend = backendOf(frontend);
  if (!backend) return { reason: "no backend repository is paired with this frontend" };
  const account = demoAccount(frontend);
  if (!account && !getSecret(`qa.${frontend.id}.session`)) {
    await askForLogin(frontend, "there is no saved session and no demo account");
    return { reason: "no login for the live local app yet (asked in Teams)" };
  }
  let sha = partSha;
  if (!sha && ticketKey) {
    try {
      const { findTicketPrs } = await import("./targets.js");
      const pr = (await findTicketPrs(ticketKey)).find((p) => p.project.id === backend.id);
      const gh = (await import("../connectors/registry.js")).clients.github();
      if (pr && backend.github?.repo) sha = G.fetchPrHead(backend.local.path, backend.github.repo, pr.num, gh?.gitAuthHeader());
    } catch { /* fall back to the base branch */ }
  }
  if (!sha) sha = G.resolveBase(backend.local.path, backend.github?.baseBranch ?? "main").sha;
  const stack = await startBackend(backend, sha, tag);
  if ("error" in stack) return { reason: stack.error };
  const fe = profileOf(frontend);
  const be = profileOf(backend);
  const apiPath = fe.frontend.apiPath || be.frontend.apiPath || "/api";
  const api = `${stack.origin}${apiPath}`;
  // a signed-in session: saved → renewed → demo login (+ authenticator code); otherwise ask once and go on without
  const { getSession } = await import("./qaSession.js");
  const session = await getSession(frontend, backend, api, account);
  if ("reason" in session) {
    await stack.stop();
    await askForLogin(frontend, session.reason);
    return { reason: `no login for the live local app: ${session.reason}` };
  }
  const env: Record<string, string> = {
    E2E_API: api, AIW_API: api, AIW_LIVE: "1",
    E2E_ACCESS_TOKEN: session.access, E2E_REFRESH_TOKEN: session.refresh ?? "",
    AIW_ACCESS_COOKIE: be.login.accessCookie || "", AIW_REFRESH_COOKIE: be.login.refreshCookie || "",
  };
  for (const v of [fe.frontend.backendUrlVar || "BACKEND_ORIGIN"]) env[v] = stack.origin;
  if (account) for (const [k, v] of [[fe.login.emailVar || "E2E_EMAIL", account.email], [fe.login.passwordVar || "E2E_PASSWORD", account.password], ["E2E_EMAIL", account.email], ["E2E_PASSWORD", account.password]]) env[k] = v;
  return { env, note: `real local backend (${backend.id} @ ${sha.slice(0, 7)}, ${stack.db}), signed in with ${session.via}`, stop: stack.stop };
}

/** What the browser-test writer is told in live mode. */
export const LIVE_INSTRUCTIONS = [
  "LIVE MODE: the app talks to a REAL local backend (its API base URL is process.env.AIW_API) with a real database. You are ALREADY signed in: use the session in process.env.E2E_ACCESS_TOKEN (and E2E_REFRESH_TOKEN). Before opening pages, add it as the cookies the backend uses – names in process.env.AIW_ACCESS_COOKIE / AIW_REFRESH_COOKIE (if empty, read the backend's auth code or the repository's e2e helpers for the names) – with context.addCookies([{ name, value, url: baseURL }]); for direct API calls send \"Authorization: Bearer <token>\". Do NOT go through the login screen (it needs MFA). Do not fake API answers in live mode.",
  "Data you create must be clearly test data: names, titles and messages start with \"qa-demo-\". Never delete or change data you did not create. Never print a token or a password.",
].join("\n");

// ------------------------------------------------------------------ which tests to run, and what a result means

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$/i;

/**
 * The tests for a change: the test files it touched plus the tests named after the changed modules
 * (refund.py → test_refund.py, quick-chips.tsx → quick-chips.test.tsx). Empty → run the whole suite.
 */
export function testsForChange(wt: string, changed: string[], max = 25): string[] {
  const all = G.git(wt, ["ls-files"], { allowFail: true }).split("\n").filter((f) => TEST_FILE.test(f));
  const picked = new Set(changed.filter((f) => TEST_FILE.test(f) && all.includes(f)));
  for (const f of changed.filter((x) => !TEST_FILE.test(x))) {
    const stem = path.basename(f).replace(/\.[^.]+$/, "").replace(/\.(d|module)$/, "");
    if (stem.length < 3 || /^(index|main|__init__|utils?|types|constants?)$/i.test(stem)) continue;
    for (const t of all) {
      const tb = path.basename(t).replace(/\.[^.]+$/, "");
      if (tb === `test_${stem}` || tb === `${stem}_test` || tb === `${stem}.test` || tb === `${stem}.spec`) picked.add(t);
    }
  }
  return [...picked].slice(0, max);
}

/**
 * A run where every test passed and only a whole-suite rule failed (e.g. "coverage below fail-under" when only some
 * files ran) – that says nothing about the change, so it counts as passed.
 */
export function onlyCoverageFailed(output: string): boolean {
  const coverage = /Coverage failure: total of [\d.]+ is less than fail-under|FAIL Required test coverage|coverage threshold.*not met|Jest: "global" coverage threshold/i.test(output);
  const testsFailed = /\b\d+ (failed|errors?)\b|\bFAILED\b|Tests:\s+\d+ failed/i.test(output.replace(/Coverage failure[^\n]*/gi, ""));
  return coverage && !testsFailed;
}

/**
 * Exact results for pytest runs, whatever the verbosity (a repo's own "-q" plus ours prints no summary at all):
 * pytest writes a JUnit XML file; read() gives the counts. Other test runners: undefined (the output text decides).
 */
export function withResults(cmd: string): { cmd: string; read: () => { tests: number; failures: number; errors: number } | undefined } {
  if (!/\bpytest\b/.test(cmd)) return { cmd, read: () => undefined };
  const file = path.join(ensureDir(path.join(paths.worktrees(), ".qa")), `junit-${process.pid}-${Date.now()}.xml`);
  return {
    cmd: `${cmd} --junitxml="${file}"`,
    read: () => {
      try {
        const xml = fs.readFileSync(file, "utf8");
        // each <testsuite …> opening tag (not <testsuites>), then the count attribute inside it
        const tags = xml.match(/<testsuite(?=[\s>])[^>]*>/g) ?? [];
        const num = (k: string) => tags.reduce((n, tag) => n + Number(new RegExp(`\\s${k}="(\\d+)"`).exec(tag)?.[1] ?? 0), 0);
        return { tests: num("tests"), failures: num("failures"), errors: num("errors") };
      } catch { return undefined; } finally { fs.rmSync(file, { force: true }); }
    },
  };
}

/** The final verdict of a test run: the exact counts when known, else the exit code (+ the coverage-only rule). */
export function testRunPassed(r: { code: number; output: string }, counts?: { tests: number; failures: number; errors: number }): boolean {
  if (counts && counts.tests > 0) return counts.failures === 0 && counts.errors === 0 && (r.code === 0 || onlyCoverageFailed(r.output) || /Coverage failure|fail-under|coverage threshold/i.test(r.output));
  if (counts) return r.code === 0;                               // the result file says nothing ran – no coverage excuse
  return r.code === 0 || onlyCoverageFailed(r.output);
}
