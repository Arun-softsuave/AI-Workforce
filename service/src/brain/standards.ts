import fs from "node:fs";
import path from "node:path";
import { git } from "../git/git.js";

/**
 * Coding standards learned from the repository's own files (no AI, no tokens):
 *  - docstring style  : Google / NumPy / reST for Python, JSDoc / TSDoc for JS/TS – and how often public code has one
 *  - test layout      : where tests live and how test files are named
 *  - pushable files   : what may be committed – real source and real tests – and what never is (scratch, debug, logs, local config)
 */

export type DocStyle = "google" | "numpy" | "rest" | "plain" | "jsdoc" | "none";

export interface DocstringRule {
  language: "python" | "js";
  style: DocStyle;
  /** Share of public functions/classes that have a docstring (0..1). */
  coverage: number;
  sampled: number;
  /** One real example from the repository (signature + docstring), so agents copy the team's exact shape. */
  example?: string;
  exampleFile?: string;
  /** JS/TS: the blocks use @param / @returns tags. */
  tagged?: boolean;
}

export interface TestLayout {
  /** Folders that hold tests (most used first), e.g. ["tests/", "app/__tests__/"]. */
  dirs: string[];
  /** File name patterns, e.g. ["test_*.py", "*.test.ts"]. */
  patterns: string[];
  count: number;
  example?: string;
}

export interface Standards {
  docstrings: DocstringRule[];
  tests: TestLayout;
}

const MAX_SAMPLE = 80;

/** Tracked files of the repository (respects .gitignore; vendored and generated folders excluded). */
export function trackedFiles(repo: string): string[] {
  const out = git(repo, ["ls-files"], { allowFail: true });
  return out.split("\n").map((s) => s.trim()).filter((f) => f && !/(^|\/)(node_modules|dist|build|\.next|vendor|migrations|__generated__|generated)\//.test(f));
}

function readSafe(file: string, max = 200_000): string {
  try { const s = fs.readFileSync(file, "utf8"); return s.length > max ? s.slice(0, max) : s; } catch { return ""; }
}

/** Spread the sample over the repository instead of taking only the first folder. */
function sample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]);
}

// ------------------------------------------------------------------ Python docstrings

interface PyDef { name: string; signature: string; doc?: string }

/** Top-level and class-level public defs with their docstring (if any). */
export function pythonDefs(src: string): PyDef[] {
  const lines = src.split(/\r?\n/);
  const defs: PyDef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (!m || m[3].startsWith("_")) continue;
    if (m[1].length > 4) continue;                              // nested helpers are not public API
    // the signature may span lines: up to the line ending with ":"
    let j = i; const sig: string[] = [lines[i]];
    while (!/:\s*(#.*)?$/.test(lines[j]) && j < i + 12 && j + 1 < lines.length) { j++; sig.push(lines[j]); }
    let k = j + 1;
    while (k < lines.length && !lines[k].trim()) k++;
    const first = lines[k] ?? "";
    const q = /^\s*[rubRUB]{0,2}("""|''')/.exec(first);
    let doc: string | undefined;
    if (q) {
      const quote = q[1];
      const rest = first.slice(first.indexOf(quote) + 3);
      if (rest.includes(quote)) doc = rest.slice(0, rest.indexOf(quote));
      else {
        const body: string[] = [rest];
        let e = k + 1;
        while (e < lines.length && !lines[e].includes(quote) && e < k + 80) { body.push(lines[e]); e++; }
        if (e < lines.length) body.push(lines[e].slice(0, lines[e].indexOf(quote)));
        doc = body.join("\n");
      }
    }
    defs.push({ name: m[3], signature: sig.join("\n"), doc });
  }
  return defs;
}

export function pythonDocStyle(doc: string): DocStyle {
  if (/^\s*(Parameters|Returns|Raises|Yields|Attributes)\s*\n\s*-{3,}/m.test(doc)) return "numpy";
  if (/^\s*(Args|Arguments|Returns|Raises|Yields|Attributes|Example|Examples|Note):\s*$/m.test(doc)) return "google";
  if (/:param\s|:returns?:|:rtype:|:raises?\s/.test(doc)) return "rest";
  return "plain";
}

function dominant<T extends string>(counts: Record<string, number>, fallback: T): T {
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return (top?.[0] as T) ?? fallback;
}

export function detectPythonDocstrings(repo: string, files: string[]): DocstringRule | undefined {
  const py = files.filter((f) => f.endsWith(".py") && !isTestFile(f) && !/(^|\/)(migrations|alembic)\//.test(f) && !/__init__\.py$/.test(f));
  if (!py.length) return undefined;
  let total = 0, documented = 0;
  const styles: Record<string, number> = {};
  const examples: Partial<Record<DocStyle, { text: string; file: string; score: number }>> = {};
  for (const f of sample(py, MAX_SAMPLE)) {
    for (const d of pythonDefs(readSafe(path.join(repo, f)))) {
      total++;
      if (!d.doc?.trim()) continue;
      documented++;
      const s = pythonDocStyle(d.doc);
      styles[s] = (styles[s] ?? 0) + 1;
      // the best example: a documented function with a structured docstring, not too long
      const lines = d.doc.split("\n").length;
      const score = (s === "plain" ? 0 : 10) + (lines >= 3 && lines <= 18 ? 5 : 0) + (/def /.test(d.signature) ? 2 : 0);
      if (!examples[s] || score > examples[s]!.score) {
        const indent = /^(\s*)/.exec(d.signature)![1];
        const text = `${d.signature.trimEnd()}\n${indent}    """${d.doc.replace(/\s+$/, "")}\n${indent}    """`;
        if (text.length < 1400) examples[s] = { text, file: f, score };
      }
    }
  }
  if (!total) return undefined;
  const structured = Object.fromEntries(Object.entries(styles).filter(([k]) => k !== "plain"));
  // a structured style wins when it is used at least a quarter as often as plain one-liners
  const style: DocStyle = documented === 0 ? "none"
    : Object.keys(structured).length && Math.max(...Object.values(structured)) * 4 >= (styles.plain ?? 0) ? dominant<DocStyle>(structured, "plain") : "plain";
  const ex = examples[style];
  return { language: "python", style, coverage: round2(documented / total), sampled: total, example: ex?.text, exampleFile: ex?.file };
}

// ------------------------------------------------------------------ JS / TS doc comments

export function detectJsDocstrings(repo: string, files: string[]): DocstringRule | undefined {
  const js = files.filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && !/\.d\.ts$/.test(f) && !isTestFile(f) && !/(^|\/)(public|static|assets)\//.test(f));
  if (!js.length) return undefined;
  let total = 0, documented = 0, tagged = 0;
  let example: { text: string; file: string } | undefined;
  const exportRe = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+\w+/;
  for (const f of sample(js, MAX_SAMPLE)) {
    const lines = readSafe(path.join(repo, f)).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!exportRe.test(lines[i].trim())) continue;
      total++;
      // a /** ... */ block directly above (decorators allowed in between)
      let k = i - 1;
      while (k >= 0 && /^\s*@/.test(lines[k])) k--;
      if (k < 0 || !/\*\/\s*$/.test(lines[k])) continue;
      let s = k;
      while (s >= 0 && !/^\s*\/\*\*/.test(lines[s]) && k - s < 40) s--;
      if (s < 0 || !/^\s*\/\*\*/.test(lines[s])) continue;
      documented++;
      const block = lines.slice(s, k + 1).join("\n");
      if (/@(param|returns?|throws)\b/.test(block)) tagged++;
      const text = `${block}\n${lines[i]}`;
      if ((!example || (/@param/.test(text) && !/@param/.test(example.text))) && text.length < 1200) example = { text, file: f };
    }
  }
  if (!total) return undefined;
  const style: DocStyle = documented && documented / total >= 0.15 ? "jsdoc" : "none";
  return { language: "js", style, coverage: round2(documented / total), sampled: total, example: style === "jsdoc" ? example?.text : undefined, exampleFile: style === "jsdoc" ? example?.file : undefined, tagged: tagged > 0 };
}

// ------------------------------------------------------------------ test layout

const TEST_FILE = /(^|\/)(test_[^/]+\.py|[^/]+_test\.py|conftest\.py|[^/]+\.(test|spec)\.[cm]?[jt]sx?|[^/]+_test\.go|[^/]+Test\.(java|kt))$/;
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e|integration_tests)\//;

export function isTestFile(f: string): boolean { return TEST_FILE.test(f) || TEST_DIR.test(f); }

function patternOf(f: string): string | undefined {
  const b = path.posix.basename(f);
  if (/^test_.+\.py$/.test(b)) return "test_*.py";
  if (/_test\.py$/.test(b)) return "*_test.py";
  const m = /\.(test|spec)\.([cm]?[jt]sx?)$/.exec(b);
  if (m) return `*.${m[1]}.${m[2]}`;
  if (/_test\.go$/.test(b)) return "*_test.go";
  return undefined;
}

export function detectTestLayout(files: string[]): TestLayout {
  const tests = files.filter((f) => TEST_FILE.test(f) && !/conftest\.py$/.test(f));
  const dirs: Record<string, number> = {};
  const pats: Record<string, number> = {};
  for (const f of tests) {
    const m = TEST_DIR.exec(f);
    const dir = m ? f.slice(0, m.index + m[0].length).replace(/^\//, "") : `${path.posix.dirname(f)}/`;
    dirs[dir] = (dirs[dir] ?? 0) + 1;
    const p = patternOf(f);
    if (p) pats[p] = (pats[p] ?? 0) + 1;
  }
  const sorted = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  // tests next to the source (e.g. src/x/foo.test.ts) show up as many small folders: summarise as "next to the source"
  const dirList = sorted(dirs);
  const colocated = dirList.length > 6 && !dirList.slice(0, 3).some((d) => TEST_DIR.test(d));
  return { dirs: colocated ? ["(next to the source file)"] : dirList.slice(0, 4), patterns: sorted(pats).slice(0, 3), count: tests.length, example: tests[0] };
}

export function detectStandards(repo: string, files = trackedFiles(repo)): Standards {
  return {
    docstrings: [detectPythonDocstrings(repo, files), detectJsDocstrings(repo, files)].filter((x): x is DocstringRule => !!x),
    tests: detectTestLayout(files),
  };
}

// ------------------------------------------------------------------ pushable files

/** Never part of a change, whatever the folder (scratch, debug, logs, local config, build and coverage output). */
export const NEVER_PUSH: { re: RegExp; why: string }[] = [
  { re: /(^|\/)\.env(\..*)?$/i, why: "local environment file" },
  { re: /\.(log|tmp|bak|orig|rej|swp|pyc)$/i, why: "log / temporary file" },
  { re: /(^|\/)(scratch|tmp|temp|debug|playground|sandbox)[^/]*\.(py|ts|js|mjs|tsx|jsx|sh|txt|json|md)$/i, why: "scratch / debug script" },
  { re: /(^|\/)(scratch|tmp|temp|playground|sandbox)\//i, why: "scratch folder" },
  { re: /(^|\/)(debug|try|check|quick|my)_?[^/]*\.(py|ts|js|mjs)$/i, why: "ad-hoc debug script" },
  { re: /\.ipynb$/i, why: "notebook" },
  { re: /(^|\/)(coverage|htmlcov|\.pytest_cache|\.mypy_cache|\.ruff_cache|playwright-report|test-results|\.nyc_output)\//i, why: "test / coverage output" },
  { re: /(^|\/)(\.coverage|coverage\.xml|junit\.xml|lcov\.info)$/i, why: "coverage report" },
  { re: /(^|\/)(\.DS_Store|Thumbs\.db)$/i, why: "system file" },
  { re: /(^|\/)\.(vscode|idea)\//i, why: "editor settings" },
  { re: /(^|\/)\.ai-workforce\//i, why: "AI Workforce working files" },
  { re: /\.(png|jpe?g|gif|webp)$/i, why: "screenshot / image (only when not already part of the repo's assets)" },
];

export type FileVerdict = { kind: "source" | "test" | "junk" | "unclear"; why: string };

/**
 * Should a NEW or changed file go into the commit? Rules only – "unclear" files are decided by a cheap model call later.
 *  - files that already exist on the base branch are always kept (editing them is the change)
 *  - tests are kept only inside the team's test layout and naming
 */
export function classifyFile(f: string, layout: TestLayout | undefined, existedBefore: boolean, imageDirs: string[] = []): FileVerdict {
  if (existedBefore) return { kind: "source", why: "existing file" };
  for (const n of NEVER_PUSH) {
    if (!n.re.test(f)) continue;
    if (/image/.test(n.why) && imageDirs.some((d) => f.startsWith(d))) break;      // a new icon in the app's assets is fine
    return { kind: "junk", why: n.why };
  }
  if (TEST_FILE.test(f) || /(^|\/)test[^/]*\.(py|ts|js)$/i.test(f)) {
    if (!layout || !layout.count) return { kind: "test", why: "test file (repo has no test layout yet)" };
    const inDir = layout.dirs.includes("(next to the source file)") || layout.dirs.some((d) => f.startsWith(d) || f.includes(`/${d}`));
    const named = !layout.patterns.length || layout.patterns.some((p) => globMatch(p, path.posix.basename(f)));
    return inDir && named ? { kind: "test", why: "in the test layout" } : { kind: "junk", why: `test file outside the team's test layout (${layout.dirs.join(", ")} · ${layout.patterns.join(", ")})` };
  }
  return { kind: "source", why: "source file" };
}

function globMatch(glob: string, name: string): boolean {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name);
}

function round2(n: number) { return Math.round(n * 100) / 100; }

export function docstringLine(r: DocstringRule): string {
  const lang = r.language === "python" ? "Python" : "JS/TS";
  if (r.style === "none") return `${lang}: the team rarely writes doc comments (${Math.round(r.coverage * 100)}% of ${r.sampled} public items) – don't add long ones; a one-line comment where the code is not obvious.`;
  const name = { google: "Google style (Args: / Returns: / Raises:)", numpy: "NumPy style (Parameters / Returns with ---- underlines)", rest: "reST style (:param x: / :returns:)", plain: "short one-paragraph docstrings", jsdoc: "JSDoc/TSDoc blocks (/** ... */ with @param / @returns)", none: "" }[r.style];
  return `${lang}: ${name} on public functions and classes (${Math.round(r.coverage * 100)}% of ${r.sampled} sampled have one) – every new or changed public function gets one in this style.`;
}
