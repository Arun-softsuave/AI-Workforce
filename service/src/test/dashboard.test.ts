import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { publish, subscribe, lastEvents, _resetBus, _setClock, type LiveEvent } from "../live/bus.js";
import { toolCallToLine, testProgressFromOutput, recordActivity, getActivity, clearActivity, _setActivityClock, activityFromSdkMessage, progressFrom } from "../live/activity.js";
import { registerTimer, runTimed, listTimers, everyToMs } from "../core/timers.js";
import { handleStream, streamClientCount, closeAllStreams, sseFrame } from "../api/stream.js";
import { createTask, transition, mergeData, startStep, endStep, getTask } from "../engine/tasks.js";
import { requestApproval } from "../approvals/approvals.js";
import { db } from "../core/db.js";
import { overview, needsYou, workingNow, board, itemTimeline, agents, timers, connections, stageOf, dashboardRoutes, STATE_LABEL } from "../api/dashboardData.js";
import { webPage, webAsset, WEB_CSP } from "../api/web.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ activity lines

test("activity: tool calls become plain-English lines", () => {
  const table: [string, unknown, string][] = [
    ["Bash", { command: "npm test" }, "Running npm test"],
    ["Bash", { command: "cd /work/repo && npm test 2>&1 | tail -20" }, "Running npm test"],
    ["Bash", { command: "CI=1 npx vitest run" }, "Running npx vitest run"],
    ["Bash", { command: "git diff --stat" }, "Looking at the changes"],
    ["Bash", { command: "rg 'refundPayment' src" }, "Searching for refundPayment"],
    ["Bash", { command: "npm ci" }, "Installing packages"],
    ["Read", { file_path: "auth/middleware.py" }, "Reading auth/middleware.py"],
    ["Read", { file_path: "C:\\aiw\\worktrees\\t_1\\src\\services\\refund.ts" }, "Reading src/services/refund.ts"],
    ["Grep", { pattern: "refund" }, "Searching for refund"],
    ["Grep", { pattern: "TODO", path: "src" }, "Searching for TODO in src"],
    ["Glob", { pattern: "**/*.test.ts" }, "Looking for files matching **/*.test.ts"],
    ["Edit", { file_path: "src/app.ts" }, "Editing src/app.ts"],
    ["Write", { file_path: "src/new.ts" }, "Editing src/new.ts"],
    ["MultiEdit", { file_path: "a/b.ts" }, "Editing a/b.ts"],
    ["mcp__lookup__jira_get_issue", { key: "KAN-42" }, "Reading Jira ticket KAN-42"],
    ["mcp__lookup__jira_search", { jql: "project = KAN" }, "Searching Jira"],
    ["mcp__lookup__github_get_pr", { pr: "https://github.com/o/r/pull/141" }, "Reading pull request #141"],
    ["mcp__lookup__figma_get_design", { link: "https://figma.com/design/abc/x", frame: "Chat / Reply chips" }, "Reading Figma frame 'Chat / Reply chips'"],
    ["mcp__lookup__figma_get_design", { link: "https://www.figma.com/design/abc/File?node-id=12-34" }, "Reading Figma frame 12:34"],
    ["mcp__lookup__notion_get_page", { url: "https://notion.so/x" }, "Reading a Notion page"],
    ["mcp__lookup__code_query", { question: "where are chips built" }, 'Searching the code map for "where are chips built"'],
    ["TodoWrite", {}, "Planning its next steps"],
    ["mcp__other__do_thing", {}, "Using do thing"],
  ];
  for (const [tool, input, want] of table) assert.equal(toolCallToLine(tool, input, { root: "C:\\aiw\\worktrees\\t_1" }), want, `${tool} ${JSON.stringify(input)}`);
});

test("activity: secrets in commands are never shown", () => {
  const line = toolCallToLine("Bash", { command: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234 curl -H 'Authorization: Bearer abc.def' https://user:pass@example.com" });
  assert.ok(!line.includes("ghp_abcdefghijklmnopqrstuvwxyz1234"), line);
  assert.ok(!line.includes("user:pass"), line);
  assert.ok(!line.includes("abc.def"), line);
});

test("activity: test output gives 'N of M passed'", () => {
  assert.equal(testProgressFromOutput("Tests:       17 failed, 41 passed, 58 total\nTime: 3s")?.line, "41 of 58 passed");
  assert.equal(testProgressFromOutput(" Test Files  3 passed (3)\n      Tests  41 passed | 2 failed (43)\n")?.line, "41 of 43 passed");
  assert.equal(testProgressFromOutput("============ 2 failed, 41 passed, 1 skipped in 4.20s ============")?.line, "41 of 43 passed");
  assert.equal(testProgressFromOutput("# tests 58\n# suites 3\n# pass 41\n# fail 17\n")?.line, "41 of 58 passed");
  assert.equal(testProgressFromOutput("  41 passing (2s)\n  2 failing\n")?.line, "41 of 43 passed");
  assert.equal(testProgressFromOutput("test result: FAILED. 41 passed; 2 failed; 0 ignored")?.line, "41 of 43 passed");
  assert.equal(testProgressFromOutput("\x1b[32mTests:\x1b[0m 5 passed, 5 total")?.line, "5 of 5 passed");
  assert.equal(testProgressFromOutput("compiling...\nnothing here"), undefined);
  // the last run counts
  assert.equal(testProgressFromOutput("Tests: 1 failed, 4 passed, 5 total\n...\nTests: 5 passed, 5 total")?.line, "5 of 5 passed");
  assert.equal(progressFrom(3, 12), 25);
  assert.equal(progressFrom(3, 12, { passed: 41, failed: 17, total: 58, line: "" }), 71);
});

test("activity: SDK stream messages give lines and test progress", () => {
  const a = activityFromSdkMessage({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
  assert.deepEqual(a.lines, ["Running npm test"]);
  const u = activityFromSdkMessage({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "Tests: 41 passed, 58 total" }] }] } });
  assert.equal(u.test?.line, "41 of 58 passed");
  assert.deepEqual(activityFromSdkMessage({ type: "result" }).lines, []);
});

test("activity: the table is written at most every 5 s, the bus gets every line", () => {
  _resetBus();
  let t = 1_000_000;
  _setActivityClock(() => t);
  const seen: LiveEvent[] = [];
  const off = subscribe((e) => seen.push(e));
  assert.equal(recordActivity("t_act", "implementer", "implement_test", "Running npm test", 40, 1000), true);
  t += 1000;
  assert.equal(recordActivity("t_act", "implementer", "implement_test", "Editing src/a.ts", 45, 1200), false);
  assert.equal(getActivity("t_act")?.line, "Running npm test");
  t += 4000;
  assert.equal(recordActivity("t_act", "implementer", "implement_test", "Reading src/b.ts", 50, 1500), true);
  const row = getActivity("t_act")!;
  assert.equal(row.line, "Reading src/b.ts");
  assert.equal(row.progress, 50);
  t += 100;
  assert.equal(recordActivity("t_act", "reviewer", "reviews", "Checking", 60, 1600, { force: true }), true);
  assert.equal(getActivity("t_act")?.agent, "reviewer");
  assert.ok(seen.length >= 1 && seen[0].kind === "activity");
  clearActivity("t_act");
  assert.equal(getActivity("t_act"), undefined);
  off();
  _setActivityClock();
  _resetBus();
});

// ------------------------------------------------------------------ bus

test("bus: throttle per key keeps the last payload and delivers it at the end of the window", async () => {
  _resetBus();
  const got: LiveEvent[] = [];
  const off = subscribe((e) => got.push(e));
  assert.equal(publish("activity", { taskId: "a", line: "1" }, { throttleMs: 60 }), "sent");
  assert.equal(publish("activity", { taskId: "a", line: "2" }, { throttleMs: 60 }), "queued");
  assert.equal(publish("activity", { taskId: "a", line: "3" }, { throttleMs: 60 }), "queued");
  assert.equal(publish("activity", { taskId: "b", line: "x" }, { throttleMs: 60 }), "sent");   // other key: not throttled
  assert.equal(publish("item", { taskId: "a" }), "sent");                                       // other kind: no throttle
  assert.equal(got.length, 3);
  await sleep(120);
  const a = got.filter((e) => e.key === "activity:a").map((e) => (e.payload as any).line);
  assert.deepEqual(a, ["1", "3"]);
  assert.deepEqual(lastEvents("activity").map((e) => (e.payload as any).line).sort(), ["3", "x"]);
  // a broken subscriber does not stop others
  const off2 = subscribe(() => { throw new Error("boom"); });
  assert.equal(publish("feed", { text: "hello" }), "sent");
  assert.equal(got.at(-1)?.kind, "feed");
  off(); off2();
  _resetBus();
});

test("bus: fake clock throttles without waiting", () => {
  _resetBus();
  let t = 0;
  _setClock(() => t);
  const got: LiveEvent[] = [];
  subscribe((e) => got.push(e));
  publish("activity", { taskId: "z" });
  t = 2500;
  publish("activity", { taskId: "z" });
  assert.equal(got.length, 2);
  _resetBus();
});

// ------------------------------------------------------------------ timers

test("timers: registry records runs, results and next run", async () => {
  assert.equal(everyToMs("every 2 min"), 120_000);
  assert.equal(everyToMs("every 10 s"), 10_000);
  assert.equal(everyToMs("daily 18:00"), undefined);
  registerTimer("Jira check", 120_000, "New and changed tickets");
  registerTimer("Daily digest", "daily 18:00", "One summary message in Teams");
  const r = await runTimed("Jira check", async () => 42);
  assert.equal(r, 42);
  let j = listTimers().find((x) => x.name === "Jira check")!;
  assert.equal(j.every, "every 2 min");
  assert.equal(j.state, "healthy");
  assert.ok(j.lastRun && j.nextRun && new Date(j.nextRun).getTime() > Date.now() + 100_000);
  await assert.rejects(runTimed("Jira check", async () => { throw new Error("token ghp_abcdefghijklmnopqrstuvwxyz123456 rejected"); }), /rejected/);
  j = listTimers().find((x) => x.name === "Jira check")!;
  assert.equal(j.state, "failed");
  assert.equal(j.lastOk, false);
  const d = listTimers().find((x) => x.name === "Daily digest")!;
  assert.equal(d.state, "scheduled");
  assert.equal(d.nextRun, null);
  const view = timers();
  assert.equal(view.find((x) => x.name === "Jira check")?.label, "Failed");
  assert.equal(view.find((x) => x.name === "Daily digest")?.tone, "wait");
  // running state while the work is going
  let during: string | undefined;
  await runTimed("Daily digest", () => { during = listTimers().find((x) => x.name === "Daily digest")?.state; });
  assert.equal(during, "running");
});

// ------------------------------------------------------------------ stream

class FakeRes extends EventEmitter {
  status = 0; headers: Record<string, string> = {}; chunks: string[] = []; ended = false;
  writeHead(s: number, h: Record<string, string>) { this.status = s; this.headers = h; return this; }
  write(s: string) { this.chunks.push(s); return true; }
  end(s?: string) { if (s) this.chunks.push(s); this.ended = true; }
  get text() { return this.chunks.join(""); }
}
const fakeReq = (url: string, host = "127.0.0.1:7421") => Object.assign(new EventEmitter(), { url, headers: { host } }) as any;

test("stream: snapshot on connect, then deltas; token, host and client limits", async () => {
  _resetBus();
  closeAllStreams();
  const snap = { hello: "world" };
  const res = new FakeRes();
  const req = fakeReq("/api/stream?t=secret-token");
  assert.equal(handleStream(req, res as any, "secret-token", { snapshot: () => snap, heartbeatMs: 30 }), true);
  assert.equal(res.status, 200);
  assert.match(res.headers["Content-Type"], /text\/event-stream/);
  assert.ok(res.text.includes(sseFrame("snapshot", snap)));
  assert.equal(streamClientCount(), 1);

  publish("item", { taskId: "t_1", state: "RUNNING" });
  assert.match(res.text, /event: item\ndata: \{"taskId":"t_1","state":"RUNNING"\}/);
  await sleep(70);
  assert.match(res.text, /: ping/);                           // heartbeat

  // a second client gets the latest activity line straight after its snapshot
  publish("activity", { taskId: "t_1", line: "Running npm test" }, { throttleMs: 0 });
  const res2 = new FakeRes();
  handleStream(fakeReq("/api/stream?t=secret-token"), res2 as any, "secret-token", { snapshot: () => snap });
  const i1 = res2.text.indexOf("event: snapshot"), i2 = res2.text.indexOf("Running npm test");
  assert.ok(i1 >= 0 && i2 > i1);
  res2.emit("close");
  assert.equal(streamClientCount(), 1);

  // refused requests
  const bad = new FakeRes();
  assert.equal(handleStream(fakeReq("/api/stream?t=wrong"), bad as any, "secret-token", { snapshot: () => snap }), false);
  assert.equal(bad.status, 401);
  const rebind = new FakeRes();
  assert.equal(handleStream(fakeReq("/api/stream?t=secret-token", "evil.example:7421"), rebind as any, "secret-token", { snapshot: () => snap }), false);
  assert.equal(rebind.status, 403);
  const extra: FakeRes[] = [];
  for (let i = 0; i < 4; i++) { const r = new FakeRes(); extra.push(r); handleStream(fakeReq("/api/stream?t=secret-token"), r as any, "secret-token", { snapshot: () => snap }); }
  assert.equal(streamClientCount(), 5);
  const full = new FakeRes();
  assert.equal(handleStream(fakeReq("/api/stream?t=secret-token"), full as any, "secret-token", { snapshot: () => snap }), false);
  assert.equal(full.status, 503);

  // closing the request unsubscribes: no more writes
  req.emit("close");
  const before = res.chunks.length;
  publish("needs", { taskId: "t_2" });
  assert.equal(res.chunks.length, before);
  assert.ok(res.ended);
  closeAllStreams();
  assert.equal(streamClientCount(), 0);
  _resetBus();
});

test("stream: a failing snapshot still opens the stream with a plain message", () => {
  _resetBus();
  const res = new FakeRes();
  handleStream(fakeReq("/api/stream?t=k"), res as any, "k", { snapshot: () => { throw new Error("db locked"); } });
  assert.match(res.text, /Could not load the dashboard data/);
  closeAllStreams();
});

// ------------------------------------------------------------------ dashboard data

function seed() {
  const q = createTask({ projectId: "nue-frontend", source: "jira", sourceRef: "KAN-35", title: "Filters on order history", kind: "assigned" });
  transition(q.id, "NEEDS_INFO", "question", { playbook: "dev-feature", size: "M" });
  mergeData(q.id, { questions: [{ question: "Show cancelled orders by default?", options: ["Hide them", "Show them"] }] });

  const s = createTask({ projectId: "nue-backend", source: "jira", sourceRef: "KAN-47", title: "Bulk export of invoices", kind: "assigned" });
  transition(s.id, "TRIAGED", "sized", { size: "L", playbook: "dev-feature" });
  transition(s.id, "AWAITING_START", "L");

  const r = createTask({ projectId: "nue-backend", source: "jira", sourceRef: "KAN-61", title: "Email templates", kind: "assigned" });
  transition(r.id, "QUEUED", "go", { playbook: "dev-feature", size: "S" });
  transition(r.id, "RUNNING", "run", { step_index: 7 });            // dev-feature: implement_test (after doc_readiness)
  const st = startStep(r.id, 1, 7, "implement_test");
  db().prepare("UPDATE tasks SET tokens_used=? WHERE id=?").run(12_000, r.id);

  const a = createTask({ projectId: "nue-backend", source: "jira", sourceRef: "KAN-58", title: "Login redirect loop", kind: "assigned" });
  transition(a.id, "QUEUED", "go", { playbook: "dev-feature", size: "S" });
  transition(a.id, "RUNNING", "run", { step_index: 3 });
  const p = startStep(a.id, 1, 3, "plan");
  endStep(p, "done", { agent: "planner", model: "claude-opus-x", tokensIn: 3000, tokensOut: 500 });
  transition(a.id, "AWAITING_APPROVAL", "plan ready", { step_index: 6 });
  const ap = requestApproval(a.id, "implement_plan", {});

  const d = createTask({ projectId: "nue-backend", source: "jira", sourceRef: "KAN-40", title: "Avatar upload", kind: "assigned" });
  transition(d.id, "QUEUED", "go", { playbook: "dev-feature", size: "M" });
  transition(d.id, "RUNNING", "run", { step_index: 14 });
  mergeData(d.id, { pr: { url: "https://github.com/o/nue-backend/pull/138" }, ticket: { url: "https://x.atlassian.net/browse/KAN-40" } });
  transition(d.id, "DONE", "published", { step_index: 16 });

  const w = createTask({ projectId: "nue-backend", source: "jira", sourceRef: "KAN-66", title: "Typing indicator", kind: "assigned" });
  transition(w.id, "QUEUED", "go", { playbook: "dev-feature", size: "S" });

  return { q, s, r, a, d, w, st, ap };
}

test("dashboard data: needs, working, board, timeline, agents, connections, overview", () => {
  _resetBus();
  const ids = seed();
  recordActivity(ids.r.id, "implementer", "implement_test", "Running npm test", 62, 38_000, { force: true });

  // needs you
  const needs = needsYou();
  const kinds = needs.map((n) => `${n.kind}:${n.ref}`);
  assert.deepEqual(kinds, ["question:KAN-35", "approval:KAN-58", "start:KAN-47"]);
  const q = needs[0];
  assert.equal(q.title, "Show cancelled orders by default?");
  assert.deepEqual(q.options.map((o) => o.label), ["Hide them", "Show them"]);
  assert.equal(q.recommended, 0);
  assert.deepEqual(q.options[1], { label: "Show them", method: "POST", path: "/api/answer", body: { ref: ids.q.id, answer: "2" } });
  assert.ok(q.freeText);
  const ap = needs[1];
  assert.equal(ap.options[0].path, `/api/approve/${ids.ap.id}`);
  assert.equal(ap.options[1].path, `/api/reject/${ids.ap.id}`);
  assert.ok(ap.options[1].ask);
  assert.equal(needs[2].options[0].path, `/api/tasks/${ids.s.id}/start`);
  assert.ok(needs[2].options[1].local);

  // working now
  const working = workingNow();
  assert.equal(working.length, 1);
  assert.equal(working[0].ref, "KAN-61");
  assert.equal(working[0].line, "Running npm test");
  assert.equal(working[0].progress, 62);
  assert.equal(working[0].agentLabel, "Implementer");
  assert.equal(working[0].tokens, 38_000);
  assert.match(working[0].tier, /^(Opus|Sonnet|Haiku|Test model|Small|Medium|Large)$/);
  assert.equal(working[0].minutes, 0);

  // board
  const b = board();
  assert.deepEqual(b.stages.map((s) => s.label), ["Waiting", "Understand & plan", "Building", "Reviewing", "PR open", "Done"]);
  const lane = (key: string) => b.stages.find((s) => s.key === key)!.items.map((c) => c.ref);
  assert.deepEqual(lane("waiting").sort(), ["KAN-47", "KAN-66"]);
  assert.deepEqual(lane("plan").sort(), ["KAN-35", "KAN-58"]);
  assert.deepEqual(lane("build"), ["KAN-61"]);
  assert.deepEqual(lane("pr"), ["KAN-40"]);
  const pr = b.stages.find((s) => s.key === "pr")!.items[0];
  assert.equal(pr.label, "PR open");
  assert.equal(pr.tone, "ok");
  assert.deepEqual(pr.prs, [{ url: "https://github.com/o/nue-backend/pull/138", label: "#138" }]);
  const approval = b.stages.find((s) => s.key === "plan")!.items.find((c) => c.ref === "KAN-58")!;
  assert.equal(approval.label, "Waiting for you");
  assert.equal(approval.tone, "you");
  assert.equal(STATE_LABEL.AWAITING_APPROVAL, "Waiting for you");
  assert.equal(stageOf(getTask(ids.d.id)!), "pr");
  mergeData(ids.d.id, { merged: true });
  assert.equal(stageOf(getTask(ids.d.id)!), "done");

  // timeline
  const tl = itemTimeline("KAN-58")!;
  assert.equal(tl.ref, "KAN-58");
  assert.equal(tl.stages.length, 6);
  assert.equal(tl.stageIndex, 1);
  assert.ok(tl.timeline.some((e) => e.title === "Wrote the plan" && e.who?.includes("Planner") && e.mark === "done"));
  assert.ok(tl.timeline.some((e) => e.title.startsWith("Asked you") && e.mark === "ask"));
  assert.ok(tl.timeline.some((e) => e.mark === "todo" && e.title === "Built and tested"));
  assert.equal(tl.actions[0].path, `/api/approve/${ids.ap.id}`);
  assert.equal(itemTimeline("nope"), undefined);
  const tlDone = itemTimeline(ids.d.id)!;
  assert.equal(tlDone.ticketUrl, "https://x.atlassian.net/browse/KAN-40");
  assert.ok(!tlDone.timeline.some((e) => e.mark === "todo"));

  // agents and queue
  const ag = agents();
  assert.equal(ag.busy.length, 1);
  assert.ok(ag.slots.total >= 1);
  assert.ok(!ag.ready.some((r) => r.agent === "implementer"));
  const why = Object.fromEntries(ag.queue.map((x) => [x.ref, x.why]));
  assert.equal(why["KAN-47"], "Needs your start");
  assert.ok(typeof why["KAN-66"] === "string" && why["KAN-66"].length > 0);

  // connections
  db().prepare("INSERT INTO connections (provider, account, status, meta, updated_at) VALUES ('jira','me@x','connected','{}',?), ('github','me','expired','{\"lastError\":\"token expired\"}',?)").run(new Date().toISOString(), new Date().toISOString());
  const cs = connections();
  const by = Object.fromEntries(cs.map((c) => [c.provider, c]));
  assert.equal(by.jira.label, "Connected");
  assert.equal(by.jira.action, undefined);
  assert.equal(by.github.label, "Sign-in expired");
  assert.deepEqual(by.github.action, { label: "Reconnect", href: "/connect/github" });
  assert.equal(by.figma.label, "Not connected");
  assert.equal(by.figma.action?.href, "/connect/figma");
  assert.ok(by.model);
  assert.equal(by.slack, undefined);

  // overview = the snapshot
  const o = overview();
  assert.equal(o.top.needsYou, 3);
  assert.equal(o.top.agentsBusy, 1);
  assert.equal(o.top.waiting, 1);              // AWAITING_START (QUEUED counts as in progress)
  assert.ok(o.top.inProgress >= 4);
  assert.equal(o.service.paused, false);
  assert.ok(Array.isArray(o.feed) && Array.isArray(o.timers) && Array.isArray(o.connections));
  assert.ok(JSON.stringify(o).length < 200_000);

  // routes table
  const route = (p: string) => dashboardRoutes.find(([m, re]) => m === "GET" && re.test(p));
  for (const p of ["/api/overview", "/api/needs", "/api/working", "/api/board", "/api/items/KAN-58/timeline", "/api/agents", "/api/timers", "/api/connections", "/api/feed"]) assert.ok(route(p), p);
  const [, re, h] = route("/api/items/KAN-58/timeline")!;
  const res = h("/api/items/KAN-58/timeline".match(re)!, {}, new URL("http://127.0.0.1/api/items/KAN-58/timeline")) as any;
  assert.equal(res.ref, "KAN-58");
  _resetBus();
});

// ------------------------------------------------------------------ static files

test("web: the page gets the token, assets are served safely", () => {
  const html = webPage('tok"<x>');
  assert.ok(html, "service/web/index.html exists");
  assert.ok(html!.includes('content="tok&quot;&lt;x&gt;"'));
  assert.ok(!html!.includes("__AIW_TOKEN__"));
  assert.ok(!/<script>(?!<\/script>)/.test(html!), "no inline script");
  assert.ok(!/fonts\.googleapis|https?:\/\//.test(html!.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "")), "no external resources");
  const js = webAsset("/web/app.js")!;
  assert.match(js.type, /javascript/);
  assert.ok(!/\beval\(|new Function\(|on(click|load)=/.test(js.body.toString("utf8")));
  assert.match(webAsset("/web/app.css")!.type, /text\/css/);
  assert.equal(webAsset("/web/../src/core/db.ts"), undefined);
  assert.equal(webAsset("/web/%2e%2e/package.json"), undefined);
  assert.equal(webAsset("/web/index.html"), undefined);
  assert.equal(webAsset("/web/.env"), undefined);
  assert.equal(webAsset("/web/nope.js"), undefined);
  assert.match(WEB_CSP, /script-src 'self'/);
  assert.doesNotMatch(WEB_CSP, /script-src[^;]*unsafe/);
});
