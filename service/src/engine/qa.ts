import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "../core/config.js";
import { truncate } from "../core/util.js";
import { audit } from "../core/db.js";
import { untrusted } from "../agents/runner.js";
import { clients } from "../connectors/registry.js";
import type { PrReviewInfo } from "../connectors/github.js";
import { failingSection } from "../connectors/github.js";
import * as G from "../git/git.js";
import { buildContextPack } from "../brain/brain.js";
import { stripAttribution, attributionHits } from "../core/attribution.js";
import { requestApproval, latestApproval } from "../approvals/approvals.js";
import { notify } from "../notify/router.js";
import { createTask, getTask, listTasks, mergeData, transition, updateTask, type Task } from "./tasks.js";
import { ticketBlock, environmentFailure, costText, type StepCtx, type StepResult } from "./steps.js";
import { resolvePrTargets } from "./targets.js";
import { webApp, withBuiltApp, writeAppConfig } from "./screenshots.js";
import { profileTestCommand, testEnvironment, testsNeedDatabase, liveStackFor, backendOf, LIVE_INSTRUCTIONS, withResults, testRunPassed } from "./localStack.js";
import { ensureProfile, profileOf } from "./testProfile.js";

/**
 * The QA engineer (after the review fixes are pushed, or on request): a risk-based test plan from the PR, ticket, PRD
 * and code → the repository's own tests for the changed areas (re-run once to spot flaky ones) → browser checks of the
 * changed pages on the built app with fake API answers → every failure classified (product / test / environment /
 * flaky / inconclusive) → duplicates searched → SHOWN to the developer → after their OK: GitHub issues for the chosen
 * product bugs and one QA report comment on the PR. Runs on this computer only; never touches a real database.
 */

export function startQaTask(project: ProjectConfig, repo: string, num: number, by: string, why: string, via = "teams-personal"): { task: Task; existing: boolean } {
  const sourceId = `qa:${repo}#${num}`;
  const before = listTasks({ states: ["TRIAGED", "QUEUED", "RUNNING", "AWAITING_APPROVAL", "PAUSED", "REJECTED", "STALE"] }).find((t) => t.source_id === sourceId);
  if (before) return { task: before, existing: true };
  const t = createTask({ projectId: project.id, source: via, sourceId, sourceRef: `QA-${num}@${project.id}`, title: `QA of ${repo}#${num}`, kind: "pr_qa", state: "TRIAGED",
    data: { qa: { repo, num, by, why, requestedAt: new Date().toISOString() } } });
  updateTask(t.id, { playbook: "pr-qa", size: "S" });
  transition(t.id, "QUEUED", `QA ${why}`);
  audit(`user:${by}`, "qa.requested", t.id, { repo, num, why });
  return { task: getTask(t.id)!, existing: false };
}

/** Teams: "QA PR 90", "test KAN-60's PR". */
export async function startQaFromText(text: string, ticketRef: string | undefined, by: string, via = "teams-personal"): Promise<string> {
  const found = await resolvePrTargets(text, ticketRef);
  if ("error" in found) return `❓ ${found.error}`;
  const lines = found.targets.map((x) => {
    const { task, existing } = startQaTask(x.project, x.repo, x.num, by, "on request", via);
    return existing ? `- PR #${x.num} (${x.project.id}) – QA already running (${task.source_ref})` : `- PR #${x.num} in ${x.repo} – ${task.source_ref}`;
  });
  return `🧪 **QA**\n\n${lines.join("\n")}\n\nI'll plan the tests from the ticket, the PRD and the change, run them on this computer, and show you the results here first. Nothing is posted and no issue is created until you say so.`;
}

const qaTestCommand = (p: ProjectConfig) => p.qa?.testCommand ?? p.local.testCommand;

/** Test file paths that are safe to put on a command line and exist in the checkout. */
function safeFiles(wt: string, files: string[]): string[] {
  return [...new Set(files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")))].filter((f) => /^[\w./@-]+$/.test(f) && !f.includes("..") && fs.existsSync(path.join(wt, f))).slice(0, 25);
}

/** Playwright's JSON report → one line per test. */
function browserResults(file: string): { title: string; status: string; error?: string }[] {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  const out: { title: string; status: string; error?: string }[] = [];
  const walk = (s: any) => {
    for (const spec of s.specs ?? []) for (const t of spec.tests ?? []) {
      const r = (t.results ?? []).at(-1) ?? {};
      out.push({ title: spec.title, status: r.status ?? t.status ?? "unknown", error: r.error?.message ? truncate(String(r.error.message).replace(/\u001b\[[0-9;]*m/g, ""), 600) : undefined });
    }
    for (const c of s.suites ?? []) walk(c);
  };
  for (const s of j.suites ?? []) walk(s);
  return out;
}

const VERDICT: Record<string, string> = { pass: "✅ PASS", pass_with_warnings: "🟡 PASS WITH WARNINGS", blocked: "🔴 BLOCKED", inconclusive: "⚪ INCONCLUSIVE" };
const SEV: Record<string, string> = { P0: "🔴 P0", P1: "🟠 P1", P2: "🟡 P2", P3: "⚪ P3" };

/** Product bugs worth an issue by default: not low confidence, not already reported. */
const defaultIssues = (r: any): number[] => (r?.findings ?? []).filter((f: any) => f.classification === "product" && f.confidence !== "low" && !f.duplicateOf).map((f: any) => f.n);

export const QA_STEPS: Record<string, (ctx: StepCtx) => Promise<StepResult>> = {
  async qa_prepare(ctx) {
    const q = ctx.task.data.qa;
    if (ctx.task.worktree && fs.existsSync(ctx.task.worktree) && ctx.task.data.qaHead) return { status: "ok", note: "workspace reused" };
    const gh = clients.github();
    if (!gh?.prForReview) return { status: "fail", reason: "GitHub is not connected" };
    const pr = await gh.prForReview(q.repo, q.num);
    if (pr.state !== "open" && !pr.merged) return { status: "fail", reason: `PR #${q.num} is ${pr.state}` };
    // how to run and test these repositories here (detected once from each repository)
    await ensureProfile(ctx.project, ctx.agent);
    const be = backendOf(ctx.project);
    if (be) await ensureProfile(be, ctx.agent);
    const sha = G.fetchPrHead(ctx.project.local.path, q.repo, q.num, gh.gitAuthHeader());
    G.git(ctx.project.local.path, ["fetch", "--quiet", G.remoteUrl(q.repo), `+refs/heads/${pr.baseRef}:refs/aiw/base/${pr.baseRef}`], { extraHeader: gh.gitAuthHeader(), allowFail: true });
    const wt = G.createDetachedWorktree(ctx.project.local.path, ctx.project.id, ctx.task.id, sha, ctx.project.conventions?.env?.linkedDirs ?? []);
    ctx.task = { ...ctx.task, worktree: wt };
    const keys = ctx.project.jira?.keys ?? [];
    const key = (keys.length ? new RegExp(`\\b(${keys.join("|")})-\\d+\\b`, "i") : /\b[A-Z][A-Z0-9]+-\d+\b/).exec(`${pr.title} ${pr.headRef} ${pr.body}`)?.[0]?.toUpperCase();
    let ticket: any = { key: key ?? `PR-${q.num}`, title: pr.title, description: pr.body };
    if (key) { try { const i = await clients.jira()?.getIssue(key); if (i) ticket = { key: i.key, title: i.title, description: i.description, url: i.url, comments: i.comments ?? [] }; } catch { /* optional */ } }
    let budget = 100_000;
    const files = pr.files.map((x) => { const patch = x.patch ? truncate(x.patch, Math.max(0, Math.min(12_000, budget))) : undefined; budget -= patch?.length ?? 0; return { ...x, patch }; });
    ctx.save({ prInfo: { ...pr, files }, qaHead: sha, ticket, worktreePath: wt });
    return { status: "ok", note: `${pr.files.length} files at ${sha.slice(0, 7)}` };
  },

  /** Risk-based test plan: what the change affects, which existing tests cover it, which browser checks to run. */
  async qa_plan(ctx) {
    const d = ctx.task.data;
    const pr: PrReviewInfo = d.prInfo;
    const brain = buildContextPack(ctx.project.id, `${d.ticket?.title ?? ""}\n${d.ticket?.description ?? ""}\n${pr.files.map((f) => f.path).join(" ")}`, 8000).text;
    const r = await ctx.agent("qa-planner", [
      ticketBlock(ctx.task),
      `## Product requirements and project knowledge\n${brain}`,
      `## Pull request #${pr.number}: ${pr.title}\n${untrusted(`pr-description:${pr.number}`, truncate(pr.body, 3000))}`,
      `## Changed files\n${untrusted("pr-diff", pr.files.map((f) => `### ${f.path}\n${f.patch ?? `(${f.status})`}`).join("\n\n"))}`,
      webApp(ctx.project) ? "This repository is a web frontend: browser checks of the changed pages are possible (on the real local backend with a demo login when available, otherwise with fake API answers)." : "No browser checks for this repository (not a web frontend with Playwright).",
      (d.feedback ?? []).length ? `## What the developer wants changed in the QA\n${d.feedback.map((x: string) => `- ${x}`).join("\n")}` : "",
      "The PR's code is the current directory (read-only). Do not modify anything.",
    ].filter(Boolean).join("\n\n"), { cwd: ctx.task.worktree!, tools: ["Read", "Grep", "Glob"], maxTurns: 20 });
    ctx.save({ qaPlan: r.data });
    return { status: "ok", note: `${r.data.risk} risk, ${(r.data.testFiles ?? []).length} test files, ${(r.data.browser?.checks ?? []).length} browser checks` };
  },

  /** Run the checks for real. Nothing is claimed as passed that did not run. */
  async qa_run(ctx) {
    const d = ctx.task.data;
    const wt = ctx.task.worktree!;
    const plan = d.qaPlan ?? {};
    const runs: Record<string, any> = {};
    // 1) the repository's own tests for the changed areas (re-run once when they fail: flaky or real?).
    //    A Python backend's tests get a TEMPORARY database (local PostgreSQL first, Docker second) – never the .env one.
    const files = safeFiles(wt, plan.testFiles ?? []);
    const py = testsNeedDatabase(ctx.project);
    const cmd = ctx.project.qa?.testCommand ?? profileTestCommand(ctx.project) ?? qaTestCommand(ctx.project);
    if (!cmd) runs.unit = { ran: false, why: profileOf(ctx.project).testCommand ? "no working runtime for its tests on this computer" : "no test command in this repository" };
    else {
      const te = py ? await testEnvironment(ctx.project, wt, ctx.task.id) : { env: {} as Record<string, string>, where: "", cleanup: () => {} };
      if ("error" in te) runs.unit = { ran: false, environment: true, why: te.error };
      else {
        try {
          const full = files.length ? (ctx.project.qa?.testCommand ? `${cmd} ${files.join(" ")}` : profileTestCommand(ctx.project, files) ?? `${cmd} ${files.join(" ")}`) : cmd;
          const res = withResults(full);                                 // exact counts (a coverage minimum is not a test failure)
          const raw = await G.runCommand(res.cmd, wt, 25 * 60_000, te.env);
          const counts = res.read();
          const t = { ...raw, code: testRunPassed(raw, counts) ? 0 : raw.code || 1, output: counts ? `${raw.output}\n[results: ${counts.tests} tests, ${counts.failures} failed, ${counts.errors} errors]` : raw.output };
          const envFail = t.code !== 0 ? environmentFailure(t.output) : undefined;
          let rerun: { code: number; output: string } | undefined;
          if (t.code !== 0 && !envFail) rerun = await G.runCommand(full, wt, 25 * 60_000, te.env);
          runs.unit = { ran: !envFail, command: full.replace(/"[^"]*python(\.exe)?"/i, "python"), scoped: files.length > 0, database: te.where || undefined, code: t.code,
            output: truncate(t.code === 0 ? t.output.split(/\r?\n/).slice(-15).join("\n") : failingSection(t.output), 8000),
            environment: envFail, rerunCode: rerun?.code, rerunOutput: rerun && rerun.code !== 0 ? truncate(failingSection(rerun.output), 3000) : undefined };
        } finally { te.cleanup(); }
      }
    }
    // 2) browser checks of the changed pages, on the built app with fake API answers
    const checks = plan.browser?.needed ? plan.browser.checks ?? [] : [];
    if (checks.length && webApp(ctx.project)) {
      // the real local backend + demo login when possible; fake API answers otherwise (and the report says which)
      const live = await liveStackFor(ctx.project, d.ticket?.key, `${ctx.task.id}-qa`);
      const liveEnv = "env" in live ? live.env : {};
      try {
      const res = await withBuiltApp(ctx.project, `${ctx.task.id}-qa`, d.qaHead ?? G.headSha(wt), async (a) => {
        const command = writeAppConfig(a, "qa.spec.ts", `[["line"], ["json", { outputFile: "results/qa-results.json" }]]`);
        const spec = ".aiw-shots/qa.spec.ts";
        const base = [
          ticketBlock(ctx.task),
          `## The planned checks\n${checks.map((c: any) => `- ${c.id}: ${c.route} – ${c.steps}\n  Expected: ${c.expected} (source: ${c.source})`).join("\n")}`,
          `## Where things go\n- Write the spec to: ${spec} (the only file you may create or edit)\n- I run \`${command}\` (it starts the built app; the base URL is set, so use page.goto("/route"))`,
          "env" in live ? LIVE_INSTRUCTIONS : "FAKE-API MODE: no real backend could be started here, so answer every API call with fakes, like the repository's own browser tests do.",
        ].join("\n\n");
        const tools = { cwd: a.dir, maxTurns: 30, tools: ["Read", "Grep", "Glob", "Write", "Edit"], allow: ["Read", "Grep", "Glob", "Write", "Edit"] };
        await ctx.agent("qa-tester", `${base}\n\nWrite the spec now. Do not run anything.`, tools);
        let out = { code: 1, output: "" };
        let results: { title: string; status: string; error?: string }[] = [];
        for (let round = 1; round <= 3; round++) {
          const json = path.join(a.dir, ".aiw-shots", "results", "qa-results.json");
          fs.rmSync(json, { force: true });
          out = await G.runCommand(command, a.dir, 15 * 60_000, liveEnv);
          results = browserResults(json);
          const testProblems = /PAGEERROR|UNSTUBBED|Cannot find module|is not a function|locator\.|waiting for|Timeout/i.test(out.output) || !results.length;
          if (round === 3 || out.code === 0 || !testProblems) break;
          // fix problems of the TEST only (fakes, selectors, waits) – product failures stay failing
          await ctx.agent("qa-tester", `${base}\n\n## Run ${round} – exit code ${out.code}\n${untrusted("playwright-output", truncate(out.output.split(/\r?\n/).filter((l) => /PAGEERROR|CONSOLE|UNSTUBBED|Error|✘|›|expect|Timeout|passed|failed/.test(l)).slice(0, 120).join("\n"), 6000))}\n\nFix only problems of the test itself. Never weaken an assertion about expected behaviour.`, tools);
        }
        return { ran: results.length > 0, mode: "env" in live ? `live: ${live.note}` : `not tested in the live local app – ${"reason" in live ? live.reason : ""} (fake API answers were used)`, code: out.code, results,
          output: truncate(out.output.split(/\r?\n/).filter((l) => /PAGEERROR|CONSOLE|UNSTUBBED|Error|✘|expect|passed|failed/.test(l)).slice(0, 80).join("\n"), 5000) };
      }, liveEnv);
      runs.browser = res.ok ? res.value : { ran: false, environment: true, why: res.reason };
      } finally { if ("stop" in live) await live.stop(); }
    } else if (plan.browser?.needed) runs.browser = { ran: false, why: "no web app with Playwright in this repository" };
    ctx.save({ qaRuns: runs });
    const unit = runs.unit?.ran ? (runs.unit.code === 0 ? "tests passed" : runs.unit.rerunCode === 0 ? "tests flaky" : "tests failing") : "tests not run";
    const br = runs.browser ? (runs.browser.ran ? `${runs.browser.results.filter((r: any) => r.status === "passed").length}/${runs.browser.results.length} browser checks passed` : "browser checks not run") : "no browser checks";
    return { status: "ok", note: `${unit}; ${br}` };
  },

  /** Classify every failure; product bugs get a duplicate search. */
  async qa_triage(ctx) {
    const d = ctx.task.data;
    const pr: PrReviewInfo = d.prInfo;
    const r = await ctx.agent("qa-triager", [
      ticketBlock(ctx.task),
      `## Test plan\n${JSON.stringify(d.qaPlan ?? {}, null, 1)}`,
      `## Results\n${untrusted("qa-results", truncate(JSON.stringify(d.qaRuns ?? {}, null, 1), 20_000))}`,
      `## The change\n${untrusted("pr-diff", truncate(pr.files.map((f) => `### ${f.path}\n${f.patch ?? ""}`).join("\n\n"), 20_000))}`,
      "The PR's code is the current directory (read-only). Do not modify anything.",
    ].join("\n\n"), { cwd: ctx.task.worktree!, tools: ["Read", "Grep", "Glob"], maxTurns: 20 });
    const gh = clients.github();
    const findings = [];
    let n = 0;
    for (const f of r.data.findings ?? []) {
      const finding: any = { ...f, n: ++n, title: stripAttribution(String(f.title ?? "")).slice(0, 140) };
      if (f.classification === "product" && gh?.searchIssues) {
        try {
          const words = new Set(String(f.title).toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
          const hit = (await gh.searchIssues(d.qa.repo, String(f.title).slice(0, 120))).find((i) => {
            const w = String(i.title).toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
            const same = w.filter((x) => words.has(x)).length;
            return i.state === "open" && words.size && same / Math.max(words.size, 1) >= 0.6;
          });
          if (hit) finding.duplicateOf = { number: hit.number, url: hit.url, title: hit.title };
        } catch { /* search is best effort */ }
      }
      findings.push(finding);
    }
    ctx.save({ qaResult: { ...r.data, findings, at: new Date().toISOString() }, qaSelection: null });
    return { status: "ok", note: `${r.data.verdict}, ${findings.filter((f: any) => f.classification === "product").length} product finding(s)` };
  },

  async qa_gate(ctx) {
    const a = latestApproval(ctx.task.id);
    if (a?.action === "create_issues" && a.state === "approved" && a.requested_at >= (ctx.task.data.qaResult?.at ?? "")) return { status: "ok", note: "approved" };
    const ap = requestApproval(ctx.task.id, "create_issues", {});
    const pr: PrReviewInfo = ctx.task.data.prInfo;
    await notify({ kind: "approval_needed", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, approvalId: ap.id, approvalAction: "create_issues", dedupeKey: ap.id,
      title: `🧪 QA of PR #${pr.number} – ${VERDICT[ctx.task.data.qaResult?.verdict] ?? "done"}`, body: qaPreview(getTask(ctx.task.id)!), url: pr.url });
    return { status: "await_approval", approvalId: ap.id };
  },

  /** The approved issues and one QA report comment on the PR. */
  async qa_publish(ctx) {
    const a = latestApproval(ctx.task.id);
    if (!a || a.state !== "approved" || a.action !== "create_issues") return { status: "fail", reason: "No approval to post the QA results" };
    const gh = clients.github();
    if (!gh?.createIssue || !gh.commentOnPr) return { status: "fail", reason: "GitHub is not connected" };
    const d = ctx.task.data;
    const r = d.qaResult;
    const pick: number[] = d.qaSelection ?? defaultIssues(r);
    const created: { n: number; number: number; url: string; title: string }[] = [];
    for (const f of (r.findings ?? []).filter((x: any) => pick.includes(x.n) && !x.duplicateOf)) {
      const title = `[BUG][${f.severity}] ${f.title}`.slice(0, 200);
      const body = stripAttribution([
        `**Summary**\n${f.actual}`,
        `**Found in**\nPR #${d.qa.num} (${d.prInfo?.headRef ?? ""} @ ${String(d.qaHead ?? "").slice(0, 7)})${d.ticket?.key ? ` · ticket ${d.ticket.key}` : ""}`,
        `**Steps to reproduce**\n${(f.steps ?? []).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`,
        `**Expected**\n${f.expected}`,
        `**Actual**\n${f.actual}`,
        f.evidence ? `**Evidence**\n\`\`\`\n${truncate(f.evidence, 1500)}\n\`\`\`` : "",
        `**Severity / confidence**\n${f.severity} · ${f.confidence}${f.area ? ` · ${f.area}` : ""}`,
        `**Related PR**\n${d.prInfo?.url ?? ""}`,
      ].filter(Boolean).join("\n\n"));
      if (attributionHits(`${title}\n${body}`).length) continue;
      const i = await gh.createIssue(d.qa.repo, { title, body });
      created.push({ n: f.n, number: i.number, url: i.url, title });
    }
    const dupes = (r.findings ?? []).filter((x: any) => x.duplicateOf && pick.includes(x.n));
    const others = (r.findings ?? []).filter((x: any) => x.classification !== "product");
    const report = stripAttribution([
      `## QA report – PR #${d.qa.num}`,
      `**Verdict:** ${VERDICT[r.verdict]?.replace(/^\S+\s/, "") ?? r.verdict}`,
      r.summary,
      (r.suites ?? []).length ? `| Suite | Passed | Failed | Skipped | Result |\n|---|---|---|---|---|\n${r.suites.map((s: any) => `| ${s.suite} | ${s.passed} | ${s.failed} | ${s.skipped} | ${s.result} |`).join("\n")}` : "",
      created.length ? `**Bugs reported**\n${created.map((c) => `- #${c.number} ${c.title}`).join("\n")}` : "",
      dupes.length ? `**Already reported**\n${dupes.map((x: any) => `- #${x.duplicateOf.number} ${x.duplicateOf.title}`).join("\n")}` : "",
      others.length ? `**Other observations (not product bugs)**\n${others.map((x: any) => `- ${x.classification}: ${x.title}`).join("\n")}` : "",
      (r.gaps ?? []).length ? `**Not tested**\n${r.gaps.map((g: string) => `- ${g}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n"));
    const c = await gh.commentOnPr(d.qa.repo, d.qa.num, report);
    ctx.save({ qaPublished: { issues: created, comment: c.url, at: new Date().toISOString() } });
    audit("service", "qa.published", ctx.task.id, { repo: d.qa.repo, num: d.qa.num, issues: created.map((x) => x.number), approvalId: a.id });
    if (ctx.task.worktree && fs.existsSync(ctx.task.worktree)) { G.removeWorktree(ctx.project.local.path, ctx.task.worktree); ctx.task = { ...ctx.task, worktree: null }; }
    await notify({ kind: "info", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, dedupeKey: `qa-done:${ctx.task.id}:${ctx.task.run_no}`,
      title: `🧪 QA results posted on PR #${d.qa.num}`,
      body: [
        created.length ? `**Issues created**\n${created.map((x) => `- #${x.number} ${x.title} – ${x.url}`).join("\n")}` : "No issues created.",
        `- **QA report:** ${c.url}`,
        created.length ? `\nTo fix them: "fix the QA issues on PR ${d.qa.num}" – the fixes come here first, like the review fixes.` : "",
        `\n💰 ${costText(ctx.task)}`,
      ].filter(Boolean).join("\n"),
      url: c.url });
    return { status: "ok", note: `${created.length} issue(s)` };
  },
};

/** What the developer sees before anything is posted. */
export function qaPreview(t: Task): string {
  const d = t.data;
  const r = d.qaResult ?? {};
  const pr: PrReviewInfo | undefined = d.prInfo;
  const blocks = [
    `**${pr?.title ?? ""}**\n${d.qa.repo}#${d.qa.num} · ${String(d.qaHead ?? "").slice(0, 7)}${d.ticket?.key ? ` · ticket ${d.ticket.key}` : ""} · risk ${d.qaPlan?.risk ?? "?"}`,
    `**Verdict: ${VERDICT[r.verdict] ?? r.verdict}**\n${r.summary ?? ""}`,
  ];
  const how = [
    d.qaRuns?.unit?.database ? `- Tests used ${d.qaRuns.unit.database} (never the .env database)` : d.qaRuns?.unit?.ran === false ? `- Tests not run: ${d.qaRuns.unit.why ?? "environment problem"}` : "",
    d.qaRuns?.browser?.mode ? `- Browser checks: ${d.qaRuns.browser.mode}` : d.qaRuns?.browser?.ran === false ? `- Browser checks not run: ${d.qaRuns.browser.why ?? ""}` : "",
  ].filter(Boolean);
  if ((r.suites ?? []).length || how.length) blocks.push(`**What ran**\n${[...(r.suites ?? []).map((s: any) => `- ${s.suite}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped – ${s.result}`), ...how].join("\n")}`);
  const def = new Set(defaultIssues(r));
  const findings = r.findings ?? [];
  if (findings.length) blocks.push(`**Findings (${findings.length})**`);
  for (const f of findings) {
    blocks.push([
      `**${f.n}.** ${f.classification === "product" ? SEV[f.severity] ?? f.severity : `ℹ️ ${f.classification}`} · ${f.title}${f.classification === "product" ? ` · confidence ${f.confidence}` : ""}`,
      f.duplicateOf ? `→ Already reported: #${f.duplicateOf.number} ${f.duplicateOf.title}` : f.classification === "product" ? (def.has(f.n) ? "→ Issue draft (created when you approve)" : "→ Low confidence – an issue only if you pick it") : "→ Not a product bug – listed in the report only",
      f.expected ? `Expected: ${truncate(f.expected, 200)}` : "",
      f.actual ? `Actual: ${truncate(f.actual, 200)}` : "",
    ].filter(Boolean).join("\n"));
  }
  if ((r.gaps ?? []).length) blocks.push(`**Not tested**\n${r.gaps.map((g: string) => `- ${g}`).join("\n")}`);
  blocks.push(`After you approve: ${def.size ? `issue${def.size > 1 ? "s" : ""} ${[...def].join(", ")} ${def.size > 1 ? "are" : "is"} created on GitHub, and ` : ""}one QA report comment is posted on the PR.`);
  blocks.push(`💰 ${costText(t)}`);
  return blocks.join("\n\n");
}

export const QA_EDIT = /^(create|report only|no issues|none)\b/i;

/** "create 1, 3", "create all", "report only" – a reply to a waiting QA result. */
export function qaCommand(t: Task, text: string): { approve: true } | { reply: string } | undefined {
  const r = t.data.qaResult;
  if (!r) return undefined;
  const s = text.trim();
  if (/^(report only|no issues|none)\b/i.test(s)) { mergeData(t.id, { qaSelection: [] }); return { approve: true }; }
  const m = /^create\b\s*(.*)$/i.exec(s);
  if (!m) return undefined;
  const rest = m[1].trim();
  const product = (r.findings ?? []).filter((f: any) => f.classification === "product" && !f.duplicateOf).map((f: any) => f.n);
  if (!rest || /^(all|them|everything)\b/i.test(rest)) { mergeData(t.id, { qaSelection: product }); return { approve: true }; }
  const nums = [...new Set((rest.match(/\d+/g) ?? []).map(Number))];
  const bad = nums.filter((n) => !product.includes(n));
  if (!nums.length || bad.length) return { reply: `For ${t.source_ref} the bugs that can become issues are ${product.join(", ") || "(none)"}. Reply e.g. "create ${product[0] ?? 1}", "create all" or "report only".` };
  mergeData(t.id, { qaSelection: nums });
  return { approve: true };
}
