import fs from "node:fs";
import path from "node:path";
import { getProject, loadProjects, loadSettings, type ProjectConfig } from "../core/config.js";
import { audit } from "../core/db.js";
import { truncate } from "../core/util.js";
import { clients, isConnected } from "../connectors/registry.js";
import { getRunner } from "../agents/runner.js";
import { AGENTS } from "../agents/catalog.js";
import * as G from "../git/git.js";
import { expandCheck } from "../brain/conventions.js";
import { trackedFiles, isTestFile } from "../brain/standards.js";
import { readRulesCard } from "../brain/rulesCard.js";
import { ensureProfile, profileOf } from "./testProfile.js";

/**
 * The ready check (last onboarding step, `aiw ready`): find on day one what would otherwise fail in the middle of a ticket.
 * Read-only for the repository – it never edits files, never commits, and test suites never touch the .env database
 * (only a temporary one, and only to collect tests, not to run them).
 */

export type ReadyState = "ok" | "warn" | "fail";
export interface ReadyItem { area: string; state: ReadyState; detail: string; fix?: string }
export interface ReadyReport { project: string; items: ReadyItem[]; ok: boolean; at: string }

const MISSING_TOOL = /(not recognized as an internal or external command|command not found|No module named|is not installed|Cannot find module|ENOENT|could not determine executable)/i;

/** A few real files of each kind to run the checks on (recently changed first). */
function sampleFiles(repo: string): string[] {
  const recent = G.git(repo, ["log", "-n", "15", "--name-only", "--format="], { allowFail: true }).split("\n").map((s) => s.trim()).filter(Boolean);
  const all = trackedFiles(repo);
  const exists = (f: string) => fs.existsSync(path.join(repo, f));
  const pick = (re: RegExp) => [...new Set([...recent, ...all])].filter((f) => re.test(f) && !isTestFile(f) && exists(f)).slice(0, 2);
  return [...pick(/\.py$/), ...pick(/\.(ts|tsx|js|jsx|mjs)$/)];
}

async function checkTools(p: ProjectConfig): Promise<ReadyItem[]> {
  const checks = p.conventions?.checks ?? [];
  if (!checks.length) return [{ area: "Lint / format", state: "warn", detail: "No lint or format check could be found or run here.", fix: "If the team uses one, install it (e.g. `uv sync` / `npm install`) and run `aiw conventions detect " + p.id + "`." }];
  const files = sampleFiles(p.local.path);
  const out: ReadyItem[] = [];
  for (const raw of checks) {
    // pre-commit may rewrite files (auto-fix hooks): only confirm it is installed, never run it on the user's clone
    if (/pre[-_]commit/.test(raw)) {
      const py = /^"([^"]+)"/.exec(raw)?.[1];
      const r = await G.runCommand(py ? `"${py}" -m pre_commit --version` : "pre-commit --version", p.local.path, 60_000);
      out.push(r.code === 0 ? { area: "Lint / format", state: "ok", detail: `pre-commit is installed (${r.output.trim().split("\n")[0]}); its hooks run on every change.` }
        : { area: "Lint / format", state: "fail", detail: "pre-commit is configured but does not start.", fix: "Install it in the project's environment (e.g. `uv sync` or `pip install pre-commit`)." });
      continue;
    }
    const cmd = expandCheck(raw, files);
    if (!cmd) { out.push({ area: "Lint / format", state: "ok", detail: `\`${raw}\` – no files of its kind to try (skipped).` }); continue; }
    const r = await G.runCommand(cmd, p.local.path, 5 * 60_000);
    if (r.code === 0) out.push({ area: "Lint / format", state: "ok", detail: `\`${raw}\` runs.` });
    else if (MISSING_TOOL.test(r.output)) out.push({ area: "Lint / format", state: "fail", detail: `\`${raw}\` does not start: ${truncate(r.output.trim(), 200)}`, fix: "Install the project's dependencies (e.g. `uv sync` / `npm install`), then `aiw conventions detect " + p.id + "`." });
    else out.push({ area: "Lint / format", state: "ok", detail: `\`${raw}\` runs (it reports existing issues in ${files.length} sample file(s) – only the plugin's own changes have to pass).` });
  }
  return out;
}

async function checkTests(p: ProjectConfig): Promise<ReadyItem[]> {
  const out: ReadyItem[] = [];
  // the test profile (how this repository tests, which database it needs) – detected now instead of in the middle of a ticket
  const agent = async (name: string, prompt: string, opts: any = {}) => {
    const def = AGENTS[name];
    return getRunner().run({ agent: name, tier: def.tier, system: def.system, schema: def.schema, prompt, maxBudgetUsd: 1, ...opts });
  };
  const prof = loadSettings().models.provider === "mock" ? profileOf(p) : await ensureProfile(p, agent);
  if (!prof.testCommand) return [{ area: "Tests", state: "warn", detail: "No test command found for this repository.", fix: `Set one: \`aiw project set ${p.id} --test-cmd "<command>"\`.` }];
  out.push({ area: "Tests", state: "ok", detail: `Test command: \`${prof.testCommand}\` (${prof.language}${prof.database?.engine && prof.database.engine !== "none" ? `, needs ${prof.database.engine}` : ""}).` });
  const env = p.conventions?.env;
  if (env?.brokenPython) {
    const { findPython } = await import("./localStack.js");
    const py = findPython(p.local.path);
    out.push(py ? { area: "Tests", state: "warn", detail: `${env.brokenPython} does not start, but ${py} works and is used.` }
      : { area: "Tests", state: "fail", detail: `The project's Python (${env.brokenPython}) does not start, so tests can't run here.`, fix: "Repair the environment (e.g. `uv sync`), then `aiw ready " + p.id + "`." });
  }
  if (prof.database?.engine && prof.database.engine !== "none") {
    const { testEnvironment } = await import("./localStack.js");
    const t = await testEnvironment(p, p.local.path, "ready");
    if ("error" in t) out.push({ area: "Test database", state: "fail", detail: `No safe temporary database: ${truncate(t.error, 300)}`, fix: "Start Docker Desktop, or give a local database login with `aiw qa database " + p.id + "` (in your own terminal)." });
    else {
      out.push({ area: "Test database", state: "ok", detail: `Tests get ${t.where} – never the .env database.` });
      // collect (not run) the tests with that environment: proves the runner and imports work
      if (/pytest/.test(prof.testCommand)) {
        const { profileTestCommand } = await import("./localStack.js");
        const cmd = profileTestCommand(p);
        const r = cmd ? await G.runCommand(`${cmd} --collect-only -q --no-cov -p no:cacheprovider`, p.local.path, 4 * 60_000, t.env) : { code: 1, output: "no Python found" };
        const n = /(\d+) tests? collected|collected (\d+) items?/.exec(r.output);
        out.push(r.code === 0 || n ? { area: "Tests", state: "ok", detail: `The test runner starts and finds ${n ? (n[1] ?? n[2]) : "the"} tests.` }
          : { area: "Tests", state: "fail", detail: `The test runner does not start: ${truncate(r.output.trim().split("\n").slice(-6).join(" "), 300)}`, fix: "Install the test dependencies (e.g. `uv sync --all-extras`)." });
      }
      t.cleanup();
    }
  }
  if (prof.language !== "python" && fs.existsSync(path.join(p.local.path, "package.json")) && !fs.existsSync(path.join(p.local.path, "node_modules")))
    out.push({ area: "Tests", state: "fail", detail: "node_modules is missing – nothing can be built or tested.", fix: "Run `npm install` (or pnpm/yarn) in the repository." });
  return out;
}

async function checkScreenshots(p: ProjectConfig): Promise<ReadyItem[]> {
  const pkgFile = path.join(p.local.path, "package.json");
  if (!fs.existsSync(pkgFile)) return [];
  const { webApp } = await import("./screenshots.js");
  const app = webApp(p);
  if (!app) {
    let pkg: any = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")); } catch { /* unreadable */ }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (!deps.react && !deps.next && !deps.vue && !deps.svelte && !deps.vite) return [];
    return [{ area: "PR screenshots", state: "fail", detail: "This frontend has no Playwright, so PR screenshots can't be taken.", fix: "Add it once: `npm i -D @playwright/test` and `npx playwright install chromium` (or set `screenshots.startCommand` for the project)." }];
  }
  const items: ReadyItem[] = [{ area: "PR screenshots", state: "ok", detail: `Web app found (build: ${app.build ?? "none"}, start: ${app.start}).` }];
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright") : path.join(process.env.HOME ?? "", process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright"));
  const has = (() => { try { return fs.readdirSync(browsers).some((d) => /^chromium/.test(d)); } catch { return false; } })();
  items.push(has ? { area: "PR screenshots", state: "ok", detail: "Playwright's Chromium is installed." }
    : { area: "PR screenshots", state: "fail", detail: "Playwright's browser is not installed, so screenshots would fail.", fix: `Run \`npx playwright install chromium\` in ${p.local.path}.` });
  return items;
}

async function checkGithub(p: ProjectConfig): Promise<ReadyItem[]> {
  const gh = clients.github();
  if (!p.github?.repo) return [{ area: "GitHub", state: "fail", detail: "No GitHub repository set for this project.", fix: `Re-add the project with: aiw project add --id ${p.id} --repo owner/name ...` }];
  if (!gh) return [{ area: "GitHub", state: "fail", detail: "GitHub is not connected.", fix: "aiw connect github" }];
  const out: ReadyItem[] = [];
  try {
    const perm = gh.permissions ? await gh.permissions(p.github.repo) : { push: true, admin: false };
    out.push(perm.push ? { area: "GitHub", state: "ok", detail: `You can push to ${p.github.repo}.` }
      : { area: "GitHub", state: "fail", detail: `Your GitHub account can read ${p.github.repo} but not push branches.`, fix: "Ask a repository admin for write access." });
  } catch (e: any) { out.push({ area: "GitHub", state: "fail", detail: `Can't reach ${p.github.repo}: ${truncate(e.message, 200)}`, fix: "aiw connect github" }); }
  const base = p.conventions?.baseBranch ?? p.github.baseBranch;
  const has = G.git(p.local.path, ["rev-parse", "--verify", "--quiet", `origin/${base}`], { allowFail: true }).trim();
  out.push(has ? { area: "GitHub", state: "ok", detail: `PRs go to \`${base}\`.` } : { area: "GitHub", state: "fail", detail: `The base branch \`${base}\` was not found on origin.`, fix: `aiw conventions set ${p.id} --base <branch>` });
  if (!p.reviewers) out.push({ area: "Reviewers", state: "warn", detail: "No reviewers set – PRs are raised without a review request.", fix: `aiw team reviewers ${p.id} --codeowners  (or --list login1,login2)` });
  else out.push({ area: "Reviewers", state: "ok", detail: p.reviewers.from === "codeowners" ? "Reviewers come from CODEOWNERS for the changed files." : `Reviewers: ${p.reviewers.logins.join(", ")}.` });
  return out;
}

function checkLearning(p: ProjectConfig): ReadyItem[] {
  const c = p.conventions;
  if (!c) return [{ area: "Repository rules", state: "fail", detail: "The repository has not been studied yet.", fix: `aiw brain onboard ${p.id}` }];
  const out: ReadyItem[] = [];
  out.push(readRulesCard(p.id) ? { area: "Repository rules", state: "ok", detail: `Rules card ready (${c.standards?.docstrings.map((d) => `${d.language} docstrings: ${d.style}`).join(", ") || "no docstring style"}; ${c.standards?.tests.count ?? 0} test files).` }
    : { area: "Repository rules", state: "fail", detail: "No rules card yet.", fix: `aiw brain onboard ${p.id}` });
  const human = (c.ci?.jobs ?? []).filter((j) => j.onPullRequest && j.fixable === "human");
  if (c.ci?.jobs.length) out.push({ area: "CI", state: human.length ? "warn" : "ok", detail: `${c.ci.jobs.filter((j) => j.onPullRequest).length} CI checks on PRs learned.${human.length ? ` These need a person when they fail (the plugin reports, never fakes them): ${human.map((j) => j.name).join(", ")}.` : " The plugin can fix all of them."}` });
  else out.push({ area: "CI", state: "warn", detail: "No GitHub Actions workflows found – nothing to watch after a PR." });
  return out;
}

export async function readyCheck(projectId: string): Promise<ReadyReport> {
  const p = getProject(projectId);
  if (!p) throw new Error(`Unknown project ${projectId}`);
  const items: ReadyItem[] = [];
  if (!fs.existsSync(p.local.path)) items.push({ area: "Repository", state: "fail", detail: `Folder not found: ${p.local.path}`, fix: `Re-add the project with: aiw project add --id ${p.id} --path <clone> ...` });
  else {
    for (const part of [() => checkLearning(p), () => checkGithub(p), () => checkTools(p), () => checkTests(p), () => checkScreenshots(p)]) {
      try { items.push(...(await part())); } catch (e: any) { items.push({ area: "Check", state: "warn", detail: `A check could not run: ${truncate(e.message, 200)}` }); }
    }
  }
  const report = { project: projectId, items, ok: !items.some((i) => i.state === "fail"), at: new Date().toISOString() };
  audit("service", "ready.checked", projectId, { ok: report.ok, fails: items.filter((i) => i.state === "fail").map((i) => i.area) });
  return report;
}

/** Checks that are not about one repository: model, connectors, notifications. */
export function globalReady(): ReadyItem[] {
  const s = loadSettings();
  const out: ReadyItem[] = [];
  out.push(s.models.provider === "mock" ? { area: "Model", state: "warn", detail: "Mock model – no real AI work is done.", fix: "aiw model --provider claude-login" } : { area: "Model", state: "ok", detail: `${s.models.provider} (${s.models.small} / ${s.models.medium} / ${s.models.large}).` });
  for (const c of ["jira", "github"] as const) out.push(isConnected(c) ? { area: "Connectors", state: "ok", detail: `${c} connected.` } : { area: "Connectors", state: "fail", detail: `${c} is not connected.`, fix: `aiw connect ${c}` });
  out.push(s.notifications.primary === "teams-personal" ? { area: "Teams", state: "ok", detail: "Two-way Teams chat is the place you work." } : { area: "Teams", state: "warn", detail: `Messages go to ${s.notifications.primary}; plans and approvals can't be answered from Teams.`, fix: "aiw connect teams-personal --bot" });
  out.push({ area: "Preferences", state: "ok", detail: `PRs: ${s.pr.draft ? "draft" : "ready for review"} · plan approval: ${s.workflow.planApproval === "skip" ? "not asked" : "asked"} · PR approval: ${s.workflow.prApproval === "skip" ? "not asked" : "asked"} · CI failures: ${s.pr.autoFixCi ? "fixed without asking" : "fix shown first"} · up to ${s.limits.maxParallel} tasks at once.` });
  out.push(s.team.members.length ? { area: "Team", state: "ok", detail: `Team: ${s.team.members.map((m) => `${m.name} (@${m.github})`).join(", ")}.` } : { area: "Team", state: "warn", detail: "No teammates set – reviews can't be requested by name.", fix: "aiw team detect <project>" });
  return out;
}

export function readyText(reports: ReadyReport[], global: ReadyItem[]): string {
  const icon = { ok: "✔", warn: "!", fail: "✘" } as const;
  const line = (i: ReadyItem) => `  ${icon[i.state]} ${i.area}: ${i.detail}${i.fix && i.state !== "ok" ? `\n      → ${i.fix}` : ""}`;
  const parts = [`Everything here\n${global.map(line).join("\n")}`];
  for (const r of reports) parts.push(`${r.project}${r.ok ? " – ready" : " – needs attention"}\n${r.items.map(line).join("\n")}`);
  const fails = [...global, ...reports.flatMap((r) => r.items)].filter((i) => i.state === "fail").length;
  parts.push(fails ? `${fails} thing(s) to fix – everything else works. Work still runs; anything that can't run here is reported as "not tested locally".` : "All set.");
  return parts.join("\n\n");
}

export async function readyAll(): Promise<{ reports: ReadyReport[]; global: ReadyItem[] }> {
  const reports: ReadyReport[] = [];
  for (const p of loadProjects()) reports.push(await readyCheck(p.id));
  return { reports, global: globalReady() };
}
