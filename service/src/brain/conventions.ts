import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getProject, upsertProject, type ProjectConfig } from "../core/config.js";
import { git } from "../git/git.js";
import { truncate, slugify } from "../core/util.js";
import { audit } from "../core/db.js";
import { clients } from "../connectors/registry.js";
import { detectStandards, docstringLine } from "./standards.js";
import { detectCiPipeline, ciSummaryLines } from "./ciPipeline.js";
import { readRulesCard } from "./rulesCard.js";

/**
 * Project conventions, detected dynamically per repository (and per Jira project) – nothing is hard-coded.
 *  - base branch          : where PRs actually go (GitHub PR history, else git history)
 *  - branch / commit style: learned from recent branch names and commit subjects
 *  - instruction files    : CLAUDE.md, AGENTS.md, CONTRIBUTING.md, Cursor/Copilot rules – given to every agent
 *  - PR template          : filled in by the Reporter
 *  - checks               : lint / format / type commands (pre-commit, ruff, eslint, prettier, package scripts)
 *  - ticket conventions   : title prefixes, labels and issue types from recent Jira tickets
 * Anything the user sets explicitly (overrides) wins over detection and survives re-detection.
 */
export interface Conventions {
  baseBranch: string;
  baseBranchSource: string;
  branchTemplate: string;            // e.g. "{type}/{key}/{slug}"
  branchTypes: Record<string, string>; // ticket type -> branch prefix, e.g. { feature: "feat", bug: "fix" }
  commitTemplate: string;            // e.g. "{type}({scope}): {summary} {key}"
  commitTypes: string[];
  instructionFiles: string[];        // repo-relative
  prTemplate?: string;               // repo-relative
  checks: string[];                  // commands; {files} = changed files of the matching kind
  ticket?: { titlePrefix?: string; commonLabels: string[]; issueTypes: string[]; example?: string };
  env?: { python?: string; brokenPython?: string; linkedDirs: string[] };   // reuse the project's own environment in task workspaces
  /** Docstring style and test layout, learned from the repository's files. */
  standards?: import("./standards.js").Standards;
  /** What CI runs on a pull request (.github/workflows) and which checks the plugin may fix itself. */
  ci?: import("./ciPipeline.js").CiPipeline;
  detectedAt: string;
  confirmed: boolean;
  overrides: Partial<Pick<Conventions, "baseBranch" | "branchTemplate" | "commitTemplate" | "checks">>;
}

const INSTRUCTION_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", "docs/CONTRIBUTING.md", ".github/CONTRIBUTING.md",
  ".cursorrules", ".github/copilot-instructions.md", "CODING_GUIDELINES.md", "STYLEGUIDE.md"];
const PR_TEMPLATES = [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md", "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE/default.md"];
const BASE_CANDIDATES = ["dev", "develop", "development", "staging", "main", "master", "trunk"];

const exists = (repo: string, rel: string) => fs.existsSync(path.join(repo, rel));
const read = (repo: string, rel: string) => { try { return fs.readFileSync(path.join(repo, rel), "utf8"); } catch { return ""; } };

/** The project's own virtualenv interpreter (absolute path), so task workspaces use the same installed packages. */
export function venvPython(repo: string): string | undefined {
  const s = venvStatus(repo);
  return s.ok ? s.path : undefined;
}

/** Find the project's virtualenv and check that its interpreter actually starts (uv/venv can break when Python moves). */
export function venvStatus(repo: string): { path?: string; ok: boolean; error?: string } {
  for (const dir of [".venv", "venv", "env", ".env"]) {
    const exe = process.platform === "win32" ? path.join(repo, dir, "Scripts", "python.exe") : path.join(repo, dir, "bin", "python");
    if (!fs.existsSync(exe)) continue;
    try { execFileSync(exe, ["--version"], { stdio: "pipe", timeout: 20_000 }); return { path: exe, ok: true }; }
    catch (e: any) { return { path: exe, ok: false, error: String(e.stderr ?? e.message).trim().split("\n")[0] }; }
  }
  return { ok: true };
}

/** How to repair a broken environment, based on the tooling the repo uses. */
export function envRepairHint(repo: string): string {
  if (exists(repo, "uv.lock")) return `cd "${repo}" && uv sync   (re-creates .venv with uv)`;
  if (exists(repo, "poetry.lock")) return `cd "${repo}" && poetry install`;
  if (exists(repo, "requirements.txt")) return `cd "${repo}" && python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt`;
  return `re-create the virtualenv in ${repo}`;
}

function pyModuleAvailable(python: string, mod: string): boolean {
  try { execFileSync(python, ["-m", mod, "--version"], { stdio: "ignore", timeout: 20_000 }); return true; } catch { return false; }
}

const q = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

/** Dependency folders that exist only in the main clone (git-ignored) and are linked into task workspaces. */
export function dependencyDirs(repo: string): string[] {
  return ["node_modules"].filter((d) => fs.existsSync(path.join(repo, d)));
}

function hasTool(cmd: string): boolean {
  try { execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }); return true; } catch { return false; }
}

// ------------------------------------------------------------------ base branch

export async function detectBaseBranch(repo: string, githubRepo?: string): Promise<{ branch: string; source: string }> {
  // 1. Ground truth: where recent PRs were opened against (GitHub).
  const gh = clients.github() as any;
  if (gh && githubRepo && gh.recentPrBases) {
    try {
      const bases: string[] = await gh.recentPrBases(githubRepo, 30);
      if (bases.length) {
        const counts = tally(bases);
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        return { branch: top[0], source: `GitHub: ${top[1]} of the last ${bases.length} PRs target ${top[0]}` };
      }
    } catch { /* fall back to git */ }
  }
  // 2. git history: which candidate branch do feature branches merge from, and which received the most merges recently.
  const remotes = git(repo, ["branch", "-r", "--format=%(refname:short)"], { allowFail: true }).split("\n").map((s) => s.trim().replace(/^origin\//, ""));
  const present = BASE_CANDIDATES.filter((b) => remotes.includes(b));
  if (!present.length) {
    const head = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowFail: true }).replace("origin/", "");
    return { branch: head || "main", source: "default branch of the remote" };
  }
  const subjects = git(repo, ["log", "--all", "--merges", "-n", "300", "--format=%s"], { allowFail: true });
  const score: Record<string, number> = {};
  for (const b of present) {
    const fromIt = (subjects.match(new RegExp(`Merge (remote-tracking )?branch '(origin/)?${b}' into`, "g")) ?? []).length;
    const merges = Number(git(repo, ["rev-list", "--merges", "--count", "--since=60.days", `origin/${b}`], { allowFail: true }) || 0);
    score[b] = fromIt * 3 + merges;
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return { branch: best[0], source: `git history (score ${JSON.stringify(score)})` };
}

// ------------------------------------------------------------------ branch names

export function inferBranchTemplate(branches: string[]): { template: string; types: Record<string, string> } {
  const shapes: Record<string, number> = {};
  const prefixes: Record<string, number> = {};
  for (const b of branches) {
    const parts = b.split("/");
    const keyIdx = parts.findIndex((p) => /^[A-Z][A-Z0-9]+-\d+$/.test(p));
    let shape: string | undefined;
    if (parts.length === 3 && keyIdx === 1) shape = "{type}/{key}/{slug}";
    else if (parts.length === 2 && keyIdx === 0) shape = "{key}/{slug}";
    else if (parts.length === 2 && /^[A-Z][A-Z0-9]+-\d+[-_]/.test(parts[1])) shape = "{type}/{key}-{slug}";
    else if (parts.length === 2 && keyIdx === -1) shape = "{type}/{slug}";
    if (shape) shapes[shape] = (shapes[shape] ?? 0) + 1;
    if (parts.length >= 2 && keyIdx !== 0) prefixes[parts[0]] = (prefixes[parts[0]] ?? 0) + 1;
  }
  // prefer a template that includes the ticket key when the team uses keys at all
  const ranked = Object.entries(shapes).sort((a, b) => b[1] - a[1]);
  const withKey = ranked.find(([s]) => s.includes("{key}"));
  const template = withKey && withKey[1] >= Math.max(1, (ranked[0]?.[1] ?? 0) / 3) ? withKey[0] : ranked[0]?.[0] ?? "{type}/{key}-{slug}";
  const has = (p: string) => (prefixes[p] ?? 0) > 0;
  const types: Record<string, string> = {
    feature: has("feat") ? "feat" : has("feature") ? "feature" : "feat",
    bug: has("fix") ? "fix" : has("bugfix") ? "bugfix" : has("hotfix") ? "hotfix" : "fix",
    chore: has("chore") ? "chore" : has("enhancement") ? "enhancement" : "chore",
    docs: has("docs") ? "docs" : "chore",
    test: has("test") ? "test" : "chore",
  };
  return { template, types };
}

// ------------------------------------------------------------------ commit messages

const CONVENTIONAL = /^(\w+)(\(([^)]+)\))?!?: (.+)$/;

export function inferCommitTemplate(subjects: string[]): { template: string; types: string[] } {
  const real = subjects.filter((s) => s && !/^Merge /.test(s));
  if (!real.length) return { template: "{key}: {summary}", types: [] };
  const conv = real.map((s) => CONVENTIONAL.exec(s)).filter(Boolean) as RegExpExecArray[];
  const keyRe = /\b[A-Z][A-Z0-9]+-\d+\b/;
  if (conv.length / real.length >= 0.5) {
    const types = Object.entries(tally(conv.map((m) => m[1]))).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const keyInScope = conv.filter((m) => m[3] && keyRe.test(m[3])).length;
    const keySuffix = conv.filter((m) => new RegExp(`${keyRe.source}\\s*$`).test(m[4])).length;
    const keyAnywhere = conv.filter((m) => keyRe.test(m[0])).length;
    let template = "{type}({scope}): {summary}";
    if (keyAnywhere / conv.length >= 0.2) template = keyInScope > keySuffix ? "{type}({key}): {summary}" : "{type}({scope}): {summary} {key}";
    return { template, types };
  }
  const prefixKey = real.filter((s) => new RegExp(`^${keyRe.source}[:\\s]`).test(s)).length;
  return { template: prefixKey / real.length >= 0.3 ? "{key}: {summary}" : "{summary} ({key})", types: [] };
}

// ------------------------------------------------------------------ checks

export function detectChecks(repo: string): string[] {
  const checks: string[] = [];
  const precommit = read(repo, ".pre-commit-config.yaml");
  const py = venvPython(repo);
  // Prefer the team's pre-commit setup when it is installed (in the project's venv or globally).
  if (precommit && py && pyModuleAvailable(py, "pre_commit")) return [`${q(py)} -m pre_commit run --files {all}`];
  if (precommit && hasTool("pre-commit")) return ["pre-commit run --files {all}"];
  const pyproject = read(repo, "pyproject.toml");
  if (/\[tool\.ruff/.test(pyproject) || /ruff/.test(precommit)) {
    // Only add checks that can actually run here – a missing tool would make every task fail.
    if (py && pyModuleAvailable(py, "ruff")) checks.push(`${q(py)} -m ruff check {py}`, `${q(py)} -m ruff format --check {py}`);
    else if (hasTool("ruff")) checks.push("ruff check {py}", "ruff format --check {py}");
  }
  if (/\[tool\.mypy/.test(pyproject)) {
    if (py && pyModuleAvailable(py, "mypy")) checks.push(`${q(py)} -m mypy {py}`);
    else if (hasTool("mypy")) checks.push("mypy {py}");
  }
  const pkg = (() => { try { return JSON.parse(read(repo, "package.json") || "{}"); } catch { return {}; } })();
  const scripts = pkg.scripts ?? {};
  if (Object.keys(pkg).length && !fs.existsSync(path.join(repo, "node_modules"))) return checks;   // JS tools not installed
  const pm = exists(repo, "pnpm-lock.yaml") ? "pnpm" : exists(repo, "yarn.lock") ? "yarn" : "npm run";
  if (scripts.lint) checks.push(`${pm} lint`);
  else if (exists(repo, "eslint.config.mjs") || exists(repo, "eslint.config.js") || exists(repo, ".eslintrc.json") || exists(repo, ".eslintrc.js") || exists(repo, ".eslintrc")) checks.push("npx eslint {js}");
  if (scripts.typecheck) checks.push(`${pm} typecheck`);
  else if (scripts["type-check"]) checks.push(`${pm} type-check`);
  if (scripts["format:check"]) checks.push(`${pm} format:check`);
  else if (exists(repo, ".prettierrc") || exists(repo, ".prettierrc.json") || exists(repo, "prettier.config.js")) checks.push("npx prettier --check {all}");
  return checks;
}

/** Expand {py} {js} {all} with the changed files of that kind; drop a check if it has no files to look at. */
export function expandCheck(cmd: string, files: string[]): string | undefined {
  const q = (fs_: string[]) => fs_.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(" ");
  const kinds: Record<string, string[]> = {
    "{py}": files.filter((f) => f.endsWith(".py")),
    "{js}": files.filter((f) => /\.(m?[jt]sx?|cjs|vue|svelte)$/.test(f)),
    "{all}": files,
  };
  let out = cmd;
  for (const [ph, list] of Object.entries(kinds)) {
    if (!out.includes(ph)) continue;
    if (!list.length) return undefined;
    out = out.split(ph).join(q(list));
  }
  return out;
}

// ------------------------------------------------------------------ Jira ticket conventions

export async function detectTicketConventions(keys: string[]): Promise<Conventions["ticket"] | undefined> {
  const jira = clients.jira();
  if (!jira || !keys.length) return undefined;
  try {
    const items = await jira.search(`project in (${keys.join(",")}) ORDER BY created DESC`, 40);
    if (!items.length) return undefined;
    const prefixes = items.map((i) => /^\[([A-Z]+)-\d+\]/.exec(i.title)?.[1]).filter(Boolean) as string[];
    const prefixTop = Object.entries(tally(prefixes)).sort((a, b) => b[1] - a[1])[0];
    const labels = Object.entries(tally(items.flatMap((i) => i.labels))).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l]) => l);
    const types = Object.entries(tally(items.map((i) => i.issueType ?? "").filter(Boolean))).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const titlePrefix = prefixTop && prefixTop[1] >= items.length * 0.3 ? `[${prefixTop[0]}-NNN] ` : undefined;
    const example = items.find((i) => !titlePrefix || i.title.startsWith("["))?.title;
    return { titlePrefix, commonLabels: labels, issueTypes: types, example };
  } catch { return undefined; }
}

// ------------------------------------------------------------------ detect / apply

export async function detectConventions(projectId: string): Promise<Conventions> {
  const p = mustProject(projectId);
  const repo = p.local.path;
  git(repo, ["fetch", "--quiet", "--prune", "origin"], { allowFail: true });
  const base = await detectBaseBranch(repo, p.github?.repo);
  const branches = git(repo, ["branch", "-r", "--sort=-committerdate", "--format=%(refname:short)"], { allowFail: true })
    .split("\n").map((s) => s.trim().replace(/^origin\//, "")).filter((b) => b && b !== "HEAD" && !BASE_CANDIDATES.includes(b) && !b.startsWith("aiw/")).slice(0, 60);
  const br = inferBranchTemplate(branches);
  const subjects = git(repo, ["log", `origin/${base.branch}`, "--no-merges", "-n", "120", "--format=%s"], { allowFail: true }).split("\n").filter(Boolean);
  const cm = inferCommitTemplate(subjects.length ? subjects : git(repo, ["log", "--no-merges", "-n", "120", "--format=%s"], { allowFail: true }).split("\n"));
  const detected: Conventions = {
    baseBranch: base.branch,
    baseBranchSource: base.source,
    branchTemplate: br.template,
    branchTypes: br.types,
    commitTemplate: cm.template,
    commitTypes: cm.types,
    instructionFiles: [...INSTRUCTION_FILES.filter((f) => exists(repo, f)),
      ...(exists(repo, ".cursor/rules") ? fs.readdirSync(path.join(repo, ".cursor/rules")).filter((f) => /\.mdc?$/.test(f)).map((f) => `.cursor/rules/${f}`) : [])],
    prTemplate: PR_TEMPLATES.find((f) => exists(repo, f)),
    checks: detectChecks(repo),
    ticket: await detectTicketConventions(p.jira?.keys ?? []),
    env: (() => { const v = venvStatus(repo); return { python: v.ok ? v.path : undefined, brokenPython: v.ok ? undefined : v.path, linkedDirs: dependencyDirs(repo) }; })(),
    standards: (() => { try { return detectStandards(repo); } catch { return undefined; } })(),
    ci: (() => { try { return detectCiPipeline(repo); } catch { return undefined; } })(),
    detectedAt: new Date().toISOString(),
    confirmed: false,
    overrides: p.conventions?.overrides ?? {},
  };
  const merged = applyOverrides(detected);
  merged.confirmed = !!p.conventions?.confirmed && sameCore(p.conventions, merged);
  p.conventions = merged;
  if (p.github) p.github.baseBranch = merged.baseBranch;           // PRs and rebases use the detected/overridden base
  // Tests run with the project's own interpreter (e.g. .venv) so installed packages are found.
  const py = merged.env?.python;
  if (py && p.local.testCommand && /^python3?\s/.test(p.local.testCommand)) p.local.testCommand = p.local.testCommand.replace(/^python3?/, q(py));
  upsertProject(p);
  audit("service", "conventions.detected", projectId, { base: merged.baseBranch, branch: merged.branchTemplate, commit: merged.commitTemplate, checks: merged.checks.length });
  return merged;
}

function applyOverrides(c: Conventions): Conventions {
  return { ...c, ...Object.fromEntries(Object.entries(c.overrides).filter(([, v]) => v !== undefined && v !== "")) } as Conventions;
}

function sameCore(a: Conventions | undefined, b: Conventions): boolean {
  return !!a && a.baseBranch === b.baseBranch && a.branchTemplate === b.branchTemplate && a.commitTemplate === b.commitTemplate;
}

export function setConventionOverride(projectId: string, o: Conventions["overrides"]): Conventions {
  const p = mustProject(projectId);
  if (!p.conventions) throw new Error(`Run \`aiw conventions detect ${projectId}\` first`);
  p.conventions.overrides = { ...p.conventions.overrides, ...o };
  p.conventions = applyOverrides(p.conventions);
  if (p.github) p.github.baseBranch = p.conventions.baseBranch;
  upsertProject(p);
  audit("user", "conventions.override", projectId, o);
  return p.conventions;
}

export function confirmConventions(projectId: string): void {
  const p = mustProject(projectId);
  if (!p.conventions) throw new Error("No conventions detected yet");
  p.conventions.confirmed = true;
  upsertProject(p);
}

export function conventionsSummary(c: Conventions | undefined): string {
  if (!c) return "not detected yet";
  return [
    `Base branch: ${c.baseBranch} (${c.baseBranchSource})`,
    `Branch names: ${c.branchTemplate}   types: ${Object.entries(c.branchTypes).map(([k, v]) => `${k}→${v}`).join(", ")}`,
    `Commit messages: ${c.commitTemplate}${c.commitTypes.length ? `   types used: ${c.commitTypes.slice(0, 8).join(", ")}` : ""}`,
    `Instruction files: ${c.instructionFiles.join(", ") || "none"}`,
    `PR template: ${c.prTemplate ?? "none"}`,
    `Checks: ${c.checks.join(" · ") || "none detected"}`,
    `Environment: ${c.env?.brokenPython ? `BROKEN – ${c.env.brokenPython} does not start` : c.env?.python ? `python ${c.env.python}` : "system tools"}${c.env?.linkedDirs?.length ? ` · reuses ${c.env.linkedDirs.join(", ")} from the main clone` : ""}`,
    ...(c.standards?.docstrings ?? []).map((d) => `Docstrings – ${docstringLine(d)}`),
    c.standards ? `Tests: ${c.standards.tests.count ? `${c.standards.tests.count} files in ${c.standards.tests.dirs.join(", ")} named ${c.standards.tests.patterns.join(" / ") || "(no fixed pattern)"}` : "no test suite found"}` : "",
    ...(c.ci ? ciSummaryLines(c.ci) : []),
    c.ticket ? `Jira tickets: ${c.ticket.titlePrefix ? `title prefix "${c.ticket.titlePrefix}" · ` : ""}types ${c.ticket.issueTypes.join("/")} · common labels ${c.ticket.commonLabels.join(", ")}` : "Jira tickets: no conventions detected",
    `Confirmed by user: ${c.confirmed ? "yes" : "no"}`,
  ].filter(Boolean).join("\n");
}

// ------------------------------------------------------------------ used by playbook steps

const TYPE_ALIASES: Record<string, string> = { feature: "feature", bug: "bug", chore: "chore", docs: "docs", test: "test", question: "chore" };

export function branchNameFor(c: Conventions | undefined, key: string, ticketType: string | undefined, title: string): string {
  const type = c?.branchTypes?.[TYPE_ALIASES[ticketType ?? "feature"] ?? "feature"] ?? "feat";
  const slug = slugify(title.replace(/^\[[A-Z]+-\d+\]\s*/, ""), 40);
  const tpl = c?.branchTemplate ?? "aiw/{key}-{slug}";
  return tpl.replace("{type}", type).replace("{key}", key).replace("{slug}", slug);
}

/** Scope for conventional commits: the main component touched (app/components/<x>, src/features/<x>, packages/<x>, …). */
export function scopeFor(files: string[]): string {
  const counts: Record<string, number> = {};
  for (const f of files) {
    const m = /(?:components|features|modules|packages|apps|services|domains)\/([\w-]+)/.exec(f) ?? /^(?:src|app|lib)\/([\w-]+)/.exec(f);
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "core";
}

export function commitMessageFor(c: Conventions | undefined, key: string, ticketType: string | undefined, summary: string, files: string[]): string {
  const convType = ticketType === "bug" ? "fix" : ticketType === "docs" ? "docs" : ticketType === "test" ? "test" : ticketType === "chore" ? "chore" : "feat";
  const type = c?.commitTypes?.length && !c.commitTypes.includes(convType) && convType === "feat" && c.commitTypes.includes("feature") ? "feature" : convType;
  // a subject, not a report: the first sentence / clause, never cut off with "…"
  let clean = summary.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s|;\s|\s[–—-]\s/)[0].replace(/[.:,]+$/, "").trim();
  if (clean.length > 72) clean = clean.slice(0, 72).replace(/\s+\S*$/, "").replace(/[\s,;:]+(and|or|to|the|a|an|of|with|for|in)?$/i, "").trim();
  const short = clean;
  const lower = short.charAt(0).toLowerCase() + short.slice(1);
  const tpl = c?.commitTemplate ?? "{key}: {summary}";
  return tpl.replace("{type}", type).replace("{scope}", scopeFor(files)).replace("{key}", key).replace("{summary}", tpl.startsWith("{type}") ? lower : short).replace(/^\s*:\s*/, "").trim();
}

/** Repository rules every agent must follow (instruction files, truncated), plus the conventions in one paragraph. */
export function rulesBlock(p: ProjectConfig, maxChars = 7000): string {
  const c = p.conventions;
  if (!c) return "";
  // the rules card (built at onboarding, ~1.5k tokens, stable → cached) replaces the raw instruction files
  const card = readRulesCard(p.id);
  if (card) return truncate(card, maxChars);
  const files = c.instructionFiles.map((f) => `### ${f}\n${read(p.local.path, f)}`).join("\n\n");
  const conv = `Base branch ${c.baseBranch}; commit messages "${c.commitTemplate}"; lint/format checks: ${c.checks.join(", ") || "none"}.`;
  return truncate(`## Repository rules – follow them exactly (from the team's own files)\n${conv}\n\n${files}`, maxChars);
}

export function prTemplateText(p: ProjectConfig): string | undefined {
  const t = p.conventions?.prTemplate;
  return t ? truncate(read(p.local.path, t), 4000) : undefined;
}

function tally(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

function mustProject(id: string): ProjectConfig {
  const p = getProject(id);
  if (!p) throw new Error(`Unknown project "${id}"`);
  return p;
}
