import { pruneChat } from "../notify/chatLog.js";
import fs from "node:fs";
import { paths, ensureBaseDirs } from "../core/paths.js";
import { db, audit } from "../core/db.js";
import { loadSettings } from "../core/config.js";
import { logger, logToConsole } from "../core/log.js";
import { randomToken, nowIso } from "../core/util.js";
import { writeRuntime, clearRuntime, readRuntime, pidAlive, VERSION } from "../core/runtime.js";
import { setSecret } from "../core/secrets.js";
import { startApiServer } from "../api/server.js";
import { setEngineRole, recoverInterrupted, tick, housekeeping, decideAndApply, migrateToLeadTasks } from "../engine/engine.js";
import { pollAll, isWorkingHours } from "../intake/intake.js";
import { flushNotifications } from "../notify/router.js";
import { maybeSendCheckup } from "../notify/checkup.js";
import { SlackSocket } from "../connectors/slack.js";
import { pollTeamsCommands } from "../intake/teamsCommands.js";
import { registerTimer, runTimed, setNextRun } from "../core/timers.js";
import { startHealthLoop } from "../intake/health.js";

/**
 * aiw-agentd – the always-on local worker. Starts at login, keeps working while Claude Code is closed,
 * survives restarts (checkpoints) and only makes OUTBOUND connections.
 */
async function main(): Promise<void> {
  ensureBaseDirs();
  if (process.argv.includes("--console")) logToConsole(true);
  acquireLock();
  setEngineRole("daemon");
  db();
  const settings = loadSettings();
  const token = randomToken();
  setSecret("api.sessionToken", token);
  const { server, port } = await startApiServer(settings.service.port, token);
  writeRuntime({ pid: process.pid, port, token, startedAt: nowIso(), version: VERSION });
  const { lastAlive, heartbeat, catchUp, dailyRefresh } = await import("./upkeep.js");
  const offSince = lastAlive();
  const recovered = recoverInterrupted();
  try { const merged = migrateToLeadTasks(); if (merged) logger.info("multi-repository tickets merged into lead tasks", { merged }); } catch (e: any) { logger.warn("lead migration failed", { error: e.message }); }
  logger.info("aiw-agentd started", { pid: process.pid, port, recovered });
  audit("service", "service.start", undefined, { port, recovered, version: VERSION });

  // Every background job is listed on the dashboard ("every 2 min · last run 40 s ago · healthy").
  registerTimers(settings);
  // Connector health (W3): every 5 min one cheap call per connector; down -> work that needs it waits, one reconnect message
  const stopHealth = startHealthLoop();

  const slack = new SlackSocket(async (a) => {
    if (a.actionId !== "aiw_approve" && a.actionId !== "aiw_reject") return "";
    const r = await decideAndApply(a.value, a.actionId === "aiw_approve" ? "approved" : "rejected", a.userName ?? a.userId, "slack",   // refused when decisions are Teams-only
      a.actionId === "aiw_reject" ? "Rejected in Slack – reply in Claude Code with `/aiw reject <ticket> \"reason\"` to add feedback" : undefined);
    return r.message;
  });
  slack.start().catch(() => {});

  let lastPoll = 0, lastLoop = Date.now(), lastHousekeeping = 0, lastGraph = 0, lastBatch = 0, lastEnvCheck = 0, lastFigma = 0, lastTeam = 0;
  let scopeDigestDay = "";
  // Code graphs (Graphify): installed once in the background, then refreshed when a repository moves – no AI tokens.
  void (async () => {
    try {
      const G = await import("../brain/graph.js");
      if (!G.graphifyBin()) { const r = await G.installGraphify(); logger.info("graphify install", r); }
      await runTimed("Graph refresh", () => G.refreshGraphs());
    } catch (e: any) { logger.warn("code graph setup failed", { error: e.message }); }
  })();
  let polling = false;
  let caughtUp = false;
  let refreshDay = "";
  const loop = async () => {
    const now = Date.now();
    heartbeat(now);
    const s = loadSettings();
    const interval = (isWorkingHours() ? s.limits.pollMinutes : s.limits.pollMinutesOffHours) * 60_000;
    const woke = now - lastLoop > 3 * 60_000;            // machine slept / was suspended -> catch up now
    lastLoop = now;
    if (!polling && (woke || now - lastPoll >= interval)) {
      polling = true;
      try {
        // "Jira check" covers the whole poll; the PR watcher, CI watch and ticket index inside it have their own rows
        const r = await runTimed("Jira check", () => pollAll(), { nextRun: new Date(Date.now() + interval) });
        if (r.items || r.tasks || r.errors.length) logger.info("poll", r);
      } catch (e: any) { logger.error("poll crashed", { error: e.message }); }
      finally { lastPoll = Date.now(); polling = false; }
      // A7: after the first catch-up poll, one message when the service had been off for a while
      if (!caughtUp) { caughtUp = true; void catchUp(offSince, recovered).catch(() => {}); }
    }
    // A3: each repository's conventions and CI map, re-learned once a day (one line when CI changed)
    const day = new Date(now).toISOString().slice(0, 10);
    if (refreshDay !== day && isWorkingHours()) { refreshDay = day; void runTimed("Conventions refresh", () => dailyRefresh()).catch((e) => logger.warn("conventions refresh failed", { error: e?.message })); }
    try { await runTimed("Scheduler", () => tick()); } catch (e: any) { logger.error("tick crashed", { error: e.message }); }
    try { await flushNotifications(); } catch (e: any) { logger.warn("flush failed", { error: e.message }); }
    try {
      const sent = await maybeSendCheckup();
      if (sent) await runTimed("Digest", () => sent);
      setNextRun("Digest", nextDaily(s.workflow?.checkupTime));
    } catch (e: any) { logger.warn("daily check-up failed", { error: e.message }); }
    if (now - lastHousekeeping > 3_600_000) { lastHousekeeping = now; try { await runTimed("Housekeeping", () => { housekeeping(); pruneChat(); }); } catch { /* ignore */ } }
    if (now - lastGraph > 15 * 60_000) { lastGraph = now; void import("../brain/graph.js").then((G) => runTimed("Graph refresh", () => G.refreshGraphs())).catch(() => {}); }
    if (now - lastBatch > 5 * 60_000) {
      lastBatch = now;
      void import("../agents/batch.js").then(async (B) => {
        if (!B.batchAvailable()) return;
        await runTimed("Batch calls", () => B.tickBatches());
        // O3: rule ideas worded through the Batch API become proposals ("add rule R1" / "skip rule R1")
        const { collectLearning } = await import("../engine/steps/close_out.js");
        const { loadProjects } = await import("../core/config.js");
        for (const p of loadProjects()) await collectLearning(p.id).catch((e) => logger.warn("learning collect failed", { project: p.id, error: e?.message }));
      }).catch((e) => logger.warn("batch tick failed", { error: e?.message }));
    }
    // W13: the Figma frames of active items – one version call per file; a changed frame becomes a design_changed event
    if (now - lastFigma >= interval) {
      lastFigma = now;
      void import("../knowledge/figma.js").then((F) => runTimed("Figma watch", () => F.watchActiveFrames())).catch((e) => logger.warn("figma watch failed", { error: e?.message }));
    }
    // W8: one daily digest per active epic / sprint / batch (deduplicated per day)
    const today = new Date().toISOString().slice(0, 10);
    if (scopeDigestDay !== today) {
      scopeDigestDay = today;
      void import("../engine/steps/scope.js").then((S) => S.sendScopeDigests()).catch((e) => logger.warn("scope digest failed", { error: e?.message }));
    }
    // A9: once a week, who joined or went quiet on your repositories (one message, nothing changed without you)
    if (now - lastTeam > 3_600_000) {
      lastTeam = now;
      void import("../core/team.js").then((T) => runTimed("Team check", () => T.weeklyTeamCheck())).catch((e) => logger.warn("team check failed", { error: e?.message }));
    }
    if (now - lastEnvCheck > 5 * 60_000) {
      lastEnvCheck = now;
      void runTimed("Environment re-check", () => resumeEnvironmentBlocked()).catch((e) => logger.warn("environment re-check failed", { error: e?.message }));
    }
  };
  const timer = setInterval(() => void loop(), 15_000);
  const teamsTimer = setInterval(() => { void runTimed("Teams inbox", () => pollTeamsCommands()).catch(() => {}); }, 10_000);
  void loop();

  const shutdown = (sig: string) => {
    logger.info("aiw-agentd stopping", { sig });
    clearInterval(timer);
    clearInterval(teamsTimer);
    stopHealth();
    slack.stop();
    void import("../api/stream.js").then((S) => S.closeAllStreams()).catch(() => {});   // open live pages keep the server up otherwise
    server.close();
    clearRuntime();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => logger.error("uncaught", { error: e.message, stack: e.stack }));
  process.on("unhandledRejection", (e: any) => logger.error("unhandled rejection", { error: e?.message ?? String(e) }));
}

function registerTimers(s: ReturnType<typeof loadSettings>): void {
  try {
    registerTimer("Jira check", s.limits.pollMinutes * 60_000, "New and changed tickets");
    registerTimer("PR watcher", s.limits.pollMinutes * 60_000, "CI results, review comments and merges on your pull requests");
    if (s.engine?.version === "v2") registerTimer("GitHub events", s.limits.pollMinutes * 60_000, "Pull request events (CI, comments, reviews, conflicts, merges, mentions)");
    registerTimer("CI watch", s.limits.pollMinutes * 60_000, "Pull requests waiting for their checks after a fix");
    registerTimer("Ticket index", "every 15 min", "Open tickets by name, for Teams messages");
    registerTimer("Teams inbox", 10_000, "Your messages to the bot");
    registerTimer("Scheduler", 15_000, "Starts queued work");
    registerTimer("Digest", s.workflow?.checkupTime ? `daily ${s.workflow.checkupTime}` : "daily", "One summary message in Teams");
    registerTimer("Housekeeping", 3_600_000, "Tidies old data");
    registerTimer("Graph refresh", 15 * 60_000, "Re-reads repositories that changed");
    registerTimer("Environment re-check", 5 * 60_000, "Restarts work that waited for the local setup to be fixed");
    registerTimer("Figma watch", s.limits.pollMinutes * 60_000, "Design changes in the Figma frames of active work");
    registerTimer("Team check", "weekly", "Who joined or went quiet on your repositories");
    setNextRun("Digest", nextDaily(s.workflow?.checkupTime));
  } catch (e: any) { logger.warn("timer registry failed", { error: e.message }); }
}

/** The next local time "HH:MM" today or tomorrow (null when there is no daily time). */
function nextDaily(hhmm: string | undefined): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? "");
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Tasks paused because the local environment was not ready (data.blocked.reason = "environment"): check again and
 * put them back in the queue when it is fixed, with one short message.
 */
async function resumeEnvironmentBlocked(): Promise<number> {
  const { resumeEnvironmentBlockedTasks } = await import("../engine/envResume.js");
  const n = await resumeEnvironmentBlockedTasks();
  if (n) await tick();
  return n;
}

function acquireLock(): void {
  const rt = readRuntime();
  if (rt && rt.pid !== process.pid && pidAlive(rt.pid)) {
    console.error(`aiw-agentd is already running (pid ${rt.pid}).`);
    process.exit(0);
  }
  try {
    const fd = fs.openSync(paths.lock(), "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    const pid = Number(fs.readFileSync(paths.lock(), "utf8"));
    if (pid && pid !== process.pid && pidAlive(pid)) { console.error(`aiw-agentd is already running (pid ${pid}).`); process.exit(0); }
    fs.writeFileSync(paths.lock(), String(process.pid));                // stale lock from a crash
  }
}

function releaseLock(): void { try { fs.rmSync(paths.lock()); } catch { /* ignore */ } }

main().catch((e) => {
  logger.error("aiw-agentd failed to start", { error: e.message });
  console.error(`aiw-agentd failed to start: ${e.message}`);
  process.exit(1);
});
