import fs from "node:fs";
import path from "node:path";
import { paths, ensureDir } from "../core/paths.js";
import { git } from "../git/git.js";

/**
 * The Map: what exists in the code and where. Built from source with zero tokens.
 * Decision: v1 uses fast language-aware regex extraction behind this module's interface;
 * a tree-sitter backend can replace `extractSymbols` without changing callers.
 */
export interface FileEntry {
  path: string;
  lang: string;
  lines: number;
  symbols: string[];       // exported / top-level functions, classes, types
  imports: string[];       // resolved repo-relative paths where possible, else module names
  routes: string[];        // HTTP routes detected
  rank: number;            // importance (in-degree + entry-point bonus)
  hash: string;            // last-modified marker for incremental updates
}

export interface CodeMap {
  root: string;
  generatedAt: string;
  stack: StackInfo;
  files: FileEntry[];
}

export interface StackInfo { languages: Record<string, number>; frameworks: string[]; manifests: string[]; testCommand?: string; installCommand?: string }

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "target", "bin", "obj", ".next", ".nuxt", "vendor",
  ".venv", "venv", "__pycache__", ".idea", ".vscode", "coverage", ".ai-workforce", ".gradle", ".terraform"]);
const LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".java": "java", ".kt": "kotlin", ".go": "go", ".cs": "csharp", ".rb": "ruby", ".php": "php", ".rs": "rust",
  ".swift": "swift", ".sql": "sql", ".vue": "vue", ".svelte": "svelte",
};
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 20_000;

export function listSourceFiles(root: string): string[] {
  // Prefer git's view (respects .gitignore); fall back to a directory walk.
  const fromGit = git(root, ["ls-files", "--cached", "--others", "--exclude-standard"], { allowFail: true });
  const all = fromGit ? fromGit.split("\n") : walk(root);
  return all
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => f && LANG[path.extname(f).toLowerCase()] && !f.split("/").some((seg) => IGNORE_DIRS.has(seg)))
    .slice(0, MAX_FILES);
}

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) out.push(...walk(root, r)); }
    else out.push(r);
  }
  return out;
}

export function extractSymbols(lang: string, src: string): { symbols: string[]; imports: string[]; routes: string[] } {
  const symbols = new Set<string>(), imports = new Set<string>(), routes = new Set<string>();
  const add = (set: Set<string>, re: RegExp, g = 1) => { for (const m of src.matchAll(re)) if (m[g]) set.add(m[g]); };
  switch (lang) {
    case "typescript": case "javascript": case "vue": case "svelte":
      add(symbols, /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+([A-Za-z_$][\w$]*)/gm);
      add(symbols, /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm);
      add(symbols, /^\s*class\s+([A-Za-z_$][\w$]*)/gm);
      add(imports, /\bfrom\s+["']([^"']+)["']/g);
      add(imports, /\brequire\(\s*["']([^"']+)["']\s*\)/g);
      for (const m of src.matchAll(/\b(?:app|router|server)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/g)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
      for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*["']?([^"')]*)/g)) routes.add(`${m[1].toUpperCase()} ${m[2] || "/"}`);
      break;
    case "python":
      add(symbols, /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm);
      add(symbols, /^class\s+([A-Za-z_]\w*)/gm);
      add(imports, /^\s*from\s+([\w.]+)\s+import/gm);
      add(imports, /^\s*import\s+([\w.]+)/gm);
      for (const m of src.matchAll(/@\w+\.(get|post|put|patch|delete|route)\(\s*["']([^"']+)/g)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
      break;
    case "java": case "kotlin":
      add(symbols, /\b(?:public\s+)?(?:abstract\s+|final\s+)?(?:class|interface|enum|record|object)\s+([A-Z]\w*)/g);
      add(imports, /^\s*import\s+([\w.]+)/gm);
      for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)/g)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
      break;
    case "csharp":
      add(symbols, /\b(?:class|interface|record|enum|struct)\s+([A-Z]\w*)/g);
      add(imports, /^\s*using\s+([\w.]+);/gm);
      for (const m of src.matchAll(/\[Http(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)/g)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
      break;
    case "go":
      add(symbols, /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm);
      add(symbols, /^type\s+([A-Za-z_]\w*)/gm);
      add(imports, /^\s*"([\w./-]+)"$/gm);
      break;
    case "ruby":
      add(symbols, /^\s*(?:class|module)\s+([A-Z][\w:]*)/gm);
      add(symbols, /^\s*def\s+([a-z_]\w*[?!]?)/gm);
      break;
    case "php":
      add(symbols, /\b(?:class|interface|trait)\s+([A-Z]\w*)/g);
      add(symbols, /\bfunction\s+([a-zA-Z_]\w*)/g);
      break;
    case "rust":
      add(symbols, /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm);
      add(imports, /^\s*use\s+([\w:]+)/gm);
      break;
    case "sql":
      add(symbols, /\bcreate\s+(?:table|view|index)\s+(?:if\s+not\s+exists\s+)?["`]?([\w.]+)/gi);
      break;
  }
  return { symbols: [...symbols].slice(0, 60), imports: [...imports].slice(0, 80), routes: [...routes].slice(0, 40) };
}

function resolveImport(from: string, spec: string, fileSet: Set<string>): string {
  if (!spec.startsWith(".")) {
    // Python / Java dotted modules -> path guess
    const guess = spec.replace(/\./g, "/");
    for (const ext of [".py", ".java", ".kt", ".ts", ".js"]) if (fileSet.has(guess + ext)) return guess + ext;
    return spec;
  }
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\.(js|mjs|cjs)$/, "");
  for (const c of [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue"].map((e) => base + e), ...["/index.ts", "/index.tsx", "/index.js"].map((e) => base + e)]) {
    if (fileSet.has(c)) return c;
  }
  return spec;
}

export function detectStack(root: string): StackInfo {
  const exists = (f: string) => fs.existsSync(path.join(root, f));
  const read = (f: string) => { try { return fs.readFileSync(path.join(root, f), "utf8"); } catch { return ""; } };
  const manifests = ["package.json", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "*.csproj"]
    .filter((m) => (m.startsWith("*") ? fs.readdirSync(root).some((f) => f.endsWith(m.slice(1))) : exists(m)));
  const frameworks: string[] = [];
  let testCommand: string | undefined, installCommand: string | undefined;
  if (exists("package.json")) {
    const pkg = safeParse(read("package.json"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const [dep, name] of [["react", "React"], ["next", "Next.js"], ["vue", "Vue"], ["@angular/core", "Angular"], ["express", "Express"], ["@nestjs/core", "NestJS"], ["fastify", "Fastify"], ["jest", "Jest"], ["vitest", "Vitest"], ["mocha", "Mocha"], ["prisma", "Prisma"], ["typeorm", "TypeORM"], ["stripe", "Stripe SDK"]] as const)
      if (deps[dep]) frameworks.push(name);
    const pm = exists("pnpm-lock.yaml") ? "pnpm" : exists("yarn.lock") ? "yarn" : "npm";
    installCommand = pm === "npm" ? (exists("package-lock.json") ? "npm ci" : "npm install") : `${pm} install`;
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) testCommand = `${pm} test`;
  }
  if (exists("pyproject.toml") || exists("requirements.txt")) {
    const txt = read("pyproject.toml") + read("requirements.txt");
    for (const [k, n] of [["django", "Django"], ["fastapi", "FastAPI"], ["flask", "Flask"], ["pytest", "pytest"], ["sqlalchemy", "SQLAlchemy"]]) if (txt.toLowerCase().includes(k)) frameworks.push(n);
    testCommand ??= "python -m pytest -q";
    installCommand ??= exists("requirements.txt") ? "pip install -r requirements.txt" : undefined;
  }
  if (exists("pom.xml")) { frameworks.push(read("pom.xml").includes("spring-boot") ? "Spring Boot" : "Maven"); testCommand ??= "mvn -q test"; }
  if (exists("build.gradle") || exists("build.gradle.kts")) { frameworks.push("Gradle"); testCommand ??= process.platform === "win32" ? "gradlew.bat test" : "./gradlew test"; }
  if (exists("go.mod")) testCommand ??= "go test ./...";
  if (exists("Cargo.toml")) testCommand ??= "cargo test";
  return { languages: {}, frameworks, manifests, testCommand, installCommand };
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

/** Build (or incrementally refresh) the map. Only files whose mtime/size changed are re-parsed. */
export function buildCodeMap(projectId: string, root: string, previous?: CodeMap): CodeMap {
  const files = listSourceFiles(root);
  const fileSet = new Set(files);
  const prev = new Map((previous?.files ?? []).map((f) => [f.path, f]));
  const entries: FileEntry[] = [];
  const languages: Record<string, number> = {};
  for (const rel of files) {
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    const lang = LANG[path.extname(rel).toLowerCase()];
    languages[lang] = (languages[lang] ?? 0) + 1;
    const hash = `${st.size}:${Math.floor(st.mtimeMs)}`;
    const old = prev.get(rel);
    if (old && old.hash === hash) { entries.push({ ...old, rank: 0 }); continue; }
    const src = fs.readFileSync(abs, "utf8");
    const { symbols, imports, routes } = extractSymbols(lang, src);
    entries.push({ path: rel, lang, lines: src.split("\n").length, symbols, imports: imports.map((i) => resolveImport(rel, i, fileSet)), routes, rank: 0, hash });
  }
  // Rank: how many files import this one, plus bonuses for entry points and routes.
  const inDeg = new Map<string, number>();
  for (const e of entries) for (const i of e.imports) if (fileSet.has(i)) inDeg.set(i, (inDeg.get(i) ?? 0) + 1);
  for (const e of entries) {
    const entryBonus = /(^|\/)(main|index|app|server|program|manage|urls|routes?)\.\w+$/.test(e.path) ? 3 : 0;
    const testPenalty = /(test|spec)s?[./]/i.test(e.path) ? -2 : 0;
    e.rank = (inDeg.get(e.path) ?? 0) * 2 + e.routes.length * 2 + entryBonus + testPenalty + Math.min(3, e.symbols.length / 10);
  }
  entries.sort((a, b) => b.rank - a.rank);
  const stack = detectStack(root);
  stack.languages = languages;
  const map: CodeMap = { root, generatedAt: new Date().toISOString(), stack, files: entries };
  ensureDir(paths.projectDir(projectId));
  fs.writeFileSync(paths.codeMap(projectId), JSON.stringify(map));
  return map;
}

export function loadCodeMap(projectId: string): CodeMap | undefined {
  try { return JSON.parse(fs.readFileSync(paths.codeMap(projectId), "utf8")); } catch { return undefined; }
}

/** Files whose path or symbols match any of the terms, best first. */
export function findInMap(map: CodeMap, terms: string[], limit = 12): FileEntry[] {
  const ts = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 2);
  if (!ts.length) return [];
  const scored = map.files.map((f) => {
    const hay = (f.path + " " + f.symbols.join(" ") + " " + f.routes.join(" ")).toLowerCase();
    const hits = ts.filter((t) => hay.includes(t)).length;
    const own = ts.filter((t) => f.path.toLowerCase().includes(t) || f.symbols.some((x) => x.toLowerCase().includes(t))).length;
    return { f, s: hits * 10 + own * 6 + f.rank };
  }).filter((x) => x.s >= 10);
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.f);
}

export function mapSummary(map: CodeMap, top = 25): string {
  const langs = Object.entries(map.stack.languages).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n})`).join(", ");
  const lines = [`Languages: ${langs || "unknown"}`, `Frameworks: ${map.stack.frameworks.join(", ") || "none detected"}`,
    `Test command: ${map.stack.testCommand ?? "none detected"}`, `Most important files:`];
  for (const f of map.files.slice(0, top)) {
    lines.push(`- ${f.path}${f.symbols.length ? ` — ${f.symbols.slice(0, 6).join(", ")}` : ""}${f.routes.length ? ` [${f.routes.slice(0, 4).join("; ")}]` : ""}`);
  }
  return lines.join("\n");
}
