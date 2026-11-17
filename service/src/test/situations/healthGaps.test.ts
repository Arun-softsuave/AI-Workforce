import { makeRepo, waitFor } from "../helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../../core/db.js";
import { saveSettings, updateSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../../core/config.js";
import { HttpError, nowIso } from "../../core/util.js";
import { setSenders } from "../../notify/router.js";
import type { Notice } from "../../notify/channels.js";
import { createItem, getItem } from "../../kernel/items.js";
import { createJob, getJob } from "../../kernel/mailbox.js";
import { pickRunnable, limitsFrom } from "../../kernel/scheduler.js";
import { requeuePausedJobs } from "../../kernel/runner.js";
import { getRecipe } from "../../kernel/recipes.js";
import { answerTask, resumeTask } from "../../engine/engine.js";
import { noteConnectorError } from "../../engine/stepRun.js";
import { isBlockedByConnector } from "../../intake/healthGate.js";
import { loadSettings } from "../../core/config.js";
import type { Item } from "../../kernel/types.js";

/**
 * Connector health holds (W3) and the wave-2 gaps closed in wave 3:
 *  - a connector that is down holds only the jobs that need it (GitHub down: the CI fix waits, planning goes on);
 *  - a sign-in error mid-task marks the connector down at once;
 *  - a question asked by a job BESIDE the item (a comment fix on a ticket's open PR) can be answered;
 *  - a paused job that owns a PR_OPEN item goes back to the queue on "resume";
 *  - budgets (stopForBudget) and "you took it over" hold work in the scheduler.
 */
const { repo } = makeRepo("shop");
saveSettings({
  ...structuredClone(DEFAULT_SETTINGS),
  profile: { name: "Owner", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" },
  notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: ["inbox"], quietHours: "off" },
  engine: { version: "v2" },
});
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" }, local: { path: repo },
  roles: ["backend-developer"], autonomy: "prepare", budget: { perTaskTokens: { S: 1000, M: 1000, L: 1000 }, dailyTokens: 10_000_000 } } as any));
const sent: Notice[] = [];
setSenders({ desktop: { send: async (n) => { sent.push(n); return undefined; } } });

const ticket = (key: string, state: any, extra: Record<string, any> = {}): Item => createItem({ projectId: "shop", source: "jira", sourceId: `id-${key}`, sourceRef: key, title: `Ticket ${key}`,
  kind: "assigned", state, playbook: "dev-feature", data: { ticket: { key, title: `Ticket ${key}` }, pr: state === "PR_OPEN" ? { number: 7, repo: "acme/shop" } : undefined, ...extra } });
const setHealth = (provider: string, state: string) =>
  db().prepare("INSERT OR REPLACE INTO connector_health (provider, state, since, last_ok, last_alert, detail) VALUES (?,?,?,?,?,?)").run(provider, state, nowIso(), null, null, `${provider} test`);
const held = (d: ReturnType<typeof pickRunnable>, jobId: string) => d.waiting.find((w) => w.jobId === jobId);

test("GitHub down: the CI fix on the open PR waits ('blocked: GitHub disconnected'); planning another ticket goes on", () => {
  const pr = ticket("KAN-1", "PR_OPEN");
  const fix = createJob({ itemId: pr.id, type: "ci_fix", recipe: "ci_fix" });
  const other = ticket("KAN-2", "QUEUED");
  const build = createJob({ itemId: other.id, type: "build", recipe: "dev-feature" });
  // its next step is planning (preparing the workspace fetches from GitHub, so that step would wait too)
  db().prepare("UPDATE jobs SET step_index=? WHERE id=?").run(getRecipe("dev-feature").steps.findIndex((x) => x.name === "plan"), build.id);
  setHealth("github", "down");
  const d = pickRunnable(limitsFrom(loadSettings()), []);
  assert.equal(held(d, fix.id)?.reason, "blocked: GitHub disconnected");
  assert.equal(d.held.find((h) => h.job.id === fix.id)?.reason, "connector");
  assert.ok(d.start.some((j) => j.id === build.id), "work that doesn't need GitHub runs");
  // engine v1 has no jobs: the item's state decides (PR work needs GitHub, planning needs the model)
  assert.equal(isBlockedByConnector({ id: pr.id, state: "PR_OPEN" }), true);
  assert.equal(isBlockedByConnector({ id: other.id, state: "QUEUED" }), false);
  setHealth("github", "up");
  assert.ok(pickRunnable(limitsFrom(loadSettings()), []).start.some((j) => j.id === fix.id), "back up: it runs");
  db().prepare("DELETE FROM jobs").run();
});

test("a sign-in error (401) from GitHub in the middle of a step marks GitHub down at once, with one reconnect message", async () => {
  const before = sent.length;
  noteConnectorError(new HttpError(401, "GET https://api.github.com/repos/acme/shop/pulls -> 401: Bad credentials"));
  await waitFor(() => (db().prepare("SELECT state FROM connector_health WHERE provider='github'").get() as any)?.state === "down", 5000);
  await waitFor(() => sent.length > before, 5000);
  assert.match(sent.slice(before).map((n) => `${n.title}\n${n.body}`).join("\n"), /GitHub[\s\S]*aiw connect github/);
  noteConnectorError(new HttpError(500, "GET https://api.github.com/x -> 500"));                    // not a sign-in problem
  setHealth("github", "up");
});

test("wave-2 gap: a question from a job beside the item (comment fix on an open PR) is answered and the job resumes", async () => {
  const it = ticket("KAN-3", "PR_OPEN");
  const job = createJob({ itemId: it.id, type: "comment_fix", recipe: "comment_fix", data: { questions: [{ question: "Rename the field too?", options: ["Yes", "No"] }], ctx: { fix: { num: 7 } } } });
  db().prepare("UPDATE jobs SET state='waiting' WHERE id=?").run(job.id);
  const r = await answerTask(undefined, "2", "Owner", "teams-personal");
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /KAN-3 continues/);
  const j = getJob(job.id)!;
  assert.equal(j.state, "queued");
  assert.equal(j.data.questions, null);
  assert.match(j.data.ctx.clarifications[0].answer, /Rename the field too\? → No$/);
  assert.equal(j.data.ctx.fix.num, 7, "the job's own context is kept");
  assert.equal(getItem(it.id)!.state, "PR_OPEN", "the item never left PR_OPEN");
  db().prepare("DELETE FROM jobs").run();
});

test("wave-2 gap: 'resume' puts a paused job that owns a PR_OPEN item back in the queue", () => {
  const it = ticket("KAN-4", "PR_OPEN");
  const job = createJob({ itemId: it.id, type: "build", recipe: "dev-feature" });
  db().prepare("UPDATE jobs SET state='waiting', activity='Budget: used up' WHERE id=?").run(job.id);
  assert.equal(requeuePausedJobs(), 0, "nothing until you say resume");
  const t = resumeTask("KAN-4")!;
  assert.equal(t.state, "PR_OPEN");
  assert.equal(requeuePausedJobs(), 1);
  assert.equal(getJob(job.id)!.state, "queued");
  assert.equal(getItem(it.id)!.data.resumeJobs, null, "one resume, one requeue");
  db().prepare("DELETE FROM jobs").run();
});

test("budgets: with stopForBudget on, an item over its budget is held ('budget: …'); otherwise budgets only report", () => {
  const it = ticket("KAN-5", "QUEUED");
  db().prepare("UPDATE tasks SET tokens_used=5000, size='M' WHERE id=?").run(it.id);
  const job = createJob({ itemId: it.id, type: "build", recipe: "dev-feature" });
  assert.ok(pickRunnable(limitsFrom(loadSettings()), []).start.some((j) => j.id === job.id), "reported, never stops by default");
  updateSettings((s) => { s.workflow.stopForBudget = true; });
  const d = pickRunnable(limitsFrom(loadSettings()), []);
  assert.match(held(d, job.id)?.reason ?? "", /^budget: /);
  assert.equal(d.held.find((h) => h.job.id === job.id)?.reason, "budget");
  updateSettings((s) => { s.workflow.stopForBudget = false; });
  db().prepare("DELETE FROM jobs").run();
});

test("take over: an item you took over is held until you hand it back", () => {
  const it = ticket("KAN-6", "QUEUED", { takenOver: { at: nowIso() } });
  const job = createJob({ itemId: it.id, type: "build", recipe: "dev-feature" });
  assert.equal(held(pickRunnable(limitsFrom(loadSettings()), []), job.id)?.reason, "you took it over");
  db().prepare("DELETE FROM jobs").run();
});
