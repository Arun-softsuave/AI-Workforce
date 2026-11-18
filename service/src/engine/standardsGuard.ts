import fs from "node:fs";
import path from "node:path";
import { fixCommandFor } from "./steps/ciClass.js";
import type { ProjectConfig } from "../core/config.js";
import type { DocstringRule } from "../brain/standards.js";

/**
 * R-STD helpers (no model calls):
 *  - the commands the coding agent may run besides the tests: the repository's own lint-fix / format commands and its
 *    package manager's add / lock commands (so a new dependency goes in the repository's way, lock file included);
 *  - dependency files a change touched (named in the PR);
 *  - new or changed public functions without a doc comment, in a repository whose team writes them.
 */

/** The prefix of a check command before its file placeholder ("ruff check {py}" → "ruff check"). */
const prefixOf = (cmd: string) => cmd.split(/\s*\{(py|js|all|files)\}/)[0].trim();

/** Lock files and the package-manager commands that keep them right. */
const MANAGERS: { lock: string; cmds: string[] }[] = [
  { lock: "uv.lock", cmds: ["uv add", "uv remove", "uv lock", "uv sync"] },
  { lock: "poetry.lock", cmds: ["poetry add", "poetry remove", "poetry lock"] },
  { lock: "pdm.lock", cmds: ["pdm add", "pdm remove", "pdm lock"] },
  { lock: "package-lock.json", cmds: ["npm install", "npm uninstall"] },
  { lock: "pnpm-lock.yaml", cmds: ["pnpm add", "pnpm remove", "pnpm install"] },
  { lock: "yarn.lock", cmds: ["yarn add", "yarn remove"] },
  { lock: "Cargo.lock", cmds: ["cargo add", "cargo remove"] },
  { lock: "go.sum", cmds: ["go get", "go mod tidy"] },
];

function packageScripts(dir: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts ?? {}; } catch { return {}; }
}

/** Commands (prefixes) the coding agent may run in this repository besides the tests. */
export function extraAgentCommands(project: Pick<ProjectConfig, "local" | "conventions">): string[] {
  const dir = project.local.path;
  const out = new Set<string>();
  const scripts = packageScripts(dir);
  for (const check of project.conventions?.checks ?? []) {
    const fix = fixCommandFor(prefixOf(check), scripts);
    if (fix) out.add(prefixOf(fix));
  }
  for (const job of project.conventions?.ci?.jobs ?? []) {
    if (!job.localCommand || !job.kinds?.some((k: string) => k === "lint" || k === "format")) continue;
    const fix = fixCommandFor(job.localCommand, scripts);
    if (fix) out.add(prefixOf(fix));
  }
  for (const m of MANAGERS) if (fs.existsSync(path.join(dir, m.lock))) m.cmds.forEach((c) => out.add(c));
  return [...out].filter((c) => c.length >= 3);
}

const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|Pipfile|setup\.(py|cfg)|Cargo\.toml|go\.mod|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?)$|(^|\/)(uv\.lock|poetry\.lock|pdm\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/i;

/** Dependency manifests and lock files this change touched (said in the PR). */
export function dependencyFiles(files: string[]): string[] {
  return files.filter((f) => MANIFEST.test(f));
}

/** Names the diff adds to a dependency manifest (best effort: package.json "name": "^1", pyproject "name>=1"). */
export function addedDependencies(diff: string): string[] {
  const out = new Set<string>();
  let file = "";
  for (const l of diff.split("\n")) {
    const h = /^\+\+\+ b\/(.+)$/.exec(l);
    if (h) { file = h[1]; continue; }
    if (!l.startsWith("+") || l.startsWith("+++")) continue;
    if (/package\.json$/.test(file)) { const m = /^\+\s*"(@?[\w./-]+)"\s*:\s*"[~^]?\d/.exec(l); if (m) out.add(m[1]); }
    else if (/pyproject\.toml$|requirements[^/]*\.txt$/.test(file)) { const m = /^\+\s*"?([A-Za-z0-9_.-]+)(\[[^\]]*\])?\s*(==|>=|~=|<|>|$|")/.exec(l); if (m && !/^(name|version|description|python|requires)/i.test(m[1])) out.add(m[1]); }
  }
  return [...out];
}

export interface MissingDoc { file: string; line: number; name: string }

/**
 * New or changed public functions / classes without a doc comment, from the added lines of a unified diff.
 * Python: "def name(" / "class Name" not starting with "_" whose next non-empty line is no docstring.
 * JS/TS: an exported function / class / const arrow whose previous line does not end a /** … *\/ block.
 */
export function missingDocstrings(wt: string, diff: string, rules: DocstringRule[]): MissingDoc[] {
  const want = new Set(rules.filter((r) => r.style !== "none" && r.coverage >= 0.4).map((r) => r.language));
  if (!want.size) return [];
  const out: MissingDoc[] = [];
  let file = "";
  let lineNo = 0;
  const lines = new Map<string, string[]>();
  const fileLines = (f: string) => { if (!lines.has(f)) { try { lines.set(f, fs.readFileSync(path.join(wt, f), "utf8").split(/\r?\n/)); } catch { lines.set(f, []); } } return lines.get(f)!; };
  for (const l of diff.split("\n")) {
    const h = /^\+\+\+ b\/(.+)$/.exec(l);
    if (h) { file = h[1]; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) { lineNo = Number(hunk[1]); continue; }
    if (l.startsWith("-")) continue;
    if (l.startsWith("+")) {
      const code = l.slice(1);
      const py = want.has("python") && /\.py$/.test(file) && !/(^|\/)tests?\/|test_[^/]*\.py$/.test(file) ? /^\s*(?:async\s+)?(def|class)\s+([A-Za-z]\w*)/.exec(code) : null;
      const js = want.has("js") && /\.(m?[jt]sx?)$/.test(file) && !/\.(test|spec)\.|__tests__/.test(file)
        ? /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/.exec(code) : null;
      const src = fileLines(file);
      if (py && !py[2].startsWith("_")) {
        // the body's first statement (after the signature, which may span lines)
        let i = lineNo; while (i < src.length && !/:\s*(#.*)?$/.test(src[i - 1] ?? "")) i++;
        const next = src.slice(i).find((x) => x.trim()) ?? "";
        if (!/^\s*[rRbBuU]?("""|''')/.test(next)) out.push({ file, line: lineNo, name: py[2] });
      } else if (js) {
        const prev = (src[lineNo - 2] ?? "").trim();
        if (!/\*\/$/.test(prev)) out.push({ file, line: lineNo, name: js[1] ?? js[2] ?? js[3] });
      }
      lineNo++;
      continue;
    }
    lineNo++;
  }
  return out;
}
