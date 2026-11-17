import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { aiwHome, paths, ensureDir } from "../core/paths.js";
import { getMeta, setMeta } from "../core/db.js";
import { logger } from "../core/log.js";
import { truncate } from "../core/util.js";
import { loadProjects, getProject, type ProjectConfig } from "../core/config.js";

/**
 * Code graph per repository, built with Graphify (github.com/Graphify-Labs/graphify, PyPI "graphifyy", Apache-2.0/MIT).
 *
 *  - Code only: parsed locally with tree-sitter – NO AI tokens, no API key (GRAPHIFY_BACKEND=none, --code-only).
 *  - Lives outside the repository: ~/.ai-workforce/projects/<id>/graph/graphify-out/graph.json (nothing is added to the repo).
 *  - Refreshed when the repository's HEAD moves (incremental), so agents look things up instead of reading many files.
 *  - Installed into ~/.ai-workforce/tools/graphify (its own Python venv) – the user's Python setup is not touched.
 * When Graphify is not available every caller falls back to normal searching (Grep/Read), so nothing breaks.
 */
const isWin = process.platform === "win32";

export function graphifyHome(): string { return path.join(aiwHome(), "tools", "graphify"); }

export function graphifyBin(): string | undefined {
  if (process.env.AIW_GRAPHIFY_BIN) return fs.existsSync(process.env.AIW_GRAPHIFY_BIN) ? process.env.AIW_GRAPHIFY_BIN : undefined;
  const p = path.join(graphifyHome(), isWin ? "Scripts" : "bin", isWin ? "graphify.exe" : "graphify");
  return fs.existsSync(p) ? p : undefined;
}

export const graphDir = (projectId: string) => path.join(paths.projectDir(projectId), "graph");
export const graphFile = (projectId: string) => path.join(graphDir(projectId), "graphify-out", "graph.json");
export const hasGraph = (projectId: string) => !!graphifyBin() && fs.existsSync(graphFile(projectId));

const ENV = () => ({ ...process.env, GRAPHIFY_BACKEND: "none", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" });

function run(args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  const bin = graphifyBin();
  if (!bin) return Promise.resolve({ code: 127, out: "Graphify is not installed" });
  return new Promise((resolve) => {
    execFile(bin, args, { env: ENV(), timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim() });
    });
  });
}

/** Find a Python 3.10+ to create Graphify's own virtual environment. */
function findPython(): string[] | undefined {
  const candidates: string[][] = isWin ? [["py", "-3.12"], ["py", "-3.11"], ["py", "-3.13"], ["py", "-3.10"], ["py", "-3"], ["python"]] : [["python3"], ["python"]];
  for (const c of candidates) {
    try {
      const v = execFileSync(c[0], [...c.slice(1), "-c", "import sys;print(sys.version_info[0]*100+sys.version_info[1])"], { encoding: "utf8", timeout: 20_000, windowsHide: true }).trim();
      if (Number(v) >= 310 && Number(v) < 315) return c;
    } catch { /* try the next one */ }
  }
  return undefined;
}

/** Install Graphify into its own venv (one time, ~1 minute). Returns a readable result. */
export async function installGraphify(): Promise<{ ok: boolean; detail: string }> {
  if (graphifyBin()) return { ok: true, detail: "already installed" };
  const py = findPython();
  if (!py) return { ok: false, detail: "No Python 3.10–3.14 found. Install Python 3.12 (python.org) and run `aiw graph install` again." };
  const home = graphifyHome();
  ensureDir(path.dirname(home));
  const sh = (cmd: string, args: string[]) => new Promise<{ code: number; out: string }>((resolve) =>
    execFile(cmd, args, { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err: any, so, se) => resolve({ code: err ? 1 : 0, out: `${so}\n${se}` })));
  const venv = await sh(py[0], [...py.slice(1), "-m", "venv", home]);
  if (venv.code !== 0) return { ok: false, detail: `Could not create Graphify's environment: ${truncate(venv.out, 300)}` };
  const pyBin = path.join(home, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
  const pip = await sh(pyBin, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "graphifyy"]);
  if (pip.code !== 0 || !graphifyBin()) return { ok: false, detail: `pip install graphifyy failed: ${truncate(pip.out, 400)}` };
  return { ok: true, detail: "installed" };
}

/** Build or refresh one repository's code graph (incremental; code only, no AI). */
export async function buildGraph(p: ProjectConfig, opts: { force?: boolean } = {}): Promise<{ ok: boolean; detail: string; ms: number }> {
  const start = Date.now();
  if (!graphifyBin()) return { ok: false, detail: "Graphify is not installed", ms: 0 };
  if (!fs.existsSync(p.local.path)) return { ok: false, detail: `missing folder ${p.local.path}`, ms: 0 };
  ensureDir(graphDir(p.id));
  const r = await run(["extract", p.local.path, "--code-only", "--out", graphDir(p.id), ...(opts.force ? ["--force"] : [])], 30 * 60_000);
  const ok = r.code === 0 && fs.existsSync(graphFile(p.id));
  if (ok) setMeta(`graph.${p.id}`, JSON.stringify({ head: repoHead(p.local.path), at: new Date().toISOString() }));
  else logger.warn("graph build failed", { project: p.id, out: truncate(r.out, 500) });
  return { ok, detail: ok ? "built" : truncate(r.out, 400), ms: Date.now() - start };
}

function repoHead(dir: string): string | undefined {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 15_000 }).trim(); } catch { return undefined; }
}

export function graphStatus(p: ProjectConfig): { installed: boolean; built: boolean; at?: string; current: boolean } {
  const meta = (() => { try { return JSON.parse(getMeta(`graph.${p.id}`) ?? "null"); } catch { return null; } })();
  const built = fs.existsSync(graphFile(p.id));
  return { installed: !!graphifyBin(), built, at: meta?.at, current: built && !!meta && meta.head === repoHead(p.local.path) };
}

let refreshing = false;
/** Background: rebuild graphs whose repository moved (after a pull / checkout). Never blocks the caller. */
export async function refreshGraphs(): Promise<number> {
  if (refreshing || !graphifyBin()) return 0;
  refreshing = true;
  let n = 0;
  try {
    for (const p of loadProjects().filter((x) => x.status !== "paused")) {
      if (graphStatus(p).current) continue;
      const r = await buildGraph(p);
      if (r.ok) n++;
      logger.info("code graph refreshed", { project: p.id, ok: r.ok, seconds: Math.round(r.ms / 1000) });
    }
  } finally { refreshing = false; }
  return n;
}

/** Make sure a repository has a graph before an agent needs it (builds it if missing; ~1–2 min the first time). */
export async function ensureGraph(projectId: string): Promise<boolean> {
  const p = getProject(projectId);
  if (!p || !graphifyBin()) return false;
  if (fs.existsSync(graphFile(projectId))) {
    if (!graphStatus(p).current) void buildGraph(p);     // refresh in the background; the slightly older graph is fine to start with
    return true;
  }
  return (await buildGraph(p)).ok;
}

// ------------------------------------------------------------------ queries (used by the agents' lookup tools)

/** Paths in the graph are relative to the repository root, so they also fit the task's worktree. */
export async function graphQuery(projectId: string, question: string, budget = 2000): Promise<string> {
  const r = await run(["query", question, "--graph", graphFile(projectId), "--budget", String(Math.min(Math.max(budget, 500), 8000))], 120_000);
  return clean(r);
}
export async function graphExplain(projectId: string, symbol: string): Promise<string> {
  return clean(await run(["explain", symbol, "--graph", graphFile(projectId)], 120_000));
}
export async function graphAffected(projectId: string, symbol: string): Promise<string> {
  return clean(await run(["affected", symbol, "--graph", graphFile(projectId), "--depth", "2"], 120_000));
}
export async function graphPath(projectId: string, from: string, to: string): Promise<string> {
  return clean(await run(["path", from, to, "--graph", graphFile(projectId), "--undirected"], 120_000));
}

function clean(r: { code: number; out: string }): string {
  const text = r.out.replace(/^Graph: [^\n]*graph\.json/m, "Graph").trim();
  if (r.code === 4) return `No matching code found. ${truncate(text, 500)}`;
  if (r.code === 3) return `Several matches – be more specific:\n${truncate(text, 3000)}`;
  if (r.code !== 0 && !text) return "The code graph could not answer – search with Grep instead.";
  return truncate(text, 12_000);
}
