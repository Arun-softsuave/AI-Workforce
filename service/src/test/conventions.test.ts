import { makeRepo, sh } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, getProject } from "../core/config.js";
import { clients } from "../connectors/registry.js";
import { inferBranchTemplate, inferCommitTemplate, expandCheck, detectConventions, setConventionOverride, branchNameFor, commitMessageFor, rulesBlock, scopeFor } from "../brain/conventions.js";
import { setSenders, inbox } from "../notify/router.js";
import { createTask, mergeData } from "../engine/tasks.js";
import { pollPrActivity } from "../intake/prActivity.js";
import type { PrActivity } from "../connectors/github.js";

saveSettings({ ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off" } });
setSenders({ desktop: { send: async () => undefined } });

test("branch style is learned from the team's branch names", () => {
  const r = inferBranchTemplate(["feat/KAN-40/protect-buyer-edits", "fix/KAN-27/audit-refusals", "feat/FR-082/multi-role", "enhancement/check-email", "KAN-31/refresh-permissions"]);
  assert.equal(r.template, "{type}/{key}/{slug}");
  assert.equal(r.types.feature, "feat");
  assert.equal(r.types.bug, "fix");
  assert.equal(inferBranchTemplate(["PROJ-1-add-login", "PROJ-2-fix-x"].map((b) => `feature/${b}`)).template, "{type}/{key}-{slug}");
});

test("commit style is learned from the team's commit subjects", () => {
  assert.equal(inferCommitTemplate(["feat(auth): add email check", "fix(buyer): answer disabled KAN-30", "chore(security): allowlist fixture KAN-30", "Merge pull request #1"]).template,
    "{type}({scope}): {summary} {key}");
  assert.equal(inferCommitTemplate(["fix(KAN-31): keep the refused draft", "feat(KAN-40): edit facts", "feat(chat): initials"]).template, "{type}({key}): {summary}");
  assert.equal(inferCommitTemplate(["PAY-1: add refunds", "PAY-2: fix rounding"]).template, "{key}: {summary}");
});

test("commit messages and branch names are rendered in the team's style", () => {
  const c: any = { branchTemplate: "{type}/{key}/{slug}", branchTypes: { feature: "feat", bug: "fix" }, commitTemplate: "{type}({scope}): {summary} {key}", commitTypes: ["feat", "fix"] };
  assert.equal(branchNameFor(c, "KAN-42", "feature", "[FR-025] Input guard"), "feat/KAN-42/input-guard");
  assert.equal(branchNameFor(c, "KAN-9", "bug", "Crash on save"), "fix/KAN-9/crash-on-save");
  assert.equal(scopeFor(["app/components/buyer/services/x.py", "app/components/buyer/api/v1/routes.py", "tests/buyer/test_x.py"]), "buyer");
  assert.equal(commitMessageFor(c, "KAN-42", "feature", "Validate buyer input length.", ["app/components/buyer/services/guard.py"]), "feat(buyer): validate buyer input length KAN-42");
  // an agent's report is cut to its first sentence – never a dangling "I did…"
  assert.equal(commitMessageFor(c, "KAN-52", "bug", "Fixed the Lint & Format and Tests & Coverage failures by hand. I did not re-record the baseline.", ["app/components/ai_engine/x.py"]),
    "fix(ai_engine): fixed the Lint & Format and Tests & Coverage failures by hand KAN-52");
  const long = commitMessageFor(c, "KAN-52", "bug", "Apply ruff format to the three reflowed files and complete the golden test setup with the usage and budget facts and spec ratings", ["app/a.py"]);
  assert.doesNotMatch(long, /…|\b(and|the|with)\s+KAN-52$/);
  assert.ok(long.length <= 100, long);
});

test("checks are expanded to the changed files and skipped when nothing matches", () => {
  assert.equal(expandCheck("ruff check {py}", ["a.py", "b.ts"]), "ruff check a.py");
  assert.equal(expandCheck("npx eslint {js}", ["a.py"]), undefined);
  assert.equal(expandCheck("npm run lint", ["a.py"]), "npm run lint");
});

test("full detection on a repo with the team's workflow: dev base, rule files, PR template, checks; overrides win", async () => {
  const { repo, origin } = makeRepo("conv-backend");
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# Rules\nAlways use the response envelope. Never log secrets.\n");
  fs.mkdirSync(path.join(repo, ".github"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".github", "PULL_REQUEST_TEMPLATE.md"), "## What\n\n## Why\n\n## Checklist\n- [ ] Tests added\n");
  fs.writeFileSync(path.join(repo, "pyproject.toml"), "[tool.ruff]\nline-length = 100\n");
  sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "chore(repo): add rules KAN-1"); sh(repo, "push", "-q", "origin", "main");
  sh(repo, "checkout", "-q", "-b", "dev"); sh(repo, "push", "-q", "origin", "dev");
  for (const [b, msg] of [["feat/KAN-40/protect-edits", "feat(buyer): protect edits KAN-40"], ["fix/KAN-27/audit-refusals", "fix(auth): audit refusals KAN-27"], ["feat/KAN-30/website", "feat(buyer): website check KAN-30"]]) {
    sh(repo, "checkout", "-q", "-b", b, "dev");
    fs.writeFileSync(path.join(repo, `${b.replace(/\//g, "_")}.txt`), b);
    sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", msg); sh(repo, "push", "-q", "origin", b);
    sh(repo, "checkout", "-q", "dev"); sh(repo, "merge", "-q", "--no-ff", "-m", `Merge remote-tracking branch 'origin/dev' into ${b}`, b); sh(repo, "push", "-q", "origin", "dev");
  }
  sh(repo, "checkout", "-q", "main");
  void origin;
  upsertProject(normaliseProject({ id: "conv", jira: { site: "x", keys: ["KAN"] }, github: { repo: "acme/conv", baseBranch: "main" }, local: { path: repo }, roles: ["backend-developer"] }));
  clients.jira = () => ({ site: "x", myself: async () => ({ accountId: "me", displayName: "Me" }), getIssue: async () => undefined, addComment: async () => {},
    search: async () => ["[FR-025] Input guard", "[FR-003] Invite members", "[FR-087] Role isolation", "Demo reset scripts"].map((title, i) => ({ provider: "jira", id: `${i}`, key: `KAN-${i}`, projectKey: "KAN", title, description: "", status: "To Do", labels: ["M1", "Nue-V1"], issueType: "Task", url: "", updated: "" })) as any });
  clients.github = () => undefined;

  const c = await detectConventions("conv");
  assert.equal(c.baseBranch, "dev", c.baseBranchSource);
  assert.equal(getProject("conv")!.github!.baseBranch, "dev", "PRs and rebases use the detected base");
  assert.equal(c.branchTemplate, "{type}/{key}/{slug}");
  assert.equal(c.commitTemplate, "{type}({scope}): {summary} {key}");
  assert.deepEqual(c.instructionFiles, ["CLAUDE.md"]);
  assert.equal(c.prTemplate, ".github/PULL_REQUEST_TEMPLATE.md");
  // ruff is configured but not installed in this test repo -> no ruff check (a missing tool would fail every task)
  const { execFileSync } = await import("node:child_process");
  const ruffInstalled = (() => { try { execFileSync(process.platform === "win32" ? "where" : "which", ["ruff"], { stdio: "ignore" }); return true; } catch { return false; } })();
  assert.ok(ruffInstalled || !c.checks.some((x) => /ruff/.test(x)), `only runnable checks are kept: ${c.checks.join(", ")}`);
  assert.deepEqual(c.env?.linkedDirs, []);
  assert.equal(c.ticket?.titlePrefix, "[FR-NNN] ");
  assert.match(rulesBlock(getProject("conv")!), /Never log secrets/);

  // user override (e.g. "PRs go to staging") survives re-detection
  setConventionOverride("conv", { baseBranch: "staging" });
  const again = await detectConventions("conv");
  assert.equal(again.baseBranch, "staging");
  setConventionOverride("conv", { baseBranch: "dev" });
});

test("PR activity: other people's comments and reviews are notified once; own comments are ignored", async () => {
  let activity: PrActivity[] = [];
  clients.github = () => ({ user: async () => ({ login: "sneha" }), prActivity: async () => activity } as any);
  upsertProject(normaliseProject({ id: "prw", github: { repo: "acme/shop", baseBranch: "dev" }, local: { path: "." }, roles: ["backend-developer"] }));
  const t = createTask({ projectId: "prw", source: "jira", sourceId: "p1", sourceRef: "KAN-42@prw", kind: "assigned" });
  mergeData(t.id, { pr: { number: 311, url: "https://github.com/acme/shop/pull/311" }, prOpenedAt: new Date(Date.now() - 3_600_000).toISOString() });
  const now = new Date().toISOString();
  activity = [
    { id: "c1", kind: "comment", author: "sneha", body: "my own note", url: "u1", at: now },
    { id: "c2", kind: "review_comment", author: "eric", body: "Please use RefundValidator here", url: "u2", at: now, path: "app/x.py" },
    { id: "v1", kind: "review", author: "kani", body: "Needs a test for the limit", url: "u3", at: now, state: "CHANGES_REQUESTED" },
    { id: "c3", kind: "comment", author: "github-actions[bot]", body: "CI passed", url: "u4", at: now },
  ];
  assert.equal(await pollPrActivity(), 2);
  const items = inbox(true).filter((i) => i.task_id === t.id);
  assert.ok(items.some((i) => /eric commented on app\/x.py in PR #311/.test(i.title)));
  assert.ok(items.some((i) => i.kind === "pr_changes_requested" && /kani requested changes on PR #311/.test(i.title)));
  assert.equal(await pollPrActivity(), 0, "the same comments are not notified twice");
});
