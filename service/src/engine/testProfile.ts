import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../core/config.js";
import { paths, ensureDir } from "../core/paths.js";
import { logger } from "../core/log.js";

/**
 * How to run and test ONE repository on this computer – detected from the repository itself, so local testing works
 * for any project (FastAPI, Django, Express, Spring, Rails, Next.js, Vite, …), not one hard-coded stack.
 * A read-only agent reads the repository's own files once (README, .env.example key names, docker-compose, package /
 * project files, CI workflows, e2e configs) and fills this in; it is refreshed every 14 days. Without it, the built-in
 * rules are used. Anything can be overridden in projects.yaml under `qa`.
 */
export interface TestProfile {
  role: "backend" | "frontend" | "fullstack" | "library" | "other";
  language: string;                            // python, node, java, go, ruby, php, dotnet, …
  /** Start the app on a port: {port} and {python} are filled in. "" = cannot run here. */
  start: string;
  /** Build before starting (frontends / compiled apps); "" = none. */
  build: string;
  /** A path that answers when the app is up (e.g. /health, /api/health, /). */
  health: string;
  /** Apply the database schema to an empty database ({python} filled in); "" = none / the app does it itself. */
  migrate: string;
  /** Run the test suite ({python} filled in); "" = none. */
  testCommand: string;
  /** How a list of test files is passed: appended to the command, or after "--" (npm scripts), or not at all. */
  testFiles: "append" | "after-dashdash" | "none";
  database: { engine: "postgres" | "mysql" | "sqlite" | "mongo" | "none"; urlVars: string[]; syncUrlVars: string[] };
  cache: { urlVars: string[] };
  /** Frontend: the variable that points it at the backend (at build and run time), and the API base path. */
  frontend: { backendUrlVar: string; apiPath: string };
  /**
   * Signing in for tests (names and paths only, never values): the login path; the refresh path that renews a session
   * WITHOUT MFA; the MFA verify path and its field names for an authenticator (TOTP) code; the session cookie names.
   */
  login: { emailVar: string; passwordVar: string; path: string; refreshPath: string; mfaPath: string; mfaTokenField: string; mfaCodeField: string; accessCookie: string; refreshCookie: string };
  /**
   * Settings that stop the app doing REAL work in the background when QA runs it against a SHARED database: job workers,
   * queue consumers, schedulers / cron, real emails / SMS / payments. Applied only then; the features under test stay on.
   */
  quietEnv: { name: string; value: string; why: string }[];
  notes: string;
  /** Profile format; older detected profiles are detected again. */
  version?: number;
  source: "detected" | "built-in rules";
  at: string;
}

export const PROFILE_SCHEMA = (() => {
  const str = { type: "string" }, strArr = { type: "array", items: str };
  const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  return obj({
    role: { type: "string", enum: ["backend", "frontend", "fullstack", "library", "other"] }, language: str, start: str, build: str, health: str, migrate: str, testCommand: str,
    testFiles: { type: "string", enum: ["append", "after-dashdash", "none"] },
    database: obj({ engine: { type: "string", enum: ["postgres", "mysql", "sqlite", "mongo", "none"] }, urlVars: strArr, syncUrlVars: strArr }),
    cache: obj({ urlVars: strArr }),
    frontend: obj({ backendUrlVar: str, apiPath: str }),
    login: obj({ emailVar: str, passwordVar: str, path: str, refreshPath: str, mfaPath: str, mfaTokenField: str, mfaCodeField: str, accessCookie: str, refreshCookie: str }),
    quietEnv: { type: "array", items: obj({ name: str, value: str, why: str }) },
    notes: str,
  });
})();

export const PROFILE_VERSION = 3;
const file = (projectId: string) => path.join(paths.projectDir(projectId), "test-profile.json");
const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return undefined; } };

/** The built-in rules (what works for the common stacks) – used until a detected profile exists. */
export function builtInProfile(project: ProjectConfig): TestProfile {
  const dir = project.local.path;
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  const pkg = readJson(path.join(dir, "package.json"));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const py = ["pyproject.toml", "requirements.txt", "setup.py"].some(has);
  const base: TestProfile = {
    role: "other", language: py ? "python" : pkg ? "node" : "other", start: "", build: "", health: "/", migrate: "", testCommand: project.local.testCommand ?? "", testFiles: "append",
    database: { engine: "none", urlVars: ["DATABASE_URL", "TEST_DATABASE_URL"], syncUrlVars: ["DATABASE_URL_SYNC"] }, cache: { urlVars: ["REDIS_URL", "VALKEY_URL"] },
    frontend: { backendUrlVar: "", apiPath: "/api" },
    login: { emailVar: "E2E_EMAIL", passwordVar: "E2E_PASSWORD", path: "/auth/login", refreshPath: "/auth/refresh", mfaPath: "", mfaTokenField: "mfa_token", mfaCodeField: "code", accessCookie: "", refreshCookie: "" },
    quietEnv: [], notes: "", source: "built-in rules", at: new Date().toISOString(),
  };
  if (py) {
    const entry = [["app/main.py", "app.main:app"], ["main.py", "main:app"], ["src/main.py", "src.main:app"], ["app.py", "app:app"]].find(([f]) => has(f));
    const django = has("manage.py");
    return {
      ...base, role: "backend", health: "/health",
      start: django ? `{python} manage.py runserver 127.0.0.1:{port} --noreload` : entry ? `{python} -m uvicorn ${entry[1]} --host 127.0.0.1 --port {port}` : "",
      migrate: has("alembic.ini") ? "{python} -m alembic upgrade head" : django ? "{python} manage.py migrate --noinput" : "",
      testCommand: "{python} -m pytest -q -p no:cacheprovider",
      database: { ...base.database, engine: "postgres" },
    };
  }
  if (pkg) {
    const fe = !!(deps.next || deps.vite || deps.react || deps.vue || deps["@angular/core"] || deps.svelte);
    const run = pkg.scripts?.test ? (fs.existsSync(path.join(dir, "yarn.lock")) ? "yarn test" : fs.existsSync(path.join(dir, "pnpm-lock.yaml")) ? "pnpm test" : "npm test") : "";
    return {
      ...base, role: fe ? "frontend" : "backend", testCommand: project.local.testCommand ?? run, testFiles: run.startsWith("npm") ? "after-dashdash" : "append",
      build: deps.next ? "npx next build" : deps.vite ? "npx vite build" : "",
      start: deps.next ? "npx next start -p {port}" : deps.vite ? "npx vite preview --port {port} --strictPort" : pkg.scripts?.start ? "npm start -- --port {port}" : "",
      frontend: { backendUrlVar: fe ? "BACKEND_ORIGIN" : "", apiPath: "/api" },
      database: { ...base.database, engine: fe ? "none" : deps.pg || deps.prisma || deps.typeorm || deps.knex ? "postgres" : deps.mysql2 ? "mysql" : deps.mongoose || deps.mongodb ? "mongo" : "none" },
    };
  }
  return base;
}

/** The profile in use: projects.yaml `qa` overrides > detected > built-in rules. */
export function profileOf(project: ProjectConfig): TestProfile {
  const saved = readJson(file(project.id)) as TestProfile | undefined;
  const p: TestProfile = saved?.start !== undefined ? saved : builtInProfile(project);
  const o = project.qa ?? {};
  return {
    ...p,
    start: o.backendStartCommand ?? p.start,
    testCommand: o.testCommand ?? p.testCommand,
    ...(o.profile ?? {}),
  } as TestProfile;
}

/** Is a fresh detected profile on file? */
export function hasDetectedProfile(projectId: string): boolean {
  const p = readJson(file(projectId));
  return !!p && p.source === "detected" && p.version === PROFILE_VERSION && Date.now() - new Date(p.at).getTime() < 14 * 86_400_000;
}

/** Variable NAMES from env files (never their values) – what the profiler may see. */
function envKeyNames(dir: string): string {
  const out: string[] = [];
  for (const f of [".env.example", ".env.sample", ".env.template", ".env", ".env.local", ".env.test"]) {
    try {
      const keys = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean);
      if (keys.length) out.push(`${f}: ${keys.join(", ")}`);
    } catch { /* none */ }
  }
  return out.join("\n") || "(no env files)";
}

/**
 * Detect the profile with a read-only agent (once; refreshed every 14 days). `agent` is the step's agent caller.
 * Never fails the caller: on any problem the built-in rules stay in use.
 */
export async function ensureProfile(project: ProjectConfig, agent: (name: string, prompt: string, opts?: any) => Promise<{ data?: any }>): Promise<TestProfile> {
  if (hasDetectedProfile(project.id)) return profileOf(project);
  try {
    const guess = builtInProfile(project);
    const r = await agent("stack-profiler", [
      `## Repository ${project.id} (${project.local.path})`,
      `## Environment variable NAMES in its env files (values are hidden from you on purpose)\n${envKeyNames(project.local.path)}`,
      `## What the built-in rules would guess\n${JSON.stringify({ ...guess, at: undefined, source: undefined }, null, 1)}`,
      "Read the repository's own files to confirm or correct every field. Do not modify anything.",
    ].join("\n\n"), { cwd: project.local.path, tools: ["Read", "Grep", "Glob"], maxTurns: 25 });
    const p: TestProfile = { ...guess, ...(r.data ?? {}), version: PROFILE_VERSION, source: "detected", at: new Date().toISOString() };
    ensureDir(paths.projectDir(project.id));
    fs.writeFileSync(file(project.id), JSON.stringify(p, null, 2));
    return profileOf(project);
  } catch (e: any) {
    logger.warn("test profile detection failed – built-in rules in use", { project: project.id, error: e.message });
    return profileOf(project);
  }
}
