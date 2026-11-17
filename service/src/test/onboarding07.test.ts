import { testHome } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveSettings, loadSettings, DEFAULT_SETTINGS, type ProjectConfig } from "../core/config.js";
import { setMeta } from "../core/db.js";
import {
  pythonDocStyle, pythonDefs, detectPythonDocstrings, detectJsDocstrings, isTestFile, detectTestLayout, classifyFile, NEVER_PUSH, docstringLine,
} from "../brain/standards.js";
import { parseWorkflow, kindsOf, jobForCheck, ciSummaryLines, detectCiPipeline, type CiPipeline } from "../brain/ciPipeline.js";
import { renderRulesCard, teamRules } from "../brain/rulesCard.js";
import { parseCodeowners, ownersFor, codeownersMatch, reviewersFor, readCodeowners } from "../core/team.js";
import { findTickets, ticketsForPrompt, words, type IndexedTicket } from "../intake/ticketIndex.js";
import { readyText, globalReady, type ReadyReport } from "../engine/ready.js";

/** Unit tests for the 0.7.0 onboarding parts (IMPLEMENTATION-PLAN Phase 0). No network, no real model. */

saveSettings({ ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off" } });

function tempDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiw-onb07-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function project(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "payments", github: { repo: "acme/payments", baseBranch: "main" }, local: { path: tempDir() }, roles: ["developer"], autonomy: "prepare" as any,
    budget: { perTaskTokens: { S: 1, M: 1, L: 1 }, dailyTokens: 1 }, ...over,
  };
}

test("helpers isolate state in a temp home", () => {
  assert.ok(testHome.startsWith(os.tmpdir()) || testHome.includes("aiw-test-"));
});

// ------------------------------------------------------------------ standards: docstrings

const GOOGLE_PY = `import os

def charge(amount, currency):
    """Charge a card.

    Args:
        amount: amount in cents.
        currency: ISO code.

    Returns:
        The charge id.
    """
    return 1


class Refund:
    """A refund."""


def undocumented(x):
    return x


def _private():
    """Never counted."""
`;

const NUMPY_DOC = `Sum two numbers.

Parameters
----------
a : int
b : int

Returns
-------
int
`;

test("python docstring style: google, numpy, reST and plain", () => {
  assert.equal(pythonDocStyle("Do it.\n\nArgs:\n    x: thing\n\nReturns:\n    y\n"), "google");
  assert.equal(pythonDocStyle(NUMPY_DOC), "numpy");
  assert.equal(pythonDocStyle("Do it.\n\n:param x: thing\n:returns: y\n"), "rest");
  assert.equal(pythonDocStyle("Just one line."), "plain");
});

test("python defs: public only, docstrings read across lines", () => {
  const defs = pythonDefs(GOOGLE_PY);
  assert.deepEqual(defs.map((d) => d.name), ["charge", "Refund", "undocumented"]);
  assert.match(defs[0].doc!, /Args:/);
  assert.equal(defs[1].doc, "A refund.");
  assert.equal(defs[2].doc, undefined);
});

test("python repository: dominant structured style, coverage and a real example", () => {
  const repo = tempDir({ "app/billing.py": GOOGLE_PY, "tests/test_billing.py": "def test_x():\n    assert True\n", "app/__init__.py": "" });
  const r = detectPythonDocstrings(repo, ["app/billing.py", "tests/test_billing.py", "app/__init__.py"])!;
  assert.equal(r.language, "python");
  assert.equal(r.style, "google");
  assert.equal(r.sampled, 3);                         // test files and __init__.py are not sampled
  assert.equal(r.coverage, 0.67);
  assert.equal(r.exampleFile, "app/billing.py");
  assert.match(r.example!, /def charge/);
  assert.match(docstringLine(r), /^Python: Google style/);
  assert.equal(detectPythonDocstrings(repo, ["README.md"]), undefined);
});

test("JS/TS repository: JSDoc blocks with tags are detected", () => {
  const src = `/**
 * Refund a payment.
 * @param id the payment id
 * @returns the refund
 */
export async function refund(id: string) { return id; }

export const other = 1;
`;
  const repo = tempDir({ "src/refund.ts": src, "src/refund.test.ts": "export function t() {}\n" });
  const r = detectJsDocstrings(repo, ["src/refund.ts", "src/refund.test.ts"])!;
  assert.equal(r.style, "jsdoc");
  assert.equal(r.coverage, 0.5);
  assert.equal(r.sampled, 2);
  assert.equal(r.tagged, true);
  assert.match(r.example!, /@param id/);

  const bare = tempDir({ "src/a.ts": "export function a() {}\nexport function b() {}\nexport function c() {}\n" });
  const n = detectJsDocstrings(bare, ["src/a.ts"])!;
  assert.equal(n.style, "none");
  assert.equal(n.example, undefined);
  assert.match(docstringLine(n), /rarely writes doc comments/);
});

// ------------------------------------------------------------------ standards: tests and pushable files

test("isTestFile knows the usual test names and folders", () => {
  for (const f of ["tests/test_x.py", "app/x_test.py", "src/a.test.ts", "src/b.spec.tsx", "app/__tests__/x.tsx", "pkg/foo_test.go", "src/FooTest.java", "conftest.py"])
    assert.equal(isTestFile(f), true, f);
  for (const f of ["src/app.ts", "app/services/refund.py", "testing.md", "contest.py"]) assert.equal(isTestFile(f), false, f);
});

test("test layout: folders and name patterns, most used first", () => {
  const t = detectTestLayout(["tests/unit/test_a.py", "tests/test_b.py", "tests/conftest.py", "app/x.py", "app/y_test.py"]);
  assert.deepEqual(t.dirs, ["tests/", "app/"]);
  assert.deepEqual(t.patterns, ["test_*.py", "*_test.py"]);
  assert.equal(t.count, 3);                            // conftest.py is not a test
  const js = detectTestLayout(["src/a.test.ts", "src/b.test.ts", "src/c.spec.ts"]);
  assert.deepEqual(js.patterns, ["*.test.ts", "*.spec.ts"]);
});

test("test layout: tests spread next to the source are summarised", () => {
  const files = Array.from({ length: 8 }, (_, i) => `src/area${i}/thing.test.ts`);
  const t = detectTestLayout(files);
  assert.deepEqual(t.dirs, ["(next to the source file)"]);
  assert.equal(t.count, 8);
  assert.equal(detectTestLayout(["src/app.ts"]).count, 0);
});

test("classifyFile: existing files always kept", () => {
  assert.deepEqual(classifyFile(".env", undefined, true), { kind: "source", why: "existing file" });
});

test("classifyFile: NEVER_PUSH catches scratch, logs, local config and reports", () => {
  for (const f of [".env", "app/.env.local", "server.log", "debug_refund.py", "scratch/try.py", "notes.ipynb", "coverage/index.html",
    "htmlcov/x.html", "coverage.xml", ".DS_Store", ".vscode/settings.json", ".ai-workforce/plan.md", "screenshot.png", "check_db.py"]) {
    const v = classifyFile(f, undefined, false);
    assert.equal(v.kind, "junk", f);
    assert.ok(NEVER_PUSH.some((n) => n.why === v.why), `${f}: ${v.why}`);
  }
});

test("classifyFile: images allowed in the app's asset folders", () => {
  assert.equal(classifyFile("src/assets/icon.png", undefined, false, ["src/assets/"]).kind, "source");
  assert.equal(classifyFile("docs/shot.png", undefined, false, ["src/assets/"]).kind, "junk");
});

test("classifyFile: tests only inside the team's layout and naming", () => {
  const layout = { dirs: ["tests/"], patterns: ["test_*.py"], count: 4 };
  assert.equal(classifyFile("tests/test_refund.py", layout, false).kind, "test");
  assert.equal(classifyFile("tests/billing/test_refund.py", layout, false).kind, "test");
  const outside = classifyFile("app/test_refund.py", layout, false);
  assert.equal(outside.kind, "junk");
  assert.match(outside.why, /outside the team's test layout/);
  assert.equal(classifyFile("tests/refund_test.py", layout, false).kind, "junk");          // wrong name pattern
  assert.equal(classifyFile("tests/test_x.py", undefined, false).kind, "test");            // no layout yet
  assert.equal(classifyFile("src/a.test.ts", { dirs: ["(next to the source file)"], patterns: ["*.test.ts"], count: 9 }, false).kind, "test");
  assert.equal(classifyFile("src/services/refund.ts", layout, false).kind, "source");
});

// ------------------------------------------------------------------ CI pipeline

const CI_YML = `name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  lint:
    name: Lint & Format
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install ruff
      - run: ruff check .
  tests:
    name: Tests & Coverage
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
    steps:
      - run: uv sync
      - run: |
          pytest --cov
          echo done
        env:
          DATABASE_URL: \${{ secrets.DB_URL }}
          TOKEN: \${{ secrets.GITHUB_TOKEN }}
  baseline:
    name: Replay baseline
    runs-on: ubuntu-latest
    steps:
      - run: python scripts/replay.py
        env:
          KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;

const DEPLOY_YML = `name: Deploy
on:
  push:
    branches: [main]
jobs:
  ship:
    steps:
      - run: vercel deploy --prod
`;

test("kindsOf: commands are sorted into kinds", () => {
  assert.ok(kindsOf("ruff check .").includes("lint"));
  assert.ok(kindsOf("npx prettier --check .").includes("format"));
  assert.ok(kindsOf("mypy app").includes("types"));
  assert.ok(kindsOf("pytest -q").includes("test"));
  assert.ok(kindsOf("gitleaks detect").includes("security"));
  assert.ok(kindsOf("npm run build").includes("build"));
  assert.ok(kindsOf("vercel deploy").includes("deploy"));
  assert.ok(kindsOf("run llm judge eval").includes("eval"));
  assert.deepEqual(kindsOf("echo hello"), ["other"]);
});

test("parseWorkflow: jobs, commands, secrets (names only), services and who can fix", () => {
  const jobs = parseWorkflow(".github/workflows/ci.yml", CI_YML);
  assert.deepEqual(jobs.map((j) => j.job), ["lint", "tests", "baseline"]);
  const [lint, tests, baseline] = jobs;
  assert.equal(lint.workflow, "ci.yml");
  assert.equal(lint.workflowName, "CI");
  assert.equal(lint.name, "Lint & Format");
  assert.ok(lint.onPullRequest);
  assert.ok(lint.kinds.includes("lint") && lint.kinds.includes("format"));
  assert.equal(lint.fixable, "auto");
  assert.equal(lint.localCommand, "ruff check .");      // never the install step
  assert.deepEqual(lint.actions, ["actions/checkout@v4"]);

  assert.deepEqual(tests.kinds, ["test"]);
  assert.equal(tests.fixable, "careful");
  assert.deepEqual(tests.services, ["postgres"]);
  assert.deepEqual(tests.secrets, ["DB_URL"]);           // GITHUB_TOKEN is not listed
  assert.equal(tests.localCommand, "pytest --cov");      // first line of a multi-line run

  assert.ok(baseline.kinds.includes("baseline"));
  assert.equal(baseline.fixable, "human");
  assert.deepEqual(baseline.secrets, ["ANTHROPIC_API_KEY"]);
  assert.equal(baseline.localCommand, undefined);

  const deploy = parseWorkflow("deploy.yml", DEPLOY_YML);
  assert.equal(deploy[0].onPullRequest, false);
  assert.equal(deploy[0].fixable, "human");
  assert.deepEqual(parseWorkflow("bad.yml", "jobs: [unclosed"), []);
  assert.deepEqual(parseWorkflow("empty.yml", ""), []);
});

test("detectCiPipeline reads .github/workflows; none when missing", () => {
  const repo = tempDir({ ".github/workflows/ci.yml": CI_YML, ".github/workflows/deploy.yaml": DEPLOY_YML, ".github/workflows/notes.txt": "x" });
  const ci = detectCiPipeline(repo)!;
  assert.deepEqual(ci.files, ["ci.yml", "deploy.yaml"]);
  assert.equal(ci.jobs.length, 4);
  assert.equal(detectCiPipeline(tempDir()), undefined);
});

test("jobForCheck matches GitHub check names to jobs", () => {
  const ci: CiPipeline = { files: ["ci.yml"], jobs: parseWorkflow("ci.yml", CI_YML), detectedAt: "" };
  assert.equal(jobForCheck(ci, "Lint & Format")?.job, "lint");
  assert.equal(jobForCheck(ci, "CI / tests (3.12)")?.job, "tests");
  assert.equal(jobForCheck(ci, "CI / Tests & Coverage")?.job, "tests");
  assert.equal(jobForCheck(ci, "baseline")?.job, "baseline");
  assert.equal(jobForCheck(ci, "Something else entirely"), undefined);
  assert.equal(jobForCheck(undefined, "Lint & Format"), undefined);
});

test("ciSummaryLines: one line per PR check, push-only jobs left out", () => {
  assert.deepEqual(ciSummaryLines(undefined), ["CI: no GitHub Actions workflows found"]);
  const ci: CiPipeline = { files: [], jobs: [...parseWorkflow("ci.yml", CI_YML), ...parseWorkflow("deploy.yml", DEPLOY_YML)], detectedAt: "" };
  const lines = ciSummaryLines(ci);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^CI "Lint & Format" .*the plugin fixes it · local: `ruff check \.`/);
  assert.match(lines[1], /never weaken the check.*services: postgres.*secrets: DB_URL/);
  assert.match(lines[2], /needs a person.*secrets: ANTHROPIC_API_KEY/);
  assert.ok(!lines.some((l) => /ship/.test(l)));
});

// ------------------------------------------------------------------ rules card

test("renderRulesCard: git, style, tests, never-commit, CI and team rules", () => {
  const tests = { dirs: ["tests/"], patterns: ["test_*.py"], count: 12, example: "tests/test_refund.py" };
  const p = project({
    conventions: {
      baseBranch: "dev", baseBranchSource: "test", branchTemplate: "{type}/{key}/{slug}", branchTypes: { feature: "feat", bug: "fix" },
      commitTemplate: "{type}({scope}): {summary} {key}", commitTypes: ["feat", "fix"], instructionFiles: ["CLAUDE.md"],
      prTemplate: ".github/pull_request_template.md", checks: ["ruff check {py}"],
      standards: { docstrings: [{ language: "python", style: "google", coverage: 0.8, sampled: 10, example: 'def a():\n    """Do a."""', exampleFile: "app/a.py" }], tests },
      ci: { files: ["ci.yml"], jobs: parseWorkflow("ci.yml", CI_YML), detectedAt: "" },
      detectedAt: "", confirmed: true, overrides: {},
    },
  });
  const card = renderRulesCard(p, "- Use type hints everywhere.");
  assert.match(card, /^# Repository rules – payments \(acme\/payments\)/);
  assert.match(card, /Base branch: `dev`\. Pull requests go to `dev`;/);
  assert.ok(!/as drafts/.test(card));                    // normal PRs by default
  assert.match(card, /feature → feat, bug → fix/);
  assert.match(card, /fill in the team's template `\.github\/pull_request_template\.md`/);
  assert.match(card, /Never mention Claude, AI or any assistant/);
  assert.match(card, /Python: Google style/);
  assert.match(card, /Example from `app\/a\.py`/);
  assert.match(card, /`ruff check <files>`/);
  assert.match(card, /Tests live in `tests\/` and are named `test_\*\.py` \(12 test files/);
  assert.match(card, /## Never commit\n- local environment file; /);
  assert.match(card, /## CI on every pull request\n- CI "Lint & Format"/);
  assert.match(card, /Never weaken or delete a test/);
  assert.match(card, /## Team rules \(from the repository's own instruction files\)\n- Use type hints everywhere\.$/);
  assert.ok(card.length <= 7000);
});

test("renderRulesCard: drafts named when the setting is on; no CI section without workflows", () => {
  const s = loadSettings();
  saveSettings({ ...s, pr: { ...s.pr, draft: true } });
  try {
    const p = project({ conventions: { baseBranch: "main", baseBranchSource: "", branchTemplate: "{key}-{slug}", branchTypes: {}, commitTemplate: "{key}: {summary}",
      commitTypes: [], instructionFiles: [], checks: [], standards: { docstrings: [], tests: { dirs: [], patterns: [], count: 0 } }, detectedAt: "", confirmed: false, overrides: {} } });
    const card = renderRulesCard(p, "");
    assert.match(card, /as drafts/);
    assert.match(card, /no test suite yet/);
    assert.ok(!/## CI on every pull request/.test(card));
    assert.ok(!/## Team rules/.test(card));
  } finally { saveSettings(s); }
});

test("teamRules: short instruction files are used word for word, long ones cut without a model", async () => {
  const short = "Always run ruff before committing.\nNo print statements.";
  const repo = tempDir({ "CLAUDE.md": short, "CONTRIBUTING.md": "x".repeat(4000) });
  const base = project({ local: { path: repo } });
  const conv = (files: string[]) => ({ baseBranch: "main", baseBranchSource: "", branchTemplate: "", branchTypes: {}, commitTemplate: "", commitTypes: [],
    instructionFiles: files, checks: [], detectedAt: "", confirmed: false, overrides: {} });
  const v = await teamRules({ ...base, conventions: conv(["CLAUDE.md"]) }, { useAi: false });
  assert.equal(v.source, "verbatim");
  assert.equal(v.text, `### CLAUDE.md\n${short}`);
  assert.equal(v.tokens, 0);
  const long = await teamRules({ ...base, id: "payments-long", conventions: conv(["CLAUDE.md", "CONTRIBUTING.md"]) }, { useAi: false });
  assert.equal(long.source, "truncated");
  assert.ok(long.text.length <= 2600);
  assert.equal((await teamRules({ ...base, conventions: conv([]) })).source, "none");
});

// ------------------------------------------------------------------ team

const CODEOWNERS = `# owners
*                 @alice
/app/buyer/       @bob @acme/buyers
*.md              @carol   # docs
/docs/legal/      someone@example.com
nobody/
`;

test("parseCodeowners: comments, e-mail owners and empty rules dropped", () => {
  const rules = parseCodeowners(CODEOWNERS);
  assert.deepEqual(rules, [
    { pattern: "*", owners: ["alice"] },
    { pattern: "/app/buyer/", owners: ["bob", "acme/buyers"] },
    { pattern: "*.md", owners: ["carol"] },
  ]);
});

test("codeownersMatch: anchored folders, bare names at any depth, wildcards", () => {
  assert.equal(codeownersMatch("*", "x/y/z.ts"), true);
  assert.equal(codeownersMatch("/app/buyer/", "app/buyer/api/v1/routes.py"), true);
  assert.equal(codeownersMatch("/app/buyer/", "other/app/buyer/x.py"), false);
  assert.equal(codeownersMatch("*.md", "docs/guide.md"), true);
  assert.equal(codeownersMatch("*.md", "README.md"), true);
  assert.equal(codeownersMatch("*.md", "app/x.py"), false);
  assert.equal(codeownersMatch("src/*.ts", "src/a.ts"), true);
  assert.equal(codeownersMatch("src/*.ts", "src/deep/a.ts"), false);
});

test("ownersFor: the last matching rule wins per file", () => {
  const rules = parseCodeowners(CODEOWNERS);
  assert.deepEqual(ownersFor(rules, ["src/x.ts"]), ["alice"]);
  assert.deepEqual(ownersFor(rules, ["app/buyer/api.py"]), ["bob", "acme/buyers"]);
  assert.deepEqual(ownersFor(rules, ["app/buyer/README.md"]), ["carol"]);
  assert.deepEqual(ownersFor(rules, ["src/x.ts", "app/buyer/api.py"]), ["alice", "bob", "acme/buyers"]);
  assert.deepEqual(ownersFor([], ["src/x.ts"]), []);
});

test("reviewersFor: CODEOWNERS of the changed files, never the author, teams split out", () => {
  const repo = tempDir({ ".github/CODEOWNERS": CODEOWNERS });
  assert.equal(readCodeowners(repo).length, 3);
  const p = project({ local: { path: repo }, reviewers: { from: "codeowners", logins: [] } });
  assert.deepEqual(reviewersFor(p, ["app/buyer/api.py", "src/x.ts"], "BOB"), { users: ["alice"], teams: ["buyers"] });
  assert.deepEqual(reviewersFor(p, ["src/x.ts"], "alice"), { users: [], teams: [] });
});

test("reviewersFor: a fixed list, deduplicated; the saved 'me' is excluded when no author is given", () => {
  const s = loadSettings();
  saveSettings({ ...s, team: { ...s.team, me: { github: "dave" } } });
  try {
    const p = project({ reviewers: { from: "list", logins: ["@alice", "dave", "alice", "acme/qa"] } });
    assert.deepEqual(reviewersFor(p, []), { users: ["alice"], teams: ["qa"] });
    assert.deepEqual(reviewersFor(p, [], "erin"), { users: ["alice", "dave"], teams: ["qa"] });
    assert.deepEqual(reviewersFor(project(), ["x"]), { users: [], teams: [] });
  } finally { saveSettings(s); }
});

// ------------------------------------------------------------------ tickets by name

const TICKETS: IndexedTicket[] = [
  { key: "KAN-1", title: "Send invite email to new buyers", status: "To Do", mine: false, assignee: "Bob", updated: "2026-11-01T00:00:00Z" },
  { key: "KAN-2", title: "Fix login timeout", status: "In Progress", mine: true, updated: "2026-11-02T00:00:00Z" },
  { key: "KAN-3", title: "Invite email template copy", status: "To Do", mine: true, updated: "2026-10-01T00:00:00Z" },
  { key: "KAN-4", title: "Refund reports export", status: "To Do", mine: false, updated: "2026-11-03T00:00:00Z" },
];

test("words: filler words and bracketed keys are dropped", () => {
  assert.deepEqual(words("Please start the [KAN-9] invite email task"), ["invite", "email"]);
});

test("findTickets: by name words, mine wins ties, unrelated tickets left out", () => {
  const hits = findTickets("start the invite email task", 5, TICKETS);
  assert.deepEqual(hits.map((h) => h.key), ["KAN-3", "KAN-1"]);
  assert.ok(hits[0].score > hits[1].score);
  assert.deepEqual(findTickets("inviting emails", 5, TICKETS).map((h) => h.key).sort(), ["KAN-1", "KAN-3"]);   // light stemming
  assert.deepEqual(findTickets("the refund export", 5, TICKETS).map((h) => h.key), ["KAN-4"]);
  assert.deepEqual(findTickets("something unrelated", 5, TICKETS), []);
  assert.deepEqual(findTickets("invite email", 1, TICKETS).map((h) => h.key), ["KAN-3"]);
});

test("findTickets: an exact key comes first", () => {
  const hits = findTickets("can you do kan-2 please", 5, TICKETS);
  assert.equal(hits[0].key, "KAN-2");
  assert.equal(hits[0].score, 100);
  assert.deepEqual(findTickets("KAN-99", 5, TICKETS), []);
});

test("ticketsForPrompt: matches first, then my other open tickets", () => {
  setMeta("tickets.index", JSON.stringify(TICKETS));
  const text = ticketsForPrompt("refund export", 3);
  const lines = text.split("\n");
  assert.equal(lines[0], "- KAN-4: Refund reports export [To Do]");
  assert.ok(lines.includes("- KAN-2: Fix login timeout [In Progress, assigned to you]"));
  assert.equal(lines.length, 3);
  assert.match(ticketsForPrompt("invite email"), /KAN-1: Send invite email to new buyers \[To Do, Bob\]/);
});

// ------------------------------------------------------------------ ready check text

test("readyText: icons, fixes only for problems, per-project verdict and a total", () => {
  const reports: ReadyReport[] = [
    { project: "backend", ok: false, at: "", items: [
      { area: "GitHub", state: "fail", detail: "GitHub is not connected.", fix: "aiw connect github" },
      { area: "Tests", state: "ok", detail: "Test command: `pytest`.", fix: "never shown" },
    ] },
    { project: "frontend", ok: true, at: "", items: [{ area: "CI", state: "warn", detail: "No workflows.", fix: "add one" }] },
  ];
  const text = readyText(reports, [{ area: "Model", state: "ok", detail: "claude." }]);
  const parts = text.split("\n\n");
  assert.equal(parts[0], "Everything here\n  ✔ Model: claude.");
  assert.equal(parts[1], "backend – needs attention\n  ✘ GitHub: GitHub is not connected.\n      → aiw connect github\n  ✔ Tests: Test command: `pytest`.");
  assert.equal(parts[2], "frontend – ready\n  ! CI: No workflows.\n      → add one");
  assert.match(parts[3], /^1 thing\(s\) to fix – everything else works\./);
  assert.ok(!text.includes("never shown"));
  assert.equal(readyText([], [{ area: "Model", state: "ok", detail: "x" }]).split("\n\n").pop(), "All set.");
});

test("globalReady: mock model warned, preferences summarised (CI fixed without asking by default)", () => {
  const items = globalReady();
  const model = items.find((i) => i.area === "Model")!;
  assert.equal(model.state, "warn");
  assert.equal(model.fix, "aiw model --provider claude-login");
  const prefs = items.find((i) => i.area === "Preferences")!;
  assert.match(prefs.detail, /PRs: ready for review/);
  assert.match(prefs.detail, /CI failures: fixed without asking/);
  assert.equal(items.filter((i) => i.area === "Connectors").length, 2);
  assert.equal(items.find((i) => i.area === "Team")!.fix, "aiw team detect <project>");
});

// ------------------------------------------------------------------ preferences (aiw prefs)

test("aiw prefs: flags change the saved settings; bad values rejected", async () => {
  const { main } = await import("../cli/main.js");
  const log = console.log;
  const printed: string[] = [];
  console.log = (...a: any[]) => { printed.push(a.join(" ")); };
  try {
    assert.equal(await main(["prefs", "--draft-pr", "yes", "--auto-fix-ci", "no", "--plan-approval", "skip", "--pr-approval", "skip", "--parallel", "4"]), 0);
    let s = loadSettings();
    assert.equal(s.pr.draft, true);
    assert.equal(s.pr.autoFixCi, false);
    assert.equal(s.workflow.planApproval, "skip");
    assert.equal(s.workflow.prApproval, "skip");
    assert.equal(s.limits.maxParallel, 4);
    assert.match(printed.join("\n"), /ciFailures: fix shown first/);

    assert.equal(await main(["prefs", "--draft-pr", "no", "--auto-fix-ci", "yes", "--plan-approval", "ask", "--parallel", "99"]), 0);
    s = loadSettings();
    assert.equal(s.pr.draft, false);
    assert.equal(s.pr.autoFixCi, true);
    assert.equal(s.workflow.planApproval, "always");
    assert.equal(s.limits.maxParallel, 4);                 // out of range: unchanged
    assert.match(printed.join("\n"), /ciFailures: fixed and pushed without asking/);

    assert.equal(await main(["prefs", "--pr-approval", "maybe"]), 1);
  } finally { console.log = log; }
});
