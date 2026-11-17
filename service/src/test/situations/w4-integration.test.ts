import { makeRepo, sh, waitFor } from "../helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../core/db.js";
import { saveSettings, loadSettings, updateSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, getProject, engineVersion } from "../../core/config.js";
import { clients } from "../../connectors/registry.js";
import type { JiraClient } from "../../connectors/jira.js";
import type { GitHubClient } from "../../connectors/github.js";
import type { WorkItem } from "../../connectors/types.js";
import { setRunner, MockRunner, type AgentRequest } from "../../agents/runner.js";
import { AGENTS, effortFor } from "../../agents/catalog.js";
import { lookupToolNames, runLookup } from "../../agents/lookup.js";
import { setSenders } from "../../notify/router.js";
import { runTicket } from "../../intake/intake.js";
import { setEngineRole, tick } from "../../engine/engine.js";
import { STEPS, type StepCtx, type StepResult } from "../../engine/steps.js";
import { buildStepCtx, runWithAskDesk, answerScopeOf } from "../../engine/stepRun.js";
import { getTask, mergeData } from "../../engine/tasks.js";
import { codeNoteBlock } from "../../engine/prFix.js";
import { WAVE4_AGENTS } from "../../engine/steps/index.js";
import { CI_WATCH_STEPS } from "../../engine/steps/ci_watch.js";
import { readDoc } from "../../knowledge/designDoc.js";
import { readCodeNote } from "../../knowledge/codeNote.js";
import { recordAnswers } from "../../knowledge/askDesk.js";
import { CODE_READ_MAX_LINES } from "../../knowledge/broker.js";
import { weeklyTeamCheck } from "../../core/team.js";
import { toolStart, BATCH_WORDS } from "../../conductor/tools.js";

/**
 * Wave 4 integration: the hook-ins work together on a real ticket run (MockRunner, fake Jira / GitHub, a real git repo).
 * Covers W5a (design document written by plan, read by the later steps), W5 6a (goldfish readiness for size M only),
 * C1, C6, the knowledge broker on the builders only, the §9.1 cost rules (explicit effort, byte-stable prompts and
 * tools, capped tool outputs), the Phase 5 done-when checks (0 files re-read on an unchanged fix; a question answered
 * in the same epic is not asked again), G7 (CI pending > 3 h → told once), A9 (weekly team check) and B7 (a batch).
 */

delete process.env.ANTHROPIC_API_KEY;

let clock = 0;
const issue = (key: string, o: Partial<WorkItem> = {}): WorkItem => ({
  provider: "jira", id: `id-${key}`, key, projectKey: key.split("-")[0], title: `Partial refunds for ${key}`,
  description: "Allow customers to refund part of a payment. The refund amount must never exceed the original payment amount. Add tests for both cases.",
  status: "To Do", statusCategory: "new", assignee: "me", priority: "High", labels: [], url: `https://acme.atlassian.net/browse/${key}`,
  updated: new Date(Date.UTC(2026, 10, 10, 9, 0, clock++)).toISOString(), comments: [], ...o,
});
const issues: WorkItem[] = [issue("SHOP-1"), issue("SHOP-2"), issue("SHOP-3", { title: "Refund reasons" }), issue("SHOP-4", { title: "Refund history page" })];
const fakeJira: JiraClient = {
  site: "https://acme.atlassian.net",
  myself: async () => ({ accountId: "me", displayName: "Me" }),
  search: async () => issues,
  getIssue: async (k) => issues.find((i) => i.key === k),
  addComment: async () => {},
};
let ghChecks: any[] = [];
const fakeGitHub: GitHubClient = {
  user: async () => ({ login: "me" }),
  repo: async () => ({ defaultBranch: "main", private: true }),
  findOpenPr: async () => undefined,
  createPr: async (_r: string, p: any) => ({ number: 400, url: "https://github.com/acme/shop/pull/400", ...p }),
  updatePr: async (_r: string, n: number, p: any) => ({ number: n, url: "x", ...p }),
  failedRuns: async () => [], failedJobLog: async () => "",
  gitAuthHeader: () => "AUTHORIZATION: basic dGVzdA==",
  recentPrBases: async () => [], prActivity: async () => [],
  requestReviewers: async () => ({ requested: [] }),
  prForReview: async () => ({ merged: false, state: "open", headSha: "abc1234", url: "https://github.com/acme/shop/pull/7", headRef: "feat/SHOP-9" }),
  prChecks: async () => ghChecks,
} as any;

const { repo, origin } = makeRepo("shop");
process.env.AIW_GIT_PUSH_URL = origin;
clients.jira = () => fakeJira;
clients.github = () => fakeGitHub;
const sent: { kind: string; title: string; body: string }[] = [];
setSenders({ desktop: { send: async (n) => { sent.push({ kind: n.kind, title: n.title, body: n.body ?? "" }); return undefined; } } });
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Tester", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  limits: { ...DEFAULT_SETTINGS.limits, askBeforeStart: [], burstThreshold: 5 },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off" },
  workflow: { ...DEFAULT_SETTINGS.workflow, planApproval: "autonomy", ticketReport: false } as any,
});
upsertProject(normaliseProject({
  id: "shop", jira: { site: "acme.atlassian.net", keys: ["SHOP"] }, github: { repo: "acme/shop", baseBranch: "main" },
  local: { path: repo, testCommand: "node -e \"process.exit(0)\"" }, roles: ["backend-developer"], autonomy: "prepare",
}));
db().prepare("INSERT INTO connections (provider, account, status, meta, updated_at) VALUES ('jira','me','connected','{\"site\":\"acme.atlassian.net\",\"email\":\"me@x\"}', datetime())").run();
setEngineRole("daemon");

const runner = new MockRunner();
setRunner(runner);

async function settle(ref: string, states: string[]) {
  return waitFor(() => { void tick(); const t = getTask(ref); return t && states.includes(t.state) ? t : undefined; }, 90_000, 100);
}
const callsFor = (itemPrompt: RegExp) => runner.calls.filter((c) => itemPrompt.test(c.prompt));

// ================================================================ one ticket, end to end

test("W5a / C1 / C6: a clear M ticket – plan writes the design document, plan review, implementer and reviewers read it; goldfish readiness once; no design check tokens", async () => {
  const before = runner.calls.length;
  await runTicket("SHOP-1");
  const t = await settle("SHOP-1", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"]);
  assert.equal(t.state, "AWAITING_APPROVAL", t.error ?? "");
  assert.equal(t.size, "M");
  assert.equal(t.playbook, "dev-feature");
  const calls = runner.calls.slice(before);
  // C1: a clear ticket asks nothing
  assert.ok(!sent.some((m) => m.kind === "needs_info"), "no questions for a clear ticket");
  // W5a: the plan is in the design document, and the later steps start from it
  const doc = readDoc(t.id)!;
  assert.ok(doc, "the design document exists");
  assert.match(doc.sections["Approach"], /Implement the requested change/);
  assert.match(doc.sections["Acceptance criteria"], /Behaviour matches the ticket description/);
  for (const agent of ["plan-reviewer", "implementer"]) {
    const c = calls.find((x) => x.agent === agent);
    assert.ok(c, agent);
    assert.match(c!.prompt, /## Design document \(v\d+\) – the source of truth/, `${agent} reads the design document`);
    assert.match(c!.prompt, /<untrusted source="design-doc:/, `${agent}: the document is fenced as data`);
  }
  assert.ok(calls.filter((x) => x.agent.startsWith("reviewer:")).every((c) => /## Design document \(v\d+\)/.test(c.prompt)), "every reviewer reads it");
  // W5 6a: size M → readiness only (no critic)
  assert.equal(calls.filter((x) => x.agent === "goldfish-readiness").length, 1);
  assert.equal(calls.filter((x) => x.agent === "goldfish-critic").length, 0);
  assert.equal(calls.find((x) => x.agent === "goldfish-readiness")!.lookup, undefined, "the goldfish gets no lookup tools");
  // C6: no Figma frame → the design check is skipped with no model call
  assert.equal(calls.filter((x) => x.agent === "design-check").length, 0);
  assert.ok((db().prepare("SELECT 1 FROM steps WHERE task_id=? AND name='design_check'").get(t.id)), "design_check ran (and skipped itself)");
  // the knowledge broker is for the agents that understand and build; reviewers judge only what they are given
  for (const agent of ["analyst", "planner", "implementer", "explorer"]) assert.equal(calls.find((x) => x.agent === agent)?.lookup?.itemId, t.id, `${agent} gets the broker`);
  assert.ok(lookupToolNames(calls.find((x) => x.agent === "planner")!.lookup).some((n) => n.endsWith("__code_read")), "broker code_read offered");
  for (const c of calls.filter((x) => x.agent.startsWith("reviewer") || x.agent === "plan-reviewer")) assert.equal(c.lookup, undefined);
});

test("§9.1 cost rules: every agent call has an explicit effort; system prompt and tool list are byte-stable per agent", async () => {
  const before = runner.calls.length;
  await runTicket("SHOP-2");
  const t = await settle("SHOP-2", ["AWAITING_APPROVAL", "FAILED", "PAUSED", "NEEDS_INFO"]);
  assert.equal(t.state, "AWAITING_APPROVAL", t.error ?? "");
  // every call of both runs carries an effort
  for (const c of runner.calls) assert.ok(c.effort, `${c.agent} has an explicit effort`);
  // every agent the catalog knows (Wave 4 ones included) has an effort and a tier
  for (const name of Object.keys(AGENTS)) assert.ok(effortFor(name), `effort for ${name}`);
  for (const [name, def] of Object.entries(WAVE4_AGENTS)) {
    assert.ok(AGENTS[name], `${name} is registered in the catalog`);
    assert.ok(def.tier && def.effort && def.maxTurns, `${name}: tier, effort and turn cap`);
  }
  // the same agent on two tickets: the same system prompt bytes and the same tools in the same order (prompt cache)
  const first = (agent: string, from: number, to: number) => runner.calls.slice(from, to).find((c) => c.agent === agent)!;
  const one = runner.calls.findIndex((c) => /SHOP-1/.test(c.prompt));
  for (const agent of ["analyst", "planner", "plan-reviewer", "implementer", "reviewer:code", "goldfish-readiness"]) {
    const a = first(agent, one, before), b = first(agent, before, runner.calls.length);
    assert.ok(a && b, agent);
    assert.equal(a.system, b.system, `${agent}: byte-stable system prompt`);
    assert.deepEqual(a.tools ?? [], b.tools ?? [], `${agent}: same built-in tools`);
    assert.deepEqual(lookupToolNames(a.lookup ?? {}), lookupToolNames(b.lookup ?? {}), `${agent}: same lookup tools, same order`);
    assert.deepEqual(a.schema, b.schema, `${agent}: same schema`);
  }
});

test("§9.1 tool outputs stay under their caps: a 2000-line file reads as ≤ 300 lines; a long ticket lookup is cut at 12k", async () => {
  fs.writeFileSync(path.join(repo, "big.ts"), Array.from({ length: 2000 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
  const t = getTask("SHOP-1")!;
  const r = await runLookup("code_read", { path: "big.ts" }, { itemId: t.id, projectId: "shop", repos: { shop: repo } });
  assert.equal(r.isError, false, r.text);
  const numbered = r.text.split("\n").filter((l) => /^\d+\t/.test(l));
  assert.ok(numbered.length <= CODE_READ_MAX_LINES, `${numbered.length} lines`);
  assert.match(r.text, /1700 more lines; file has 2000/);
  const huge = issue("SHOP-99", { description: "x".repeat(50_000) });
  issues.push(huge);
  const j = await runLookup("jira_get_issue", { key: "SHOP-99" }, {});
  assert.ok(j.text.length < 12_000 + 600, `${j.text.length} chars`);
  fs.rmSync(path.join(repo, "big.ts"));
});

// ================================================================ Phase 5 done-when

test("Phase 5: a CI fix six days later with no code change re-reads 0 files (the code note is reused)", () => {
  const t = getTask("SHOP-1")!;
  const note = readCodeNote(t.id, "shop");
  assert.ok(note, "analyse wrote a code note");
  assert.ok(Object.keys(note!.files).includes("src/app.ts"));
  // the fix job's view of the same item (same folder, nothing changed since)
  const ctx = { task: { ...t, data: { ...t.data, ticket: { key: "SHOP-1" } } }, project: getProject("shop")! } as unknown as StepCtx;
  const b = codeNoteBlock(ctx);
  assert.equal(b.status, "unchanged");
  assert.match(b.reason ?? "", /code unchanged since/);
  assert.match(b.block, /has not changed since this note was written – rely on it; do not re-read these files/);
  // one changed file → only that one is re-read
  fs.appendFileSync(path.join(t.worktree!, "src", "app.ts"), "// changed later\n");
  const c = codeNoteBlock(ctx);
  assert.ok(c.status === "changed" || c.status === "full", c.reason ?? "");
  if (c.status === "changed") assert.match(c.block, /- src\/app\.ts/);
});

test("Phase 5 / O4: a question answered in the same epic is never asked again (decision log before need_info)", async () => {
  const now = new Date().toISOString();
  const ins = (id: string, ref: string, level: string, parent: string | null) => db().prepare("INSERT INTO tasks (id, project_id, source, source_ref, title, kind, state, level, parent_id, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "shop", "jira", ref, ref, level === "epic" ? "scope" : "assigned", "RUNNING", level, parent, "{}", now, now);
  ins("ep1", "SHOP-40", "epic", null);
  ins("ch1", "SHOP-41", "ticket", "ep1");
  ins("ch2", "SHOP-42", "ticket", "ep1");
  ins("lone", "SHOP-50", "ticket", null);
  const question = { question: "Should refunds over 1000 wait for a manager?", options: ["Yes, a manager approves", "No, refund at once"] };
  assert.equal(await answerScopeOf("ch1"), "epic");
  const rec = recordAnswers("ch1", [question], "1", await answerScopeOf("ch1"));
  assert.ok(rec.ok);
  let asks = 0;
  const step = async (ctx: StepCtx): Promise<StepResult> => {
    asks++;
    const known = (ctx.task.data.decided ?? []).find((d: any) => d.question === question.question);
    return known ? { status: "ok", note: `used: ${known.answer}` } : { status: "need_info", questions: [question] };
  };
  const ctxOf = (id: string) => buildStepCtx({ task: getTask(id)!, project: getProject("shop")!, settings: loadSettings(), runner });
  const r2 = await runWithAskDesk(step, ctxOf("ch2"));
  assert.equal(r2.status, "ok", "the sibling in the same epic is not asked");
  assert.match((r2 as any).note, /Yes, a manager approves/);
  assert.equal(asks, 2, "the step ran again with the earlier answer – no message to you");
  assert.match(getTask("ch2")!.data.decided?.[0]?.answer ?? "", /Yes, a manager approves/);
  // outside the epic the question still reaches you
  asks = 0;
  const r3 = await runWithAskDesk(step, ctxOf("lone"));
  assert.equal(r3.status, "need_info");
  assert.equal(asks, 1);
});

// ================================================================ G7, A9, B7

test("G7: CI still running after 3 h → told once; under 3 h it keeps waiting", async () => {
  const now = new Date().toISOString();
  db().prepare("INSERT INTO tasks (id, project_id, source, source_ref, title, kind, state, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("g7", "shop", "jira", "SHOP-9", "CI pending", "assigned", "PR_OPEN", "{}", now, now);
  ghChecks = [{ id: "1", name: "Tests", state: "pending", conclusion: "", url: "x" }];
  const ctxFor = (sinceMs: number) => {
    mergeData("g7", { ciwatch: { projectId: "shop", repo: "acme/shop", num: 7, sha: "abc1234", round: 1, since: new Date(Date.now() - sinceMs).toISOString() } });
    return buildStepCtx({ task: getTask("g7")!, project: getProject("shop")!, settings: loadSettings(), runner });
  };
  const early = await CI_WATCH_STEPS.ci_watch_check(ctxFor(3_600_000));
  assert.equal(early.status, "wait", "1 h: keep watching");
  const told = () => sent.filter((m) => /CI still red on PR #7/.test(m.title));
  assert.equal(told().length, 0);
  const late = await CI_WATCH_STEPS.ci_watch_check(ctxFor(4 * 3_600_000));
  assert.equal(late.status, "done");
  assert.equal(told().length, 1);
  assert.match(told()[0].body, /Tests \(still running after 3 h\)/);
  await CI_WATCH_STEPS.ci_watch_check(ctxFor(5 * 3_600_000));
  assert.equal(told().length, 1, "told once, not again for the same commit");
});

test("A9: the weekly team check names a newcomer and a quiet teammate in one message, once a week, and changes nothing", async () => {
  const { repo: teamRepo } = makeRepo("team-repo");
  sh(teamRepo, "config", "user.name", "New Dev");
  sh(teamRepo, "config", "user.email", "4242+newdev@users.noreply.github.com");
  for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(teamRepo, `f${i}.txt`), `${i}\n`); sh(teamRepo, "add", "-A"); sh(teamRepo, "commit", "-q", "-m", `change ${i}`); }
  updateSettings((s) => { s.team = { me: { github: "me" }, members: [{ github: "eric", name: "Eric" }] }; });
  const project = normaliseProject({ id: "team-repo", github: { repo: "acme/team-repo", baseBranch: "main" }, local: { path: teamRepo }, roles: ["backend-developer"] });
  const lines = await weeklyTeamCheck(new Date(2026, 10, 16, 9), [project]);
  assert.ok(lines.some((l) => /New on team-repo: @newdev \(New Dev\), 3 commits\. Say "add @newdev to the team"/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /Eric has no commits in 6 months\. Say "Eric left the team"/.test(l)));
  assert.equal(sent.filter((m) => m.title === "👥 Team changes").length, 1, "one message");
  assert.deepEqual(loadSettings().team.members.map((m) => m.github), ["eric"], "nothing changed without you");
  assert.deepEqual(await weeklyTeamCheck(new Date(2026, 10, 18, 9), [project]), [], "not again within the week");
});

test("B7: tickets asked for as one batch on engine v2 → one batch item and one acknowledgement; a plain list still starts each", async () => {
  assert.ok(BATCH_WORDS.test("do SHOP-3 and SHOP-4 together as a batch"));
  assert.ok(!BATCH_WORDS.test("please work on SHOP-3 and SHOP-4"));
  const prev = process.env.AIW_ENGINE;
  process.env.AIW_ENGINE = "v2";
  try {
    assert.equal(engineVersion(), "v2");
    const r = await toolStart({ refs: ["SHOP-3", "SHOP-4"] }, { who: "Tester", original: "do SHOP-3 and SHOP-4 together as a batch" });
    assert.match(r.reply, /Batch SHOP-3, SHOP-4: 2 tickets/);
    const batch = db().prepare("SELECT * FROM tasks WHERE kind='scope' AND level='batch' ORDER BY created_at DESC LIMIT 1").get() as any;
    assert.ok(batch, "one batch item");
    assert.equal((db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE source_ref IN ('SHOP-3','SHOP-4') AND kind<>'scope' AND (parent_id IS NULL OR parent_id<>?)").get(batch.id) as any).n, 0, "no separate tickets started beside the batch");
  } finally {
    if (prev === undefined) delete process.env.AIW_ENGINE; else process.env.AIW_ENGINE = prev;
  }
});

test("every recipe and playbook step exists in STEPS (Wave 4 steps merged)", async () => {
  for (const s of ["doc_readiness", "design_check", "preview_scope", "scope_plan", "spawn_children", "merge_order", "epic_check", "audit_find", "audit_review", "audit_report", "adopt_prepare", "adopt_design", "adopt_sync", "learn_from_reviews"]) {
    assert.equal(typeof STEPS[s], "function", s);
  }
});
