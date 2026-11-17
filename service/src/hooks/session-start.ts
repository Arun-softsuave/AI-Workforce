import "../core/quiet.js";

/**
 * Claude Code SessionStart hook: injects a short AI Workforce inbox summary into the session context.
 * Claude Code cannot be interrupted mid-conversation, so this (plus the status line and desktop alerts)
 * is how pending approvals and questions reach the user. Must never fail or slow the session.
 */
try {
  const { inboxView, inboxSummaryLine } = await import("../api/ops.js");
  const { readRuntime, pidAlive } = await import("../core/runtime.js");
  const fs = await import("node:fs");
  const { paths } = await import("../core/paths.js");
  if (!fs.existsSync(paths.db())) {
    console.log("AI Workforce plugin is installed but not set up yet. Suggest running /aiw-setup to the user if they ask about it.");
  } else {
    const items = inboxView(false).slice(0, 8);
    const rt = readRuntime();
    const alive = !!rt && pidAlive(rt.pid);
    const lines = [`[AI Workforce] ${inboxSummaryLine()}${alive ? "" : " · background service NOT running (suggest `aiw service start`)"}`];
    // Teams is the only channel: if it is disconnected the user hears nothing, so say it here.
    const { loadSettings } = await import("../core/config.js");
    const { isConnected } = await import("../connectors/registry.js");
    const { db } = await import("../core/db.js");
    const s = loadSettings();
    if (s.notifications.primary === "teams-personal") {
      if (!isConnected("teams-personal")) lines.push("- WARNING: the AI Workforce Teams chat is disconnected, so plans, questions and approvals cannot reach the user. Tell them to run `aiw connect teams-personal --bot`.");
      const failed = (db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE channel='teams-personal' AND status='failed' AND attempts>=5 AND created_at >= ?").get(new Date(Date.now() - 86_400_000).toISOString()) as any).n;
      if (failed) lines.push(`- WARNING: ${failed} Teams message(s) could not be delivered in the last 24 h. Suggest \`aiw status\` and reconnecting Teams.`);
    }
    for (const i of items) lines.push(`- ${i.kind}: ${i.title}`);
    if (items.length) lines.push("Mention these to the user briefly at a natural moment. Use /aiw-inbox or the aiw MCP tools for details; never approve without the user's explicit instruction.");
    console.log(lines.join("\n"));
  }
} catch {
  // Never block a Claude Code session because of the plugin.
}
