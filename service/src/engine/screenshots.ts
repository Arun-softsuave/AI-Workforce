import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ProjectConfig } from "../core/config.js";
import { paths, ensureDir } from "../core/paths.js";
import { truncate } from "../core/util.js";
import { audit } from "../core/db.js";
import * as G from "../git/git.js";
import { untrusted } from "../agents/runner.js";
import { shareInTeams } from "../notify/files.js";
import { jiraKey, getTask, partsOf, type Task } from "./tasks.js";
import { liveStackFor, LIVE_INSTRUCTIONS } from "./localStack.js";
import { profileOf } from "./testProfile.js";
import type { StepCtx } from "./steps.js";

/**
 * PR screenshots of a frontend change, without a test account or a backend: the app runs from the task's folder and
 * every API call is answered by a fake – the same way the repository's own browser tests work. Desktop + mobile per
 * page. It never stops the work: when capture is impossible, the PR and Teams say why.
 */

export interface Shot { name: string; route: string; state: string; desktop?: string; mobile?: string; note?: string }
export interface Screenshots { taken: boolean; reason?: string; pages: Shot[]; problems: string[]; head?: string; dir?: string; shareUrl?: string; at: string }

const SPEC = ".aiw-shots/capture.spec.ts";
const CONFIG = ".aiw-shots/playwright.config.ts";
const OUT = ".aiw-shots/out";
export const CAPTURE_COMMAND = `npx playwright test -c ${CONFIG}`;

function readJson(file: string): any { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } }

/**
 * A web frontend with Playwright available? Returns how to build and start it, or undefined (no screenshots for this repo).
 * Like the repository's own browser tests: a production build once, then a quick production server for every capture run.
 */
export function webApp(project: ProjectConfig): { build?: string; start: string } | undefined {
  if (project.screenshots?.enabled === false) return undefined;
  const pkg = readJson(path.join(project.local.path, "package.json"));
  if (!pkg) return undefined;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (!deps["@playwright/test"] && !project.screenshots?.startCommand) return undefined;
  if (project.screenshots?.startCommand) return { build: project.screenshots.buildCommand, start: project.screenshots.startCommand };
  // the repository's test profile (detected from its own files) knows how this frontend builds and starts
  const prof = profileOf(project);
  if (prof.start && ["frontend", "fullstack"].includes(prof.role) && prof.source === "detected") return { build: prof.build || undefined, start: prof.start };
  if (deps.next) return { build: "npx next build", start: "npx next start -p {port}" };
  if (deps.vite) return { build: "npx vite build", start: "npx vite preview --port {port} --strictPort" };
  if (pkg.scripts?.dev) return { start: "npm run dev -- --port {port}" };
  return undefined;
}

/**
 * Where the throw-away capture folder goes: on the SAME DRIVE as the repository. The folder links the repository's
 * installed packages (node_modules), and bundlers like Next.js cannot build across two Windows drives.
 */
function captureRoot(repo: string, projectId: string): string {
  const home = paths.worktrees();
  const repoDrive = path.parse(path.resolve(repo)).root.toLowerCase();
  if (process.platform !== "win32" || path.parse(path.resolve(home)).root.toLowerCase() === repoDrive) return ensureDir(path.join(home, projectId));
  return ensureDir(path.join(repoDrive, ".ai-workforce-worktrees", projectId));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** Keep the capture folder out of every commit (local exclude, never the team's .gitignore). */
function excludeLocally(wt: string): void {
  const common = G.git(wt, ["rev-parse", "--git-common-dir"], { allowFail: true });
  if (!common) return;
  const file = path.join(path.isAbsolute(common) ? common : path.join(wt, common), "info", "exclude");
  try {
    const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (!now.split(/\r?\n/).includes(".aiw-shots/")) { ensureDir(path.dirname(file)); fs.appendFileSync(file, `${now && !now.endsWith("\n") ? "\n" : ""}.aiw-shots/\n`); }
  } catch { /* best effort */ }
}

/** The app's local env files (ignored by git, so missing in the task folder) – copied for the capture, removed after. */
function copyEnvFiles(repo: string, wt: string): string[] {
  const copied: string[] = [];
  for (const f of fs.readdirSync(repo)) {
    if (!/^\.env(\.[\w-]+)?$/.test(f) || fs.existsSync(path.join(wt, f))) continue;
    if (!G.git(wt, ["check-ignore", f], { allowFail: true })) continue;          // only files git ignores (never committed)
    try { fs.copyFileSync(path.join(repo, f), path.join(wt, f)); copied.push(path.join(wt, f)); } catch { /* skip */ }
  }
  return copied;
}

const configText = (port: number, start: string, testMatch = "capture.spec.ts", reporter = `"line"`) => `// Temporary – browser run for the PR (removed afterwards, never committed)
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: ${JSON.stringify(testMatch)},
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: ${reporter},
  outputDir: "results",
  use: { baseURL: "http://localhost:${port}" },
  webServer: { command: ${JSON.stringify(start.replace("{port}", String(port)))}, url: "http://localhost:${port}", cwd: "..", reuseExistingServer: false, timeout: 300_000 },
});
`;

/** Text for Teams and the PR approval message. */
export function screenshotsLine(s: Screenshots | undefined): string {
  if (!s) return "";
  if (!s.taken) return `⚠️ Could not be taken – ${s.reason ?? s.problems[0] ?? "unknown reason"}`;
  const ok = s.pages.filter((p) => p.desktop || p.mobile);
  const lines = ok.map((p) => `- ${p.name}${p.state ? ` – ${p.state}` : ""} (\`${p.route}\`)`);
  if (s.shareUrl) lines.push(`👀 View them: ${s.shareUrl}`);
  else if (s.dir) lines.push(`Saved on this computer: ${s.dir}`);
  if (s.problems.length) lines.push(`Not captured: ${s.problems.join("; ")}`);
  return `${ok.length} page(s), desktop + mobile – added to the PR when it is raised\n${lines.join("\n")}`;
}

/** One picture of a page, for the design check (W5 step 10): which page, which screen size, where it is on disk. */
export interface ShotFile { page: string; route: string; state: string; view: "desktop" | "mobile"; file: string }

/** The pictures that exist on disk, desktop first (the design check compares them with the Figma frames). */
export function shotFiles(s: Screenshots | undefined): ShotFile[] {
  if (!s?.taken) return [];
  const out: ShotFile[] = [];
  for (const view of ["desktop", "mobile"] as const) {
    for (const p of s.pages) {
      const f = p[view];
      if (f && fs.existsSync(f)) out.push({ page: p.name, route: p.route, state: p.state, view, file: f });
    }
  }
  return out;
}

/** Take the screenshots for a frontend task (best effort; the result is saved on the task as data.screenshots). */
export async function captureScreenshots(ctx: StepCtx): Promise<Screenshots | undefined> {
  const app = webApp(ctx.project);
  const wt = ctx.task.worktree;
  if (!app || !wt || !fs.existsSync(wt)) return undefined;
  const head = G.headSha(wt);
  const prev: Screenshots | undefined = ctx.task.data.screenshots;
  if (prev?.taken && prev.head === head) return prev;                    // nothing changed since the last capture
  const done = (s: Omit<Screenshots, "at" | "head">): Screenshots => {
    const full = { ...s, head, at: new Date().toISOString() };
    ctx.save({ screenshots: full });
    audit("service", "screenshots", ctx.task.id, { taken: s.taken, pages: s.pages.length, reason: s.reason });
    return full;
  };
  // a real local backend with the demo login when possible (the app often cannot even start on fake answers alone)
  const lead = ctx.task.data.leadId ? getTask(ctx.task.data.leadId) : undefined;
  const backendPart = lead ? partsOf(lead.id).find((p) => p.id !== ctx.task.id && p.worktree && fs.existsSync(p.worktree)) : undefined;
  const live = await liveStackFor(ctx.project, jiraKey(ctx.task) || undefined, `${ctx.task.id}-shots`, backendPart ? G.headSha(backendPart.worktree!) : undefined);
  try {
    const res = await withBuiltApp(ctx.project, `${ctx.task.id}-shots`, head, (a) => shootIn(ctx, a.dir, a.port, done, "env" in live ? live : undefined), "env" in live ? live.env : {});
    if (res.ok) { if ("reason" in live) res.value.problems.push(`not tested in the live local app – ${live.reason} (fake API answers were used)`); return res.value; }
    return done({ taken: false, reason: res.reason, pages: [], problems: "reason" in live ? [`not tested in the live local app – ${live.reason}`] : [] });
  } finally { if ("stop" in live) await live.stop(); }
}

/** env: settings for the build and every run (e.g. BACKEND_ORIGIN of a real local backend, the demo login) – pass it to runCommand. */
export interface BuiltApp { dir: string; port: number; start: string; env: Record<string, string> }

/**
 * Build the app at one commit in a throw-away copy (on the repository's drive, with the repository's installed packages
 * linked in), run `fn` with it, then delete the copy. The task's own folder and the user's working copy are never touched.
 * Used by the PR screenshots and by the QA engineer's browser checks.
 */
export async function withBuiltApp<T>(project: ProjectConfig, id: string, head: string, fn: (a: BuiltApp) => Promise<T>, env: Record<string, string> = {}): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const app = webApp(project);
  if (!app) return { ok: false, reason: "this repository has no web app with Playwright" };
  const repo = project.local.path;
  if (!fs.existsSync(path.join(repo, "node_modules"))) return { ok: false, reason: "the app's packages are not installed in the repository (node_modules is missing)" };
  // its own container: the production build writes a few files next to the copy, and the whole container is deleted after
  const root = captureRoot(repo, project.id);
  const box = path.join(root, id);
  const dir = path.join(box, "app");
  const before = new Set(fs.readdirSync(root));
  let made = false;
  try {
    if (fs.existsSync(dir)) G.removeWorktree(repo, dir);
    fs.rmSync(box, { recursive: true, force: true });
    ensureDir(box);
    G.git(repo, ["worktree", "add", "--detach", dir, head]);
    made = true;
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"), "junction");
    copyEnvFiles(repo, dir);
    ensureDir(path.join(dir, OUT));
    // build once (minutes); every run then only starts the built app (seconds)
    if (app.build) {
      const b = await G.runCommand(app.build, dir, 15 * 60_000, env);
      if (b.code !== 0) return { ok: false, reason: `the app did not build: ${truncate(failingLines(b.output), 300)}` };
    }
    const port = project.screenshots?.port ?? await freePort();
    await G.runCommand("npx playwright install chromium", dir, 10 * 60_000);   // no-op when the browser is already there
    return { ok: true, value: await fn({ dir, port, start: app.start, env }) };
  } catch (e: any) {
    return { ok: false, reason: truncate(e.message, 300) };
  } finally {
    if (made) { try { G.removeWorktree(repo, dir); } catch { /* best effort */ } }
    try { fs.rmSync(box, { recursive: true, force: true }); } catch { /* best effort */ }
    // the production build's file tracing can copy a few package files next to the container – remove what this run added
    for (const f of fs.readdirSync(root)) {
      if (!before.has(f) && !/-(shots|qa)$/.test(f)) { try { fs.rmSync(path.join(root, f), { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }
}

/** Write a temporary Playwright config for a built app (removed with the throw-away copy). */
export function writeAppConfig(a: BuiltApp, testMatch: string, reporter = `"line"`): string {
  fs.writeFileSync(path.join(a.dir, CONFIG), configText(a.port, a.start, testMatch, reporter));
  return `npx playwright test -c ${CONFIG}`;
}

async function shootIn(ctx: StepCtx, shots: string, port: number, done: (s: Omit<Screenshots, "at" | "head">) => Screenshots, live?: { env: Record<string, string>; note: string }): Promise<Screenshots> {
  {
    const app = webApp(ctx.project)!;
    fs.writeFileSync(path.join(shots, CONFIG), configText(port, app.start));
    const d = ctx.task.data;
    const diff = truncate(G.diffAgainst(shots, d.baseSha), 15_000);
    const base = [
      `## The change\n${d.plan?.summary ?? ctx.task.title ?? ""}\n${(d.requirements?.acceptanceCriteria ?? []).map((x: string) => `- ${x}`).join("\n")}`,
      `## Changed files\n${(d.changedFiles ?? G.changedFiles(shots, d.baseSha)).join("\n")}`,
      `## Diff\n${untrusted("diff", diff)}`,
      `## Where things go\n- Write the spec to: ${SPEC} (the only file you may create or edit)\n- Save screenshots to: ${OUT}/<name>-desktop.png and ${OUT}/<name>-mobile.png (name = short kebab-case page name)\n- The app is already built. After you finish, I run \`${CAPTURE_COMMAND}\` (it starts the app on port ${port}; the base URL is set, so use page.goto("/route")) and give you its output if something fails.`,
      live ? `${LIVE_INSTRUCTIONS}
Look at the repository's live browser tests (e.g. e2e/live) first and reuse their login helper – import it with a relative path from .aiw-shots/.` : "Look at the repository's existing browser tests (e.g. e2e/, tests/, playwright folders) first and reuse their helpers for the fake API and the fake sign-in – import them with a relative path from .aiw-shots/.",
      "So that failures can be fixed: in the spec, print every browser error and every API call that got no fake answer – page.on('pageerror', e => console.log('PAGEERROR', e.message)); page.on('console', m => m.type() === 'error' && console.log('CONSOLE', m.text())); and log each request to the API that your stubs did not answer as 'UNSTUBBED <method> <url>'.",
    ].join("\n\n");
    // write → run → fix from the output (at most 3 rounds), then check the pictures – the plugin runs the command itself
    const tools = { cwd: shots, maxTurns: 30, tools: ["Read", "Grep", "Glob", "Write", "Edit"], allow: ["Read", "Grep", "Glob", "Write", "Edit"] };
    let r = await ctx.agent("screenshotter", `${base}\n\nWrite the spec now. Do not run anything.`, tools);
    const listPngs = () => (fs.existsSync(path.join(shots, OUT)) ? fs.readdirSync(path.join(shots, OUT)).filter((f) => f.endsWith(".png")) : []);
    for (let round = 1; round <= 3; round++) {
      for (const f of listPngs()) fs.rmSync(path.join(shots, OUT, f), { force: true });
      const run = await G.runCommand(CAPTURE_COMMAND, shots, 12 * 60_000, live?.env ?? {});
      const got = listPngs();
      const output = truncate(capturedLines(run.output), 6000);
      const check = got.length ? `\n\n## Pictures taken\n${got.map((f) => `- ${OUT}/${f}`).join("\n")}\nOpen EVERY picture with Read and check it shows the changed UI (not a blank page, a spinner, a sign-in page or an error screen like "Something went wrong").` : "";
      const last = round === 3 || (run.code === 0 && got.length > 0);
      r = await ctx.agent("screenshotter", `${base}\n\n## Run ${round} of the capture – exit code ${run.code}\n${untrusted("playwright-output", output)}${check}\n\n${
        last ? "Report every page (ok=false for a bad picture) and any problem. Do not change the spec any more."
          : got.length ? "If every picture is right, report the pages. If any is wrong, fix the spec (the output above shows the browser errors and unstubbed API calls) and report ok=false for those pages – I run it again."
          : "No picture was taken. Fix the spec from the output above (add the missing fake answers, fix selectors and waits). I run it again."}`, tools);
      if (last || (got.length && (r.data.pages ?? []).length && (r.data.pages ?? []).every((p: any) => p.ok !== false))) break;
    }
    // keep the pictures outside the throw-away folder
    const key = jiraKey(ctx.task) || ctx.task.source_ref || ctx.task.id;
    const keep = ensureDir(path.join(paths.projectDir(ctx.project.id), "reports", key, "screenshots"));
    for (const f of fs.readdirSync(keep)) fs.rmSync(path.join(keep, f), { force: true });
    const pngs = fs.existsSync(path.join(shots, OUT)) ? fs.readdirSync(path.join(shots, OUT)).filter((f) => f.endsWith(".png")) : [];
    for (const f of pngs) fs.copyFileSync(path.join(shots, OUT, f), path.join(keep, f));
    const at = (f?: string) => (f && pngs.includes(path.basename(f)) ? path.join(keep, path.basename(f)) : undefined);
    const pages: Shot[] = (r.data.pages ?? []).map((p: any) => ({ name: p.name, route: p.route, state: p.state, desktop: p.ok !== false ? at(p.desktop) : undefined, mobile: p.ok !== false ? at(p.mobile) : undefined, note: p.note || undefined }))
      .filter((p: Shot) => p.desktop || p.mobile);
    // pictures the agent did not report still count
    for (const f of pngs) {
      if (pages.some((p) => p.desktop?.endsWith(f) || p.mobile?.endsWith(f))) continue;
      const m = /^(.+)-(desktop|mobile)\.png$/.exec(f);
      const name = m?.[1] ?? f.replace(/\.png$/, "");
      let page = pages.find((p) => p.name === name);
      if (!page) { page = { name, route: "", state: "" }; pages.push(page); }
      if (m?.[2] === "mobile") page.mobile = path.join(keep, f); else page.desktop = path.join(keep, f);
    }
    const problems: string[] = (r.data.problems ?? []).filter(Boolean);
    const shared = pages.length ? await shareInTeams(`${key} screenshots`, pngs.map((f) => ({ local: path.join(keep, f), name: f }))) : undefined;
    return done({ taken: pages.length > 0, reason: pages.length ? undefined : problems[0] ?? "no page could be captured", pages, problems: pages.length ? problems : problems.slice(1), dir: keep, shareUrl: shared?.url });
  }
}

/** What matters in a capture run's output: errors, unstubbed calls, failures – not the progress lines. */
function capturedLines(out: string): string {
  const keep = out.split(/\r?\n/).filter((l) => /PAGEERROR|CONSOLE|UNSTUBBED|Error|error|failed|Timeout|timed out|expect|✘|›|passed|at .*capture\.spec/.test(l));
  return (keep.length ? keep : out.split(/\r?\n/).slice(-40)).slice(0, 120).join("\n");
}

/** The useful part of a failed build log (the error lines, not the progress output). */
function failingLines(out: string): string {
  const lines = out.split(/\r?\n/).filter((l) => /error|failed|cannot|can't|not found/i.test(l));
  return (lines.length ? lines : out.split(/\r?\n/).slice(-5)).slice(0, 4).join(" | ");
}

// ------------------------------------------------------------------ in the PR

/**
 * Push the screenshots to their own branch (pr-screenshots/<ticket>, never the task branch) and return the PR body
 * with a "Screenshots (mobile + desktop)" section – replacing the template's screenshot section when it has one.
 */
export function withScreenshots(task: Task, project: ProjectConfig, body: string, authHeader: string): string {
  const s: Screenshots | undefined = task.data.screenshots;
  if (!s || !project.github?.repo) return body;
  const repo = project.github.repo;
  let section: string;
  if (!s.taken) {
    section = `Could not be taken automatically: ${s.reason ?? "unknown reason"}. Please add them by hand.`;
  } else {
    const key = jiraKey(task) || task.source_ref || task.id;
    const branch = `pr-screenshots/${key}`;
    const files = s.pages.flatMap((p) => [p.desktop, p.mobile]).filter((f): f is string => !!f && fs.existsSync(f));
    try {
      G.pushFilesToBranch(project.local.path, repo, branch, files.map((f) => ({ path: `${key}/${path.basename(f)}`, local: f })), `Screenshots for ${key}`, authHeader);
    } catch (e: any) {
      section = `Could not be uploaded: ${truncate(e.message, 200)}. They are saved locally in ${s.dir}.`;
      return replaceSection(body, section);
    }
    const url = (f: string) => `https://github.com/${repo}/blob/${branch}/${key}/${encodeURIComponent(path.basename(f))}?raw=true`;
    section = s.pages.map((p) => [
      `**${p.name}**${p.state ? ` – ${p.state}` : ""}${p.route ? ` (\`${p.route}\`)` : ""}`,
      "",
      "| Desktop | Mobile |",
      "|---|---|",
      `| ${p.desktop ? `<img src="${url(p.desktop)}" width="620" alt="${p.name} desktop">` : "–"} | ${p.mobile ? `<img src="${url(p.mobile)}" width="260" alt="${p.name} mobile">` : "–"} |`,
    ].join("\n")).join("\n\n");
    if (s.problems.length) section += `\n\nNot captured: ${s.problems.join("; ")}`;
  }
  return replaceSection(body, section);
}

function replaceSection(body: string, content: string): string {
  const head = /^(#{2,3})\s*Screenshots?\b.*$/im.exec(body);
  if (!head) return `${body.trimEnd()}\n\n## Screenshots (mobile + desktop)\n\n${content}\n`;
  const level = head[1].length;
  const start = head.index + head[0].length;
  const rest = body.slice(start);
  const next = new RegExp(`^#{1,${level}}\\s|^---\\s*$`, "m").exec(rest);
  const end = next ? start + next.index : body.length;
  return `${body.slice(0, start)}\n\n${content}\n\n${body.slice(end).replace(/^\n+/, "")}`;
}
