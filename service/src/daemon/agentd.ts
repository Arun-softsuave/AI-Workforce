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
  const recovered = recoverInterrupted();
  try { const merged = migrateToLeadTasks(); if (merged) logger.info("multi-repository tickets merged into lead tasks", { merged }); } catch (e: any) { logger.warn("lead migration failed", { error: e.message }); }
  logger.info("aiw-agentd started", { pid: process.pid, port, recovered });
  audit("service", "service.start", undefined, { port, recovered, version: VERSION });

  const slack = new SlackSocket(async (a) => {
    if (a.actionId !== "aiw_approve" && a.actionId !== "aiw_reject") return "";
    const r = await decideAndApply(a.value, a.actionId === "aiw_approve" ? "approved" : "rejected", a.userName ?? a.userId, "slack",   // refused when decisions are Teams-only
      a.actionId === "aiw_reject" ? "Rejected in Slack – reply in Claude Code with `/aiw reject <ticket> \"reason\"` to add feedback" : undefined);
    return r.message;
  });
  slack.start().catch(() => {});

  let lastPoll = 0, lastLoop = Date.now(), lastHousekeeping = 0, lastGraph = 0;
  // Code graphs (Graphify): installed once in the background, then refreshed when a repository moves – no AI tokens.
  void (async () => {
    try {
      const G = await import("../brain/graph.js");
      if (!G.graphifyBin()) { const r = await G.installGraphify(); logger.info("graphify install", r); }
      await G.refreshGraphs();
    } catch (e: any) { logger.warn("code graph setup failed", { error: e.message }); }
  })();
  let polling = false;
  const loop = async () => {
    const now = Date.now();
    const s = loadSettings();
    const interval = (isWorkingHours() ? s.limits.pollMinutes : s.limits.pollMinutesOffHours) * 60_000;
    const woke = now - lastLoop > 3 * 60_000;            // machine slept / was suspended -> catch up now
    lastLoop = now;
    if (!polling && (woke || now - lastPoll >= interval)) {
      polling = true;
      try {
        const r = await pollAll();
        if (r.items || r.tasks || r.errors.length) logger.info("poll", r);
      } catch (e: any) { logger.error("poll crashed", { error: e.message }); }
      finally { lastPoll = Date.now(); polling = false; }
    }
    try { await tick(); } catch (e: any) { logger.error("tick crashed", { error: e.message }); }
    try { await flushNotifications(); } catch (e: any) { logger.warn("flush failed", { error: e.message }); }
    try { await maybeSendCheckup(); } catch (e: any) { logger.warn("daily check-up failed", { error: e.message }); }
    if (now - lastHousekeeping > 3_600_000) { lastHousekeeping = now; try { housekeeping(); pruneChat(); } catch { /* ignore */ } }
    if (now - lastGraph > 15 * 60_000) { lastGraph = now; void import("../brain/graph.js").then((G) => G.refreshGraphs()).catch(() => {}); }
  };
  const timer = setInterval(() => void loop(), 15_000);
  const teamsTimer = setInterval(() => { void pollTeamsCommands(); }, 10_000);
  void loop();

  const shutdown = (sig: string) => {
    logger.info("aiw-agentd stopping", { sig });
    clearInterval(timer);
    clearInterval(teamsTimer);
    slack.stop();
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
