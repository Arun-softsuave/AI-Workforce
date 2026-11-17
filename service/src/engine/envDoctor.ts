import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ProjectConfig } from "../core/config.js";
import { db } from "../core/db.js";
import * as G from "../git/git.js";
import { readDotEnv, parseDbUrl, reachable } from "./localStack.js";
import { builtInProfile, profileOf, type TestProfile } from "./testProfile.js";

/**
 * The environment doctor (W2 12a): can this repository's tests run on THIS computer right now?
 * Language versions, the project's environment (venv / node_modules), packages, .env keys (NAMES only – values are
 * never put in any output), the database and the services the tests need, and an optional quick test check.
 * Runs in `aiw ready` and before every build (cached for 1 hour). A build never starts on a broken environment: the
 * item waits as "Blocked: environment" and resumes when the doctor passes.
 */

export interface EnvCheck { name: string; ok: boolean; detail: string; fix?: string; /** true: reported, but does not stop the tests */ warn?: boolean }
export interface EnvResult { ok: boolean; checks: EnvCheck[]; summary: string; checkedAt: string; cached?: boolean }

/** Runs one shell command (same contract as git.runCommand). */
export type ExecFn = (cmd: string, cwd: string, timeoutMs: number) => Promise<{ code: number; output: string }>;
/** Is something listening on host:port (TCP)? */
export type ConnectFn = (host: string, port: number, timeoutMs: number) => Promise<boolean>;
/** The quick test check: ok + a short detail. */
export type SmokeFn = (repoPath: string, ctx: { python?: string; profile: TestProfile; exec: ExecFn }) => Promise<{ ok: boolean; detail: string; fix?: string; warn?: boolean }>;

export interface EnvDoctorOpts {
  /** Ignore the cached result. */
  force?: boolean;
  /** The project (for its test profile); otherwise the built-in rules are used. */
  project?: ProjectConfig;
  exec?: ExecFn;
  connect?: ConnectFn;
  /** Clock in ms (tests). */
  now?: () => number;
  /** Run a quick test check: true = the default one, or your own runner. Off by default. */
  smoke?: boolean | SmokeFn;
  /** Cache lifetime (default 1 hour). */
  cacheMs?: number;
  /** Extra variable names that count as set (default: this process's environment). */
  envNames?: string[];
}

const HOUR = 3_600_000;
const win = process.platform === "win32";
const has = (dir: string, f: string) => fs.existsSync(path.join(dir, f));
const read = (dir: string, f: string) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return undefined; } };
const q = (p: string) => (/[\s"]/.test(p) || path.isAbsolute(p) ? `"${p}"` : p);

// ------------------------------------------------------------------ versions

/** "Python 3.11.4" / "v22.1.0" → [3, 11, 4]. */
export function parseVersion(s: string): number[] | undefined {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s ?? "");
  return m ? [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number) : undefined;
}

const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };
const prefix = (v: number[], req: number[]) => req.every((n, i) => v[i] === n);

/**
 * Does an installed version meet a requirement? Understands the common forms of .python-version, .nvmrc, engines and
 * requires-python: "3.11", ">=3.10,<3.13", "~=3.11", "^20", "~18.2", "18.x", ">=18 <21", "16 || 18". undefined = can't tell.
 */
export function satisfies(installed: string, spec: string): boolean | undefined {
  const v = parseVersion(installed);
  const s = (spec ?? "").trim().replace(/^v/i, "");
  if (!v || !s || /^(lts|node|stable|latest|system|\*)/i.test(s)) return undefined;
  const alts = s.split("||").map((a) => a.trim()).filter(Boolean);
  let known = false;
  for (const alt of alts) {
    const parts = alt.replace(/(>=|<=|===|==|~=|!=|>|<|=|\^|~)\s+/g, "$1").split(/[\s,]+/).filter(Boolean);
    let all = true;
    let any = false;
    for (const part of parts) {
      const m = /^(>=|<=|===|==|~=|!=|>|<|=|\^|~)?v?(\d+(?:\.(?:\d+|x|\*))*)(?:\.\*)?$/i.exec(part);
      if (!m) continue;
      any = true;
      const req = m[2].split(".").filter((x) => /^\d+$/.test(x)).map(Number);
      const op = m[1] ?? "";
      let ok: boolean;
      switch (op) {
        case ">=": ok = cmp(v, req) >= 0; break;
        case ">": ok = cmp(v, req) > 0; break;
        case "<=": ok = cmp(v, req) <= 0 || prefix(v, req); break;
        case "<": ok = cmp(v, req) < 0; break;
        case "!=": ok = !prefix(v, req); break;
        case "~=": ok = cmp(v, req) >= 0 && prefix(v, req.slice(0, Math.max(1, req.length - 1))); break;
        case "^": ok = cmp(v, req) >= 0 && v[0] === req[0]; break;
        case "~": ok = cmp(v, req) >= 0 && prefix(v, req.slice(0, req.length > 1 ? 2 : 1)); break;
        default: ok = prefix(v, req);                                   // "3.11", "==3.11", "18.x"
      }
      if (!ok) all = false;
    }
    if (any) { known = true; if (all) return true; }
  }
  return known ? false : undefined;
}

/** The Python version the repository asks for, and where it says so. */
export function requiredPython(dir: string): { spec: string; from: string } | undefined {
  const pv = read(dir, ".python-version")?.split(/\r?\n/)[0]?.trim();
  if (pv && /^\d/.test(pv)) return { spec: pv, from: ".python-version" };
  const py = read(dir, "pyproject.toml");
  const rp = py && /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(py);
  if (rp) return { spec: rp[1], from: "pyproject.toml" };
  const poetry = py && /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(py)?.[1];
  const pp = poetry && /^\s*python\s*=\s*["']([^"']+)["']/m.exec(poetry);
  if (pp) return { spec: pp[1], from: "pyproject.toml" };
  const cfg = read(dir, "setup.cfg");
  const pr = cfg && /^\s*python_requires\s*=\s*(.+)$/m.exec(cfg);
  if (pr) return { spec: pr[1].trim(), from: "setup.cfg" };
  return undefined;
}

/** The Node version the repository asks for, and where it says so. */
export function requiredNode(dir: string): { spec: string; from: string } | undefined {
  for (const f of [".nvmrc", ".node-version"]) {
    const s = read(dir, f)?.split(/\r?\n/)[0]?.trim();
    if (s && /^v?\d/.test(s)) return { spec: s, from: f };
  }
  try { const e = JSON.parse(read(dir, "package.json") ?? "{}")?.engines?.node; if (typeof e === "string" && e.trim()) return { spec: e.trim(), from: "package.json engines" }; } catch { /* unreadable */ }
  return undefined;
}

// ------------------------------------------------------------------ packages

const IMPORT_NAMES: Record<string, string> = {
  pyyaml: "yaml", "python-dotenv": "dotenv", beautifulsoup4: "bs4", pillow: "PIL", "scikit-learn": "sklearn", "psycopg2-binary": "psycopg2",
  "python-jose": "jose", "python-multipart": "multipart", "opencv-python": "cv2", "opencv-python-headless": "cv2", pyjwt: "jwt", "python-dateutil": "dateutil",
  protobuf: "google.protobuf", "email-validator": "email_validator", "pydantic-settings": "pydantic_settings", "google-cloud-storage": "google.cloud.storage",
};

/** Top-level Python packages the repository needs (requirements.txt, else pyproject), as distribution names. */
export function pythonPackages(dir: string, max = 8): string[] {
  const names: string[] = [];
  const req = read(dir, "requirements.txt");
  if (req) for (const l of req.split(/\r?\n/)) {
    const t = l.trim();
    if (!t || /^(#|-|git\+|https?:)/.test(t)) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(t);
    if (m) names.push(m[1]);
  }
  const py = read(dir, "pyproject.toml");
  if (!names.length && py) {
    const proj = /\[project\]([\s\S]*?)(?:\n\[|$)/.exec(py)?.[1] ?? "";
    const arr = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(proj)?.[1] ?? "";
    for (const m of arr.matchAll(/["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.push(m[1]);
    const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(py)?.[1] ?? "";
    for (const m of poetry.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)) if (m[1].toLowerCase() !== "python") names.push(m[1]);
  }
  return [...new Set(names)].slice(0, max);
}
const importName = (dist: string) => IMPORT_NAMES[dist.toLowerCase()] ?? dist.toLowerCase().replace(/-/g, "_");

/** One line of Python (no double quotes, safe in cmd.exe and sh): prints MISSING:<names that are not installed or don't import>. */
const IMPORT_CHECK = "exec('import importlib,importlib.metadata as m,importlib.util as u,sys\\nb=[]\\nfor a in sys.argv[1:]:\\n d,i=a.split(chr(58))\\n try: m.distribution(d)\\n except Exception:\\n  b.append(d); continue\\n try:\\n  if u.find_spec(i): importlib.import_module(i)\\n except Exception: b.append(d)\\nprint(chr(77)+chr(73)+chr(83)+chr(83)+chr(73)+chr(78)+chr(71)+chr(58)+chr(44).join(b))')";

function venvPython(dir: string): { py: string; venv: string } | undefined {
  for (const v of [".venv", "venv", ".venv-local", "env"]) {
    const py = path.join(dir, v, win ? "Scripts" : "bin", win ? "python.exe" : "python");
    if (fs.existsSync(py)) return { py, venv: v };
  }
  return undefined;
}

function pythonSetupFix(dir: string): string {
  if (has(dir, "uv.lock")) return "Run `uv sync` in the repository.";
  if (has(dir, "poetry.lock")) return "Run `poetry install` in the repository.";
  if (has(dir, "Pipfile")) return "Run `pipenv install --dev` in the repository.";
  const pip = win ? ".venv\\Scripts\\pip" : ".venv/bin/pip";
  return has(dir, "requirements.txt") ? `Run \`python -m venv .venv\` then \`${pip} install -r requirements.txt\`.` : `Run \`python -m venv .venv\` then \`${pip} install -e .\`.`;
}

function nodeInstallFix(dir: string): string {
  return has(dir, "pnpm-lock.yaml") ? "Run `pnpm install`." : has(dir, "yarn.lock") ? "Run `yarn install`." : has(dir, "package-lock.json") ? "Run `npm ci`." : "Run `npm install`.";
}

// ------------------------------------------------------------------ .env (names only)

/** Variable NAMES in an env file – values are never read into memory here. */
export function envNames(dir: string, file: string): string[] | undefined {
  const text = read(dir, file);
  if (text === undefined) return undefined;
  return text.split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter((x): x is string => !!x);
}

// ------------------------------------------------------------------ services (docker-compose)

const SERVICE_KIND = /postgres|postgis|pgvector|mysql|mariadb|mongo|redis|valkey|memcached|rabbitmq|kafka|zookeeper|nats|elasticsearch|opensearch|minio|localstack|mailhog|mailpit/i;
const CORE_KIND = /postgres|postgis|pgvector|mysql|mariadb|mongo|redis|valkey/i;

export function composeServices(dir: string): { name: string; image: string; port: number }[] {
  const file = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].find((f) => has(dir, f));
  if (!file) return [];
  let doc: any;
  try { doc = YAML.parse(read(dir, file) ?? ""); } catch { return []; }
  const out: { name: string; image: string; port: number }[] = [];
  for (const [name, svc] of Object.entries<any>(doc?.services ?? {})) {
    const image = String(svc?.image ?? "");
    if (!SERVICE_KIND.test(`${image} ${name}`)) continue;                 // the app itself does not need to be running
    for (const p of svc?.ports ?? []) {
      let host: number | undefined;
      if (typeof p === "object" && p) host = Number(p.published);
      else {
        const parts = String(p).replace(/\/(tcp|udp)$/, "").split(":");
        if (parts.length >= 2) host = Number(parts[parts.length - 2].split("-")[0]);
      }
      if (host && Number.isFinite(host)) { out.push({ name, image, port: host }); break; }
    }
  }
  return out;
}

// ------------------------------------------------------------------ the database (from .env names → host:port)

const DB_URL_VARS = ["DATABASE_URL", "DATABASE_URL_SYNC", "TEST_DATABASE_URL", "DB_URL", "POSTGRES_URL", "MYSQL_URL", "MONGO_URL", "MONGODB_URI", "SQLALCHEMY_DATABASE_URI"];
const DEFAULT_DB_PORT: Record<string, number> = { postgres: 5432, mysql: 3306, mongo: 27017 };

/** Where the .env database is: the variable name, host and port only (never a login). */
export function databaseTarget(dir: string, profile?: TestProfile): { from: string; host: string; port: number; engine: string } | { sqlite: true; from: string } | undefined {
  const env = readDotEnv(dir);                                          // in memory only; nothing below returns a value except host and port
  const vars = [...new Set([...(profile?.database.syncUrlVars ?? []), ...(profile?.database.urlVars ?? []), ...DB_URL_VARS])];
  for (const k of vars) {
    const v = env[k];
    if (!v) continue;
    if (/^sqlite/i.test(v)) return { sqlite: true, from: k };
    const u = parseDbUrl(v);
    if (u) return { from: k, host: u.host, port: u.port, engine: /mongo/i.test(u.scheme) ? "mongo" : /mysql|maria/i.test(u.scheme) ? "mysql" : "postgres" };
  }
  for (const [hk, pk, engine] of [["DB_HOST", "DB_PORT", ""], ["POSTGRES_HOST", "POSTGRES_PORT", "postgres"], ["PGHOST", "PGPORT", "postgres"], ["MYSQL_HOST", "MYSQL_PORT", "mysql"], ["MONGO_HOST", "MONGO_PORT", "mongo"]]) {
    if (!env[hk]) continue;
    const eng = engine || (/mysql|maria/i.test(env.DB_ENGINE ?? env.DB_CONNECTION ?? "") ? "mysql" : /mongo/i.test(env.DB_ENGINE ?? env.DB_CONNECTION ?? "") ? "mongo" : "postgres");
    const port = Number(env[pk]) || DEFAULT_DB_PORT[eng];
    return { from: env[pk] ? `${hk}/${pk}` : hk, host: env[hk], port, engine: eng };
  }
  return undefined;
}

// ------------------------------------------------------------------ the doctor

function profileFor(repoPath: string, project?: ProjectConfig): TestProfile {
  if (project) return profileOf(project);
  return builtInProfile({ id: path.basename(repoPath), local: { path: repoPath } } as unknown as ProjectConfig);
}

const defaultSmoke: SmokeFn = async (repo, { python, profile, exec }) => {
  if (python && (/pytest/.test(profile.testCommand) || has(repo, "pytest.ini") || has(repo, "conftest.py") || has(repo, "tests"))) {
    const r = await exec(`${q(python)} -m pytest --collect-only -q -p no:cacheprovider`, repo, 4 * 60_000);
    const n = /(\d+) tests? collected|collected (\d+) items?/.exec(r.output);
    return r.code === 0 || n ? { ok: true, detail: `The test runner starts${n ? ` and finds ${n[1] ?? n[2]} tests` : ""}.` }
      : { ok: false, detail: "The test runner does not start.", fix: "Install the test packages (e.g. `uv sync --all-extras` or `pip install -r requirements-dev.txt`)." };
  }
  const bin = path.join(repo, "node_modules", ".bin");
  const tool = fs.existsSync(path.join(bin, win ? "jest.cmd" : "jest")) ? "jest --listTests" : fs.existsSync(path.join(bin, win ? "vitest.cmd" : "vitest")) ? "vitest list --run" : undefined;
  if (tool) {
    const r = await exec(`npx --no-install ${tool}`, repo, 4 * 60_000);
    return r.code === 0 ? { ok: true, detail: "The test runner starts and finds the tests." } : { ok: false, detail: "The test runner does not start.", fix: nodeInstallFix(repo) };
  }
  return { ok: true, warn: true, detail: "No quick test check for this repository (skipped)." };
};

async function runChecks(repo: string, opts: EnvDoctorOpts): Promise<EnvCheck[]> {
  const exec = opts.exec ?? G.runCommand;
  const connect: ConnectFn = opts.connect ?? reachable;
  const checks: EnvCheck[] = [];
  if (!fs.existsSync(repo)) return [{ name: "Repository", ok: false, detail: `Folder not found: ${repo}.`, fix: "Clone the repository there, or update the project's folder." }];

  const isPy = ["pyproject.toml", "requirements.txt", "setup.cfg", "setup.py", "Pipfile"].some((f) => has(repo, f));
  const isNode = has(repo, "package.json");
  const profile = profileFor(repo, opts.project);
  checks.push({ name: "Language", ok: true, detail: isPy && isNode ? "Python and Node." : isPy ? "Python." : isNode ? "Node." : "No Python or Node project files found." });

  // ---- Python
  let python: string | undefined;
  if (isPy) {
    const venv = venvPython(repo);
    const req = requiredPython(repo);
    const candidates = venv ? [venv.py] : [win ? "python" : "python3", "python"];
    let version: string | undefined;
    for (const c of candidates) {
      const r = await exec(`${q(c)} --version`, repo, 30_000).catch(() => ({ code: 1, output: "" }));
      if (r.code === 0 && /Python\s+\d/i.test(r.output)) { python = c; version = /Python\s+([\d.]+)/i.exec(r.output)![1]; break; }
    }
    if (!python) {
      checks.push(venv ? { name: "Python version", ok: false, detail: `The project's Python (${venv.venv}) does not start.`, fix: `Remove ${venv.venv} and set it up again: ${pythonSetupFix(repo)}` }
        : { name: "Python version", ok: false, detail: "Python is not installed (or not on PATH).", fix: `Install Python${req ? ` ${req.spec}` : ""}.` });
    } else {
      const okVer = req ? satisfies(version!, req.spec) : undefined;
      checks.push(okVer === false ? { name: "Python version", ok: false, detail: `Python ${version} is used, but ${req!.from} asks for ${req!.spec}.`, fix: `Install Python ${req!.spec} and set up the environment with it: ${pythonSetupFix(repo)}` }
        : { name: "Python version", ok: true, detail: `Python ${version}${req ? ` (${req.from} asks for ${req.spec})` : ""}.` });
    }
    // packages: installed and importable
    const pkgs = pythonPackages(repo);
    let missing: string[] | undefined;
    if (python && pkgs.length) {
      const r = await exec(`${q(python)} -c "${IMPORT_CHECK}" ${pkgs.map((d) => `${d}:${importName(d)}`).join(" ")}`, repo, 120_000).catch(() => ({ code: 1, output: "" }));
      const line = r.output.split(/\r?\n/).reverse().find((l) => l.startsWith("MISSING:"));
      missing = line === undefined ? pkgs : line.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (!venv) {
      const fine = !!python && pkgs.length > 0 && missing !== undefined && missing.length === 0;
      checks.push(fine ? { name: "Python environment", ok: true, detail: "No project environment folder, but the installed Python has the packages." }
        : { name: "Python environment", ok: false, detail: "No virtual environment (.venv) found.", fix: pythonSetupFix(repo) });
    } else checks.push({ name: "Python environment", ok: !!python, detail: python ? `${venv.venv} found.` : `${venv.venv} is broken.`, ...(python ? {} : { fix: pythonSetupFix(repo) }) });
    if (python && pkgs.length && venv) {
      checks.push(missing!.length ? { name: "Python packages", ok: false, detail: `Missing or broken: ${missing!.slice(0, 5).join(", ")}${missing!.length > 5 ? ` (+${missing!.length - 5} more)` : ""}.`, fix: pythonSetupFix(repo) }
        : { name: "Python packages", ok: true, detail: `${pkgs.length} main package(s) import fine.` });
    }
  }

  // ---- Node
  if (isNode) {
    const req = requiredNode(repo);
    const r = await exec("node --version", repo, 30_000).catch(() => ({ code: 1, output: "" }));
    const version = r.code === 0 ? /v?(\d+\.\d+\.\d+)/.exec(r.output)?.[1] : undefined;
    if (!version) checks.push({ name: "Node version", ok: false, detail: "Node is not installed (or not on PATH).", fix: `Install Node${req ? ` ${req.spec}` : ""}.` });
    else {
      const okVer = req ? satisfies(version, req.spec) : undefined;
      checks.push(okVer === false ? { name: "Node version", ok: false, detail: `Node ${version} is installed, but ${req!.from} asks for ${req!.spec}.`, fix: `Install Node ${req!.spec} (e.g. \`nvm install ${req!.spec.replace(/[^\d.]/g, "") || req!.spec}\`).` }
        : { name: "Node version", ok: true, detail: `Node ${version}${req ? ` (${req.from} asks for ${req.spec})` : ""}.` });
    }
    let pkg: any = {};
    try { pkg = JSON.parse(read(repo, "package.json") ?? "{}"); } catch { /* unreadable */ }
    const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    if (!has(repo, "node_modules")) {
      checks.push(deps.length ? { name: "Node packages", ok: false, detail: "node_modules is missing.", fix: nodeInstallFix(repo) }
        : { name: "Node packages", ok: true, detail: "No packages needed." });
    } else {
      const missing = deps.slice(0, 15).filter((d) => !fs.existsSync(path.join(repo, "node_modules", ...d.split("/"), "package.json")));
      checks.push(missing.length ? { name: "Node packages", ok: false, detail: `Not installed: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""}.`, fix: nodeInstallFix(repo) }
        : { name: "Node packages", ok: true, detail: "node_modules is installed." });
    }
  }

  // ---- .env (names only)
  const example = [".env.example", ".env.sample", ".env.template"].find((f) => has(repo, f));
  const present = new Set([...(envNames(repo, ".env") ?? []), ...(envNames(repo, ".env.local") ?? []), ...(opts.envNames ?? Object.keys(process.env))]);
  if (example) {
    const need = envNames(repo, example) ?? [];
    if (!has(repo, ".env") && !has(repo, ".env.local")) checks.push({ name: ".env", ok: false, detail: "No .env file.", fix: `Copy ${example} to .env and fill in the values.` });
    else {
      const missing = need.filter((k) => !present.has(k));
      checks.push(missing.length ? { name: ".env", ok: false, detail: `Missing in .env: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ` (+${missing.length - 6} more)` : ""}.`, fix: `Add ${missing.length === 1 ? "it" : "them"} to .env (see ${example}).` }
        : { name: ".env", ok: true, detail: `All ${need.length} settings from ${example} are set.` });
    }
  } else if (has(repo, ".env")) checks.push({ name: ".env", ok: true, detail: ".env found (no example file to compare with)." });

  // ---- database
  const target = databaseTarget(repo, profile);
  const compose = composeServices(repo);
  let dbPort: number | undefined;
  if (target && "sqlite" in target) checks.push({ name: "Database", ok: true, detail: `${target.from} uses a local SQLite file.` });
  else if (target) {
    dbPort = target.port;
    const up = await connect(target.host, target.port, 2000).catch(() => false);
    const svc = compose.find((s) => s.port === target.port);
    checks.push(up ? { name: "Database", ok: true, detail: `The database (${target.from}) answers at ${target.host}:${target.port}.` }
      : { name: "Database", ok: false, detail: `The database (${target.from}) does not answer at ${target.host}:${target.port}.`, fix: svc ? `Start it: \`docker compose up -d ${svc.name}\`.` : /^(localhost|127\.0\.0\.1|::1)$/i.test(target.host) ? `Start the ${target.engine} server on this computer.` : "Check the VPN or network, or that the database server is up." });
  }

  // ---- services from docker-compose (the database one is already checked)
  for (const s of compose) {
    if (s.port === dbPort) continue;
    const up = await connect("127.0.0.1", s.port, 2000).catch(() => false);
    const core = CORE_KIND.test(`${s.image} ${s.name}`);
    checks.push(up ? { name: `Service ${s.name}`, ok: true, detail: `${s.name} answers on port ${s.port}.` }
      : { name: `Service ${s.name}`, ok: !core, ...(core ? {} : { warn: true }), detail: `${s.name} is not running (port ${s.port}).`, fix: `Start it: \`docker compose up -d ${s.name}\`.` });
  }

  // ---- quick test check (only when everything else is fine)
  if (opts.smoke && checks.every((c) => c.ok)) {
    const run: SmokeFn = typeof opts.smoke === "function" ? opts.smoke : defaultSmoke;
    try {
      const r = await run(repo, { python, profile, exec });
      checks.push({ name: "Smoke test", ok: r.ok, detail: r.detail, ...(r.fix ? { fix: r.fix } : {}), ...(r.warn ? { warn: true } : {}) });
    } catch (e: any) { checks.push({ name: "Smoke test", ok: false, detail: `The quick test check could not run: ${String(e?.message ?? e).slice(0, 160)}.` }); }
  }
  return checks;
}

function summarize(checks: EnvCheck[]): string {
  const bad = checks.filter((c) => !c.ok);
  return bad.length ? `Tests can't run: ${bad.map((c) => c.detail.replace(/\.$/, "")).join("; ")}.` : "Ready";
}

/** Can this repository's tests run here? Cached for 1 hour per repository (force: check again). */
export async function checkEnvironment(repoPath: string, opts: EnvDoctorOpts = {}): Promise<EnvResult> {
  const repo = path.resolve(repoPath);
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheMs ?? HOUR;
  if (!opts.force) {
    const row = db().prepare("SELECT ok, report, checked_at FROM env_checks WHERE repo = ?").get(repo) as { ok: number; report: string; checked_at: string } | undefined;
    if (row && now() - new Date(row.checked_at).getTime() < ttl && now() >= new Date(row.checked_at).getTime()) {
      try { const r = JSON.parse(row.report) as EnvResult; return { ...r, cached: true }; } catch { /* re-check */ }
    }
  }
  const checks = await runChecks(repo, opts);
  const ok = checks.every((c) => c.ok);
  const result: EnvResult = { ok, checks, summary: summarize(checks), checkedAt: new Date(now()).toISOString() };
  db().prepare("INSERT INTO env_checks (repo, ok, report, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(repo) DO UPDATE SET ok = excluded.ok, report = excluded.report, checked_at = excluded.checked_at")
    .run(repo, ok ? 1 : 0, JSON.stringify(result), result.checkedAt);
  return result;
}

/** Forget the cached result (e.g. after the user says they fixed it). */
export function clearEnvCache(repoPath?: string): void {
  if (repoPath) db().prepare("DELETE FROM env_checks WHERE repo = ?").run(path.resolve(repoPath));
  else db().exec("DELETE FROM env_checks");
}

/** Short text for Teams / the CLI: "Ready" or "Tests can't run: … Fix: …". */
export function envReport(result: EnvResult): string {
  const bad = result.checks.filter((c) => !c.ok);
  const warns = result.checks.filter((c) => c.ok && c.warn && c.fix);
  if (!bad.length) return warns.length ? `Ready (note: ${warns.map((c) => c.detail.replace(/\.$/, "")).join("; ")})` : "Ready";
  const shown = bad.slice(0, 3);
  const more = bad.length > shown.length ? ` (+${bad.length - shown.length} more)` : "";
  const fixes = [...new Set(shown.map((c) => c.fix).filter((f): f is string => !!f))];
  return `Tests can't run: ${shown.map((c) => c.detail.replace(/\.$/, "")).join("; ")}${more}.${fixes.length ? ` Fix: ${fixes.map((f) => f.replace(/\.$/, "")).join("; ")}.` : ""}`;
}
