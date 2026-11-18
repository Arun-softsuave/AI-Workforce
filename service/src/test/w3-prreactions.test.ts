import { makeRepo, sh, waitFor } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "../core/db.js";
import { saveSettings, loadSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, engineVersion, type Settings } from "../core/config.js";
import { paths } from "../core/paths.js";
import { clients } from "../connectors/registry.js";
import type { GitHubClient, CiCheck, ReviewThread } from "../connectors/github.js";
import type { JiraClient } from "../connectors/jira.js";
import { setRunner, MockRunner, type AgentRequest, type AgentResult, type Runner } from "../agents/runner.js";
import { setSenders } from "../notify/router.js";
import { setEngineRole, tick, decideAndApply } from "../engine/engine.js";
import { getTask, updateTask } from "../engine/tasks.js";
import { STEPS } from "../engine/steps.js";
import { pollCiWatches, answerJob, commentClass, fixedSummary, OUTSIDE_TICKET } from "../engine/prFix.js";
import { classifyCheck, fixCommandFor, looksFlaky } from "../engine/steps/ciClass.js";
import { conflictStats, isSimpleConflict, teamUpdateStyle } from "../engine/steps/rebase.js";
import { textDelta, summariseChange } from "../engine/steps/replan.js";
import { noticeFor } from "../engine/steps/notices.js";
import { resolvedCounts } from "../intake/prActivity.js";
import { AFTER_PR_STEPS } from "../engine/steps/index.js";
import { parseWorkflow } from "../brain/ciPipeline.js";
import { emit } from "../kernel/events.js";
import { REACTIONS, REACTED_EVENTS, reactionFor, routeEvents, settleTells, validateReactions, type RouteDeps } from "../kernel/reactions.js";
import { loadRecipes, validateWith } from "../kernel/recipes.js";
import { createItem, getItem, addEdge } from "../kernel/items.js";
import { rowToJob } from "../kernel/mailbox.js";
import { requestApproval, decide } from "../approvals/approvals.js";
import type { Item, Job, KernelEvent } from "../kernel/types.js";

/**
 * Wave 3 – after the PR (W9 CI classes, W10 comments, W13 rebase / re-plan, W14 close-out) on engine v2, plus the
 * two-plugin scenario (ORCHESTRATION-MERMAID §12) at the reaction layer: two settings profiles, one fake GitHub.
 */

// ---------------------------------------------------------------- a repository with a CI map and a PR branch
const { repo, origin } = makeRepo("shop");
process.env.AIW_GIT_PUSH_URL = origin;
fs.writeFileSync(path.join(repo, "fmt.cjs"), [
  "const fs = require('fs'); const f = 'src/app.ts'; const t = fs.readFileSync(f, 'utf8');",
  "if (process.argv.includes('--check')) process.exit(t.includes('// formatted') ? 0 : 1);",
  "if (!t.includes('// formatted')) fs.writeFileSync(f, t + '// formatted\\n');",
].join("\n"));
fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "node -e \"process.exit(0)\"", format: "node fmt.cjs", "format:check": "node fmt.cjs --check" } }, null, 2));
fs.mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
fs.writeFileSync(path.join(repo, ".github", "workflows", "ci.yml"), [
  "name: CI", "on: [pull_request]", "jobs:",
  "  lint:", "    name: Lint & Format", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm ci", "      - run: npm run format:check",
  "  tests:", "    name: Tests", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm test",
  "  replay:", "    name: Regression replay", "    runs-on: ubuntu-latest", "    steps:", "      - run: python scripts/run_regression.py replay",
].join("\n"));
sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "ci and formatter"); sh(repo, "push", "-q", "origin", "main");
sh(repo, "checkout", "-q", "-b", "feat/KAN-9/refund");
fs.writeFileSync(path.join(repo, "src", "services", "refund.ts"), "import { stripe } from './stripe';\nexport async function refund(paymentId: string, amount: number) {\n  return stripe.refunds.create({ payment_intent: paymentId, amount });\n}\n");
sh(repo, "commit", "-q", "-am", "KAN-9 refund amount"); sh(repo, "push", "-q", "origin", "feat/KAN-9/refund");
sh(repo, "checkout", "-q", "main");
const remoteHead = (branch: string) => sh(repo, "ls-remote", origin, `refs/heads/${branch}`).split(/\s+/)[0];
/** Commit on a branch of the "GitHub" remote as someone else (a throwaway clone). */
function pushAs(branch: string, file: string, text: string, msg: string): string {
  const tmp = fs.mkdtempSync(path.join(path.dirname(repo), "other-"));
  sh(tmp, "clone", "-q", origin, "c");
  const c = path.join(tmp, "c");
  sh(c, "config", "user.email", "eric@example.com"); sh(c, "config", "user.name", "Eric");
  sh(c, "checkout", "-q", branch);
  fs.mkdirSync(path.dirname(path.join(c, file)), { recursive: true });
  fs.writeFileSync(path.join(c, file), text);
  sh(c, "add", "-A"); sh(c, "commit", "-q", "-m", msg); sh(c, "push", "-q", "origin", branch);
  return remoteHead(branch);
}

// ---------------------------------------------------------------- one fake GitHub
interface FakePr { author: string; headRef: string; baseRef: string; title: string; state: string; merged: boolean }
const prs = new Map<number, FakePr>([[7, { author: "sneha", headRef: "feat/KAN-9/refund", baseRef: "main", title: "KAN-9: refund a part of a payment", state: "open", merged: false }]]);
const checks = new Map<string, CiCheck[]>();
const logs = new Map<string, string>();
let threads: ReviewThread[] = [];
const calls = { rerun: [] as string[], reviewers: [] as string[][], replies: [] as string[], prComments: [] as string[], retarget: [] as string[] };
const fakeGitHub: GitHubClient & Record<string, any> = {
  user: async () => ({ login: "sneha" }), repo: async () => ({ defaultBranch: "main", private: true }),
  findOpenPr: async () => undefined, createPr: async () => ({ number: 1, url: "x" }), updatePr: async () => ({ number: 1, url: "x" }),
  failedRuns: async () => [], failedJobLog: async () => "", gitAuthHeader: () => "AUTHORIZATION: basic dGVzdA==", recentPrBases: async () => [], prActivity: async () => [],
  prForReview: async (_r, n) => {
    const p = prs.get(n)!;
    return { number: n, title: p.title, body: "", url: `https://github.com/acme/shop/pull/${n}`, author: p.author, state: p.state, draft: false, merged: p.merged,
      headRef: p.headRef, headSha: remoteHead(p.headRef), baseRef: p.baseRef, baseSha: remoteHead(p.baseRef), files: [], checks: [], comments: [] };
  },
  prChecks: async (_r, sha) => checks.get(sha) ?? [],
  checkFailure: async (_r, c) => logs.get(c.name) ?? "",
  rerunJob: async (_r: string, jobId: number) => { calls.rerun.push(String(jobId)); return { ok: true }; },
  retargetPr: async (_r: string, n: number, base: string) => { calls.retarget.push(`${n}->${base}`); return { number: n, url: "x", base }; },
  reviewThreads: async () => threads,
  prConversation: async () => [],
  replyToReviewComment: async (_r, _n, id, body) => { calls.replies.push(`${id}:${body}`); return { url: "x" }; },
  commentOnPr: async (_r, _n, body) => { calls.prComments.push(body); return { url: "x" }; },
  requestReviewers: async (_r, _n, w) => { calls.reviewers.push(w.users); return { requested: w.users }; },
};
const jiraComments: string[] = [];
const fakeJira: JiraClient = { site: "https://acme.atlassian.net", myself: async () => ({ accountId: "me", displayName: "Me" }), search: async () => [],
  getIssue: async () => undefined, addComment: async (k, t) => { jiraComments.push(`${k}: ${t}`); } };
clients.github = () => fakeGitHub as GitHubClient;
clients.jira = () => fakeJira;

const sent: { kind: string; ref?: string; title: string; body: string }[] = [];
setSenders({ desktop: { send: async (n) => { sent.push({ kind: n.kind, ref: n.taskRef, title: n.title, body: n.body }); return undefined; } } });

class Counting implements Runner {
  mock: Runner = new MockRunner();
  calls: AgentRequest[] = [];
  async run(req: AgentRequest): Promise<AgentResult> { this.calls.push(req); return this.mock.run(req); }
  count(agent?: string) { return this.calls.filter((c) => !agent || c.agent.split(":")[0] === agent).length; }
}
const runner = new Counting();
setRunner(runner);

function settings(patch: (s: Settings) => void = () => {}): Settings {
  const s: Settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    profile: { name: "Sneha", workingHours: "00:00-23:59", roles: ["fullstack-developer"] },
    models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
    notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off", jiraComments: true },
    workflow: { ...DEFAULT_SETTINGS.workflow, qaAfterFix: false },
    team: { me: { github: "sneha" }, members: [{ name: "Eric", github: "eric" }] },
    engine: { version: "v2" },
  };
  patch(s);
  return s;
}
saveSettings(settings());
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" },
  local: { path: repo, testCommand: "node -e \"process.exit(0)\"" }, roles: ["fullstack-developer"], autonomy: "prepare" }));
setEngineRole("daemon");

/** A ticket item whose PR #num is open (built by this plugin), with its create_pr approval already given. */
function prItem(key: string, num: number, extra: Record<string, any> = {}): Item {
  const it = createItem({ projectId: "shop", source: "jira", sourceId: `id-${key}`, sourceRef: key, title: `Ticket ${key}`, kind: "assigned", state: "PR_OPEN", playbook: "dev-feature",
    data: { ticket: { key, title: `Ticket ${key}`, description: "Support can refund part of a payment." }, pr: { number: num, url: `https://github.com/acme/shop/pull/${num}`, repo: "acme/shop" },
      implementation: { summary: "built" }, ...extra } });
  const ap = requestApproval(it.id, "create_pr", {});
  decide(ap.id, "approved", "Sneha", "claude-code");
  return getItem(it.id)!;
}
const jobsOf = (itemId: string): Job[] => (db().prepare("SELECT * FROM jobs WHERE item_id=? ORDER BY created_at, rowid").all(itemId) as any[]).map(rowToJob);
const approvalsOf = (taskId: string) => (db().prepare("SELECT action, state, channel FROM approvals WHERE task_id=? ORDER BY requested_at").all(taskId) as any[]).map((a) => `${a.action}:${a.state}`);
async function settleJob(itemId: string, type: string, states = ["done", "failed", "cancelled", "waiting"]): Promise<Job> {
  return waitFor(() => { void tick(); const j = jobsOf(itemId).filter((x) => x.type === type).at(-1); return j && states.includes(j.state) ? j : undefined; }, 90_000, 100);
}
const titles = () => sent.map((s) => s.title);

let ticket: Item;

// ================================================================ pure parts

test("W9 classes: CI map → base / human / flaky / auto / agent; fix commands without AI", () => {
  const ci = { files: ["ci.yml"], detectedAt: "", jobs: parseWorkflow("ci.yml", fs.readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8")) };
  const c = (name: string, conclusion = "failure") => ({ name, conclusion });
  const scripts = { format: "node fmt.cjs", "format:check": "node fmt.cjs --check" };
  assert.equal(classifyCheck({ check: c("Lint & Format"), ci, scripts }).cls, "auto");
  assert.equal(classifyCheck({ check: c("Lint & Format"), ci, scripts }).fixCommand, "npm run format");
  assert.equal(classifyCheck({ check: c("Tests"), ci }).cls, "agent");
  const human = classifyCheck({ check: c("Regression replay"), ci });
  assert.equal(human.cls, "human");
  assert.match(human.needs!, /baseline/);
  assert.equal(classifyCheck({ check: c("Tests"), ci, failsOnBase: true, baseRef: "dev" }).cls, "base");
  // flaky: re-run once, red again → real
  assert.equal(classifyCheck({ check: c("Tests", "cancelled"), ci }).cls, "flaky");
  assert.equal(classifyCheck({ check: c("Tests"), log: "Error: The runner has received a shutdown signal", ci }).cls, "flaky");
  assert.equal(classifyCheck({ check: c("Tests", "cancelled"), ci, reruns: 1 }).cls, "agent");
  assert.ok(looksFlaky({ conclusion: "failure" }, "npm ERR! network ECONNRESET"));
  assert.ok(!looksFlaky({ conclusion: "failure" }, "AssertionError: expected 2 to equal 3"));
  // a missing secret is never "fixed" in code
  assert.equal(classifyCheck({ check: c("Tests"), log: "Error: Bad credentials", ci }).cls, "human");
  // fix commands of common tools
  assert.equal(fixCommandFor("ruff check ."), "ruff check --fix .");
  assert.equal(fixCommandFor("ruff format --check ."), "ruff format .");
  assert.equal(fixCommandFor("black --check src"), "black src");
  assert.equal(fixCommandFor("npx prettier --check ."), "npx prettier --write .");
  assert.equal(fixCommandFor("npx eslint src"), "npx eslint src --fix");
  assert.equal(fixCommandFor("gofmt -l ."), "gofmt -w .");
  assert.equal(fixCommandFor("npm run lint", { lint: "eslint .", "lint:fix": "eslint . --fix" }), "npm run lint:fix");
  assert.equal(fixCommandFor("npm run lint", { lint: "eslint ." }), undefined, "no safe fix command → the fix agent");
  assert.equal(fixCommandFor("mypy src"), undefined, "types are fixed by the agent");
});

test("W10 helpers: comment classes, G19 marker, one-line result", () => {
  assert.deepEqual(["fix", "auto", "answer", "disagree", "other_repo", "skip", "needs_decision"].map(commentClass), ["fix", "fix", "reply", "reply", "reply", "reply", "needs-you"]);
  assert.ok(OUTSIDE_TICKET.test("Outside the ticket: add CSV export"));
  const items: any[] = [{ n: 1, kind: "check", check: "Lint & Format", word: "format" }, { n: 2, kind: "check", check: "Tests", word: "tests" }, { n: 3, kind: "thread" }];
  assert.equal(fixedSummary(items, [{ n: 1, action: "auto" }, { n: 2, action: "fix" }], ["a.ts", "b.ts"]), "format and tests in 2 files");
  assert.equal(fixedSummary(items, [{ n: 1, action: "auto" }], ["a.ts"]), "format in 1 file");
  assert.equal(fixedSummary(items, [{ n: 3, action: "fix" }], []), undefined);
});

test("W13 helpers: conflict size, team style, change summaries", () => {
  const text = "a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\nb\n";
  assert.deepEqual(conflictStats(text), { hunks: 1, lines: 2 });
  assert.ok(isSimpleConflict([{ path: "src/a.ts", hunks: 1, lines: 2 }]));
  assert.ok(!isSimpleConflict([{ path: "package-lock.json", hunks: 1, lines: 2 }]), "lock files are never simple");
  assert.ok(!isSimpleConflict([1, 2, 3, 4].map((i) => ({ path: `f${i}.ts`, hunks: 1, lines: 2 }))), "more than 3 files is a real conflict");
  assert.ok(!isSimpleConflict([{ path: "a.ts", hunks: 2, lines: 80 }]));
  assert.equal(teamUpdateStyle({ conventions: undefined }), "merge", "default: a merge commit (never a force-push)");
  assert.equal(teamUpdateStyle({ conventions: { prUpdate: "rebase" } as any }), "rebase");
  assert.deepEqual(textDelta("Refund part of a payment.\nAmount ≤ payment.", "Refund part of a payment.\nAmount ≤ payment.\nSend an email."), ["+ Send an email."]);
  const ch = summariseChange({ id: "i", source_ref: "KAN-9", data: { ticket: { title: "A", description: "x" }, pendingTicket: { title: "A", description: "x\ny" } } }, []);
  assert.equal(ch.kind, "ticket");
  assert.deepEqual(ch.lines, ["+ y"]);
  const d = summariseChange({ id: "i", source_ref: "KAN-9", data: {} }, [{ type: "design_changed", payload: { frameName: "Chat / Reply chips", changes: ["padding 12 -> 16"] } }]);
  assert.equal(d.title, "Design of 'Chat / Reply chips' changed");
  assert.deepEqual(d.lines, ["Chat / Reply chips: padding 12 -> 16"]);
});

test("reactions: every event the producers emit has a row; every recipe step exists in STEPS", () => {
  for (const e of ["ci_failed", "ci_passed", "review_comment", "comment_added", "changes_requested", "pr_approved", "review_requested", "teammate_pr_opened",
    "new_commits", "pr_conflict", "pr_merged", "pr_closed", "mention", "design_changed", "ticket_changed", "connector_down", "connector_up"]) {
    assert.ok(REACTED_EVENTS.includes(e), `${e} has a reaction`);
  }
  assert.deepEqual(validateReactions(loadRecipes(true).keys()), []);
  for (const n of Object.keys(AFTER_PR_STEPS)) assert.equal(typeof STEPS[n], "function", `${n} reached STEPS`);
  assert.deepEqual(validateWith(loadRecipes(true), new Set(Object.keys(STEPS))), [], "every recipe (incl. ci_watch, close, rebase, replan) can run");
  for (const r of REACTIONS) assert.ok(r.note, `${r.on} has a note`);
  // close-out runs on the open item: no state change before the job (close_item moves it MERGED → DONE last)
  assert.equal(REACTIONS.find((r) => r.on === "pr_merged")!.setState, undefined);
});

// ================================================================ two plugins, one GitHub (ORCHESTRATION-MERMAID §12)

test("two plugins, one fake GitHub: each plugin reacts only as author or reviewer (K1–K5, G9–G11, H2, H3)", () => {
  const sneha = settings();
  const eric = settings((s) => { s.team.me = { github: "eric" }; s.profile.name = "Eric"; s.pr.autoReview = false; });
  // the same GitHub activity, seen by both plugins: Sneha's plugin owns the PR's item, Eric's has a light pr item owned by "sneha"
  const base = { id: "", type: "", idem_key: "", item_id: "i", project_id: "shop", source_ref: null, handled_by: null, received_at: "", processed_at: null };
  const mine = { id: "i", project_id: "shop", source: "jira", source_id: "x", source_ref: "KAN-45", title: "t", kind: "assigned", role: null, size: "M", playbook: "dev-feature",
    state: "PR_OPEN", priority: 3, step_index: 0, run_no: 1, tokens_used: 0, cost_usd: 0, worktree: null, branch: null, data: { pr: { number: 140, repo: "acme/shop" } }, error: null,
    created_at: "", updated_at: "", level: "ticket", parent_id: null, root_id: "i", areas: [], owner: "me", due: null } as Item;
  const theirs = { ...mine, source: "github", source_ref: "PR-140@shop", playbook: null, level: "pr", owner: "sneha", data: { prRef: { number: 140, repo: "acme/shop" } } } as Item;
  const github: { type: string; payload: Record<string, any>; item: boolean }[] = [
    { type: "teammate_pr_opened", payload: { author: "sneha", num: 140, key: "KAN-45", title: "Invites" }, item: false },
    { type: "review_requested", payload: { author: "sneha", num: 140, key: "KAN-45" }, item: false },
    { type: "review_comment", payload: { by: "eric", num: 140, body: "Check the limit" }, item: true },
    { type: "user_command", payload: { command: "resolve", by: "sneha" }, item: true },
    { type: "new_commits", payload: { by: "sneha", num: 140, resolved: 4, total: 4 }, item: true },
    { type: "ci_failed", payload: { round: 1, num: 140 }, item: true },
    { type: "pr_approved", payload: { by: "eric", num: 140 }, item: true },
    { type: "pr_merged", payload: { num: 140 }, item: true },
  ];
  const run = (s: Settings, item: Item, onlyAuthorEvents: boolean) => {
    const out: string[] = [];
    let n = 0;
    const events: KernelEvent[] = github
      .filter((g) => !(onlyAuthorEvents && ["teammate_pr_opened", "review_requested"].includes(g.type)))   // GitHub tells only others about these
      .filter((g) => !(g.type === "user_command" && s.team.me?.github !== g.payload.by))                    // orders only from the owner's own chat
      .map((g) => ({ ...base, id: `e${++n}`, idem_key: `k${n}`, type: g.type, payload: { ...g.payload }, item_id: g.item ? "i" : null }));
    const deps: RouteDeps = { pendingEvents: () => events, markHandled: () => {}, getItem: () => item,
      enqueue: (_i, r) => { out.push(`${r.job}`); return { job: { id: "j" } as Job, merged: false }; },
      tell: (ev, _it, r) => { const t = noticeFor(ev, ev.item_id ? item : undefined, s); out.push(`${r.recipe}${t ? `: ${t.title}` : ""}`); } };
    routeEvents(s, deps);
    return out;
  };
  const sp = run(sneha, mine, true);
  const ep = run(eric, theirs, false);
  // Sneha's plugin: summary of Eric's comment, her "resolve" fixes them, CI fixed, approval → ready to merge, merged → close-out
  assert.deepEqual(sp, [
    "notify: 💬 eric commented on PR #140 · KAN-45",
    "comment_fix",
    "ci_fix",
    "notify: ✅ PR #140 · KAN-45 approved by eric – ready to merge",
    "close",
  ]);
  // Eric's plugin: told about the PR and the review request, re-review offered after the fixes; never fixes or closes Sneha's work
  assert.deepEqual(ep.slice(0, 3), [
    "notify: 👀 sneha raised PR #140 · KAN-45",
    "notify: 👀 sneha asked you to review PR #140 · KAN-45",
    "notify: 🔁 sneha resolved 4 of 4 on PR #140 you reviewed · PR-140@shop",
  ]);
  assert.ok(!ep.includes("comment_fix") && !ep.includes("ci_fix"), `only the author's plugin pushes (${ep.join(" | ")})`);
  // with autoReview on, Eric's plugin reviews straight away
  assert.equal(reactionFor({ ...base, type: "review_requested", payload: { author: "sneha" } } as any, theirs, settings((s) => { s.pr.autoReview = true; s.team.me = { github: "eric" }; }))!.job, "review");
  const say = noticeFor({ ...base, type: "teammate_pr_opened", payload: { author: "sneha", num: 140, key: "KAN-45" } } as any, undefined, eric)!;
  assert.match(say.body, /say "review PR 140 shop"/);
});

test("reactions: K6 minor Jira change is information only; design before building → design note", () => {
  const s = settings();
  const it = (patch: Partial<Item> = {}) => ({ id: "i", state: "PR_OPEN", owner: "me", data: { pr: { number: 1 } }, ...patch }) as Item;
  const ev = (type: string, payload: Record<string, any> = {}) => ({ id: "e", type, idem_key: "k", item_id: "i", project_id: "shop", source_ref: null, payload, handled_by: null, received_at: "", processed_at: null }) as KernelEvent;
  assert.equal(reactionFor(ev("ticket_changed", { major: false }), it(), s)!.job, "none");
  assert.equal(reactionFor(ev("ticket_changed", { major: true }), it(), s)!.job, "replan");
  assert.equal(reactionFor(ev("design_changed"), it({ state: "RUNNING", data: {} }), s)!.recipe, "design_note");
  assert.equal(reactionFor(ev("design_changed"), it(), s)!.job, "replan");
  assert.equal(reactionFor(ev("mention", { author: "eric" }), undefined, s)!.recipe, "notify");
  assert.equal(reactionFor(ev("user_command", { command: "adapt" }), it(), s)!.job, "comment_fix");
  assert.equal(reactionFor(ev("user_command", { command: "fix_ci" }), it(), s)!.job, "ci_fix");
  assert.equal(reactionFor(ev("pr_reopened"), it({ state: "CLOSED" }), s)!.setState, "PR_OPEN");
  // intake/github.ts puts the COMMENTER in payload.author on talk events: still our PR, still a summary to us
  assert.equal(reactionFor(ev("review_comment", { author: "eric", text: "Check the limit" }), it(), s)!.recipe, "notify");
  assert.equal(reactionFor(ev("changes_requested", { author: "eric" }), it(), s)!.job, "comment_fix");
  assert.match(noticeFor(ev("review_comment", { author: "eric", text: "Check the limit", num: 7 }), it({ source_ref: "KAN-9" } as any), s)!.title, /^💬 eric commented on PR #7 · KAN-9$/);
  // ...but on CI events author is the PR's author (a teammate's PR is not ours to fix)
  assert.equal(reactionFor(ev("ci_failed", { author: "eric" }), it(), s), undefined);
});

test("K3: 'resolved 4 of 4' counts only the reviewer's own threads", () => {
  const th = (id: string, authors: string[], resolved = false) => ({ id, resolved, outdated: false, path: "a.ts", line: 1, comments: authors.map((a, i) => ({ id: i, author: a, body: "x", at: "", url: "" })) });
  assert.deepEqual(resolvedCounts([th("1", ["eric", "sneha"]), th("2", ["eric"], true), th("3", ["eric"]), th("4", ["priya", "sneha"])], "eric"), { resolved: 2, total: 3 });
  assert.deepEqual(resolvedCounts([], "eric"), { resolved: 0, total: 0 });
});

// ================================================================ engine v2, end to end

test("setup: engine v2", async () => {
  assert.equal(engineVersion(), "v2");
  ticket = prItem("KAN-9", 7);
  // the ticket's own build folder must survive every job on its PR
  const wt = path.join(paths.worktrees(), "shop", ticket.id);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, "MARKER"), "build folder");
  updateTask(ticket.id, { worktree: wt });
  ticket = getItem(ticket.id)!;
  // the first kernel pass migrates once (and ignores the backlog): run it before any event of this file
  await tick();
});

test("G2: a lint/format failure is fixed by the project's own command (no AI), pushed without asking, ONE result message when CI is green", async () => {
  const head0 = remoteHead("feat/KAN-9/refund");
  checks.set(head0, [{ id: "1", name: "Lint & Format", state: "failed", conclusion: "failure", url: "x" }, { id: "2", name: "Tests", state: "passed", conclusion: "success", url: "x" }]);
  const before = runner.count();
  const sentBefore = sent.length;
  emit({ type: "ci_failed", idemKey: "w3:ci:1", itemId: ticket.id, payload: { ours: true, round: 1, repo: "acme/shop", num: 7, sha: head0 } });
  const job = await settleJob(ticket.id, "ci_fix");
  assert.equal(job.state, "done", job.error ?? "");
  assert.equal(runner.count() - before, 0, "no model call for a lint/format fix");
  const head1 = remoteHead("feat/KAN-9/refund");
  assert.notEqual(head1, head0, "pushed");
  assert.equal(sh(repo, "merge-base", "--is-ancestor", head0, head1), "", "a normal push on top (never forced)");
  assert.match(sh(repo, "show", `${head1}:src/app.ts`), /\/\/ formatted/);
  // job-scoped approval: the fix's own push_fixes (by policy) – the ticket's create_pr approval is untouched
  assert.deepEqual(approvalsOf(ticket.id), ["create_pr:approved", "push_fixes:approved"]);
  assert.equal((db().prepare("SELECT channel FROM approvals WHERE task_id=? AND action='push_fixes'").get(ticket.id) as any).channel, "policy");
  assert.equal(getTask(ticket.id)!.state, "PR_OPEN");
  assert.ok(fs.existsSync(path.join(ticket.worktree!, "MARKER")), "the ticket's build folder was not replaced");
  assert.equal(getTask(ticket.id)!.data.fixItems, undefined, "the fix context stayed on the job, not the ticket");
  assert.ok(!sent.slice(sentBefore).some((m) => /Fixes pushed/.test(m.title)), "no 'pushed' message – the result comes after CI");
  // CI is watched by a real ci_watch job; green → one message
  const watch = jobsOf(ticket.id).find((j) => j.type === "ci_watch" && j.state === "waiting");
  assert.ok(watch, "ci_watch job waiting");
  assert.equal(watch!.data.ctx.ciwatch.round, 2);
  checks.set(head1, [{ id: "3", name: "Lint & Format", state: "pending", conclusion: "", url: "x" }]);
  await pollCiWatches();
  assert.equal(jobsOf(ticket.id).find((j) => j.id === watch!.id)!.state, "waiting", "still running: no step run, keep waiting");
  checks.set(head1, [{ id: "3", name: "Lint & Format", state: "passed", conclusion: "success", url: "x" }, { id: "4", name: "Tests", state: "passed", conclusion: "success", url: "x" }]);
  await pollCiWatches();
  assert.equal(jobsOf(ticket.id).find((j) => j.id === watch!.id)!.state, "done");
  const mine = sent.slice(sentBefore).filter((m) => m.ref === "KAN-9");
  assert.deepEqual(mine.map((m) => m.title), ["✅ CI green on PR #7 – fixed format in 1 file."]);
});

test("G4 + G6: a runner problem is re-run once; a baseline check is never faked – one short message, nothing pushed", async () => {
  const head = remoteHead("feat/KAN-9/refund");
  checks.set(head, [{ id: "5", name: "Tests", state: "failed", conclusion: "cancelled", url: "x", jobId: 55 }, { id: "6", name: "Regression replay", state: "failed", conclusion: "failure", url: "x", jobId: 66 }]);
  logs.set("Tests", "Error: The operation was canceled.");
  emit({ type: "ci_failed", idemKey: "w3:ci:2", itemId: ticket.id, payload: { ours: true, round: 2, repo: "acme/shop", num: 7, sha: head } });
  const job = await settleJob(ticket.id, "ci_fix");
  assert.equal(job.state, "done", job.error ?? "");
  assert.deepEqual(calls.rerun, ["55"], "only the runner problem is re-run, once");
  assert.equal(remoteHead("feat/KAN-9/refund"), head, "nothing pushed");
  const msg = sent.find((m) => /CI on PR #7 needs a person/.test(m.title));
  assert.ok(msg);
  assert.match(msg!.body, /Regression replay – the baseline must be re-recorded by a person/);
  assert.match(msg!.body, /Re-ran once \(runner problem\):\*\* Tests/);
  assert.ok(jobsOf(ticket.id).some((j) => j.type === "ci_watch" && j.state === "waiting"), "the re-run is watched");
});

test("G9–G11 on v2: comment fixes on a ticket's PR use the job's own context and approval; shown first; replies; review asked again", async () => {
  checks.clear();
  threads = [{ id: "T1", resolved: false, outdated: false, path: "src/services/refund.ts", line: 2,
    comments: [{ id: 501, author: "eric", body: "The amount is not checked.", at: "2026-11-13T10:00:00Z", url: "x" }] }];
  // the ticket's own build had feedback and answers – they must not leak into the fix
  db().prepare("UPDATE tasks SET data=json_set(data,'$.feedback',json('[\"old build feedback\"]')) WHERE id=?").run(ticket.id);
  const head0 = remoteHead("feat/KAN-9/refund");
  emit({ type: "changes_requested", idemKey: "w3:cr:1", itemId: ticket.id, payload: { ours: true, repo: "acme/shop", num: 7, author: "eric" } });
  const waiting = await settleJob(ticket.id, "comment_fix");
  assert.equal(waiting.state, "waiting", waiting.error ?? "");
  const ap = waiting.data.ctx.fixApprovalId;
  assert.ok(ap, "the approval id is kept on the job");
  assert.equal(waiting.data.approvalId, ap);
  assert.deepEqual(approvalsOf(ticket.id).slice(-1), ["push_fixes:pending"]);
  assert.equal(getTask(ticket.id)!.state, "PR_OPEN", "the item is not moved to AWAITING_APPROVAL");
  assert.deepEqual(waiting.data.ctx.feedback, [], "the ticket's build feedback did not leak in");
  const resolver = runner.calls.filter((c) => c.agent === "comment-resolver").at(-1)!;
  assert.doesNotMatch(resolver.prompt, /old build feedback/);
  assert.match(sent.find((m) => /Fixes for PR #7 ready/.test(m.title))?.body ?? "", /✅ fixed · `src\/services\/refund\.ts` line 2 · eric/);
  assert.equal(remoteHead("feat/KAN-9/refund"), head0, "nothing pushed before the OK");

  const r = await decideAndApply(ap, "approved", "Sneha", "claude-code");
  assert.equal(r.ok, true, r.message);
  const done = await settleJob(ticket.id, "comment_fix", ["done", "failed", "cancelled"]);
  assert.equal(done.state, "done", done.error ?? "");
  assert.notEqual(remoteHead("feat/KAN-9/refund"), head0);
  assert.match(calls.replies.at(-1)!, /^501:Done – changed as suggested\. \([0-9a-f]{7}\)$/);
  assert.deepEqual(calls.reviewers.at(-1), ["eric"], "review asked again from the commenter");
  const result = sent.find((m) => /Fixes pushed to PR #7/.test(m.title))!;
  assert.match(result.body, /Comments:\*\* 1 fixed, 0 answered/);
  assert.match(result.body, /Review asked again from:\*\* eric/);
  assert.deepEqual(approvalsOf(ticket.id).filter((a) => a.startsWith("create_pr")), ["create_pr:approved"]);
  assert.ok(fs.existsSync(path.join(ticket.worktree!, "MARKER")));
});

test("G19 + job questions: a request outside the ticket is asked, the answer reaches the waiting job, otherwise a new ticket is suggested", async () => {
  checks.clear();
  threads = [{ id: "T2", resolved: false, outdated: false, path: "src/app.ts", line: 1,
    comments: [{ id: 601, author: "eric", body: "Can you also add a CSV export of refunds?", at: "2026-11-14T10:00:00Z", url: "x" }] }];
  let asked = 0;
  runner.mock = new MockRunner({ "comment-resolver": () => { asked++; return { summary: "One request is new scope.", items: [{ n: 1, action: "needs_decision", reason: "", instruction: "", reply: "", otherRepo: "",
    question: "Outside the ticket: add a CSV export of refunds?", options: ["Do it in this PR", "Suggest a separate ticket"] }] }; } });
  saveSettings(settings((s) => { s.workflow.questionRounds = 1; }));
  const head0 = remoteHead("feat/KAN-9/refund");
  emit({ type: "user_command", idemKey: "w3:resolve:1", itemId: ticket.id, payload: { command: "resolve", by: "sneha" } });
  const waiting = await settleJob(ticket.id, "comment_fix");
  assert.equal(waiting.state, "waiting", waiting.error ?? "");
  assert.ok(waiting.data.questions?.length, "the question is kept on the job");
  assert.equal(getTask(ticket.id)!.state, "PR_OPEN");
  const a = await answerJob("KAN-9", "2", "Sneha");
  assert.equal(a?.ok, true, a?.message ?? "no waiting job");
  // replies leave the machine only through the gate: shown first, then posted after the OK
  const gate = await waitFor(() => { void tick(); const j = jobsOf(ticket.id).filter((x) => x.type === "comment_fix").at(-1)!; return j.state === "waiting" && j.data.ctx?.fixApprovalId && !j.data.questions ? j : (["done", "failed"].includes(j.state) ? j : undefined); }, 90_000, 100);
  assert.equal(gate.state, "waiting", gate.error ?? "");
  assert.match(sent.filter((m) => /Fixes for PR #7 ready/.test(m.title)).at(-1)!.body, /💬 answered/);
  assert.equal((await decideAndApply(gate.data.ctx.fixApprovalId, "approved", "Sneha", "claude-code")).ok, true);
  const done = await settleJob(ticket.id, "comment_fix", ["done", "failed", "cancelled"]);
  assert.equal(done.state, "done", done.error ?? "");
  assert.equal(asked, 2, "the step ran again with the answer");
  assert.match(done.data.ctx.clarifications[0].answer, /Suggest a separate ticket/);
  assert.equal(remoteHead("feat/KAN-9/refund"), head0, "no code change for out-of-scope work");
  assert.match(calls.replies.at(-1)!, /^601:Good point – this is outside this ticket, so I suggest a separate ticket for it\.$/);
  runner.mock = new MockRunner();
  saveSettings(settings());
});

test("G14: the PR fell behind main → main merged in (no force-push); a real conflict stops and tells, nothing pushed", async () => {
  threads = [];
  pushAs("main", "docs/notes.md", "notes\n", "docs on main");
  const head0 = remoteHead("feat/KAN-9/refund");
  emit({ type: "pr_conflict", idemKey: "w3:conflict:1", itemId: ticket.id, payload: { ours: true, repo: "acme/shop", num: 7 } });
  const job = await settleJob(ticket.id, "rebase");
  assert.equal(job.state, "done", job.error ?? "");
  const head1 = remoteHead("feat/KAN-9/refund");
  assert.notEqual(head1, head0);
  assert.equal(sh(repo, "merge-base", "--is-ancestor", head0, head1), "", "the old head is kept (no force-push)");
  assert.equal(sh(repo, "log", "-1", "--format=%P", head1).split(" ").length, 2, "a merge commit, the team's default");
  assert.ok(sent.some((m) => /PR #7 \(KAN-9\) updated/.test(m.title)));

  // a real conflict: four files changed on both sides
  sh(repo, "fetch", "-q", "origin");
  for (const side of ["main", "feat/KAN-9/refund"]) {
    const tmp = fs.mkdtempSync(path.join(path.dirname(repo), "cf-"));
    sh(tmp, "clone", "-q", origin, "c");
    const c = path.join(tmp, "c");
    sh(c, "config", "user.email", "x@example.com"); sh(c, "config", "user.name", "X");
    sh(c, "checkout", "-q", side);
    for (const f of ["a", "b", "c", "d"]) fs.writeFileSync(path.join(c, `${f}.txt`), `${side} ${f}\n`);
    sh(c, "add", "-A"); sh(c, "commit", "-q", "-m", `${side} files`); sh(c, "push", "-q", "origin", side);
  }
  const head2 = remoteHead("feat/KAN-9/refund");
  const before = runner.count("implementer");
  emit({ type: "pr_conflict", idemKey: "w3:conflict:2", itemId: ticket.id, payload: { ours: true, repo: "acme/shop", num: 7 } });
  await waitFor(() => { void tick(); const rb = jobsOf(ticket.id).filter((j) => j.type === "rebase"); return rb.length === 2 && rb.every((j) => ["done", "failed"].includes(j.state)) ? true : undefined; }, 90_000, 100);
  assert.equal(jobsOf(ticket.id).filter((j) => j.type === "rebase").at(-1)!.state, "done");
  assert.equal(remoteHead("feat/KAN-9/refund"), head2, "nothing pushed");
  assert.equal(runner.count("implementer"), before, "a real conflict is not given to the agent");
  const told = sent.find((m) => /PR #7 \(KAN-9\) conflicts with main/.test(m.title));
  assert.ok(told);
  assert.match(told!.body, /A real conflict \(4 files\)[\s\S]*Nothing was pushed/);
  assert.match(told!.body, /resolve the conflicts on PR 7 yourself/, "says how to give the OK for bigger conflicts");
  assert.equal(getTask(ticket.id)!.data.conflict?.state, "open", "\"is it resolved?\" knows it is still open");
  assert.deepEqual(getTask(ticket.id)!.data.conflict?.files, ["a.txt", "b.txt", "c.txt", "d.txt"]);
});

test("PR #131 case: on your order ('resolve them yourself') a bigger conflict is resolved, tested and shown before the push", async () => {
  const head0 = remoteHead("feat/KAN-9/refund");
  let resolved = 0;
  runner.mock = new MockRunner({ implementer: (req) => {
    for (const f of ["a", "b", "c", "d"]) fs.writeFileSync(path.join(req.cwd!, `${f}.txt`), `both sides ${f}\n`);
    resolved++;
    return { summary: "resolved", filesChanged: [], testsAdded: [], notes: "" };
  } });
  emit({ type: "user_command", idemKey: "w3:resolveall:1", itemId: ticket.id, payload: { command: "rebase", resolveAll: true, ours: true, by: "sneha" } });
  const waiting = await settleJob(ticket.id, "rebase");
  assert.equal(waiting.state, "waiting", waiting.error ?? "");
  assert.equal(resolved, 1, "the agent resolved the 4-file conflict on your order");
  assert.equal(remoteHead("feat/KAN-9/refund"), head0, "nothing pushed before your OK");
  const ask = sent.filter((m) => /PR #7: merged main in and resolved 4 conflicted files – push\?/.test(m.title)).at(-1);
  assert.ok(ask, "shown to you first");
  assert.match(ask!.body, /- a\.txt[\s\S]*Reply 1 to push/);
  assert.equal((await decideAndApply(waiting.data.ctx.rebaseApprovalId, "approved", "Sneha", "teams-personal")).ok, true);
  const done = await settleJob(ticket.id, "rebase", ["done", "failed", "cancelled"]);
  assert.equal(done.state, "done", done.error ?? "");
  const head1 = remoteHead("feat/KAN-9/refund");
  assert.notEqual(head1, head0);
  assert.equal(sh(repo, "merge-base", "--is-ancestor", head0, head1), "", "a normal push on top (no force-push)");
  assert.equal(getTask(ticket.id)!.data.conflict?.state, "resolved");
  runner.mock = new MockRunner();
});

test("a git hook that fails on the merge commit is reported as a hook (never as 'a conflict with 0 files'), never skipped", async () => {
  pushAs("main", "docs/hook.md", "hook\n", "docs for the hook test");
  const head0 = remoteHead("feat/KAN-9/refund");
  const hook = path.join(repo, ".git", "hooks", "pre-merge-commit");   // what git runs for a merge commit
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\necho 'check yaml...............................................................Failed'\nexit 1\n");   // git runs it only for merge commits
  fs.chmodSync(hook, 0o755);
  try {
    emit({ type: "pr_conflict", idemKey: "w3:conflict:hook", itemId: ticket.id, payload: { ours: true, repo: "acme/shop", num: 7 } });
    const job = await waitFor(() => { void tick(); const j = jobsOf(ticket.id).filter((x) => x.type === "rebase").at(-1); return j && j.data.events?.some((e: any) => e.payload?.num === 7 && e.type === "pr_conflict") && ["done", "failed"].includes(j.state) && j.created_at > "" ? j : undefined; }, 90_000, 100);
    assert.equal(job.state, "done", job.error ?? "");
    assert.equal(remoteHead("feat/KAN-9/refund"), head0, "nothing pushed");
    const told = sent.filter((m) => /git hook stopped the update from main/.test(m.title)).at(-1);
    assert.ok(told, "told as a hook problem");
    assert.match(told!.body, /no file conflicts, but your git hook failed on the merge commit: check yaml/);
    assert.match(told!.body, /the hook was not skipped/);
    assert.ok(!sent.some((m) => /A real conflict \(0 files\)/.test(m.body)));
  } finally { fs.rmSync(hook, { force: true }); }
});

test("PR #90/#95 case: a Conventional Commit hook accepts the merge commit (the team's message, not git's default) and the update is pushed", async () => {
  pushAs("main", "docs/cc.md", "conventional\n", "docs for the commit-msg test");
  const head0 = remoteHead("feat/KAN-9/refund");
  const hook = path.join(repo, ".git", "hooks", "commit-msg");   // git runs it for merge commits made with -m too
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\nif ! head -1 \"$1\" | grep -Eq '^(feat|fix|chore|docs|style|refactor|test|ci|build|perf)(\\(.+\\))?: '; then echo 'Conventional Commit......................................................Failed'; exit 1; fi\n");
  fs.chmodSync(hook, 0o755);
  const before = jobsOf(ticket.id).filter((x) => x.type === "rebase").length;
  try {
    emit({ type: "pr_conflict", idemKey: "w3:conflict:cc", itemId: ticket.id, payload: { ours: true, repo: "acme/shop", num: 7 } });
    const job = await waitFor(() => { void tick(); const j = jobsOf(ticket.id).filter((x) => x.type === "rebase")[before]; return j && ["done", "failed"].includes(j.state) ? j : undefined; }, 90_000, 100);
    assert.equal(job.state, "done", job.error ?? "");
    const head1 = remoteHead("feat/KAN-9/refund");
    assert.notEqual(head1, head0, "the merge was pushed (the hook accepted the message)");
    const subject = sh(origin, "log", "-1", "--format=%s", head1);
    assert.match(subject, /^chore(\(.+\))?: merge main into feat\/KAN-9\/refund/);
    assert.equal(sh(repo, "merge-base", "--is-ancestor", head0, head1), "", "a normal push on top (no force-push)");
  } finally { fs.rmSync(hook, { force: true }); }
});

test("G13: someone else pushed to our branch with nothing local here → nothing moved, nothing overwritten", async () => {
  const head = pushAs("feat/KAN-9/refund", "src/extra.ts", "export const x = 1;\n", "Eric's commit");
  emit({ type: "new_commits", idemKey: "w3:nc:1", itemId: ticket.id, payload: { by: "eric", repo: "acme/shop", num: 7 } });
  const job = await waitFor(() => { void tick(); const j = jobsOf(ticket.id).filter((x) => x.type === "rebase").at(-1); return j && j.data.events?.some((e: any) => e.type === "new_commits") && ["done", "failed"].includes(j.state) ? j : undefined; }, 60_000, 100);
  assert.equal(job.state, "done", job.error ?? "");
  assert.equal(remoteHead("feat/KAN-9/refund"), head, "their commit stays the head");
});

test("C7 / K6: ticket changed after the PR → 'adapt?' with the exact lines; a minor change is only noted", async () => {
  db().prepare("UPDATE tasks SET data=json_set(data,'$.pendingTicket',json(?)) WHERE id=?")
    .run(JSON.stringify({ key: "KAN-9", title: "Ticket KAN-9", description: "Support can refund part of a payment.\nSend the customer an email." }), ticket.id);
  emit({ type: "ticket_changed", idemKey: "w3:tc:1", itemId: ticket.id, payload: { key: "KAN-9", major: true } });
  const job = await settleJob(ticket.id, "replan", ["done", "failed", "cancelled"]);
  assert.equal(job.state, "done", job.error ?? "");
  const ask = sent.find((m) => /KAN-9 changed in Jira after PR #7\. Adapt\?/.test(m.title));
  assert.ok(ask, titles().join(" | "));
  assert.match(ask!.body, /\+ Send the customer an email\.[\s\S]*say "adapt KAN-9"/i);
  emit({ type: "ticket_changed", idemKey: "w3:tc:2", itemId: ticket.id, payload: { key: "KAN-9", major: false } });
  routeEvents(loadSettings());
  await settleTells();
  assert.ok(sent.some((m) => /KAN-9 changed in Jira – noted/.test(m.title)));
});

test("design changed before building → design document updated and re-planned (no job); after building → 'adapt?'", async () => {
  const early = createItem({ projectId: "shop", source: "jira", sourceId: "id-KAN-20", sourceRef: "KAN-20", title: "Chips", kind: "assigned", state: "PAUSED", playbook: "dev-feature", data: {} });
  emit({ type: "design_changed", idemKey: "w3:dc:1", itemId: early.id, payload: { frameName: "Chat / Reply chips", nodeId: "1:2", changes: ["padding 12 -> 16"], newVersion: "v2" } });
  routeEvents(loadSettings());
  await settleTells();
  assert.equal(getTask(early.id)!.data.ticketChange, "major", "the build re-plans with the new design");
  assert.ok(sent.some((m) => /Design of 'Chat \/ Reply chips' changed – re-planning with it/.test(m.title)));
  assert.equal(jobsOf(early.id).filter((j) => j.type === "replan").length, 0);
});

test("W14: merged → dependents unblocked, stacked PR re-targeted, Jira note, MERGED → DONE, one message", async () => {
  const dep = createItem({ projectId: "shop", source: "jira", sourceId: "id-KAN-10", sourceRef: "KAN-10", title: "After KAN-9", kind: "assigned", state: "AWAITING_START", data: {} });
  addEdge(dep.id, ticket.id, "depends_on");
  const stacked = prItem("KAN-11", 11);
  prs.set(11, { author: "sneha", headRef: "feat/KAN-11/x", baseRef: "feat/KAN-9/refund", title: "KAN-11", state: "closed", merged: false });   // its own rebase job then ends at once
  addEdge(stacked.id, ticket.id, "stacks_on");
  prs.get(7)!.merged = true; prs.get(7)!.state = "closed";
  emit({ type: "pr_merged", idemKey: "w3:merged:7", itemId: ticket.id, payload: { ours: true, repo: "acme/shop", num: 7 } });
  const job = await settleJob(ticket.id, "close", ["done", "failed", "cancelled"]);
  assert.equal(job.state, "done", job.error ?? "");
  assert.equal(getTask(ticket.id)!.state, "DONE");
  assert.deepEqual(calls.retarget, ["11->main"]);
  assert.ok((db().prepare("SELECT COUNT(*) AS n FROM events WHERE type='new_base' AND item_id=?").get(stacked.id) as any).n === 1, "the stacked PR brings the base in");
  assert.ok(jiraComments.some((c) => /^KAN-9: PR merged \(acme\/shop\)/.test(c)));
  const msg = sent.find((m) => m.title === "✅ KAN-9 merged – done")!;
  assert.match(msg.body, /Unblocked: KAN-10/);
  assert.match(msg.body, /Re-targeted to main: KAN-11 \(PR #11\)/);
  assert.ok(!fs.existsSync(ticket.worktree!), "the item's folder is cleaned up");
});

test("G18: closed without merge → item CLOSED and one 'drop or reopen?' question", async () => {
  const it = prItem("KAN-12", 12);
  prs.set(12, { author: "sneha", headRef: "feat/KAN-12", baseRef: "main", title: "KAN-12", state: "closed", merged: false });
  emit({ type: "pr_closed", idemKey: "w3:closed:12", itemId: it.id, payload: { ours: true, repo: "acme/shop", num: 12 } });
  routeEvents(loadSettings());
  await settleTells();
  assert.equal(getTask(it.id)!.state, "CLOSED");
  const q = sent.find((m) => /PR #12 for KAN-12 was closed without merging/.test(m.title));
  assert.ok(q);
  assert.match(q!.body, /Drop the work or reopen\?[\s\S]*cancel KAN-12/);
});
