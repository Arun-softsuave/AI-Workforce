import "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "../core/db.js";
import { paths } from "../core/paths.js";
import { newId, nowIso, HttpError } from "../core/util.js";
import { setSecret } from "../core/secrets.js";
import { setSenders } from "../notify/router.js";
import { setTeamsPersonalClient, type TeamsPersonalClient } from "../connectors/teamsPersonal.js";
import { preferredFigmaMode } from "../connectors/registry.js";
import { createJob } from "../kernel/mailbox.js";
import {
  checkHealth, applyResult, setHealthProbes, _resetHealth, healthRow, reportConnectorError, defaultProbes,
  isBlockedByConnector, blockingConnector, needsOf, ALERT_REPEAT_MS, reconnectCommand,
} from "../intake/health.js";
import type { State } from "../engine/tasks.js";

// ------------------------------------------------------------------ helpers

const sent: { kind: string; title: string; body: string }[] = [];
setSenders({ desktop: { async send(n) { sent.push({ kind: n.kind, title: n.title, body: n.body }); return "ok"; } } });

function addItem(ref: string, o: { state?: State; data?: any; title?: string } = {}): string {
  const id = newId("t");
  const now = nowIso();
  db().prepare(`INSERT INTO tasks (id, project_id, source, source_ref, title, kind, state, priority, areas, data, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, "repo-a", "jira", ref, o.title ?? ref, "ticket", o.state ?? "QUEUED", 3, "[]", JSON.stringify(o.data ?? {}), now, now);
  return id;
}
const stateOf = (id: string) => (db().prepare("SELECT state, error, data FROM tasks WHERE id=?").get(id) as any);
const events = (type: string) => (db().prepare("SELECT * FROM events WHERE type=?").all(type) as any[]);
const alerts = () => (db().prepare("SELECT * FROM notifications WHERE kind='connector_problem' AND channel='inbox' ORDER BY created_at").all() as any[]);
const job = (type: string, recipe: string, step_index = 0) => ({ type: type as any, recipe, step_index });

function reset() {
  _resetHealth();
  sent.length = 0;
  for (const t of ["connector_health", "jobs", "events", "notifications"]) db().exec(`DELETE FROM ${t}`);
  db().exec("DELETE FROM tasks");
  db().exec("DELETE FROM connections");
  delete process.env.AIW_ENGINE;
  try { fs.rmSync(paths.settings()); } catch { /* none */ }
}
beforeEach(reset);

const ok = async () => ({ ok: true as const });
const skipAll = { jira: async () => "skip" as const, github: async () => "skip" as const, figma: async () => "skip" as const, teams: async () => "skip" as const, model: ok };

// ------------------------------------------------------------------ Figma token first

test("preferredFigmaMode: token unless settings say desktop", () => {
  assert.equal(preferredFigmaMode(), "token");
  fs.mkdirSync(path.dirname(paths.settings()), { recursive: true });
  fs.writeFileSync(paths.settings(), "figma:\n  mode: desktop\n");
  assert.equal(preferredFigmaMode(), "desktop");
  fs.writeFileSync(paths.settings(), "figma:\n  mode: token\n");
  assert.equal(preferredFigmaMode(), "token");
});

// ------------------------------------------------------------------ what needs what

test("needsOf: PR jobs need GitHub, coding needs the model, publish needs GitHub but not the model", () => {
  const it = { id: "x", state: "QUEUED", title: "KAN-1" };
  assert.deepEqual([...needsOf(it, job("ci_fix", "ci_fix"))].sort(), ["github", "model"]);
  assert.deepEqual([...needsOf(it, job("ci_watch", "ci_watch"))], ["github"]);
  assert.deepEqual([...needsOf(it, job("build", "dev-feature", 6))], ["model"]);           // implement_test
  assert.deepEqual([...needsOf(it, job("build", "dev-feature", 12))], ["github"]);         // publish
  assert.deepEqual([...needsOf(it, job("build", "dev-feature", 0))].sort(), ["github"]);   // prepare_workspace
  // a linked Figma design is needed while the ticket is understood, not later
  const fig = { ...it, data: { issue: { description: "see https://www.figma.com/design/AbCdEf123456/x" } } };
  assert.ok(needsOf(fig, job("build", "dev-feature", 2)).has("figma"));                    // analyse
  assert.ok(!needsOf(fig, job("build", "dev-feature", 6)).has("figma"));
  assert.deepEqual([...needsOf({ id: "y", state: "PR_OPEN" })], ["github"]);
});

test("isBlockedByConnector reads connector_health (down and rate limited both hold)", async () => {
  setHealthProbes(skipAll);
  const it = { id: "x", state: "PR_OPEN" };
  assert.equal(isBlockedByConnector(it, job("ci_fix", "ci_fix")), false);
  await applyResult("github", { ok: false, kind: "limited", detail: "GitHub rate limit reached", retryAfterMs: 60_000 });
  assert.equal(isBlockedByConnector(it, job("ci_fix", "ci_fix")), true);
  assert.equal(blockingConnector(it, job("ci_fix", "ci_fix"))?.reason, "GitHub rate limited");
  assert.equal(isBlockedByConnector({ id: "y", state: "QUEUED" }, job("build", "dev-feature", 6)), false);  // coding runs on
  assert.equal(alerts().length, 0, "no reconnect message for a rate limit");
  await applyResult("github", { ok: true });
  assert.equal(isBlockedByConnector(it, job("ci_fix", "ci_fix")), false);
});

// ------------------------------------------------------------------ the down → up cycle (A6)

test("v2: GitHub down → event, BLOCKED, one alert (not again within 6 h) → up → resumed, reconnected message", async () => {
  process.env.AIW_ENGINE = "v2";
  const pr = addItem("KAN-10", { state: "PR_OPEN" });
  createJob({ itemId: pr, type: "ci_fix", recipe: "ci_fix" });
  const coding = addItem("KAN-11", { state: "QUEUED" });
  createJob({ itemId: coding, type: "build", recipe: "dev-feature" });
  db().prepare("UPDATE jobs SET step_index=6 WHERE item_id=?").run(coding);   // implement_test: no GitHub needed

  let gh: () => Promise<any> = async () => ({ ok: false, kind: "auth", detail: "GitHub sign-in expired or was revoked" });
  setHealthProbes({ ...skipAll, github: () => gh() });
  const t0 = new Date("2026-11-17T09:00:00Z");
  const r = await checkHealth(t0);
  assert.equal(r.github, "down");
  assert.equal(healthRow("github")?.state, "down");
  assert.equal(events("connector_down").length, 1);
  assert.equal(stateOf(pr).state, "BLOCKED");
  assert.match(stateOf(pr).error, /connector: GitHub disconnected/);
  assert.equal(JSON.parse(stateOf(pr).data).blockedBy.prev, "PR_OPEN");
  assert.equal(stateOf(coding).state, "QUEUED", "work that doesn't need GitHub keeps running");
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].title, /GitHub disconnected – run `aiw connect github`/);
  assert.equal(sent.length, 1);

  // still down: no second message within 6 h, no second event
  await checkHealth(new Date(t0.getTime() + 5 * 60_000));
  await checkHealth(new Date(t0.getTime() + 5 * 3_600_000));
  assert.equal(alerts().length, 1);
  assert.equal(events("connector_down").length, 1);
  // after 6 h: one reminder
  await checkHealth(new Date(t0.getTime() + ALERT_REPEAT_MS + 60_000));
  assert.equal(alerts().length, 2);

  // back up
  gh = async () => ({ ok: true, account: "me" });
  await checkHealth(new Date(t0.getTime() + 7 * 3_600_000));
  assert.equal(healthRow("github")?.state, "up");
  assert.equal(events("connector_up").length, 1);
  assert.equal(stateOf(pr).state, "PR_OPEN");
  assert.equal(stateOf(pr).error, null);
  assert.equal(JSON.parse(stateOf(pr).data).blockedBy, null);
  assert.ok(sent.some((m) => /✅ GitHub reconnected/.test(m.title)));
  assert.equal(isBlockedByConnector({ id: pr, state: "PR_OPEN" }, job("ci_fix", "ci_fix")), false);
});

test("v2: an item waiting on two connectors resumes only when both are back", async () => {
  process.env.AIW_ENGINE = "v2";
  const pr = addItem("KAN-20", { state: "PR_OPEN" });
  createJob({ itemId: pr, type: "ci_fix", recipe: "ci_fix" });
  setHealthProbes(skipAll);
  await applyResult("github", { ok: false, kind: "auth", detail: "x" });
  await applyResult("model", { ok: false, kind: "auth", detail: "No model API key saved" });
  assert.deepEqual(JSON.parse(stateOf(pr).data).blockedBy.connectors.sort(), ["github", "model"]);
  await applyResult("github", { ok: true });
  assert.equal(stateOf(pr).state, "BLOCKED");
  await applyResult("model", { ok: true });
  assert.equal(stateOf(pr).state, "PR_OPEN");
});

test("v1: never enters BLOCKED, but the gate still holds the work", async () => {
  process.env.AIW_ENGINE = "v1";
  const pr = addItem("KAN-30", { state: "PR_OPEN" });
  createJob({ itemId: pr, type: "ci_fix", recipe: "ci_fix" });
  setHealthProbes({ ...skipAll, github: async () => ({ ok: false, kind: "auth", detail: "expired" }) });
  await checkHealth(new Date("2026-11-17T09:00:00Z"));
  assert.equal(stateOf(pr).state, "PR_OPEN");
  assert.equal(isBlockedByConnector({ id: pr, state: "PR_OPEN" }, job("ci_fix", "ci_fix")), true);
  assert.equal(alerts().length, 1);
});

test("a single network error is not an outage; two in a row are", async () => {
  setHealthProbes({ ...skipAll, jira: async () => ({ ok: false, kind: "network", detail: "Can't reach Jira" }) });
  await checkHealth(new Date("2026-11-17T09:00:00Z"));
  assert.notEqual(healthRow("jira")?.state, "down");
  assert.equal(alerts().length, 0);
  await checkHealth(new Date("2026-11-17T09:05:00Z"));
  assert.equal(healthRow("jira")?.state, "down");
  assert.equal(alerts().length, 1);
});

test("not reconnected message when we never said it was down; skip marks a removed connector off", async () => {
  setHealthProbes({ ...skipAll, figma: async () => ({ ok: false, kind: "network", detail: "Can't reach Figma" }) });
  await checkHealth(new Date("2026-11-17T09:00:00Z"));
  setHealthProbes({ figma: ok });
  await checkHealth(new Date("2026-11-17T09:05:00Z"));
  assert.equal(sent.length, 0);
  await applyResult("figma", { ok: false, kind: "auth", detail: "expired" });
  await applyResult("figma", "skip");
  assert.equal(healthRow("figma")?.state, "off");
  assert.equal(isBlockedByConnector({ id: "x", state: "QUEUED" }, job("build", "dev-feature", 2)), false);
});

test("reportConnectorError: a 401 seen mid-task marks the connector down at once; a 500 does not", async () => {
  setHealthProbes(skipAll);
  await reportConnectorError("jira", new HttpError(500, "boom"));
  assert.equal(healthRow("jira"), undefined);
  await reportConnectorError("jira", new HttpError(401, "GET /myself -> 401"));
  assert.equal(healthRow("jira")?.state, "down");
  assert.match(alerts()[0].title, /Jira disconnected – run `aiw connect jira`/);
  assert.equal(reconnectCommand("teams"), "aiw connect teams-personal");
  assert.equal(reconnectCommand("model"), "aiw model");
});

// ------------------------------------------------------------------ real probes against local fakes (no network)

test("GitHub probe: conditional request (ETag → 304), 401 → down, rate limit → limited", async () => {
  const seen: (string | undefined)[] = [];
  let mode: "ok" | "401" | "limit" = "ok";
  const srv = http.createServer((req, res) => {
    seen.push(req.headers["if-none-match"] as string | undefined);
    if (mode === "401") { res.writeHead(401); res.end("{}"); return; }
    if (mode === "limit") { res.writeHead(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) }); res.end("{}"); return; }
    if (req.headers["if-none-match"] === '"abc"') { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { etag: '"abc"', "content-type": "application/json" }); res.end(JSON.stringify({ login: "me" }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  process.env.AIW_GITHUB_API = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    setSecret("github.token", "ghp_test");
    db().prepare("INSERT INTO connections (provider, status, updated_at) VALUES ('github','connected',?)").run(nowIso());
    assert.deepEqual(await defaultProbes.github(), { ok: true });
    assert.deepEqual(await defaultProbes.github(), { ok: true });
    assert.deepEqual(seen, [undefined, '"abc"'], "second check sends If-None-Match and gets a free 304");
    mode = "limit";
    const l: any = await defaultProbes.github();
    assert.equal(l.kind, "limited");
    assert.ok(l.retryAfterMs > 0);
    mode = "401";
    assert.equal(((await defaultProbes.github()) as any).kind, "auth");
    db().exec("DELETE FROM connections");
    assert.equal(await defaultProbes.github(), "skip");
  } finally {
    delete process.env.AIW_GITHUB_API;
    srv.close();
  }
});

test("Teams probe uses the client's whoAmI; a lost sign-in is down", async () => {
  let signedIn = true;
  const fake = { hasSavedLogin: () => signedIn, whoAmI: async () => ({ mri: "8:orgid:me", region: null }) } as unknown as TeamsPersonalClient;
  setTeamsPersonalClient(fake);
  try {
    assert.equal(await defaultProbes.teams(), "skip");
    db().prepare("INSERT INTO connections (provider, status, updated_at) VALUES ('teams-personal','connected',?)").run(nowIso());
    assert.deepEqual(await defaultProbes.teams(), { ok: true, account: "8:orgid:me" });
    signedIn = false;
    assert.equal(((await defaultProbes.teams()) as any).kind, "auth");
  } finally { setTeamsPersonalClient(undefined); }
});

test("model probe: the mock model needs no call", async () => {
  fs.mkdirSync(path.dirname(paths.settings()), { recursive: true });
  fs.writeFileSync(paths.settings(), "models:\n  provider: mock\n");
  assert.equal(((await defaultProbes.model()) as any).ok, true);
});
