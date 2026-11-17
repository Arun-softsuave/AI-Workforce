import fs from "node:fs";
import path from "node:path";
import { loadSettings, getProject, type ProjectConfig, type Settings } from "../core/config.js";
import { normaliseQuestions, questionTexts, type Question } from "../core/questions.js";
import { paths, ensureDir } from "../core/paths.js";
import { truncate, slugify } from "../core/util.js";
import { audit } from "../core/db.js";
import { logger } from "../core/log.js";
import { type Runner, type AgentResult, untrusted } from "../agents/runner.js";
import { AGENTS, effortFor, type Effort } from "../agents/catalog.js";
import { compact as compactOutput, type CompactProfile } from "../agents/tools/compact.js";
import { buildContextPack, proposeFacts, recordTaskMemory, refreshProject } from "../brain/brain.js";
import { syncHandbookInto } from "../brain/handbook.js";
import { loadCodeMap } from "../brain/codemap.js";
import * as G from "../git/git.js";
import { scanDiff } from "../git/secretScan.js";
import { clients } from "../connectors/registry.js";
import { failingSection } from "../connectors/github.js";
import { figmaFileSummary, figmaKeyFromText, figmaFramesFor, notionLinksIn, notionPageText } from "../connectors/docs.js";
import { figmaNodeFromText } from "../connectors/figmaDesktop.js";
import { isConnected } from "../connectors/registry.js";
import { getSecret } from "../core/secrets.js";
import { requestApproval, latestApproval, verifyBinding, decide, approveByPolicy, pendingChanges, markChangesApplied } from "../approvals/approvals.js";
import { needsApproval, canCreatePr, protectedHits as policyProtectedHits } from "../policy/gate.js";
import { notify, markInboxRead } from "../notify/router.js";
import { checkBudget } from "./budget.js";
import { mergeData, getTask, jiraKey, partsOf, createTask, transition, updateTask, addStepUsage, type Task } from "./tasks.js";
import { groupMembers, describeMembers, heuristicTargets } from "./routing.js";
import { getPlaybook, stepIndex } from "./playbooks.js";
import { branchNameFor, commitMessageFor, rulesBlock, prTemplateText, expandCheck } from "../brain/conventions.js";
import { stripAttribution, attributionHits, attributionInDiff, NO_ATTRIBUTION_RULE } from "../core/attribution.js";
import { captureScreenshots, screenshotsLine, withScreenshots } from "./screenshots.js";
import { isPythonBackend, findPython, profileTestCommand, testEnvironment, testsNeedDatabase, testsForChange, withResults, testRunPassed } from "./localStack.js";
import { ensureProfile, profileOf } from "./testProfile.js";

/** tokensIn = freshIn + cacheRead + cacheWrite (the split is also written to the running step row call by call). */
export interface Usage { tokensIn: number; tokensOut: number; cost: number; agents: string[]; model?: string; freshIn?: number; cacheRead?: number; cacheWrite?: number; effort?: string }

export interface StepCtx {
  task: Task;
  project: ProjectConfig;
  settings: Settings;
  runner: Runner;
  params: Record<string, any>;
  usage: Usage;
  agent(name: string, prompt: string, opts?: { cwd?: string; dirs?: string[]; tools?: string[]; allow?: string[]; tier?: "small" | "medium" | "large"; maxTurns?: number; system?: string;
    /** Default: the effort table (agents/catalog.ts), by ticket size for the implementer. */
    effort?: Effort;
    /** Compact run_tests / run_lint / git_diff_stat tools in the worktree (needs cwd). */
    compact?: CompactProfile }): Promise<AgentResult>;
  save(patch: Record<string, any>): Task;
}

export type StepResult =
  | { status: "ok"; note?: string }
  | { status: "await_approval"; approvalId: string }
  | { status: "need_info"; questions: Question[]; context?: string }
  | { status: "retriage"; note?: string }
  | { status: "pause"; reason: string }
  | { status: "fail"; reason: string }
  | { status: "done"; note?: string }
  /** Multi-repository work: the lead waits for its parts (WAITING_PARTS), a finished part waits for the lead (PART_READY). */
  | { status: "wait"; state: "WAITING_PARTS" | "PART_READY"; note?: string };

export class BudgetPause extends Error {}

/** Agents that get the read-only lookup tools. Reviewers deliberately don't: they judge only the ticket, plan and diff. */
export const LOOKUP_AGENTS = new Set(["pr-reviewer", "comment-resolver", "qa-planner", "qa-triager", "explorer", "analyst", "planner", "implementer", "interviewer", "lead", "contract", "lead-planner", "coordinator", "integration-reviewer"]);

/** Budget-checked agent call used by every AI step. */
export function makeAgentCaller(ctxRef: () => StepCtx) {
  return async (name: string, prompt: string, opts: Parameters<StepCtx["agent"]>[2] = {}): Promise<AgentResult> => {
    const ctx = ctxRef();
    const b = checkBudget(ctx.project, ctx.task);
    if (!b.ok) throw new BudgetPause(`${b.reason} (${b.used.toLocaleString()} / ${b.limit.toLocaleString()} tokens)`);
    if (b.warn) { ctx.save({ budgetWarned: true }); throw new BudgetPause(`80% of the task budget used (${b.used.toLocaleString()} / ${b.limit.toLocaleString()} tokens)`); }
    const base = name.split(":")[0];
    const def = AGENTS[base];
    if (!def) throw new Error(`Unknown agent ${name}`);
    const tools = opts.tools ?? (opts.cwd ? def.tools : []);
    if (tools?.some((t) => /^(Edit|Write|Bash)/.test(t)) && !opts.cwd) throw new Error(`${name}: refusing to run a writing agent without an isolated workspace`);
    // extra folders (other repositories) are only ever given to read-only agents
    if (opts.dirs?.length && [...(tools ?? []), ...(opts.allow ?? [])].some((t) => /^(Edit|Write|Bash)/.test(t))) throw new Error(`${name}: extra folders are read-only`);
    const effort = opts.effort ?? effortFor(name, ctx.task.size, ctx.settings.cost?.effort);
    const r = await ctx.runner.run({
      agent: name, tier: opts.tier ?? def.tier, system: `${opts.system ?? def.system}\n\n${NO_ATTRIBUTION_RULE}`, prompt, schema: def.schema,
      cwd: opts.cwd, additionalDirectories: opts.dirs, tools, allow: opts.allow, maxTurns: opts.maxTurns, effort,
      compact: opts.cwd ? opts.compact : undefined,
      // the agents that understand and build the change may look up linked tickets, PRs, designs and pages (read-only)
      // code graph: a lead task may look at every repository of the product, a single task at its own
      lookup: LOOKUP_AGENTS.has(base) ? { repo: ctx.project.github?.repo, codeRepos: ctx.task.playbook === "dev-lead" ? groupMembers(ctx.project).map((m) => m.id) : [ctx.project.id] } : undefined,
    });
    ctx.usage.tokensIn += r.tokensIn; ctx.usage.tokensOut += r.tokensOut; ctx.usage.cost += r.costUsd;
    ctx.usage.agents.push(name); ctx.usage.model = r.model;
    // fresh input vs prompt-cache reads / writes (a runner that doesn't split counts everything as fresh)
    const cacheRead = r.cacheRead ?? 0, cacheWrite = r.cacheWrite ?? 0;
    const freshIn = r.freshIn ?? Math.max(0, r.tokensIn - cacheRead - cacheWrite);
    ctx.usage.freshIn = (ctx.usage.freshIn ?? 0) + freshIn;
    ctx.usage.cacheRead = (ctx.usage.cacheRead ?? 0) + cacheRead;
    ctx.usage.cacheWrite = (ctx.usage.cacheWrite ?? 0) + cacheWrite;
    ctx.usage.effort = r.effort ?? effort ?? ctx.usage.effort;
    addStepUsage(ctx.task.id, { freshIn, cacheRead, cacheWrite, effort: r.effort ?? effort });
    // keep the budget view current between calls
    ctx.task = { ...ctx.task, tokens_used: ctx.task.tokens_used + r.tokensIn + r.tokensOut, cost_usd: ctx.task.cost_usd + r.costUsd };
    if (!r.ok) throw new Error(`${name} agent failed: ${r.error ?? "unknown error"}`);
    return r;
  };
}

// ---------------------------------------------------------------- helpers

export function ticketText(t: Task): string {
  const k = t.data.ticket ?? {};
  const comments = (k.comments ?? []).map((c: any) => `- ${c.author}: ${truncate(c.body, 400)}`).join("\n");
  const answers = [...(t.data.leadClarifications ?? []), ...(t.data.clarifications ?? [])].map((c: any) => `- Q: ${c.questions?.join(" / ") || "(general)"}\n  A (${c.by}): ${c.answer}`).join("\n");
  return `${k.key ?? t.source_ref ?? ""}: ${k.title ?? t.title ?? ""}\n\n${k.description ?? ""}${comments ? `\n\nRecent comments:\n${comments}` : ""}${answers ? `\n\nClarifications from the assignee (use these – they override assumptions):\n${answers}` : ""}`.trim();
}

/**
 * Clarification rounds are capped so a task never asks forever (settings.workflow.questionRounds, all steps together);
 * after the cap it proceeds with the recommended options and states its assumptions.
 */
export const clarifyRoundsLeft = (t: Task, s: Settings = loadSettings()) => s.workflow.questionRounds - (t.data.clarifications ?? []).length;

export const ticketBlock = (t: Task) => untrusted(`ticket:${t.source_ref ?? t.id}`, truncate(ticketText(t), 8000));
const json = (o: unknown) => JSON.stringify(o, null, 1);
/**
 * The test command of a project. A Python backend whose configured command uses a broken environment gets one with its
 * WORKING Python instead (e.g. .venv-local). Its tests always run through runTests (a temporary database).
 */
export const testCommandOf = (ctx: StepCtx) => {
  const cmd = ctx.project.local.testCommand ?? loadCodeMap(ctx.project.id)?.stack.testCommand;
  if (ctx.project.qa?.testCommand) return ctx.project.qa.testCommand;
  // no command, or one that uses a broken environment: the repository's test profile (with a working runtime filled in)
  const broken = ctx.project.conventions?.env?.brokenPython;
  return !cmd || (broken && cmd.includes(broken)) ? profileTestCommand(ctx.project) ?? cmd : cmd;
};

/** Test suites that use a database drop and recreate tables, so they must never reach the .env (dev / shared) database. */
const isSafeTestsOnly = (ctx: StepCtx) => testsNeedDatabase(ctx.project);

/**
 * Run the project's tests. For a Python backend every database variable points at a TEMPORARY database (local
 * PostgreSQL first, Docker second) that is dropped afterwards – never the .env one. envError: no safe database.
 */
export async function runTests(ctx: StepCtx, cmd: string, wt: string): Promise<{ code: number; output: string; envError?: string; scope?: string }> {
  // the tests for the change (changed test files + tests named after the changed modules); the whole suite only when none
  // match – a backend's full suite can take most of an hour, and CI runs it anyway
  const files = ctx.task.data.baseSha ? testsForChange(wt, G.changedFiles(wt, ctx.task.data.baseSha)) : [];
  const prof = profileOf(ctx.project);
  const scoped = !files.length ? cmd
    : profileTestCommand(ctx.project) === cmd ? profileTestCommand(ctx.project, files)!
    : `${cmd} ${/^(npm|yarn|pnpm)\s/.test(cmd) || prof.testFiles === "after-dashdash" ? "-- " : ""}${files.join(" ")}`;
  const scope = files.length ? `targeted: ${files.length} test file${files.length > 1 ? "s" : ""} for the change` : "the whole suite";
  // every test passed and only a whole-suite rule (coverage minimum) failed: that says nothing about the change
  const res = withResults(scoped);                                // exact pass / fail counts where the runner can give them
  const finish = (r: { code: number; output: string }) => ({ ...r, code: testRunPassed(r, res.read()) ? 0 : r.code || 1, scope });
  if (!isSafeTestsOnly(ctx)) return finish(await G.runCommand(res.cmd, wt));
  const te = await testEnvironment(ctx.project, wt, ctx.task.id);
  if ("error" in te) return { code: 1, output: te.error, envError: te.error, scope };
  try { return finish(await G.runCommand(res.cmd, wt, 30 * 60_000, te.env)); } finally { te.cleanup(); }
}

/**
 * Test output that means "the tests could not run on this computer" (missing interpreter, package, database, Docker),
 * not "the code is wrong". Returns a short reason, or undefined.
 */
const ENV_FAILURES: [RegExp, string][] = [
  [/trampoline failed|No Python at|is not recognized as an internal or external command|command not found|cannot find the path specified/i, "the interpreter or test tool is missing"],
  [/No module named '?(pytest|jest|vitest|mocha)/i, "the test tool is not installed"],
  [/ConnectionRefusedError|could not connect to server|Connect call failed|ECONNREFUSED|password authentication failed/i, "the test database or service is not reachable"],
  [/docker[\s\S]{0,80}(not running|daemon|cannot connect)/i, "Docker is not running"],
];
export function environmentFailure(output: string): string | undefined {
  for (const [re, why] of ENV_FAILURES) if (re.test(output ?? "")) return why;
  return undefined;
}

/** Record (once) that this task's tests cannot run here; every later message and the PR say so. */
export function markUntested(ctx: StepCtx, reason: string, fix?: string): void {
  if (ctx.task.data.testsUnavailable) return;
  ctx.save({ testsUnavailable: { reason, fix, at: new Date().toISOString() } });
  audit("service", "task.untested", ctx.task.id, { reason });
}

/** The tests line for Teams messages. */
function testsLine(d: Record<string, any>): string {
  if (d.testsUnavailable) return `⚠️ NOT run on this computer – ${d.testsUnavailable.reason}. The change and its tests were checked by reading only; the PR's CI must pass before merging.${d.testsUnavailable.fix ? `\nTo test locally: ${d.testsUnavailable.fix}` : ""}`;
  return d.tests?.ran ? (d.tests.passed ? `✅ passed${d.tests.attempts ? ` (attempt ${d.tests.attempts})` : ""}${d.tests.scope ? ` – ${d.tests.scope}` : ""}${d.tests.flaky ? ", one flaky run" : ""}` : "❌ failing") : "no test command in this repo";
}
/**
 * E13: an agent is stuck after its round limit. The item pauses (not fails – "resume" retries from here) with
 * data.stuck for the dashboard ("Stuck") and ONE short message: what failed, what it tried, the options.
 */
export function stuckResult(ctx: StepCtx, s: { step: string; failed: string; tried: string }): StepResult {
  const ref = ctx.task.source_ref ?? ctx.task.id;
  ctx.save({ stuck: { ...s, at: new Date().toISOString() } });
  return { status: "pause", reason: `Stuck: ${s.failed}\nTried: ${s.tried}.\nReply "resume ${ref}" to retry, "take over ${ref}" to finish it yourself, or "cancel ${ref}".` };
}

const feedbackBlock = (t: Task) => {
  const out: string[] = [];
  if (t.data.feedback?.length) out.push(`\n## Human feedback from earlier review (must be addressed)\n${t.data.feedback.map((f: string) => `- ${f}`).join("\n")}`);
  // D4: "yes, but skip the email part" – the owner approved with a change; it must be applied without another round
  const changes = [...new Set([
    ...(t.data.planChanges ?? []).map((c: any) => String(c?.text ?? c)),
    ...(t.data.approvedChanges ?? []).filter((c: any) => c?.action === "implement_plan").map((c: any) => String(c.change)),
  ].filter(Boolean))];
  if (changes.length) out.push(`\n## Changes the owner asked for when approving the plan (must be applied)\n${changes.map((c) => `- ${c}`).join("\n")}`);
  // W13: the design changed while building (Figma); the plan was not redone for a minor change
  const dc = (t.data.designChanges ?? []) as any[];
  if (dc.length) out.push(`\n## Design changes since the plan (follow the newer design)\n${dc.slice(-5).map((c) => `- ${truncate(String(c?.summary ?? c?.text ?? JSON.stringify(c)), 300)}`).join("\n")}`);
  return out.join("");
};

/**
 * Environment doctor before a build (W2 12a). With settings.workflow.untestedWork "pause", a repository whose tests
 * can't run here stops the task as "Blocked: environment" with a short report – never a failed build. With "continue"
 * (default) nothing is checked up front; the report is used later as the fix hint when the tests can't run.
 */
async function environmentGate(ctx: StepCtx): Promise<StepResult | undefined> {
  if (ctx.settings.workflow.untestedWork !== "pause") return undefined;
  const report = await environmentReport(ctx);
  if (!report) {
    if (ctx.task.data.blocked?.reason === "environment") ctx.save({ blocked: null });
    return undefined;
  }
  ctx.save({ blocked: { reason: "environment", report, at: new Date().toISOString() } });
  return { status: "pause", reason: `Blocked: environment. ${report}` };
}

/** The doctor's short report when this repository's tests can't run here, else undefined (cached 1 h; never throws). */
async function environmentReport(ctx: StepCtx, force = false): Promise<string | undefined> {
  const repo = ctx.project.local.path;
  if (!repo || !fs.existsSync(repo)) return undefined;
  try {
    const { checkEnvironment, envReport } = await import("./envDoctor.js");
    const env = await checkEnvironment(repo, { project: ctx.project, force });
    return env.ok ? undefined : envReport(env);
  } catch (e: any) {
    logger.warn("environment check failed", { project: ctx.project.id, error: e.message });
    return undefined;
  }
}

/** The change itself for the reporter (it has no tools, so it can't read files): cut to keep the call small. */
function reportDiff(ctx: StepCtx): string {
  const wt = ctx.task.worktree, base = ctx.task.data.baseSha;
  if (!wt || !base || !fs.existsSync(wt)) return "";
  try { const diff = G.diffAgainst(wt, base); return diff.trim() ? `## The change (diff, may be cut)\n${untrusted("diff", truncate(diff, 12_000))}` : ""; } catch { return ""; }
}

function implementerAllow(testCmd?: string): string[] {
  const allow = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git status:*)", "Bash(git diff:*)", "Bash(ls:*)", "Bash(dir:*)"];
  if (testCmd) allow.push(`Bash(${testCmd}:*)`, `Bash(${testCmd})`);
  return allow;
}

/** Commit with the team's message convention (e.g. "feat(buyer): validate input length KAN-42"). */
function commitWithConvention(ctx: StepCtx, wt: string, summary: string, typeOverride?: string): void {
  const files = G.changedFiles(wt, ctx.task.data.baseSha ?? "HEAD~1");
  const status = G.git(wt, ["status", "--porcelain"], { allowFail: true }).split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
  // fixes on a PR (review comments, CI, QA issues) are "fix" commits under the PR's ticket
  const type = typeOverride ?? (ctx.task.kind === "pr_fix" ? "bug" : ctx.task.data.triage?.type);
  const key = (ctx.task.kind === "pr_fix" ? ctx.task.data.ticket?.key : undefined) || jiraKey(ctx.task) || ctx.task.id;
  const msg = commitMessageFor(ctx.project.conventions, /^PR-\d+$/.test(key) ? "" : key, type, summary, [...new Set([...status, ...files])]);
  G.commitAll(wt, msg, ctx.settings.profile.name || "Developer");
}

/** Run the project's detected lint / format / type checks on the changed files. */
async function runChecks(ctx: StepCtx, wt: string): Promise<{ ok: boolean; output: string; ran: string[] }> {
  const files = G.changedFiles(wt, ctx.task.data.baseSha).filter((f) => fs.existsSync(path.join(wt, f)));
  const ran: string[] = [];
  const marks = attributionInDiff(G.diffAgainst(wt, ctx.task.data.baseSha));
  if (marks.length) {
    return { ok: false, output: `Remove every mention of Claude / AI / AI Workforce from the code and comments (hard rule):\n${marks.slice(0, 10).map((m) => `${m.file}: ${m.line}`).join("\n")}`, ran: ["no-ai-attribution"] };
  }
  for (const raw of ctx.project.conventions?.checks ?? []) {
    const cmd = expandCheck(raw, files);
    if (!cmd) continue;
    ran.push(raw);
    const r = await G.runCommand(cmd, wt, 10 * 60_000);
    // only the errors with file:line (compact), not the whole log
    if (r.code !== 0) return { ok: false, output: `$ ${raw}\n${compactOutput(r.output, r.code).text}`, ran };
  }
  return { ok: true, output: "", ran };
}

/** For artefacts posted to Jira: match the team's ticket style (title prefix, labels, issue types). */
function ticketStyle(ctx: StepCtx): string {
  const t = ctx.project.conventions?.ticket;
  if (!t) return "";
  return `\nFollow this Jira project's conventions: ${t.titlePrefix ? `titles start with "${t.titlePrefix}" (e.g. "${t.example ?? ""}"); ` : ""}issue types used: ${t.issueTypes.join(", ")}; common labels: ${t.commonLabels.join(", ")}.`;
}

/** Ask the project's reviewers (a fixed list or CODEOWNERS of the changed files) to review a new PR. Best effort. */
async function requestPrReviewers(project: ProjectConfig, repo: string, num: number, files: string[]): Promise<string[]> {
  const gh = clients.github();
  if (!gh?.requestReviewers) return [];
  const { reviewersFor } = await import("../core/team.js");
  let me: string | undefined;
  try { me = (await gh.user()).login; } catch { /* use the saved login */ }
  const who = reviewersFor(project, files, me);
  if (!who.users.length && !who.teams.length) return [];
  try {
    const r = await gh.requestReviewers(repo, num, who);
    audit("service", "publish.reviewers", undefined, { repo, num, requested: r.requested });
    return r.requested;
  } catch (e: any) {
    logger.warn("requesting reviewers failed", { repo, num, error: e.message });
    return [];
  }
}

/** A PR was raised: watch its CI from the first commit, so a failing check is fixed (your preference) without waiting to be asked. */
function afterPrRaised(project: ProjectConfig, repo: string, num: number, sha: string): boolean {
  if (loadSettings().pr?.autoFixCi === false) return false;
  void import("./prFix.js").then(({ watchCi }) => watchCi({ projectId: project.id, repo, num, sha, by: "you", via: "teams-personal", round: 1 })).catch(() => {});
  return true;
}

/** Steps that touch code require the task's isolated worktree; never fall back to another directory. */
function needWorkspace(ctx: StepCtx): StepResult | undefined {
  const wt = ctx.task.worktree;
  if (!wt || !fs.existsSync(wt) || !ctx.task.data.baseSha) return { status: "fail", reason: "Task workspace is missing – run `aiw resume` to re-create it" };
  return undefined;
}

function reportsDir(projectId: string) { return ensureDir(path.join(paths.projectDir(projectId), "reports")); }

const bullets = (items: unknown, max = 15) => (Array.isArray(items) ? items : []).slice(0, max).map((x) => `• ${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n");
const numbered = (items: unknown) => (Array.isArray(items) ? items : []).map((x, i) => `${i + 1}. ${x}`).join("\n");
/** A section of a chat message: a bold heading on its own line, then its content (a blank line separates sections). */
const section = (title: string, body: string) => (body.trim() ? `**${title}**\n${body}` : "");

/** The whole plan, readable in a chat: nothing is cut off (long messages are split into parts by the Teams sender). */
export function planMessage(t: Task): string {
  const p = t.data.plan ?? {};
  if (Array.isArray(p.parts)) return leadPlanMessage(t);
  const sections: string[] = [];
  if (p.summary) sections.push(String(p.summary));
  if (t.data.requirements?.acceptanceCriteria?.length) sections.push(section("✅ Done when", bullets(t.data.requirements.acceptanceCriteria)));
  if (p.steps?.length) sections.push(section("🛠️ Steps", numbered(p.steps)));
  if (p.files?.length) sections.push(section("📄 Files", bullets(p.files, 25)));
  if (p.tests?.length) sections.push(section("🧪 Tests", bullets(p.tests)));
  if (p.risks?.length) sections.push(section("⚠️ Risks", bullets(p.risks)));
  if (t.data.assumptions?.length) sections.push(section("💭 Assumptions (questions left open)", bullets(t.data.assumptions)));
  const issues = t.data.planReview && !t.data.planReview.pass ? t.data.planReview.issues ?? [] : [];
  if (issues.length) sections.push(section("🔎 Plan reviewer still flags", bullets(issues.map((x: any) => `[${x.severity}] ${x.description}`))));
  if (t.data.testsUnavailable) sections.push(`⚠️ The tests can't run on this computer (${t.data.testsUnavailable.reason}). I'll still build it and add tests, check it by reading, and mark it "not tested locally" in the result and the PR.`);
  if ((t.data.targets ?? []).length > 1) sections.push(`This is the ${t.project_id} part of a ${t.data.targets.join(" + ")} change.`);
  return `${sections.filter(Boolean).join("\n\n") || "(the planner returned an empty plan)"}\n\n💰 ${costText(t)}`;
}

/** One plan for a change across several repositories: which repositories and why, build order, contract, each part. */
function leadPlanMessage(t: Task): string {
  const p = t.data.plan ?? {};
  const u = t.data.understanding ?? {};
  const targets: string[] = t.data.targets ?? [];
  const sections: string[] = [];
  if (p.summary) sections.push(String(p.summary));
  const order = targets.length > 1 ? (t.data.order === "parallel" ? `${targets.join(" + ")}, built at the same time` : `${targets.join(" → ")}, one after the other`) : targets[0] ?? "";
  sections.push(section("📦 Repositories", `${order}${u.targetsReason ? `\nWhy: ${u.targetsReason}` : ""}${targets.length > 1 && u.orderReason ? `\nOrder: ${u.orderReason}` : ""}`));
  if (t.data.requirements?.acceptanceCriteria?.length) sections.push(section("✅ Done when", bullets(t.data.requirements.acceptanceCriteria)));
  if (u.existing?.length) sections.push(section("📚 Already exists", bullets(u.existing, 10)));
  const delegated = (t.data.clarifications ?? []).some((c: any) => c.delegated);
  if (u.decisions?.length) sections.push(section(`🧭 Decided by the agent${delegated ? " (you left these to me)" : ""}`, bullets(u.decisions)));
  if (t.data.contract) sections.push(section("🔗 Contract between the repositories", contractText(t.data.contract, "•")));
  for (const part of p.parts ?? []) {
    sections.push(`📦 **${part.repo}**${part.summary ? `\n${part.summary}` : ""}`);
    if (part.steps?.length) sections.push(section("🛠️ Steps", numbered(part.steps)));
    if (part.files?.length) sections.push(section("📄 Files", bullets(part.files, 20)));
    if (part.tests?.length) sections.push(section("🧪 Tests", bullets(part.tests)));
  }
  if (p.risks?.length) sections.push(section("⚠️ Risks", bullets(p.risks)));
  if (t.data.assumptions?.length) sections.push(section("💭 Assumptions (questions left open)", bullets(t.data.assumptions)));
  const issues = t.data.planReview && !t.data.planReview.pass ? t.data.planReview.issues ?? [] : [];
  if (issues.length) sections.push(section("🔎 Plan reviewer still flags", bullets(issues.map((x: any) => `[${x.severity}] ${x.description}`))));
  const untestable = targets.filter((id) => { const p = getProject(id); const b = p?.conventions?.env?.brokenPython; return !!b && (!p!.local.testCommand || p!.local.testCommand.includes(b)) && !(isPythonBackend(p!.local.path) && findPython(p!.local.path)); });
  if (untestable.length) sections.push(`⚠️ The tests of ${untestable.join(", ")} can't run on this computer (its Python environment is broken). That part is still built and checked by reading, and marked "not tested locally".`);
  if (targets.length > 1) sections.push("After building, I check that the repositories fit together and run each one's tests, then ask you once to raise all the PRs.");
  sections.push(`💰 ${costText(t)}`);
  return sections.filter(Boolean).join("\n\n");
}

/** Agreed requirements of a request without a ticket – shown in Teams for confirmation and put in the PR body. */
export function requirementsMarkdown(r: Record<string, any>, bullet = "-"): string {
  const list = (items: unknown) => (Array.isArray(items) ? items : []).map((x) => `${bullet} ${x}`).join("\n");
  const part = (label: string, items: unknown) => (Array.isArray(items) && items.length ? `${label}:\n${list(items)}` : "");
  return [
    r.title ? `${bullet === "-" ? "**" : ""}${r.title}${bullet === "-" ? "**" : ""}` : "",
    r.goal ? `Goal: ${r.goal}` : "",
    part("What it does", r.behaviour),
    part("Done when", r.acceptanceCriteria),
    part("Edge cases", r.edgeCases),
    part("Repositories", r.repositories),
    part("Out of scope", r.outOfScope),
    part("Assumptions", r.assumptions),
  ].filter(Boolean).join("\n\n");
}

/** What the change does, for the "Raise PR?" message. */
export function resultMessage(t: Task): string {
  const d = t.data;
  const sections: string[] = [];
  sections.push(d.implementation?.summary ?? d.report?.title ?? t.title ?? "");
  if (d.changedFiles?.length) sections.push(section(`📄 Changed files (${d.changedFiles.length}${d.diffStat ? `, +${d.diffStat.added}/-${d.diffStat.removed}` : ""})`, bullets(d.changedFiles, 20)));
  if (d.implementation?.testsAdded?.length) sections.push(section("🧪 Tests added", bullets(d.implementation.testsAdded)));
  const tests = testsLine(d);
  const checks = (d.checks ?? []).length ? `✅ ${d.checks.join(", ")}` : "none detected";
  const reviews = Object.entries(d.reviews ?? {}).map(([k, v]: any) => `${k} ${v.pass ? "✅" : "⚠️"}`).join(" · ") || "n/a";
  sections.push(section("🔎 Checks", `- **Tests:** ${tests}\n- **Lint/format/type checks:** ${checks}\n- **Reviews:** ${reviews}`));
  if (d.screenshots) sections.push(section("🖼️ Screenshots", screenshotsLine(d.screenshots)));
  if (d.unresolvedIssues?.length) sections.push(section("⚠️ Open review findings", bullets(d.unresolvedIssues.map((x: any) => `[${x.reviewer}/${x.severity}] ${x.file}: ${x.description}`))));
  if (d.prepublishWarnings?.length) sections.push(section("⚠️ Warnings", bullets(d.prepublishWarnings)));
  if (d.plan?.risks?.length) sections.push(section("⚠️ Risks", bullets(d.plan.risks)));
  const pr = [d.report?.title ? `- **PR title:** ${d.report.title}` : "", t.branch ? `- **Branch:** ${t.branch}` : ""].filter(Boolean).join("\n");
  if (pr) sections.push(pr);
  if (t.kind !== "part") sections.push(`💰 ${costText(t)}`);
  return sections.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------- multi-repository helpers (lead + parts)

/** Notion pages and the Figma design linked in the ticket (read-only, best effort). */
export async function linkedDocsText(t: Task, project: ProjectConfig): Promise<string> {
  let text = "";
  const notionLinks = [...notionLinksIn(ticketText(t)), ...(project.notion?.pageIds ?? [])].slice(0, 3);
  if (notionLinks.length && isConnected("notion")) {
    const pages: string[] = [];
    for (const link of notionLinks) {
      try { pages.push(untrusted(`notion:${link}`, truncate(await notionPageText(link), 6000))); } catch (e: any) { pages.push(`(could not read ${link}: ${truncate(e.message, 160)})`); }
    }
    text += `\n\n## Linked Notion pages\n${pages.join("\n\n")}`;
  }
  const figmaKey = figmaKeyFromText(ticketText(t));
  if (figmaKey && isConnected("figma")) {
    try {
      text += `\n\n## Linked Figma design\n${untrusted(`figma:${figmaKey}`, truncate(await figmaFileSummary(figmaKey, figmaNodeFromText(ticketText(t))), 8000))}`;
    } catch (e: any) {
      text += `\n\n## Linked Figma design\n(could not read it now: ${truncate(e.message, 160)} – use the figma_get_design tool, or ask the user)`;
    }
  } else if (isConnected("figma") && (project.figma?.fileKeys ?? []).length) {
    // no link in the ticket: the project's default design file – the frame named after this ticket, when there is one
    const key = jiraKey(t);
    for (const fileKey of project.figma!.fileKeys!) {
      try {
        const frames = key ? await figmaFramesFor(fileKey, key) : [];
        if (frames.length) {
          text += `\n\n## Figma design for ${key} (found in the project's design file by its frame name)\n${untrusted(`figma:${fileKey}`, truncate(await figmaFileSummary(fileKey, frames[0].id), 8000))}`;
          if (frames.length > 1) text += `\nOther frames named with ${key}: ${frames.slice(1, 13).map((f) => `"${f.name}" (node ${f.id}, page ${f.page})`).join("; ")} – read them with figma_get_design("https://www.figma.com/design/${fileKey}/?node-id=<node>").`;
          break;
        }
        text += `\n\n## Project design file\nThe team's Figma file is ${fileKey}; no frame is named after ${key || "this ticket"}. If the ticket changes UI, look for the right frame with figma_get_design("${fileKey}") and say which frame you used.`;
      } catch (e: any) {
        text += `\n\n## Project design file\n(could not read ${fileKey} now: ${truncate(e.message, 160)})`;
      }
    }
  }
  return text;
}

/**
 * Find the relevant code ONCE per task (like Claude Code's explore sub-agent): a medium-model explorer uses the code
 * graph first and reads only the lines it needs, then returns compact findings with file:line. Every later step works
 * from these findings instead of exploring again. Re-runs (after an answer or a re-plan) reuse them.
 */
async function exploreOnce(ctx: StepCtx, members: ProjectConfig[], docs: string): Promise<any> {
  if (ctx.task.data.findings) return ctx.task.data.findings;
  const { ensureGraph, hasGraph } = await import("../brain/graph.js");
  for (const m of members) { try { await ensureGraph(m.id); } catch { /* falls back to Grep/Read */ } }
  const f = repoFolders(members);
  const graphNote = members.some((m) => hasGraph(m.id))
    ? "Use the code graph tools (code_query, code_explain, code_affected) first, then Read only the exact lines you need."
    : "No code graph is available: search with Grep/Glob and Read only the specific lines you need.";
  const r = await ctx.agent("explorer", [
    ticketBlock(ctx.task),
    `## Repositories\n${f.list}${members.length > 1 ? "\nThe first is the current directory; the others are additional folders you can read." : ""}`,
    docs.trim(),
    graphNote,
    "Do not modify anything.",
  ].filter(Boolean).join("\n\n"), { cwd: f.cwd, dirs: f.dirs, tools: ["Read", "Grep", "Glob"], maxTurns: 30 });
  ctx.save({ findings: r.data, findingsAt: new Date().toISOString(), linkedDocs: docs || undefined });
  return r.data;
}

/** The findings as compact text for prompts (optionally only one repository's part). */
export function findingsText(f: any, repo?: string): string {
  if (!f) return "(no findings)";
  const repos = (f.repos ?? []).filter((r: any) => !repo || r.repo === repo);
  const block = (r: any) => [
    `### ${r.repo}`,
    ...(r.relevant ?? []).map((x: any) => `- ${x.file}:${x.line} ${x.symbol} – ${x.why}${x.excerpt ? `\n    ${String(x.excerpt).replace(/\n/g, "\n    ")}` : ""}`),
    (r.existing ?? []).length ? `Exists:\n${(r.existing as string[]).map((x) => `- ${x}`).join("\n")}` : "",
    (r.missing ?? []).length ? `Missing for this ticket:\n${(r.missing as string[]).map((x) => `- ${x}`).join("\n")}` : "",
    (r.tests ?? []).length ? `Tests in this area:\n${(r.tests as string[]).map((x) => `- ${x}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  return truncate([
    f.summary ?? "",
    ...repos.map(block),
    !repo && (f.facts ?? []).length ? `Across repositories:\n${(f.facts as string[]).map((x) => `- ${x}`).join("\n")}` : "",
    !repo && (f.openPoints ?? []).length ? `Open points (the code does not answer):\n${(f.openPoints as string[]).map((x) => `- ${x}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n"), 24_000);
}

/** Tokens and money a ticket has used so far (a lead counts its parts). Shown in Teams; it never stops the work. */
export function costOf(t: Task): { tokens: number; usd: number } {
  const parts = t.playbook === "dev-lead" ? partsOf(t.id) : [];
  return { tokens: t.tokens_used + parts.reduce((n, p) => n + p.tokens_used, 0), usd: t.cost_usd + parts.reduce((n, p) => n + p.cost_usd, 0) };
}
export function costText(t: Task): string {
  const c = costOf(getTask(t.id) ?? t);
  const tok = c.tokens >= 1e6 ? `${(c.tokens / 1e6).toFixed(1)}M` : `${Math.round(c.tokens / 1000)}k`;
  return `Cost so far: $${c.usd.toFixed(2)} (${tok} tokens)`;
}

/** The contract between the repositories, as text for prompts and the plan message. */
export function contractText(c: any, bullet = "-"): string {
  if (!c) return "";
  const items = (c.items ?? []).map((i: any) => `${bullet} [${i.kind}] ${i.name} – ${i.producer || "?"} → ${i.consumer || "?"}: ${i.details}`);
  const errors = (c.errors ?? []).map((e: string) => `${bullet} ${e}`);
  const changes = (c.changes ?? []).map((x: any) => `${bullet} (agreed later, asked by ${x.from}) ${x.change}`);
  return [c.summary ?? "", items.join("\n"), errors.length ? `Errors / empty cases:\n${errors.join("\n")}` : "", (c.notes ?? []).length ? `Notes:\n${c.notes.map((n: string) => `${bullet} ${n}`).join("\n")}` : "", changes.length ? `Changes agreed while building:\n${changes.join("\n")}` : ""]
    .filter(Boolean).join("\n");
}

/** Context a part gets from its lead: decisions, the contract, the other parts' plans and what they already built. */
function partContext(part: Task, lead: Task): string {
  const out: string[] = [];
  const u = lead.data.understanding ?? {};
  if (u.existing?.length) out.push(`## What already exists (found by the lead)\n${bullets(u.existing, 20)}`);
  if (u.decisions?.length) out.push(`## Decisions already made\n${bullets(u.decisions)}`);
  if (lead.data.findings) out.push(`## Code Explorer findings for this repository (start here – no need to search again)\n${findingsText(lead.data.findings, part.project_id)}`);
  if (lead.data.contract) out.push(`## Contract between the repositories – build exactly this\n${contractText(lead.data.contract)}`);
  for (const o of partsOf(lead.id).filter((p) => p.id !== part.id)) {
    const p = o.data.plan ?? {};
    let block = `## The ${o.project_id} part (another repository – do NOT change it)\n${truncate(JSON.stringify({ summary: p.summary, steps: p.steps, files: p.files }, null, 1), 2500)}`;
    if (["PART_READY", "DONE"].includes(o.state) && o.worktree && o.data.baseSha && fs.existsSync(o.worktree)) {
      try { block += `\nAlready built – its change:\n${untrusted(`diff:${o.project_id}`, truncate(G.diffAgainst(o.worktree, o.data.baseSha), 8000))}`; } catch { /* worktree gone */ }
    }
    out.push(block);
  }
  return out.length ? `\n\n${out.join("\n\n")}` : "";
}

/** The repositories of a lead task: the first is the working directory, the others are extra read-only folders. */
function repoFolders(members: ProjectConfig[]): { cwd: string; dirs: string[]; list: string } {
  return {
    cwd: members[0].local.path,
    dirs: members.slice(1).map((m) => m.local.path),
    list: `Repository ids: ${members.map((m) => m.id).join(", ")}\n${members.map((m) => `- ${m.id}: ${m.local.path}${m.github ? ` (${m.github.repo})` : ""}`).join("\n")}`,
  };
}

const leadMembers = (ctx: StepCtx) => {
  const all = groupMembers(ctx.project);
  const targets: string[] = ctx.task.data.targets ?? [];
  return targets.length ? [...targets.map((id) => all.find((m) => m.id === id)).filter((m): m is ProjectConfig => !!m), ...all.filter((m) => !targets.includes(m.id))] : all;
};

/** The "raise the PRs?" message of a lead task: the integration check, then each repository's result. */
export function leadResultMessage(lead: Task): string {
  const parts = partsOf(lead.id);
  const i = lead.data.integration;
  const sections: string[] = [lead.data.plan?.summary ?? lead.title ?? ""];
  if (i) {
    const issues = (i.issues ?? []).filter((x: any) => x.severity !== "minor");
    sections.push(i.single ? "🔗 Integration check: one repository – not needed" : section(`🔗 Integration check (do the repositories fit together?) ${i.pass ? "✅" : "⚠️"}`, `${i.summary ?? ""}${issues.length ? `\nStill open:\n${bullets(issues.map((x: any) => `[${x.repo}/${x.severity}] ${x.description}`))}` : ""}`));
    const missing = (i.criteria ?? []).filter((c: any) => !c.covered);
    if (missing.length) sections.push(section("⚠️ Acceptance criteria not covered", bullets(missing.map((c: any) => c.criterion))));
  }
  for (const p of parts) sections.push(`📦 **${p.project_id}**`, resultMessage(p));
  sections.push(`💰 ${costText(lead)}`);
  return sections.filter(Boolean).join("\n\n");
}

/** ONE PR approval for every repository: bound to each part's exact commit and diff. */
async function requestLeadApproval(ctx: StepCtx): Promise<StepResult> {
  const parts = partsOf(ctx.task.id).filter((p) => p.state === "PART_READY");
  if (!parts.length) return { status: "fail", reason: "No finished parts to publish" };
  const bindings = parts.map((p) => ({ id: p.id, project: p.project_id, repo: getProject(p.project_id)?.github?.repo, branch: p.branch, baseSha: p.data.baseSha, headSha: G.headSha(p.worktree!), diffHash: G.diffHash(p.worktree!, p.data.baseSha) }));
  const ap = requestApproval(ctx.task.id, "create_pr", {});
  ctx.save({ partBindings: { approvalId: ap.id, parts: bindings } });
  {
    // F2 + rails: directives and settings decide whether the PRs wait for you; rails (secrets, protected branches) refuse
    const files = parts.flatMap((p) => (p.worktree && p.data.baseSha ? G.changedFiles(p.worktree, p.data.baseSha) : []));
    const g = canCreatePr(ctx.task.id, { files, base: ctx.project.github?.baseBranch }, { settings: ctx.settings, project: ctx.project });
    if (g.verdict === "deny") return { status: "fail", reason: g.reason };
    if (g.verdict === "allow") {
      approveByPolicy(ap.id, g.rule ?? "pr_approval");
      return { status: "ok", note: g.by === "directive" ? "PR approval skipped by your rule" : g.by === "settings" ? "PR approval skipped by your settings" : g.reason };
    }
  }
  const ref = ctx.task.source_ref ?? ctx.task.id;
  await notify({
    kind: "approval_needed", taskId: ctx.task.id, taskRef: ref, approvalId: ap.id, approvalAction: "create_pr", dedupeKey: ap.id,
    facts: [["Commits", bindings.map((b) => `${b.project} ${b.headSha.slice(0, 7)}`).join(" · ")]],
    title: `✅ ${ref} Built and tested${parts.length > 1 ? ` in ${parts.length} repositories` : ""} – raise the PR${parts.length > 1 ? "s" : ""}?`,
    body: leadResultMessage(getTask(ctx.task.id) ?? ctx.task),
    url: ctx.task.data.ticket?.url,
  });
  return { status: "await_approval", approvalId: ap.id };
}

/** A part asked something: record the answer on the part and let it continue. */
function answerPart(part: Task, questions: string[], answer: string, by: string): void {
  const clarifications = [...(part.data.clarifications ?? []), { questions, answer, reply: answer, by, at: new Date().toISOString() }];
  mergeData(part.id, { clarifications, questions: null });
  transition(part.id, "QUEUED", `answered by ${by}`);
}

/** Send a part back to implementing with extra instructions (integration fixes, contract changes, PR feedback). */
function reworkPart(part: Task, instruction: string, from = "implement_test"): void {
  const at = Math.max(0, stepIndex(getPlaybook(part.playbook ?? "dev-part"), from));
  mergeData(part.id, { feedback: [...(part.data.feedback ?? []), instruction] });
  updateTask(part.id, { step_index: at, run_no: part.run_no + 1 });
  if (part.state !== "QUEUED") transition(part.id, "QUEUED", "rework requested by the lead");
}

/**
 * The lead looks after its parts: answers their questions (or asks the user), forwards the user's answer,
 * stops on a failed / paused part, and continues once every part is ready.
 */
async function superviseParts(ctx: StepCtx): Promise<StepResult> {
  const lead = getTask(ctx.task.id)!;
  // the user answered a question a part had asked → pass it on
  const pq = lead.data.partQuestion;
  if (pq) {
    const last = (lead.data.clarifications ?? []).at(-1);
    if (last && last.at > pq.at) {
      const part = getTask(pq.partId);
      if (part?.state === "ASKING_LEAD") answerPart(part, pq.questions, last.answer, last.by);
      ctx.save({ partQuestion: null });
    }
  }
  const parts = partsOf(lead.id);
  for (const part of parts.filter((p) => p.state === "ASKING_LEAD")) {
    const r = await coordinate(ctx, part);
    if (r) return r;
  }
  const now = partsOf(lead.id);
  const failed = now.find((p) => p.state === "FAILED");
  if (failed) return { status: "fail", reason: `The ${failed.project_id} part failed: ${failed.error ?? "unknown error"}` };
  const paused = now.find((p) => p.state === "PAUSED");
  if (paused) return { status: "pause", reason: `The ${paused.project_id} part is paused: ${paused.error ?? "needs attention"}` };
  if (now.length && now.every((p) => p.state === "PART_READY" || p.state === "DONE")) return { status: "ok", note: `${now.map((p) => p.project_id).join(" + ")} ready` };
  return { status: "wait", state: "WAITING_PARTS", note: now.map((p) => `${p.project_id}: ${p.state.toLowerCase()}`).join(", ") };
}

/** A part asked the lead: the coordinator answers from the code / contract, or (product decision) the user is asked. */
async function coordinate(ctx: StepCtx, part: Task): Promise<StepResult | undefined> {
  const asked = normaliseQuestions(part.data.questions, 4);
  const lead = getTask(ctx.task.id)!;
  const f = repoFolders(leadMembers(ctx));
  const prompt = [
    ticketBlock(lead),
    `## Repositories\n${f.list}`,
    lead.data.contract ? `## Contract\n${contractText(lead.data.contract)}` : "",
    `## The whole plan\n${json(lead.data.plan ?? {})}`,
    `## Question from the ${part.project_id} part (${part.data.askedWhile ?? "while building"})\n${asked.map((q) => `- ${q.question}${q.options.length ? ` (options: ${q.options.join(" / ")})` : ""}`).join("\n")}`,
    "Read the code where it helps. Do not modify anything.",
  ].filter(Boolean).join("\n\n");
  const r = await ctx.agent("coordinator", prompt, { cwd: f.cwd, dirs: f.dirs, tools: ["Read", "Grep", "Glob"], maxTurns: 20 });
  const userQs = normaliseQuestions(r.data.userQuestions, 2);
  if (r.data.decision === "ask_user" && clarifyRoundsLeft(lead, ctx.settings) > 0) {
    const questions = userQs.length ? userQs : asked;
    ctx.save({ partQuestion: { partId: part.id, questions: questionTexts(asked), at: new Date().toISOString() } });
    return { status: "need_info", questions, context: `While building the ${part.project_id} part` };
  }
  const answer = r.data.decision === "ask_user"
    ? `${r.data.answer || ""} No more questions can be asked – use the recommended (first) option and mention it in your summary.`.trim()
    : r.data.answer;
  answerPart(part, questionTexts(asked), answer, "the lead engineer");
  if (r.data.contractChange?.trim()) {
    const c = lead.data.contract ?? { summary: "", items: [], errors: [], notes: [] };
    const contract = { ...c, version: (c.version ?? 1) + 1, changes: [...(c.changes ?? []), { from: part.project_id, change: r.data.contractChange.trim(), at: new Date().toISOString() }] };
    ctx.save({ contract });
    // parts that already finished must follow the change
    for (const o of partsOf(lead.id).filter((p) => p.id !== part.id && p.state === "PART_READY")) {
      reworkPart(o, `The contract changed (asked by the ${part.project_id} part): ${r.data.contractChange.trim()} – update this repository to match.`);
    }
  }
  audit("service", "lead.coordinated", lead.id, { part: part.project_id, decision: r.data.decision, contractChange: !!r.data.contractChange?.trim() });
  return undefined;
}

// ---------------------------------------------------------------- steps

type StepFn = (ctx: StepCtx) => Promise<StepResult>;

export const STEPS: Record<string, StepFn> = {
  async prepare_workspace(ctx) {
    const repo = ctx.project.local.path;
    if (!G.isGitRepo(repo)) return { status: "fail", reason: `Local folder ${repo} is missing or not a git repository` };
    // A broken project environment: by default the work continues WITHOUT local tests and says so everywhere
    // (settings.workflow.untestedWork = "continue"); with "pause" the task waits with exact repair steps.
    const env = ctx.project.conventions?.env;
    // (a custom test command that uses another interpreter, e.g. a working venv, is not affected)
    const testCmdNow = ctx.project.local.testCommand;
    if (env?.brokenPython && (!testCmdNow || testCmdNow.includes(env.brokenPython)) && !(isPythonBackend(repo) && findPython(repo))) {
      const { envRepairHint } = await import("../brain/conventions.js");
      const fix = `${envRepairHint(repo)} – then run \`aiw conventions detect ${ctx.project.id}\``;
      if (ctx.settings.workflow.untestedWork === "pause") {
        return { status: "pause", reason: `The project's Python environment can't start (${env.brokenPython}). Fix it once: ${fix} and \`aiw resume ${ctx.task.source_ref}\`.` };
      }
      markUntested(ctx, "the project's Python environment can't start on this computer", fix);
    }
    // how to run and test this repository on this computer (detected once from the repository, refreshed every 14 days)
    await ensureProfile(ctx.project, ctx.agent);
    const free = G.freeDiskBytes(paths.worktrees());
    if (free !== undefined && free < 1024 ** 3) return { status: "pause", reason: "Less than 1 GB of free disk space for task workspaces" };
    const baseBranch = ctx.project.github?.baseBranch ?? "main";
    const base = G.resolveBase(repo, baseBranch);
    if (ctx.task.worktree && fs.existsSync(ctx.task.worktree) && ctx.task.data.baseSha) return { status: "ok", note: "workspace reused" };
    const key = jiraKey(ctx.task) || ctx.task.id;                    // branch names use the plain ticket key (no "@repo" suffix)
    // Branch name follows the team's detected convention (e.g. feat/KAN-42/input-guard).
    const branch = G.uniqueBranch(repo, branchNameFor(ctx.project.conventions, key, ctx.task.data.triage?.type, ctx.task.title ?? "change"));
    const wt = G.createWorktree(repo, ctx.project.id, ctx.task.id, branch, base.ref, ctx.project.conventions?.env?.linkedDirs ?? []);
    ctx.task = { ...ctx.task, worktree: wt, branch };
    ctx.save({ baseSha: base.sha, baseRef: base.ref, worktreePath: wt, branchName: branch });
    const install = ctx.project.local.installCommand;
    if (install) {
      const r = await G.runCommand(install, wt, 20 * 60_000);
      if (r.code !== 0) return { status: "fail", reason: `Dependency install failed:\n${truncate(r.output, 1500)}` };
    }
    return { status: "ok", note: `${branch} from ${base.ref}@${base.sha.slice(0, 7)}` };
  },

  async context_pack(ctx) {
    const pack = buildContextPack(ctx.project.id, ticketText(ctx.task));
    const rules = rulesBlock(ctx.project);
    let text = rules ? `${rules}\n\n${pack.text}` : pack.text;
    const sib = ctx.task.data.siblingOf ? getTask(ctx.task.data.siblingOf) : undefined;
    if (sib?.data.plan) {
      text += `\n\n## Paired change in ${sib.project_id} (${sib.source_ref}) – keep both sides consistent\n${truncate(JSON.stringify({ summary: sib.data.plan.summary, steps: sib.data.plan.steps, files: sib.data.plan.files }, null, 1), 2500)}`;
    }
    // A part of a lead task: the contract, the lead's decisions, and what the other repositories plan / already built.
    const lead = ctx.task.data.leadId ? getTask(ctx.task.data.leadId) : undefined;
    if (lead) text += partContext(ctx.task, lead);
    const targets: string[] = ctx.task.data.targets ?? [];
    if (targets.length > 1) text += `\n\nScope: change this repository (${ctx.project.id}) only. Other repositories in this change: ${targets.filter((x) => x !== ctx.project.id).join(", ")}.`;
    text += await linkedDocsText(ctx.task, ctx.project);
    ctx.save({ contextPack: text, contextFiles: pack.files });
    return { status: "ok", note: `${pack.text.length} chars, ${pack.files.length} files, ${pack.hits} memory hits` };
  },

  async analyse(ctx) {
    // The explorer finds the relevant code once (code graph first); the analyst works from its findings, so it answers
    // from the code instead of asking the user – and later steps reuse the same findings.
    const findings = await exploreOnce(ctx, [ctx.project], "");
    const r = await ctx.agent("analyst", `${ticketBlock(ctx.task)}\n\n## Code Explorer findings (from the code itself)\n${findingsText(findings)}\n\n## Project context\n${ctx.task.data.contextPack ?? ""}${feedbackBlock(ctx.task)}\n\nWork from the findings; read code only to confirm a specific point. Do not modify anything.`,
      { cwd: ctx.task.worktree ?? ctx.project.local.path, tools: ["Read", "Grep", "Glob"], maxTurns: 10 });
    ctx.save({ requirements: r.data });
    const open = normaliseQuestions(r.data.openQuestions, 3);
    if (open.length && clarifyRoundsLeft(ctx.task, ctx.settings) > 0) return { status: "need_info", questions: open, context: "While analysing the requirements" };
    if (open.length) ctx.save({ assumptions: questionTexts(open) });   // cap reached: proceed, but say so in the plan
    return { status: "ok" };
  },

  async plan(ctx) {
    const prior = ctx.task.data.planIssues?.length ? `\n## Issues found in the previous plan (fix them)\n${json(ctx.task.data.planIssues)}` : "";
    const assumptions = ctx.task.data.assumptions?.length ? `\n\n## Unanswered questions – choose a sensible assumption for each and list it under risks\n${ctx.task.data.assumptions.map((q: string) => `- ${q}`).join("\n")}` : "";
    const r = await ctx.agent("planner",
      `${ticketBlock(ctx.task)}\n\n## Requirements\n${json(ctx.task.data.requirements ?? {})}${ctx.task.data.findings ? `\n\n## Code Explorer findings (files, symbols and lines to build on)\n${findingsText(ctx.task.data.findings)}` : ""}\n\n## Project context\n${ctx.task.data.contextPack ?? ""}${feedbackBlock(ctx.task)}${prior}${assumptions}\n\nPlan from the findings; read files only to confirm a location they leave open. Do not modify anything.`,
      { cwd: ctx.task.worktree ?? ctx.project.local.path, tools: ["Read", "Grep", "Glob"], maxTurns: 20, tier: ctx.params.tier });
    ctx.save({ plan: r.data, planAt: new Date().toISOString() });
    return { status: "ok" };
  },

  async plan_review(ctx) {
    const lead = Array.isArray(ctx.task.data.plan?.parts);
    const review = async () => (await ctx.agent("plan-reviewer",
      `${ticketBlock(ctx.task)}\n\n## Requirements\n${json(ctx.task.data.requirements ?? {})}${ctx.task.data.contract ? `\n\n## Contract between the repositories (check every part follows it)\n${contractText(ctx.task.data.contract)}` : ""}\n\n## Plan\n${json(ctx.task.data.plan)}`)).data;
    let r = await review();
    if (!r.pass) {
      ctx.save({ planIssues: r.issues });
      await (lead ? STEPS.lead_plan : STEPS.plan)(ctx);   // one re-plan round, then proceed with issues recorded
      r = await review();
    }
    ctx.save({ planReview: r });
    return { status: "ok", note: r.pass ? "plan approved by reviewer" : `${r.issues.length} plan issues remain` };
  },

  async plan_gate(ctx) {
    // D4: the plan was approved with a change – re-plan with it once and go on to build without asking again
    if (ctx.task.data.replanPending) {
      const changes = pendingChanges(ctx.task.id, "implement_plan");
      if (changes.length) {
        const r = await (ctx.task.playbook === "dev-lead" && STEPS.lead_plan ? STEPS.lead_plan : STEPS.plan)(ctx);
        if (r.status !== "ok") return r;
        markChangesApplied(ctx.task.id, changes.map((c) => c.approvalId));
        const t = getTask(ctx.task.id) ?? ctx.task;
        await notify({ kind: "info", taskId: t.id, taskRef: t.source_ref ?? undefined, dedupeKey: `plan-changed:${changes.map((c) => c.approvalId).join(",")}`,
          title: `📋 ${t.source_ref ?? t.id} – plan updated with your change (building now)`, body: planMessage(t), url: t.data.ticket?.url });
        return { status: "ok", note: "re-planned with the change you approved" };
      }
      ctx.save({ replanPending: false });
    }
    // D5: a directive ("no need to ask for approval") or your settings decide whether the plan waits for you
    const need = needsApproval("plan", ctx.task, { settings: ctx.settings, project: ctx.project });
    const large = ctx.task.size === "L" && !!ctx.task.data.gateLargePlans;
    if (!need.ask && !large) {
      // "autonomy" mode on a project that doesn't gate plans: nothing to tell
      if (need.by === "settings" && ctx.settings.workflow.planApproval === "autonomy") return { status: "ok", note: "not required" };
      // no plan approval – the short plan is still sent so you know what is being built
      await notify({ kind: "info", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, dedupeKey: `plan-info:${ctx.task.data.planAt ?? ""}`,
        title: `📋 ${ctx.task.source_ref} – plan (starting now)`, body: planMessage(ctx.task), url: ctx.task.data.ticket?.url });
      return { status: "ok", note: need.by === "directive" ? "plan approval skipped by your rule" : "plan approval skipped by your preference" };
    }
    const a = latestApproval(ctx.task.id, "implement_plan");
    if (a?.action === "implement_plan" && a.state === "approved" && a.requested_at >= (ctx.task.data.planAt ?? "")) return { status: "ok", note: "plan approved" };
    const ap = requestApproval(ctx.task.id, "implement_plan", {});
    await notify({ kind: "approval_needed", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, approvalId: ap.id, approvalAction: "implement_plan", dedupeKey: ap.id,
      title: `📋 Plan ready – ${ctx.task.source_ref}`, body: planMessage(ctx.task), url: ctx.task.data.ticket?.url });
    return { status: "await_approval", approvalId: ap.id };
  },

  async implement_test(ctx) {
    { const missing = needWorkspace(ctx); if (missing) return missing; }
    const wt = ctx.task.worktree!;
    // Tests that cannot run on this computer don't stop the work: build anyway and say so clearly (settings.workflow.untestedWork).
    const testCmd = ctx.task.data.testsUnavailable ? undefined : testCommandOf(ctx);
    const loops = ctx.settings.limits.implementLoops;
    if (testCmd) { const blocked = await environmentGate(ctx); if (blocked) return blocked; }
    // compact test / lint / diff tools: the agent sees failures with file:line, never a full log (§9.1.2). A suite that
    // needs a temporary database is run by the plugin, so run_tests is not offered for it.
    const safeOnly = isSafeTestsOnly(ctx);
    const compactProfile: CompactProfile = {
      testCommand: safeOnly ? undefined : testCmd, testFiles: profileOf(ctx.project).testFiles,
      lintCommands: ctx.project.conventions?.checks ?? [], base: ctx.task.data.baseSha,
    };
    let lastFailure = "";
    for (let i = 1; i <= loops; i++) {
      const unavailable = ctx.task.data.testsUnavailable;
      const prompt = [
        ticketBlock(ctx.task),
        `## Plan\n${json(ctx.task.data.plan ?? { summary: "Make the minimal change the ticket asks for." })}`,
        ctx.task.data.findings ? `## Code Explorer findings (exact files and lines – open these directly, no need to search again)\n${findingsText(ctx.task.data.findings, ctx.project.id)}` : "",
        `## Project context\n${ctx.task.data.contextPack ?? ""}`,
        feedbackBlock(ctx.task),
        (ctx.task.data.ciFailures ?? []).length ? `## Failing CI checks on GitHub – your change must make each of them pass (find the root cause; do not weaken or delete tests or checks)\n${ctx.task.data.ciFailures.map((x: string) => untrusted("ci-log", x)).join("\n\n")}` : "",
        unavailable
          ? `## Tests\nThe tests CANNOT run on this computer (${unavailable.reason}). Still add or update focused tests in the project's test structure, and check your change and the tests very carefully by reading the code. Do not try to run them.`
          : testCmd && isSafeTestsOnly(ctx) ? "## Tests\nAdd or update focused tests in the project's test structure. Do NOT run the test suite yourself: it needs a temporary database that I set up – I run the tests after your change and give you the output if they fail."
          : testCmd ? `## Test command\nRun the tests with the run_tests tool (pass the test files for your change). The command it runs: ${testCmd}` : "## Tests\nNo test command detected – add focused tests where the project has a test structure.",
        lastFailure ? `## Previous attempt failed – fix this\n${untrusted("test-output", truncate(lastFailure, 6000))}` : "",
      ].filter(Boolean).join("\n\n");
      ctx.save({ implementAttempt: i, implementLoops: loops });
      // a Python backend's tests need a temporary database the agent cannot set up – the plugin runs them instead
      const r = await ctx.agent("implementer", prompt, { cwd: wt, allow: implementerAllow(safeOnly ? undefined : testCmd), maxTurns: 60, compact: compactProfile });
      const asked = normaliseQuestions(r.data.questions, 3);
      if (asked.length) {
        // Keep the work done so far (committed in the task branch), then ask instead of guessing.
        if (G.git(wt, ["status", "--porcelain"], { allowFail: true }).trim()) commitWithConvention(ctx, wt, String(r.data.commitSubject || r.data.summary || "work in progress").split("\n")[0]);
        if (clarifyRoundsLeft(ctx.task, ctx.settings) > 0) return { status: "need_info", questions: asked, context: `While implementing (attempt ${i} of ${loops})` };
        ctx.save({ assumptions: [...(ctx.task.data.assumptions ?? []), ...questionTexts(asked)] });
        lastFailure = `You asked:\n${questionTexts(asked).map((q) => `- ${q}`).join("\n")}\nNo more questions can be asked for this task – use your recommended (first) option for each, finish the change and mention the assumption in your summary.`;
        continue;
      }
      commitWithConvention(ctx, wt, String(r.data.commitSubject || r.data.summary || "implement change").split("\n")[0]);
      if (!G.changedFiles(wt, ctx.task.data.baseSha).length) { lastFailure = "No files were changed."; continue; }
      // The team's lint / format / type checks are part of "done", just like the tests.
      const checks = await runChecks(ctx, wt);
      if (!checks.ok) { lastFailure = `Project checks failed (fix them; follow the repository's lint/format rules):\n${checks.output}`; continue; }
      if (!testCmd) {
        const u = ctx.task.data.testsUnavailable;
        ctx.save({ implementation: r.data, tests: { ran: false, ...(u ? { unavailable: u.reason } : {}) }, checks: checks.ran });
        return { status: "ok", note: u ? `not tested on this computer: ${u.reason}` : "no test command" };
      }
      const t = await runTests(ctx, testCmd, wt);
      if (t.code === 0) { ctx.save({ implementation: r.data, tests: { ran: true, passed: true, attempts: i, scope: t.scope }, checks: checks.ran }); return { status: "ok", note: `tests passed (attempt ${i}, ${t.scope})` }; }
      // The test command itself could not run here (missing Python, database or Docker…): that says nothing about the code.
      const env = t.envError ? `no safe test database – ${t.envError}` : environmentFailure(t.output);
      if (env && ctx.settings.workflow.untestedWork !== "pause") {
        markUntested(ctx, `the test command could not run here (${env})`, await environmentReport(ctx, true));
        ctx.save({ implementation: r.data, tests: { ran: false, unavailable: ctx.task.data.testsUnavailable.reason }, checks: checks.ran });
        return { status: "ok", note: `not tested on this computer: ${env}` };
      }
      // flaky check: re-run once before spending another AI round
      const again = await runTests(ctx, testCmd, wt);
      if (again.code === 0) { ctx.save({ implementation: r.data, tests: { ran: true, passed: true, attempts: i, flaky: true }, checks: checks.ran }); return { status: "ok", note: "tests passed on re-run (flaky)" }; }
      // only the failures with file:line (about 1.5 KB) when the output is recognised; else the failing section
      const c = compactOutput(t.output, t.code);
      lastFailure = c.failures.length ? c.text : truncate(failingSection(t.output), 4000);
    }
    ctx.save({ tests: { ran: true, passed: false, lastFailure: truncate(lastFailure, 3000) } });
    // E13: the agent is stuck after its round limit – one message with what failed, what it tried and the options
    const failed = truncate((lastFailure.split("\n").find((l) => l.trim()) ?? "tests or project checks").trim(), 200);
    return stuckResult(ctx, { step: "implement", failed, tried: `${loops} attempts to make the tests and checks pass` });
  },

  async reviews(ctx) {
    { const missing = needWorkspace(ctx); if (missing) return missing; }
    const wt = ctx.task.worktree!;
    const kinds: string[] = ctx.params.reviewers ?? ["code", "security", "qa"];
    const focus: Record<string, string> = {
      code: "Focus: correctness, readability, adherence to project standards, unnecessary complexity.",
      security: "Focus: input validation, authz, injection, secrets, unsafe data handling, money/PII handling.",
      qa: "Focus: are all acceptance criteria implemented and tested? Missing edge cases?",
      combined: "Check correctness, security and whether the ticket is fully implemented and tested.",
    };
    let pending = kinds;
    const rounds = ctx.settings.limits.reviewRounds;
    const results: Record<string, any> = {};
    const leadTask = ctx.task.data.leadId ? getTask(ctx.task.data.leadId) : undefined;
    const untested = ctx.task.data.testsUnavailable
      ? `\n\n## The tests could NOT be run on this computer (${ctx.task.data.testsUnavailable.reason})\nNobody has executed this change. Check extra carefully, by reading, that the code and the new tests are correct (imports, names, types, edge cases); report anything that would fail at run time as a major issue.`
      : "";
    const contract = `${leadTask?.data.contract ? `\n\n## Contract with the other repositories (this repository's side must match it)\n${contractText(leadTask.data.contract)}` : ""}${untested}`;
    for (let round = 0; round <= rounds; round++) {
      const diff = truncate(G.diffAgainst(wt, ctx.task.data.baseSha), 30_000);
      const out = await Promise.all(pending.map((k) => ctx.agent(`reviewer:${k}`,
        `${focus[k] ?? ""}\n\n${rulesBlock(ctx.project, 3000)}\n\n${ticketBlock(ctx.task)}\n\n## Acceptance criteria\n${json(ctx.task.data.requirements?.acceptanceCriteria ?? [])}\n\n## Plan\n${json(ctx.task.data.plan ?? {})}${contract}\n\n## Diff\n${untrusted("diff", diff)}`)));
      pending.forEach((k, i) => (results[k] = out[i].data));
      const asked = normaliseQuestions(pending.flatMap((k) => results[k].questions ?? []), 3);
      if (asked.length && clarifyRoundsLeft(ctx.task, ctx.settings) > 0) {
        ctx.save({ reviews: results });
        return { status: "need_info", questions: asked, context: "While reviewing the change" };
      }
      const failing = pending.filter((k) => !results[k].pass && results[k].issues.some((x: any) => x.severity !== "minor"));
      if (!failing.length) { ctx.save({ reviews: results, unresolvedIssues: [] }); return { status: "ok", note: `${kinds.join(", ")} passed` }; }
      if (round === rounds) break;
      const issues = failing.flatMap((k) => results[k].issues.map((x: any) => ({ reviewer: k, ...x })));
      await ctx.agent("implementer", `${ticketBlock(ctx.task)}\n\n## Fix these review findings (keep the change minimal)\n${json(issues)}\n\n## Plan\n${json(ctx.task.data.plan ?? {})}`,
        { cwd: wt, allow: implementerAllow(isSafeTestsOnly(ctx) ? undefined : testCommandOf(ctx)), maxTurns: 40 });
      commitWithConvention(ctx, wt, "address review findings");
      pending = failing;
    }
    const unresolved = Object.entries(results).flatMap(([k, r]: any) => (r.pass ? [] : r.issues.map((x: any) => ({ reviewer: k, ...x }))));
    ctx.save({ reviews: results, unresolvedIssues: unresolved });
    return { status: "ok", note: `${unresolved.length} review issues remain – flagged for the human approver` };
  },

  async propose_memory(ctx) {
    { const missing = needWorkspace(ctx); if (missing) return missing; }
    const r = await ctx.agent("memory-keeper", [
      `## Task\n${ticketBlock(ctx.task)}`, `## Plan\n${json(ctx.task.data.plan ?? {})}`,
      `## Review findings\n${json(ctx.task.data.reviews ?? {})}`, feedbackBlock(ctx.task),
      `## Existing context\n${truncate(ctx.task.data.contextPack ?? "", 3000)}`,
    ].join("\n\n"));
    // Proposed facts are written to the local Handbook (.ai-workforce/knowledge, never committed into the PR) as unverified.
    const n = proposeFacts(ctx.project.local.path, r.data.facts ?? [], `${ctx.task.source_ref ?? ctx.task.id}`);
    for (const l of r.data.lessons ?? []) proposeFacts(ctx.project.local.path, [{ file: "standards", text: l }], `review of ${ctx.task.source_ref ?? ctx.task.id}`);
    ctx.save({ memory: r.data });
    return { status: "ok", note: `${n} facts, ${(r.data.lessons ?? []).length} lessons proposed` };
  },

  async prepublish(ctx) {
    { const missing = needWorkspace(ctx); if (missing) return missing; }
    const wt = ctx.task.worktree!;
    const baseBranch = ctx.project.github?.baseBranch ?? "main";
    const latest = G.resolveBase(ctx.project.local.path, baseBranch);
    if (latest.sha !== ctx.task.data.baseSha) {
      if (!G.rebaseOnto(wt, latest.ref)) return { status: "pause", reason: `Conflicts while rebasing onto the latest ${baseBranch}. Resolve in ${wt} and run \`aiw resume ${ctx.task.source_ref}\`.` };
      ctx.save({ baseSha: latest.sha });
    }
    const diff = G.diffAgainst(wt, ctx.task.data.baseSha);
    const marks = attributionInDiff(diff);
    if (marks.length) return { status: "fail", reason: `Hard rule: the change mentions Claude/AI authorship – ${marks.slice(0, 5).map((m) => `${m.file}: "${m.line}"`).join("; ")}` };
    const log = G.git(wt, ["log", "--format=%an <%ae>%n%B", `${ctx.task.data.baseSha}..HEAD`], { allowFail: true });
    if (attributionHits(log).length) return { status: "fail", reason: `Hard rule: a commit message or author mentions Claude/AI (${attributionHits(log).join(", ")})` };
    const secrets = scanDiff(diff);
    if (secrets.length) return { status: "fail", reason: `Possible secrets in the change: ${secrets.map((s) => `${s.rule} in ${s.file}`).join(", ")}` };
    const stat = G.diffStat(wt, ctx.task.data.baseSha);
    const files = G.changedFiles(wt, ctx.task.data.baseSha);
    const protectedHits = policyProtectedHits(files);
    const warnings: string[] = [];
    if (stat.added + stat.removed > ctx.settings.limits.maxDiffLines) warnings.push(`Large change: ${stat.added + stat.removed} lines`);
    if (protectedHits.length) warnings.push(`Touches protected paths: ${protectedHits.join(", ")}`);
    const testCmd = ctx.task.data.testsUnavailable ? undefined : testCommandOf(ctx);
    if (testCmd) {
      const t = await runTests(ctx, testCmd, wt);
      const env = t.envError ? `no safe test database: ${t.envError}` : t.code !== 0 ? environmentFailure(t.output) : undefined;
      if (env && ctx.settings.workflow.untestedWork !== "pause") markUntested(ctx, `the test command could not run here (${env})`);
      else if (t.code !== 0) return { status: "fail", reason: `Final test run failed after rebase:\n${truncate(failingSection(t.output), 1500)}` };
    }
    if (ctx.task.data.testsUnavailable) warnings.push(`Not tested on this computer: ${ctx.task.data.testsUnavailable.reason}`);
    const checks = await runChecks(ctx, wt);
    if (!checks.ok) return { status: "fail", reason: `Project checks failed after rebase:\n${truncate(checks.output, 1500)}` };
    ctx.save({ diffStat: stat, changedFiles: files, prepublishWarnings: warnings });
    return { status: "ok", note: warnings.join("; ") || "clean" };
  },

  async report(ctx) {
    // a web frontend: desktop + mobile screenshots of the changed pages (fake API, fake sign-in; never stops the work)
    try {
      const { webApp } = await import("./screenshots.js");
      if (webApp(ctx.project)) for (const m of groupMembers(ctx.project)) await ensureProfile(m, ctx.agent);
      await captureScreenshots(ctx);
    } catch { /* recorded on the task when possible */ }
    const d = ctx.task.data;
    const template = prTemplateText(ctx.project);
    const r = await ctx.agent("reporter", [
      template ? `## The team's PR template – the body MUST follow it: keep every heading and checkbox, fill each section, tick only boxes that are true\n${template}` : "",
      ticketBlock(ctx.task), `## Plan\n${json(d.plan ?? {})}`, `## Implementation\n${json(d.implementation ?? {})}`,
      `## Tests\n${json(d.tests ?? {})}`, `## Reviews\n${json(d.reviews ?? {})}`, `## Changed files\n${(d.changedFiles ?? []).join("\n")}`,
      reportDiff(ctx),
    ].filter(Boolean).join("\n\n"));
    const reviewLine = Object.entries(d.reviews ?? {}).map(([k, v]: any) => `${k} ${v.pass ? "OK" : "issues"}`).join(", ");
    const checksLine = (d.checks ?? []).length ? `**Project checks:** ${d.checks.join(" · ")} – passed` : "";
    const appendix = [
      "", "---",
      ctx.task.source === "chat" && d.agreedRequirements ? `**Requirements (agreed before implementation):**\n${requirementsMarkdown(d.agreedRequirements)}` : `**Ticket:** ${d.ticket?.url ?? ctx.task.source_ref ?? ""}`,
      `**Tests:** ${d.testsUnavailable ? `not run locally (${d.testsUnavailable.reason}) – please make sure CI passes before merging` : d.tests?.ran ? (d.tests.passed ? `passed (attempts: ${d.tests.attempts}${d.tests.flaky ? ", flaky test detected" : ""})${d.tests.scope?.startsWith("targeted") ? ` – locally the ${d.tests.scope.replace(/^targeted: /, "")} ran; the full suite runs in CI` : ""}` : "FAILING") : "no test command"}`,
      `**Reviews:** ${reviewLine || "n/a"}`,
      checksLine,
      d.unresolvedIssues?.length ? `**Unresolved review findings:**\n${d.unresolvedIssues.map((x: any) => `- [${x.reviewer}/${x.severity}] ${x.file}: ${x.description}`).join("\n")}` : "",
      d.prepublishWarnings?.length ? `**Warnings:** ${d.prepublishWarnings.join("; ")}` : "",
      (d.targets ?? []).length > 1 ? `**Multi-repo change:** ${d.targets.join(" + ")} (Jira ${jiraKey(ctx.task)})` : "",
      `**Change size:** ${d.diffStat ? `${d.diffStat.files} files, +${d.diffStat.added}/-${d.diffStat.removed}` : "n/a"}`,
    ].filter((x) => x !== "").join("\n");
    // Only real Jira keys prefix the PR title; a chat request's TASK-n id means nothing to reviewers.
    const key = ctx.task.source === "jira" ? jiraKey(ctx.task) : "";
    // the reporter sometimes starts the title with the key already ("KAN-52: KAN-52: …" otherwise)
    const bare = String(r.data.title ?? "").replace(key ? new RegExp(`^\\s*\\[?${key}\\]?\\s*[:\\-–]?\\s*`, "i") : /^$/, "");
    const title = stripAttribution(`${key ? `${key}: ` : ""}${bare}`).slice(0, 120);
    const body = stripAttribution(`${r.data.body}\n${appendix}`);
    const file = path.join(reportsDir(ctx.project.id), `${ctx.task.source_ref ?? ctx.task.id}.md`);
    fs.writeFileSync(file, `# ${title}\n\n${body}\n`);
    ctx.save({ report: { title, body, file } });
    return { status: "ok" };
  },

  async request_approval(ctx) {
    const action = ctx.params.action ?? "create_pr";
    const d = ctx.task.data;
    const existing = latestApproval(ctx.task.id, action);
    if (existing && existing.action === action && existing.state === "approved") return { status: "ok", note: "already approved" };
    if (ctx.task.playbook === "dev-lead") return requestLeadApproval(ctx);
    const wt = ctx.task.worktree;
    const binding = wt && d.baseSha
      ? { repo: ctx.project.github?.repo, branch: ctx.task.branch ?? undefined, baseSha: d.baseSha, headSha: G.headSha(wt), diffHash: G.diffHash(wt, d.baseSha) }
      : {};
    const ap = requestApproval(ctx.task.id, action, binding);
    if (action === "create_pr") {
      // F2 + rails: a directive or your settings may skip the PR approval; protected paths always ask; rails refuse
      const files = wt && d.baseSha ? G.changedFiles(wt, d.baseSha) : (d.changedFiles ?? []);
      const g = canCreatePr(ctx.task.id, { branch: ctx.task.branch ?? undefined, base: ctx.project.github?.baseBranch, files,
        secrets: wt && d.baseSha ? scanDiff(G.diffAgainst(wt, d.baseSha)) : 0 }, { settings: ctx.settings, project: ctx.project });
      if (g.verdict === "deny") return { status: "fail", reason: g.reason };
      if (g.verdict === "allow") {
        approveByPolicy(ap.id, g.rule ?? "pr_approval");
        return { status: "ok", note: g.by === "directive" ? "PR approval skipped by your rule" : g.by === "settings" ? "PR approval skipped by your settings" : g.reason };
      }
    }
    const facts: [string, string][] = [];
    if (d.diffStat) facts.push(["Changes", `${d.diffStat.files} files, +${d.diffStat.added}/-${d.diffStat.removed}`]);
    if (d.tests) facts.push(["Tests", d.testsUnavailable ? "NOT run locally" : d.tests.ran ? (d.tests.passed ? "passed" : "failing") : "none"]);
    if (d.reviews) facts.push(["Reviews", Object.entries(d.reviews).map(([k, v]: any) => `${k} ${v.pass ? "OK" : "issues"}`).join(", ")]);
    if (binding.headSha) facts.push(["Commit", binding.headSha.slice(0, 7)]);
    if (d.unresolvedIssues?.length) facts.push(["Needs attention", `${d.unresolvedIssues.length} unresolved review findings`]);
    const what = action === "create_pr" ? "Built and tested – raise the PR?" : action === "post_jira_comment" ? "Ready – post to Jira?" : "Approval needed";
    const body = action === "create_pr"
      ? resultMessage(getTask(ctx.task.id) ?? ctx.task)
      : `${d.artefact?.summary ?? ctx.task.title ?? ""}${d.artefact?.markdown ? `\n\n${truncate(d.artefact.markdown, 3000)}` : ""}`;
    await notify({
      kind: "approval_needed", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, approvalId: ap.id, approvalAction: action, dedupeKey: ap.id,
      facts: binding.headSha ? [["Commit", binding.headSha.slice(0, 7)]] : facts.slice(0, 1),
      title: `${action === "create_pr" ? "✅ " : ""}${ctx.task.source_ref ?? ""} ${what}`.trim(),
      body,
      url: d.ticket?.url,
    });
    return { status: "await_approval", approvalId: ap.id };
  },

  async publish(ctx) {
    const a = latestApproval(ctx.task.id, ["create_pr", "post_jira_comment"]);
    if (!a || a.state !== "approved") return { status: "fail", reason: "No valid approval" };
    if (a.action === "post_jira_comment") {
      const jira = clients.jira();
      if (!jira || !jiraKey(ctx.task)) return { status: "fail", reason: "Jira is not connected" };
      await jira.addComment(jiraKey(ctx.task), stripAttribution(`${ctx.task.data.artefact?.title ?? "Notes"}\n\n${ctx.task.data.artefact?.markdown ?? ""}`));
      ctx.save({ published: { jiraComment: true } });
      audit("service", "publish.jira_comment", ctx.task.id, { approvalId: a.id });
      return { status: "ok" };
    }
    const missing = needWorkspace(ctx);
    if (missing) return missing;
    const wt = ctx.task.worktree!;
    const bind = verifyBinding(a, wt);
    if (!bind.ok) return { status: "pause", reason: `STALE: ${bind.reason}` };
    const gh = clients.github();
    const repo = ctx.project.github?.repo;
    if (!gh || !repo) return { status: "fail", reason: "GitHub is not connected for this project" };
    try { G.pushBranch(wt, repo, ctx.task.branch!, gh.gitAuthHeader()); }
    catch (e: any) {
      const refused = G.pushRefusal(e, repo, ctx.task.branch ?? undefined);
      if (!refused) throw e;
      ctx.save({ pushRefused: { at: new Date().toISOString(), repo, reason: refused } });
      return { status: "pause", reason: refused };
    }
    const raw = ctx.task.data.report ?? { title: ctx.task.title, body: "" };
    const report = { title: stripAttribution(raw.title ?? ""), body: stripAttribution(raw.body ?? "") };
    if (attributionHits(`${report.title}\n${report.body}`).length) return { status: "fail", reason: "Hard rule: PR text still mentions Claude/AI – fix the report and refresh" };
    report.body = withScreenshots(ctx.task, ctx.project, report.body, gh.gitAuthHeader());     // own branch pr-screenshots/<ticket>
    const existing = await gh.findOpenPr(repo, ctx.task.branch!);
    const pr = existing
      ? await gh.updatePr(repo, existing.number, { title: report.title, body: report.body })
      : await gh.createPr(repo, { title: report.title, body: report.body, head: ctx.task.branch!, base: ctx.project.conventions?.baseBranch ?? ctx.project.github!.baseBranch, draft: !!ctx.settings.pr?.draft });   // never merged by AI Workforce
    ctx.save({ pr, prOpenedAt: ctx.task.data.prOpenedAt ?? new Date().toISOString() });
    audit("service", "publish.pr", ctx.task.id, { approvalId: a.id, pr: pr.url, head: a.head_sha });
    const asked = existing ? [] : await requestPrReviewers(ctx.project, repo, pr.number, G.changedFiles(wt, ctx.task.data.baseSha));
    const watching = afterPrRaised(ctx.project, repo, pr.number, G.headSha(wt));
    const draft = !!ctx.settings.pr?.draft;
    await notify({ kind: "pr_created", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined,
      title: `🚀 ${ctx.task.source_ref ?? ""} PR #${pr.number} ${existing ? "updated" : draft ? "raised (draft)" : "raised"}`,
      body: `${report.title ?? ""}\n\n- **Repository:** ${repo}\n- **Branch:** ${ctx.task.branch}${asked.length ? `\n- **Review requested from:** ${asked.join(", ")}` : ""}\n\n${draft ? "It is a draft – " : ""}Nothing is merged.${watching ? " I'm watching CI – if a check fails I'll fix it and tell you." : ""} I'll tell you here when someone comments or reviews it.\n\n💰 ${costText(ctx.task).replace("so far", "in total")}`, url: pr.url });
    if (ctx.settings.notifications.jiraComments && ctx.task.source === "jira" && jiraKey(ctx.task)) {
      try { await clients.jira()?.addComment(jiraKey(ctx.task), `${ctx.settings.pr?.draft ? "Draft PR" : "PR"} (${ctx.project.github?.repo}): ${pr.url}`); } catch { /* optional */ }
    }
    return { status: "ok", note: pr.url };
  },

  async record_memory(ctx) {
    const d = ctx.task.data;
    const key = ctx.task.source_ref ?? ctx.task.id;
    const parts = ctx.task.playbook === "dev-lead" ? partsOf(ctx.task.id) : [];
    const changed = parts.length ? parts.flatMap((p) => (p.data.changedFiles ?? []).map((f: string) => `${p.project_id}:${f}`)) : d.changedFiles ?? [];
    const content = [
      `# ${key}: ${ctx.task.title ?? ""}`, "",
      `- Date: ${new Date().toISOString().slice(0, 10)}`, `- Playbook: ${ctx.task.playbook}`,
      `- Outcome: ${d.pr?.url ?? (d.prs?.length ? d.prs.map((x: any) => x.url).join(", ") : d.published ? "posted" : "delivered")}`,
      `- Asked: ${truncate((d.ticket?.description ?? "").replace(/\s+/g, " "), 300)}`,
      changed.length ? `- Changed: ${changed.join(", ")}` : "",
      d.plan?.summary ? `- Approach: ${d.plan.summary}` : "",
      d.contract?.summary ? `- Contract: ${truncate(d.contract.summary, 300)}` : "",
      d.artefact?.summary ? `- Result: ${truncate(d.artefact.summary, 300)}` : "",
      ...(d.memory?.lessons ?? []).map((l: string) => `- Lesson: ${l}`),
      ...(d.feedback ?? []).map((f: string) => `- Human feedback: ${f}`),
      ...(d.unresolvedIssues ?? []).map((x: any) => `- Open review finding: ${x.description}`),
    ].filter(Boolean).join("\n");
    // a change across repositories is remembered by every repository it touched
    const projects = parts.length ? [...new Set(parts.map((p) => p.project_id))] : [ctx.project.id];
    for (const pid of projects) {
      recordTaskMemory(pid, key, content, `${key}: ${ctx.task.title ?? ""}`);
      try { refreshProject(pid); } catch { /* map refresh is best effort */ }
    }
    return { status: "ok" };
  },

  // ----------------------------- one ticket across several repositories: the lead task

  /** Understand the ticket completely: ticket, links, Brain and the code of every repository → repositories + build order. */
  async understand(ctx) {
    const members = groupMembers(ctx.project);
    const f = repoFolders(members);
    const brain = members.map((m) => `### ${m.id}\n${truncate(buildContextPack(m.id, ticketText(ctx.task)).text, 2500)}`).join("\n\n");
    const docs = ctx.task.data.linkedDocs ?? await linkedDocsText(ctx.task, ctx.project);
    // 1) A cheaper explorer finds the code once (code graph first); 2) the lead decides from its findings.
    //    After the user answers a question only step 2 runs again – nothing is re-read.
    const findings = await exploreOnce(ctx, members, docs);
    const prompt = [
      ticketBlock(ctx.task),
      `## Repositories\n${f.list}\n${describeMembers(members)}`,
      `## Code Explorer findings (from the code itself – your main source)\n${findingsText(findings)}`,
      `## Project Brain notes per repository\n${brain}`,
      docs.trim(),
      feedbackBlock(ctx.task),
      "Decide from the findings. Read code yourself only to confirm a specific point they leave open. Do not modify anything.",
    ].filter(Boolean).join("\n\n");
    const r = await ctx.agent("lead", prompt, { cwd: f.cwd, dirs: f.dirs, tools: ["Read", "Grep", "Glob"], maxTurns: 15 });
    const ids = members.map((m) => m.id);
    let targets = [...new Set<string>((r.data.targets ?? []).filter((x: string) => ids.includes(x)))];
    if (!targets.length) targets = heuristicTargets(ticketText(ctx.task), members);
    const order = targets.length > 1 && r.data.order === "parallel" ? "parallel" : "sequential";
    ctx.save({
      understanding: r.data, targets, order, group: ids,
      requirements: { requirements: r.data.requirements ?? [], acceptanceCriteria: r.data.acceptanceCriteria ?? [], openQuestions: [] },
      contextPack: `${brain}${docs}`,
    });
    const open = normaliseQuestions(r.data.questions, 3);
    if (open.length && clarifyRoundsLeft(ctx.task, ctx.settings) > 0) return { status: "need_info", questions: open, context: "While understanding the ticket (I read the ticket, the linked documents and the code of every repository)" };
    if (open.length) ctx.save({ assumptions: questionTexts(open) });
    return { status: "ok", note: `${targets.join(order === "parallel" ? " + " : " → ")}` };
  },

  /** The agreement between the repositories (endpoints, fields, types, errors) that every part is built against. */
  async contract(ctx) {
    const targets: string[] = ctx.task.data.targets ?? [];
    if (targets.length < 2) { ctx.save({ contract: null }); return { status: "ok", note: "one repository – no contract needed" }; }
    const f = repoFolders(leadMembers(ctx));
    const r = await ctx.agent("contract", [
      ticketBlock(ctx.task),
      `## What the lead decided\n${json(ctx.task.data.understanding ?? {})}`,
      `## Code Explorer findings (existing routes, schemas and client calls)\n${findingsText(ctx.task.data.findings)}`,
      `## Repositories\n${f.list}\nTargets in build order: ${targets.join(", ")}`,
      feedbackBlock(ctx.task),
      "Base the contract on the findings and keep the existing names; read code only to confirm an exact type or field the findings leave open. Do not modify anything.",
    ].filter(Boolean).join("\n\n"), { cwd: f.cwd, dirs: f.dirs, tools: ["Read", "Grep", "Glob"], maxTurns: 15 });
    ctx.save({ contract: { ...r.data, version: 1, changes: [] } });
    return { status: "ok", note: `${(r.data.items ?? []).length} contract items` };
  },

  /** One plan with a part per repository. */
  async lead_plan(ctx) {
    const targets: string[] = ctx.task.data.targets ?? [ctx.project.id];
    const f = repoFolders(leadMembers(ctx));
    const prior = ctx.task.data.planIssues?.length ? `\n## Issues found in the previous plan (fix them)\n${json(ctx.task.data.planIssues)}` : "";
    const assumptions = ctx.task.data.assumptions?.length ? `\n\n## Unanswered questions – choose a sensible assumption for each and list it under risks\n${ctx.task.data.assumptions.map((q: string) => `- ${q}`).join("\n")}` : "";
    const r = await ctx.agent("lead-planner", [
      ticketBlock(ctx.task),
      `## Requirements\n${json(ctx.task.data.requirements ?? {})}`,
      `## What the lead decided\n${json(ctx.task.data.understanding ?? {})}`,
      ctx.task.data.contract ? `## Contract (every part must follow it)\n${contractText(ctx.task.data.contract)}` : "",
      `## Code Explorer findings (files, symbols and lines to build on)\n${findingsText(ctx.task.data.findings)}`,
      `## Repositories\n${f.list}\nTargets in build order: ${targets.join(", ")}`,
      `## Project context\n${truncate(ctx.task.data.contextPack ?? "", 6_000)}${feedbackBlock(ctx.task)}${prior}${assumptions}`,
      "Plan from the findings (exact files and symbols). Read code only to confirm a location they leave open. Do not modify anything.",
    ].filter(Boolean).join("\n\n"), { cwd: f.cwd, dirs: f.dirs, tools: ["Read", "Grep", "Glob"], maxTurns: 20 });
    const parts = targets.map((repo) => {
      const p = (r.data.parts ?? []).find((x: any) => x.repo === repo) ?? {};
      return { repo, summary: p.summary ?? r.data.summary, steps: p.steps ?? [], files: p.files ?? [], tests: p.tests ?? [] };
    });
    const tag = (repo: string, xs: string[]) => targets.length > 1 ? xs.map((x) => `[${repo}] ${x}`) : xs;
    ctx.save({
      plan: { summary: r.data.summary, parts, risks: r.data.risks ?? [], steps: parts.flatMap((p) => tag(p.repo, p.steps)), files: parts.flatMap((p) => tag(p.repo, p.files)), tests: parts.flatMap((p) => tag(p.repo, p.tests)) },
      planAt: new Date().toISOString(),
    });
    return { status: "ok" };
  },

  /** Build every repository's part (in the decided order); answer their questions; continue when all are ready. */
  async run_parts(ctx) {
    const lead = getTask(ctx.task.id)!;
    const targets: string[] = lead.data.targets ?? [ctx.project.id];
    const existing = partsOf(lead.id);
    // the user asked for changes at the PR approval → every part reworks with that feedback
    if (lead.data.rework && !lead.data.rework.sent) {
      for (const p of existing.filter((x) => x.state === "PART_READY")) reworkPart(p, `Feedback from the reviewer of the whole change: ${lead.data.rework.feedback}`);
      ctx.save({ rework: { ...lead.data.rework, sent: true }, integrationRounds: 0 });
    }
    const key = jiraKey(lead) || lead.source_ref || lead.id;
    for (const repo of targets) {
      if (existing.some((p) => p.project_id === repo)) continue;
      const project = getProject(repo);
      if (!project) return { status: "fail", reason: `Repository ${repo} is no longer configured` };
      const slice = (lead.data.plan?.parts ?? []).find((x: any) => x.repo === repo) ?? { summary: lead.data.plan?.summary, steps: [], files: [], tests: [] };
      const part = createTask({
        projectId: repo, source: lead.source, sourceId: `${lead.source_id ?? lead.id}#${repo}`, sourceRef: `${key}@${repo}`, title: lead.title ?? undefined,
        kind: "part", role: lead.role ?? undefined, priority: lead.priority, state: "TRIAGED",
        data: {
          leadId: lead.id, ticket: lead.data.ticket, triage: lead.data.triage, targets, order: lead.data.order, group: lead.data.group,
          plan: { summary: slice.summary, steps: slice.steps, files: slice.files, tests: slice.tests, risks: lead.data.plan?.risks ?? [] },
          requirements: lead.data.requirements, leadClarifications: lead.data.clarifications ?? [], agreedRequirements: lead.data.agreedRequirements, request: lead.data.request,
        },
      });
      if (part.state === "TRIAGED") {
        updateTask(part.id, { size: lead.size, playbook: "dev-part" });
        transition(part.id, "QUEUED", `part of ${key}`);
      }
    }
    return superviseParts(ctx);
  },

  /** A part is built, tested, reviewed and rebased: it waits for the lead (integration check, one PR approval). */
  async part_ready() {
    return { status: "wait", state: "PART_READY", note: "waiting for the lead" };
  },

  /** Do the repositories fit together? Read every change together + each repository's tests; send fixes back. */
  async integration_check(ctx) {
    const sup = await superviseParts(ctx);
    if (sup.status !== "ok") return sup;
    const parts = partsOf(ctx.task.id).filter((p) => p.state === "PART_READY");
    if (parts.length < 2) {
      ctx.save({ integration: { pass: true, single: true, summary: "One repository – no cross-repository check needed", issues: [], criteria: [] } });
      return { status: "ok", note: "single repository" };
    }
    const changes = parts.map((p) => {
      const tests = p.data.testsUnavailable ? `NOT RUN on this computer (${p.data.testsUnavailable.reason}) – check this side extra carefully` : p.data.tests?.ran ? (p.data.tests.passed ? "passed" : "FAILING") : "no test command";
      return `### ${p.project_id} (branch ${p.branch}) – tests: ${tests}\n${untrusted(`diff:${p.project_id}`, truncate(G.diffAgainst(p.worktree!, p.data.baseSha), 30_000))}`;
    }).join("\n\n");
    const r = await ctx.agent("integration-reviewer", [
      ticketBlock(ctx.task),
      `## Acceptance criteria\n${json(ctx.task.data.requirements?.acceptanceCriteria ?? [])}`,
      ctx.task.data.contract ? `## Contract\n${contractText(ctx.task.data.contract)}` : "",
      `## Repositories (current directory = ${parts[0].project_id}; additional folders: ${parts.slice(1).map((p) => `${p.project_id} = ${p.worktree}`).join(", ")})`,
      `## The changes\n${changes}`,
      "Read the changed code where needed. Do not modify anything.",
    ].filter(Boolean).join("\n\n"), { cwd: parts[0].worktree!, dirs: parts.slice(1).map((p) => p.worktree!), tools: ["Read", "Grep", "Glob"], maxTurns: 30 });
    const ids = parts.map((p) => p.project_id);
    const blocking = (r.data.issues ?? []).filter((x: any) => x.severity !== "minor");
    const failingTests = parts.filter((p) => p.data.tests?.ran && !p.data.tests.passed);
    const rounds = ctx.task.data.integrationRounds ?? 0;
    if (!blocking.length && !failingTests.length) {
      ctx.save({ integration: { ...r.data, pass: true, rounds } });
      return { status: "ok", note: "the repositories fit together" };
    }
    if (rounds >= 2) {
      ctx.save({ integration: { ...r.data, pass: false, rounds } });
      return { status: "ok", note: `${blocking.length} integration issues remain – shown at the PR approval` };
    }
    let sent = 0;
    for (const p of parts) {
      const mine = blocking.filter((x: any) => x.repo === p.project_id || !ids.includes(x.repo));
      const failing = failingTests.includes(p);
      if (!mine.length && !failing) continue;
      const lines = mine.map((x: any) => `- ${x.description}${x.fix ? ` → fix: ${x.fix}` : ""}`);
      if (failing) lines.push("- The tests are failing – make them pass.");
      reworkPart(p, `Integration check with ${ids.filter((x) => x !== p.project_id).join(", ")} found problems in this repository:\n${lines.join("\n")}`);
      sent++;
    }
    ctx.save({ integrationRounds: rounds + 1, integration: { ...r.data, pass: false, rounds: rounds + 1 } });
    return { status: "wait", state: "WAITING_PARTS", note: `sent fixes to ${sent} part(s), round ${rounds + 1}` };
  },

  /** One approval covered every repository: open one draft PR per repository, linked to each other. Never merged. */
  async publish_parts(ctx) {
    const a = latestApproval(ctx.task.id, "create_pr");
    if (!a || a.state !== "approved" || a.action !== "create_pr") return { status: "fail", reason: "No valid approval" };
    const bind = ctx.task.data.partBindings;
    if (!bind || bind.approvalId !== a.id) return { status: "fail", reason: "The approval does not match the built change – refresh the task" };
    const gh = clients.github();
    if (!gh) return { status: "fail", reason: "GitHub is not connected" };
    // verify every repository first, so nothing is pushed when one of them changed after the approval
    const items: { part: Task; project: ProjectConfig; b: any }[] = [];
    for (const b of bind.parts) {
      const part = getTask(b.id);
      const project = part ? getProject(part.project_id) : undefined;
      if (!part || !project?.github?.repo || !part.worktree || !fs.existsSync(part.worktree)) return { status: "fail", reason: `The ${b.project ?? b.id} part or its workspace is missing` };
      if (G.headSha(part.worktree) !== b.headSha || G.diffHash(part.worktree, b.baseSha) !== b.diffHash) return { status: "pause", reason: `STALE: the ${part.project_id} change was modified after your approval – refresh to approve again` };
      items.push({ part, project, b });
    }
    const prs: { project: string; repo: string; number: number; url: string; title: string; body: string; existing: boolean }[] = [];
    for (const { part, project } of items) {
      const repo = project.github!.repo;
      const raw = part.data.report ?? { title: part.title, body: "" };
      const report = { title: stripAttribution(raw.title ?? ""), body: stripAttribution(raw.body ?? "") };
      if (attributionHits(`${report.title}\n${report.body}`).length) return { status: "fail", reason: `Hard rule: the ${part.project_id} PR text still mentions Claude/AI` };
      try { G.pushBranch(part.worktree!, repo, part.branch!, gh.gitAuthHeader()); }
      catch (e: any) { const refused = G.pushRefusal(e, repo, part.branch ?? undefined); if (!refused) throw e; return { status: "pause", reason: refused }; }
      report.body = withScreenshots(part, project, report.body, gh.gitAuthHeader());
      const existingPr = await gh.findOpenPr(repo, part.branch!);
      const pr = existingPr
        ? await gh.updatePr(repo, existingPr.number, { title: report.title, body: report.body })
        : await gh.createPr(repo, { title: report.title, body: report.body, head: part.branch!, base: project.conventions?.baseBranch ?? project.github!.baseBranch, draft: !!ctx.settings.pr?.draft });
      mergeData(part.id, { pr, prOpenedAt: part.data.prOpenedAt ?? new Date().toISOString() });
      audit("service", "publish.pr", part.id, { approvalId: a.id, pr: pr.url, lead: ctx.task.id });
      if (!existingPr) await requestPrReviewers(project, repo, pr.number, G.changedFiles(part.worktree!, part.data.baseSha));
      afterPrRaised(project, repo, pr.number, G.headSha(part.worktree!));
      prs.push({ project: part.project_id, repo, number: pr.number, url: pr.url, title: report.title, body: report.body, existing: !!existingPr });
    }
    // link the PRs to each other
    if (prs.length > 1) {
      for (const p of prs) {
        const others = prs.filter((x) => x !== p).map((x) => `- ${x.repo}#${x.number}: ${x.url}`).join("\n");
        try { await gh.updatePr(p.repo, p.number, { body: `${p.body}\n\n**Paired change (merge together):**\n${others}` }); } catch { /* the PR itself exists */ }
      }
    }
    ctx.save({ prs: prs.map(({ body: _b, ...x }) => x), prOpenedAt: new Date().toISOString() });
    for (const { part } of items) {
      transition(part.id, "DONE", `published by ${ctx.task.source_ref ?? ctx.task.id}`);
      mergeData(part.id, { cleanupAfter: new Date(Date.now() + 7 * 86_400_000).toISOString() });
      markInboxRead(part.id);
    }
    const ref = ctx.task.source_ref ?? ctx.task.id;
    await notify({ kind: "pr_created", taskId: ctx.task.id, taskRef: ref,
      title: `🚀 ${ref}: ${prs.length === 1 ? `PR #${prs[0].number} ${prs[0].existing ? "updated" : ctx.settings.pr?.draft ? "raised (draft)" : "raised"}` : `${prs.length} PRs raised${ctx.settings.pr?.draft ? " (draft)" : ""}`}`,
      body: `${prs.map((p) => `- **${p.repo}** – PR #${p.number}: ${p.url}`).join("\n")}\n\n${prs.length > 1 ? "The PRs link to each other – merge them together. " : ""}${ctx.settings.pr?.draft ? "Drafts – " : ""}Nothing is merged.${ctx.settings.pr?.autoFixCi !== false ? " I'm watching CI – if a check fails I'll fix it and tell you." : ""} I'll tell you here when someone comments or reviews them.\n\n💰 ${costText(ctx.task).replace("so far", "in total")}`,
      url: prs[0]?.url });
    if (ctx.settings.notifications.jiraComments && ctx.task.source === "jira" && jiraKey(ctx.task)) {
      try { await clients.jira()?.addComment(jiraKey(ctx.task), `${ctx.settings.pr?.draft ? "Draft PR" : "PR"}${prs.length > 1 ? "s" : ""}:\n${prs.map((p) => `${p.repo}: ${p.url}`).join("\n")}`); } catch { /* optional */ }
    }
    return { status: "ok", note: prs.map((p) => p.url).join(" ") };
  },

  // ----------------------------- work without a ticket: requirements interview

  /** Ask the requester, round by round, until the requirement is complete (or the round limit is reached). */
  async requirements_interview(ctx) {
    const d = ctx.task.data;
    const ref = ctx.task.source_ref ?? ctx.task.id;
    const rounds = (d.clarifications ?? []).length;
    const answers = (d.clarifications ?? []).map((c: any) => `- ${(c.questions ?? []).join(" / ") || "(general)"}\n  → ${c.answer}`).join("\n") || "none";
    const { groupMembers, describeMembers } = await import("./routing.js");
    const prompt = [
      `## The request (from ${d.request?.by ?? "the user"})\n${untrusted(`request:${ref}`, d.request?.text ?? ctx.task.title ?? "")}`,
      `## Answers so far\n${answers}`,
      d.requirementsDraft ? `## Your current understanding\n${json(d.requirementsDraft)}` : "",
      `## Repositories in this product\n${describeMembers(groupMembers(ctx.project))}${d.request?.preferRepo ? `\n(The user asked while working in ${d.request.preferRepo}.)` : ""}`,
      `## Project context\n${truncate(d.contextPack ?? "", 12_000)}`,
      feedbackBlock(ctx.task),
      rounds >= ctx.settings.workflow.interviewRounds - 1 ? "## This is the last round – set done=true and record anything still open under assumptions." : "",
      "You may read files in the current directory to understand the code. Do not modify anything.",
    ].filter(Boolean).join("\n\n");
    const r = await ctx.agent("interviewer", prompt, { cwd: ctx.project.local.path, tools: ["Read", "Grep", "Glob"], maxTurns: 20 });
    ctx.save({ requirementsDraft: r.data.requirements });
    const qs = normaliseQuestions(r.data.questions, 4);
    if (!r.data.done && qs.length && rounds < ctx.settings.workflow.interviewRounds) {
      return { status: "need_info", questions: qs, context: rounds === 0 ? "Before I plan this, I need to understand it fully" : `Follow-up questions (round ${rounds + 1})` };
    }
    return { status: "ok", note: `requirements complete after ${rounds} round(s)` };
  },

  /** The requester confirms the summary (or says what to change, which re-opens the interview). */
  async requirements_confirm(ctx) {
    const a = latestApproval(ctx.task.id, "confirm_requirements");
    if (a?.action === "confirm_requirements" && a.state === "approved") return { status: "ok", note: "requirements confirmed" };
    const ap = requestApproval(ctx.task.id, "confirm_requirements", {});
    await notify({ kind: "approval_needed", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, approvalId: ap.id, approvalAction: "confirm_requirements", dedupeKey: ap.id,
      title: `📝 ${ctx.task.source_ref}: is this what you want?`, body: requirementsMarkdown(ctx.task.data.requirementsDraft ?? {}, "•") });
    return { status: "await_approval", approvalId: ap.id };
  },

  /** Confirmed: the request becomes a normal ticket-like task (triage, plan, plan approval, build, PR approval). */
  async requirements_handoff(ctx) {
    const d = ctx.task.data;
    const req = d.requirementsDraft ?? {};
    const description = `${requirementsMarkdown(req)}\n\nOriginal request: ${d.request?.text ?? ""}`;
    ctx.save({ agreedRequirements: req, ticket: { ...(d.ticket ?? {}), title: req.title || d.ticket?.title || ctx.task.title, description } });
    return { status: "retriage", note: "requirements confirmed – continuing as a normal task" };
  },

  // ----------------------------- non-developer steps

  async ci_logs(ctx) {
    const gh = clients.github();
    const run = ctx.task.data.ciRun;
    if (!gh || !run) return { status: "fail", reason: "GitHub not connected or CI run missing" };
    const log = await gh.failedJobLog(run.repo, run.id);
    ctx.save({ ciLog: truncate(log, 14_000) });
    return { status: "ok" };
  },

  async pm_collect(ctx) {
    const jira = clients.jira();
    if (!jira || !ctx.project.jira) return { status: "fail", reason: "Jira is not connected" };
    const keys = ctx.project.jira.keys.join(",");
    const done = await jira.search(`project in (${keys}) AND statusCategory = Done AND updated >= -1d ORDER BY updated DESC`, 50);
    const inProgress = await jira.search(`project in (${keys}) AND sprint in openSprints() AND statusCategory = "In Progress" ORDER BY priority DESC`, 50);
    const blocked = await jira.search(`project in (${keys}) AND sprint in openSprints() AND (labels in (blocked, Blocked) OR status = Blocked)`, 30);
    const stale = await jira.search(`project in (${keys}) AND sprint in openSprints() AND statusCategory != Done AND updated <= -3d`, 30);
    const line = (i: any) => `${i.key} [${i.status}] ${i.title} (${i.assigneeName ?? "unassigned"})`;
    const data = `Done in last 24h:\n${done.map(line).join("\n") || "none"}\n\nIn progress:\n${inProgress.map(line).join("\n") || "none"}\n\nBlocked:\n${blocked.map(line).join("\n") || "none"}\n\nNo update for 3+ days:\n${stale.map(line).join("\n") || "none"}`;
    ctx.save({ pmData: data, pmCounts: { done: done.length, inProgress: inProgress.length, blocked: blocked.length, stale: stale.length } });
    return { status: "ok" };
  },

  async design_fetch(ctx) {
    const key = figmaKeyFromText(ticketText(ctx.task)) ?? ctx.project.figma?.fileKeys?.[0];
    if (!key) return { status: "need_info", questions: [{ question: "Which Figma file should be reviewed? Paste the Figma link (or add it to the ticket).", options: [] }] };
    // no frame in the ticket's link: the frame of the default file named after this ticket (if there is one)
    let node = figmaNodeFromText(ticketText(ctx.task));
    if (!node && !figmaKeyFromText(ticketText(ctx.task)) && jiraKey(ctx.task)) {
      try { node = (await figmaFramesFor(key, jiraKey(ctx.task)))[0]?.id; } catch { /* the whole file then */ }
    }
    if (/Skip the design review/i.test(ctx.task.data.clarifications?.at(-1)?.answer ?? "")) return { status: "done", note: "design review skipped by the user" };
    try {
      ctx.save({ figma: await figmaFileSummary(key, node), figmaKey: key });
    } catch (e: any) {
      // Desktop-app mode: the design must be open in the Figma app. Ask instead of failing.
      if (!getSecret("figma.token") && clarifyRoundsLeft(ctx.task, ctx.settings) > 0) {
        return { status: "need_info", context: "To review the design", questions: [{
          question: `Please open this design in the Figma desktop app${node ? " and select the frame from the ticket link" : ""} (with its MCP server on). ${truncate(e.message, 160)}`,
          options: ["Done – it's open now", "Skip the design review"],
        }] };
      }
      throw e;
    }
    return { status: "ok" };
  },

  async artefact(ctx) {
    const kind = ctx.params.kind as string;
    const d = ctx.task.data;
    const briefs: Record<string, string> = {
      qa_test_plan: "Write a QA test plan for this ticket: items = test cases as 'ID | title | steps | expected result | priority', covering every acceptance criterion, boundaries, negative paths and regression risks.",
      ci_root_cause: "Find the root cause of this CI failure from the failing log section. summary = root cause in 2-3 sentences; items = concrete fix steps, file/line hints, and whether it looks flaky or environmental.",
      user_stories: `Split this epic into user stories. items = 'As a … I want … so that …' each followed by ' | AC: ' and testable acceptance criteria. Flag gaps or open questions as items starting with 'QUESTION:'.${ticketStyle(ctx)}`,
      pm_digest: "Write a short daily sprint digest for a project manager. summary = 3 sentence status; items = highlights, blockers, risks and suggested follow-ups (one line each).",
      design_review: "Review this design for consistency (naming, components, styles) and accessibility (contrast, text size, focus order, labels). items = findings as 'severity | where | issue | suggestion'.",
    };
    const input = kind === "ci_root_cause" ? untrusted("ci-log", d.ciLog ?? "")
      : kind === "pm_digest" ? untrusted("jira-sprint-data", d.pmData ?? "")
      : kind === "design_review" ? `${ticketBlock(ctx.task)}\n\n${untrusted("figma", d.figma ?? "")}`
      : ticketBlock(ctx.task);
    const r = await ctx.agent("analyser", `${briefs[kind] ?? "Produce the requested artefact."}\n\n${input}\n\n## Project context\n${d.contextPack ?? ""}${d.requirements ? `\n\n## Requirements\n${json(d.requirements)}` : ""}`,
      { tier: ctx.params.tier });
    const title = { qa_test_plan: "QA test plan", ci_root_cause: "CI failure analysis", user_stories: "Proposed user stories", pm_digest: "Daily sprint digest", design_review: "Design review" }[kind] ?? "Report";
    const markdown = `${r.data.summary}\n\n${(r.data.items ?? []).map((x: string) => `- ${x}`).join("\n")}`;
    const file = path.join(reportsDir(ctx.project.id), `${ctx.task.source_ref ?? ctx.task.id}-${kind}.md`);
    fs.writeFileSync(file, `# ${title}${ctx.task.source_ref ? ` – ${ctx.task.source_ref}` : ""}\n\n${markdown}\n`);
    ctx.save({ artefact: { kind, title, summary: r.data.summary, markdown, file } });
    return { status: "ok" };
  },

  async deliver(ctx) {
    const a = ctx.task.data.artefact;
    await notify({
      kind: ctx.params.kind ?? "report_ready", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, dedupeKey: `run${ctx.task.run_no}`,
      title: `${a?.title ?? "Report"}${ctx.task.source_ref ? ` – ${ctx.task.source_ref}` : ""}`,
      body: `${truncate(a?.summary ?? "", 600)}\nFull report: ${a?.file ?? "n/a"}`, url: ctx.task.data.ticket?.url ?? ctx.task.data.ciRun?.url,
    });
    return { status: "ok" };
  },
};

// Reviewing someone's pull request (playbook pr-review): fetch_pr, review_pr, review_gate, post_review.
import { REVIEW_STEPS } from "./prReview.js";
Object.assign(STEPS, REVIEW_STEPS);

/** After the PR is raised: the ticket's report as a PDF (what was asked, decided and done, diagrams), sent to Teams. */
STEPS.ticket_report = async (ctx) => {
  if ((ctx.settings.workflow as any).ticketReport === false) return { status: "ok", note: "turned off in settings" };
  try {
    const { deliverTicketReport } = await import("../report/ticketReport.js");
    const r = await deliverTicketReport(ctx, `report:${ctx.task.run_no}`);
    return { status: "ok", note: r.file };
  } catch (e: any) {
    ctx.save({ ticketReport: { error: e.message, at: new Date().toISOString() } });
    return { status: "ok", note: `report not created: ${e.message}` };     // never stops the ticket
  }
};

// Fixing review comments / QA issues on a PR (playbook pr-fix) and the QA engineer (playbook pr-qa).
import { FIX_STEPS } from "./prFix.js";
import { QA_STEPS } from "./qa.js";
Object.assign(STEPS, FIX_STEPS, QA_STEPS);
