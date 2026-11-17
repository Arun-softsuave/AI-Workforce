import { logChat } from "../notify/chatLog.js";
import { getMeta, setMeta, audit } from "../core/db.js";
import { loadSettings } from "../core/config.js";
import { logger } from "../core/log.js";
import { truncate } from "../core/util.js";
import { connectionMeta, isConnected } from "../connectors/registry.js";
import { teamsPersonal, AIW_PREFIX } from "../connectors/teamsPersonal.js";
import { decideAndApply, startAwaiting, cancelTask, resumeTask, tick, answerTask } from "../engine/engine.js";
import { inboxView, inboxSummaryLine, taskDetail } from "../api/ops.js";
import { runTicket } from "./intake.js";
import { answerQuestion, resetConversation } from "../chat/assistant.js";
import { handleChatMessage } from "./teamsIntent.js";
import { holdTicks, releaseTicks } from "../engine/engine.js";
import { splitMessage } from "../notify/channels.js";

/**
 * Two-way Teams: read the notification chat and act on the user's OWN messages that start with "aiw".
 * Messages from anyone else, and AI Workforce's own notifications, are ignored. Each message is handled once.
 */
export interface ParsedCommand { cmd: string; ref?: string; reason?: string }

export const TEAMS_HELP = [
  "Just write normally – for example:",
  "• \"plan for KAN-42\" – I analyse it and send you the plan for approval (several at once: \"work on KAN-42, KAN-43 and KAN-44\")",
  "• \"give me the PDF of KAN-42\" – the report of a finished ticket",
  "• \"add a CSV export to the orders page\" – work without a ticket: I ask about the requirements first",
  "• \"yes\" / \"1\" – approve what is waiting · \"2\" or \"no, use the existing validator\" – ask for changes · \"3\" – cancel",
  "• a number or your own words – answer my question",
  "• \"status of KAN-42?\" – where it is now",
  "• \"review PR 90\", a PR link, \"add comments on KAN-60\" or \"review Eric's PR\" – I review it (yours or a teammate's) against the ticket and the PRD and show you the comments first; \"post\" posts them",
  "• \"resolve the comments on PR 90\" (your own PR) – I fix / answer each comment and show you everything first; \"1\" pushes to the same PR and replies; then QA runs",
  "• \"PR 90 failed, fix the CI\" (your own PR) – I read the failing checks' logs, fix them and show you first; after the push I watch CI until every check passes (a check that fails again is fixed again, up to 3 rounds)",
  "• \"QA PR 90\" – the QA engineer tests it; bugs come here as issue drafts first (\"create 1, 3\", \"create all\", \"report only\") · \"fix the QA issues on PR 90\"",
  "When several things are waiting, start your reply with the ticket: \"KAN-42 1\".",
  "",
  "Exact commands still work too:",
  "• aiw inbox – what needs your attention",
  "• aiw status – summary",
  "• aiw show KAN-42@nue-backend – details of a task",
  "• aiw approve KAN-42@nue-backend",
  "• aiw reject KAN-42@nue-backend \"what to change\"",
  "• aiw answer KAN-42@nue-backend \"your answer\" – reply to a question from the agents",
  "• aiw start KAN-42 | aiw start all – start waiting tasks",
  "• aiw cancel KAN-42@nue-backend · aiw resume KAN-42@nue-backend",
  "• aiw run KAN-57 – start work on a ticket now",
  "• aiw new – start a fresh conversation",
  "",
  "Or just ask a question, e.g. \"which KAN tickets are in progress?\" or \"where is buyer input validated?\"",
  "(in your own Notes chat, start questions with \"aiw\"). I can read your code, the project Brain, tasks and Jira – I can't change anything.",
].join("\n");

export const KNOWN_COMMANDS = new Set(["help", "status", "inbox", "show", "approve", "reject", "answer", "start", "cancel", "resume", "run", "new"]);

/**
 * What a chat message means:
 *  - "aiw <known command> …"        -> command
 *  - bot chat: anything else         -> question for the assistant
 *  - own Notes chat: "aiw <question>" -> question (plain notes without "aiw" are left alone)
 */
export function interpret(text: string, botMode: boolean): { kind: "command"; cmd: ParsedCommand } | { kind: "question"; text: string } | undefined {
  // "/aiw resume kan-52@nue-backend" works like "aiw resume KAN-52@nue-backend" (Claude Code style slash, any case)
  const t = text.trim().replace(/^\/(?=aiw\b)/i, "");
  if (!t) return undefined;
  const norm = (c: ParsedCommand | undefined) => (c?.ref && /^[a-z][a-z0-9]*-\d+(@[\w-]+)?$/i.test(c.ref)
    ? { ...c, ref: c.ref.replace(/^([^@]+)(@.*)?$/, (_m, k: string, r?: string) => `${k.toUpperCase()}${(r ?? "").toLowerCase()}`) } : c);
  const parsed = norm(parseCommand(t));
  if (parsed && KNOWN_COMMANDS.has(parsed.cmd)) return { kind: "command", cmd: parsed };
  // Bot chat: commands also work without the "aiw" prefix ("approve KAN-42@nue-backend", "start all", "help").
  if (botMode) {
    const bare = norm(parseCommand(`aiw ${t}`));
    if (bare && KNOWN_COMMANDS.has(bare.cmd)) return { kind: "command", cmd: bare };
  }
  if (/^aiw\b/i.test(t)) {
    const q = t.replace(/^aiw\b[:,]?\s*/i, "").trim();
    return q ? { kind: "question", text: q } : { kind: "command", cmd: { cmd: "help" } };
  }
  return botMode ? { kind: "question", text: t } : undefined;
}

export function parseCommand(text: string): ParsedCommand | undefined {
  const t = text.trim().replace(/\s+/g, " ");
  const m = /^aiw\s+(\w[\w-]*)(?:\s+(\S+))?(?:\s+(.+))?$/i.exec(t);
  if (!m) return undefined;
  const cmd = m[1].toLowerCase();
  const reason = m[3]?.replace(/^["“']|["”']$/g, "").trim();
  return { cmd, ref: m[2], reason: reason || undefined };
}

export async function executeCommand(c: ParsedCommand, who: string): Promise<string> {
  const need = (what: string) => `Please add ${what}, e.g. "aiw ${c.cmd} KAN-42@nue-backend".`;
  switch (c.cmd) {
    case "help": return TEAMS_HELP;
    case "new": resetConversation(); return "Started a new conversation – I've forgotten our earlier messages.";
    case "status": return inboxSummaryLine();
    case "inbox": {
      const items = inboxView(false).slice(0, 10);
      return items.length ? items.map((i) => `• [${i.kind}] ${i.title}`).join("\n") : "Inbox is empty – nothing needs your attention.";
    }
    case "show": {
      if (!c.ref) return need("a task");
      const d = taskDetail(c.ref);
      if (!d) return `No task ${c.ref}.`;
      return truncate([`${d.ref} – ${d.title}`, `State: ${d.state} · size ${d.size ?? "-"} · ${d.playbook ?? ""}`,
        d.approval ? `Approval: ${d.approval.action} (${d.approval.state})` : "", d.pr ? `PR: ${d.pr}` : "", d.error ? `Note: ${d.error}` : ""].filter(Boolean).join("\n"), 1500);
    }
    case "approve": {
      if (!c.ref) return need("a task");
      return (await decideAndApply(c.ref, "approved", who, "teams-personal")).message;
    }
    case "reject": {
      if (!c.ref) return need("a task");
      if (!c.reason) return `Please say what to change: aiw reject ${c.ref} "use the existing validator"`;
      return (await decideAndApply(c.ref, "rejected", who, "teams-personal", c.reason)).message;
    }
    case "answer": {
      // "answer KAN-42@nue-backend use 2000 chars"  or  "answer use 2000 chars" (when only one task waits)
      const looksLikeRef = !!c.ref && /^[A-Z][A-Z0-9]+-\d+(@[\w-]+)?$|^t_[0-9a-f]+$/i.test(c.ref);
      const ref = looksLikeRef ? c.ref : undefined;
      const text = looksLikeRef ? (c.reason ?? "") : [c.ref, c.reason].filter(Boolean).join(" ");
      return (await answerTask(ref, text.replace(/^["“']|["”']$/g, ""), who, "teams-personal")).message;
    }
    case "start": { const n = startAwaiting(c.ref ?? "all"); await tick(); return `Started ${n} task(s).`; }
    case "cancel": { if (!c.ref) return need("a task"); const t = await cancelTask(c.ref); return t ? `${t.source_ref}: ${t.state}` : `No task ${c.ref}.`; }
    case "resume": { if (!c.ref) return need("a task"); const t = resumeTask(c.ref); await tick(); return !t ? `No task ${c.ref}.` : t.state === "QUEUED" || t.state === "RUNNING" ? `▶️ Resumed ${t.source_ref} – continuing from where it stopped.` : `${t.source_ref} can't be resumed now (it is ${t.state.toLowerCase().replace(/_/g, " ")}).`; }
    case "run": {
      if (!c.ref) return need("a Jira key");
      try { const t = await runTicket(c.ref.toUpperCase()); await tick(); return `Queued ${t.source_ref ?? c.ref}. I'll post here when the plan is ready.`; }
      catch (e: any) { return `Could not start ${c.ref}: ${e.message}`; }
    }
    default: return `Unknown command "${c.cmd}". Type "aiw help".`;
  }
}

/** A bare "approve" / "reject" / "start" (no task named) is a conversational reply, not a command. */
const NEEDS_REF = new Set(["approve", "reject", "show", "cancel", "resume", "run"]);
export function needsNaturalHandling(c: ParsedCommand): boolean {
  if (c.cmd === "resume") return true;                       // "resume", "resume KAN-52" (both halves) – handled in plain language
  if (NEEDS_REF.has(c.cmd) && !c.ref) return true;
  if (c.cmd === "start" && !c.ref) return true;
  // "run" / "show" / "cancel" with a word that is not a task ("run the tests please") – plain language
  if (["run", "show", "cancel", "resume", "approve", "reject"].includes(c.cmd) && c.ref && !/^([A-Z][A-Z0-9]+-\d+(@[\w-]+)?|t_[0-9a-f]+|a_[0-9a-f]+|TASK-\d+(@[\w-]+)?)$/i.test(c.ref)) return true;
  return false;
}

let busy = false;
let nextPollAt = 0;
let activeUntil = 0;

/** One pass: read new messages in the notification chat and handle the user's own "aiw …" commands. */
export async function pollTeamsCommands(force = false): Promise<number> {
  if (busy || !isConnected("teams-personal")) return 0;
  if (!force && Date.now() < nextPollAt) return 0;
  busy = true;
  try {
    const meta = connectionMeta("teams-personal");
    const chat: string | undefined = meta.chatId;
    if (!chat) return 0;
    const client = await teamsPersonal();
    const cursor = getMeta("teams_personal.cursor") ?? new Date().toISOString();   // first run starts "now": no replays
    const msgs = (await client.getMessages(chat, cursor))
      .filter((m) => new Date(m.time).getTime() > new Date(cursor).getTime())
      .sort((a, b) => a.time.localeCompare(b.time));
    let handled = 0, last = cursor;
    const botMode = meta.mode === "bot";
    for (const m of msgs) {
      last = m.time > last ? m.time : last;
      // self mode: only the signed-in user; bot mode: only the configured owner (never the bot itself)
      const fromOwner = botMode ? (!m.isMine && !!meta.ownerId && m.fromId === meta.ownerId) : m.isMine;
      if (!fromOwner) continue;
      if (m.text.trim().startsWith(AIW_PREFIX)) continue;       // our own notifications
      const meaning = interpret(m.text, botMode);
      if (!meaning) continue;
      if (handled >= 10) break;                                  // runaway protection
      const seenKey = `teams_personal.seen.${m.id}`;
      if (getMeta(seenKey)) continue;
      setMeta(seenKey, "1");
      const who = (botMode ? meta.ownerName : undefined) || loadSettings().profile.name || "Teams user";
      logChat("in", m.text.trim());                              // tokens / keys are blanked in the history
      let reply: string;
      // "qa token <access> [refresh]" – a session for testing the live local app, saved in the OS credential vault
      if (/^\s*qa\s+token\b/i.test(m.text)) {
        reply = await saveTokenFromChat(m.text.replace(/^\s*qa\s+token\b[:\s]*/i, ""));
        try { for (const part of splitMessage(reply)) await client.sendMessage(chat, botMode ? part : `${AIW_PREFIX}\n${part}`); logChat("out", reply, { kind: "chat" }); } catch { /* best effort */ }
        audit(`user:${who}`, "qa.token.saved", undefined, {});
        handled++;
        continue;
      }
      try {
        // Background work started by this message waits until the reply is posted (holdTicks/releaseTicks).
        reply = await holdTicks(async () => {
          if (meaning.kind === "command" && !needsNaturalHandling(meaning.cmd)) {
            audit(`user:${who}`, "teams.command", meaning.cmd.ref, { cmd: meaning.cmd.cmd });
            return executeCommand(meaning.cmd, who);
          }
          // Plain language: "plan for KAN-42", "yes", "2", "no – use the validator", "add a CSV export"…
          const said = meaning.kind === "command" ? m.text.trim().replace(/^aiw\b[:,]?\s*/i, "") : meaning.text;
          return handleChatMessage(said, who);
        });
      } catch (e: any) { reply = `Error: ${e.message}`; }
      try {
        for (const part of splitMessage(reply)) await client.sendMessage(chat, botMode ? part : `${AIW_PREFIX}\n${part}`);
        logChat("out", reply, { kind: "chat" });
      } finally { await releaseTicks(); }
      handled++;
      activeUntil = Date.now() + 10 * 60_000;
    }
    setMeta("teams_personal.cursor", last);
    return handled;
  } catch (e: any) {
    logger.warn("teams-personal command poll failed", { error: e.message });
    return 0;
  } finally {
    busy = false;
    nextPollAt = Date.now() + (Date.now() < activeUntil ? 10_000 : 30_000);   // quicker while you're chatting
  }
}

/** A session pasted in the bot chat ("qa token <access> [refresh]") – saved for the product QA asked about. */
async function saveTokenFromChat(text: string): Promise<string> {
  const { parseTokenInput, saveSession, jwtSecondsLeft } = await import("../engine/qaSession.js");
  const { loadProjects } = await import("../core/config.js");
  const { backendOf } = await import("../engine/localStack.js");
  const t = parseTokenInput(text);
  if (!t) return "I didn't find a token in that message. Reply: qa token <access token> [refresh token]";
  const asked = getMeta("qa.token.asked");
  const candidates = loadProjects().filter((p) => backendOf(p));
  const project = candidates.find((p) => p.id === asked) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!project) return `Which app is this session for? On this computer run: aiw qa token <project> (${candidates.map((p) => p.id).join(" / ") || "no frontend with a backend is configured"}).`;
  saveSession(project.id, t.access, t.refresh);
  const left = jwtSecondsLeft(t.access);
  return [
    `🔑 Saved the test session for **${project.id}** in the Windows credential vault${left !== undefined ? ` – valid for ${Math.max(0, Math.round(left / 60))} more minutes${t.refresh ? ", then renewed with the refresh token" : ""}` : ""}.`,
    "QA and the PR screenshots now test the live local app with it.",
    "⚠️ The token is still in this Teams chat's history – delete your message if you can, or use `aiw qa token` on this computer next time.",
  ].join("\n\n");
}
