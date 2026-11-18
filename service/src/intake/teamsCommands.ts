import path from "node:path";
import { logChat, getFocus, setFocus, refsIn } from "../notify/chatLog.js";
import { getMeta, setMeta, delMeta, audit } from "../core/db.js";
import { normalize, hasAttachments, learnServerId, recordSent, recordReceived, resolveQuoted, routeTarget, type InboundMessage, type ResolveOpts } from "./teamsMessage.js";
import { isOwnerOrder } from "../policy/untrusted.js";
import { getTask } from "../engine/tasks.js";
import { getApproval } from "../approvals/approvals.js";
import { pendingItems } from "./teamsIntent.js";
import type { TeamsPersonalClient } from "../connectors/teamsPersonal.js";
import { loadSettings } from "../core/config.js";
import { logger } from "../core/log.js";
import { truncate } from "../core/util.js";
import { connectionMeta, isConnected } from "../connectors/registry.js";
import { teamsPersonal, AIW_PREFIX } from "../connectors/teamsPersonal.js";
import { decideAndApply, startAwaiting, cancelTask, resumeTask, tick, answerTask } from "../engine/engine.js";
import { inboxView, inboxSummaryLine, taskDetail } from "../api/ops.js";
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
  "• \"no need to ask for approval\", \"only backend\", \"from now on raise draft PRs\" – a rule I keep (said back once)",
  "• \"KAN-47 first, it's urgent\" · \"pause everything until Monday\" · \"stop, I'll do KAN-45 myself\" / \"continue KAN-45\" · \"undo that\"",
  "• \"why did you …?\" – I explain from the plan and the history · reply to one of my messages to answer exactly that question",
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
      // the same start as "start KAN-45" in words: someone else's ticket is asked first, a repository not on this
      // computer is offered for cloning, a ticket already in progress is reported – never started twice
      const { toolStart } = await import("../conductor/tools.js");
      const r = await toolStart({ ref: c.ref.toUpperCase() } as any, { who, original: `start ${c.ref}` } as any);
      if (r.ask) { const { setAwaiting } = await import("../conductor/state.js"); setAwaiting({ type: "conductor", question: r.ask.question, calls: r.ask.calls, options: r.ask.options, at: Date.now() } as any); return [r.reply, r.ask.question].filter(Boolean).join("\n\n"); }
      return r.reply;
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
  // "start KAN-62" (a ticket, a Jira link): the full start – someone else's ticket, an open PR, a missing clone are
  // checked there (B5, B6, M6). Only "start all" stays the old command (start everything waiting to start).
  if (c.cmd === "start" && c.ref && !/^all$/i.test(c.ref)) return true;
  // "approve KAN-104 and start KAN-105", "cancel KAN-48 please": more words than the command – read the whole message (J3)
  if (["approve", "cancel", "resume", "run", "show", "start"].includes(c.cmd) && c.reason) return true;
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
    const send = (reply: string, itemId?: string) => sendReply(client, chat, botMode, reply, itemId);
    for (const m of msgs) {
      last = m.time > last ? m.time : last;
      const nm = normalize(m);
      // our own messages coming back: link the client id we sent with the server id Teams gave it (quotes carry the server id)
      if (m.clientMessageId && m.id && (botMode ? m.isMine : m.text.trim().startsWith(AIW_PREFIX))) learnServerId(m.clientMessageId, m.id);
      // self mode: only the signed-in user; bot mode: only the configured owner (never the bot itself).
      // No chat-id comparison: messages are read from the configured chat already, and Teams may spell a 1:1 chat's
      // id differently (partner id vs "19:…" thread id) – comparing would silently drop every command.
      const fromOwner = !(botMode && m.isMine) && isOwnerOrder("teams", m.fromId, {
        mode: botMode ? "bot" : "self", ownerId: meta.ownerId, isMine: botMode ? undefined : m.isMine,   // the bot's own messages: m.isMine above
      });
      if (!fromOwner) continue;
      if (m.text.trim().startsWith(AIW_PREFIX)) continue;       // our own notifications
      const files = hasAttachments(nm);
      const quoted = nm.replyTo ? resolveQuoted(nm.replyTo, { isOpen: questionIsOpen }) : undefined;
      let meaning = interpret(m.text, botMode);
      // own Notes chat: a reply that quotes one of our messages is meant for us even without "aiw"
      if (!meaning && m.text.trim() && quoted?.bot && quoted.itemId) meaning = { kind: "question", text: m.text.trim() };
      if (!meaning && !files) continue;                          // picture-only and file-only messages are kept
      if (handled >= 10) break;                                  // runaway protection
      const seenKey = `teams_personal.seen.${m.id}`;
      if (getMeta(seenKey)) continue;
      setMeta(seenKey, "1");
      const who = (botMode ? meta.ownerName : undefined) || loadSettings().profile.name || "Teams user";
      if (m.text.trim()) logChat("in", m.text.trim());           // tokens / keys are blanked in the history
      let reply: string;
      // "qa token <access> [refresh]" – a session for testing the live local app, saved in the OS credential vault
      if (/^\s*qa\s+token\b/i.test(m.text)) {
        reply = await saveTokenFromChat(m.text.replace(/^\s*qa\s+token\b[:\s]*/i, ""));
        try { await send(reply); } catch { /* best effort */ }
        audit(`user:${who}`, "qa.token.saved", undefined, {});
        handled++;
        continue;
      }
      // Which item this is for: a quoted message of ours > the focus item > a key in the text > ask.
      const route = routeTarget(nm, getFocus(), { isOpen: questionIsOpen, candidates: files ? waitingRefs() : [] });
      const routedItem = route.kind === "item" ? route.itemId : undefined;
      const parts: string[] = [];
      let handleText = !!meaning;
      let rowId: number | undefined;
      try {
        if (route.kind === "item" && route.via === "quote" && route.notice) {
          // quoting a question that was already answered: say so instead of answering twice
          recordReceived(nm, { itemId: route.itemId });
          parts.push(route.notice);
          handleText = false;
        } else {
          rowId = recordReceived(nm, route.kind === "item" ? { itemId: route.itemId, questionKey: route.via === "quote" ? route.questionKey : undefined } : {});
          if (route.kind === "item" && route.via === "quote") setFocus(route.itemId);   // "1" / "yes" now go to the quoted item
          if (files) {
            if (route.kind === "item") {
              parts.push(await saveMessageInputs(client, chat, nm, route.itemId));
              // with a picture or file, the words go on only when they are a command or that item waits for an answer
              handleText = !!meaning && (meaning.kind === "command" || waitingRefs().includes(route.itemId));
            } else {
              setMeta(PENDING_INPUTS, JSON.stringify({ msg: nm, at: Date.now() }));
              parts.push(route.question);
              handleText = false;
            }
          } else {
            // the answer to "Is this for KAN-52 or KAN-35?" after a picture or file
            const pending = takePendingInputs(m.text, routedItem);
            if (pending) {
              parts.push(await saveMessageInputs(client, chat, pending.msg, pending.itemId));
              if (pending.onlyKey) handleText = false;
            }
          }
        }
        if (handleText && meaning) {
          // Background work started by this message waits until the reply is posted (holdTicks/releaseTicks).
          parts.push(await holdTicks(async () => {
            if (meaning.kind === "command" && !needsNaturalHandling(meaning.cmd)) {
              audit(`user:${who}`, "teams.command", meaning.cmd.ref, { cmd: meaning.cmd.cmd });
              return executeCommand(meaning.cmd, who);
            }
            // Plain language: "plan for KAN-42", "yes", "2", "no – use the validator", "add a CSV export"…
            const said = meaning.kind === "command" ? m.text.trim().replace(/^aiw\b[:,]?\s*/i, "") : meaning.text;
            // W1a: a quoted bot message names the item and question exactly; a quoted person's text is context (data)
            return handleChatMessage(said, who, {
              ...(route.kind === "item" && route.via === "quote" ? { quotedItem: route.itemId, quotedQuestion: route.questionKey } : {}),
              ...(route.quotedContext ? { quotedContext: route.quotedContext } : {}),
              fromMsg: rowId ?? null,
            });
          }));
        }
      } catch (e: any) { parts.push(`Error: ${e.message}`); }
      reply = parts.filter(Boolean).join("\n\n") || "Got it.";
      try {
        await send(reply, routedItem);
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

/** Post a reply (split when long), keep it in the chat history and remember each part's Teams id. */
async function sendReply(client: TeamsPersonalClient, chat: string, botMode: boolean, reply: string, itemId?: string): Promise<void> {
  // R-MSG: a long reply (status lists, long answers) is cut to its first lines; the rest comes on "more"
  { const { shortenReply } = await import("../messenger/details.js"); reply = shortenReply(reply); }
  const sent: { part: string; r: Awaited<ReturnType<TeamsPersonalClient["sendMessage"]>> | undefined }[] = [];
  for (const part of splitMessage(reply)) sent.push({ part, r: await client.sendMessage(chat, botMode ? part : `${AIW_PREFIX}\n${part}`) });
  logChat("out", reply, { kind: "chat" });
  for (const { part, r } of sent) recordSent({ msgId: r?.messageId ?? r?.id ?? null, clientMsgId: r?.clientmessageid ?? null, itemId: itemId ?? null, text: part });
}

/**
 * Is the question behind a quoted message still open? Approval ids: the approval is still pending. Question keys
 * ("q:…"): the item still waits for an answer. Undefined (unknown) when the message asked nothing.
 */
const questionIsOpen: ResolveOpts["isOpen"] = (itemId, key) => {
  if (!key) return undefined;
  try {
    if (key.startsWith("q:")) { const t = getTask(itemId); return t ? t.state === "NEEDS_INFO" : undefined; }
    const a = getApproval(key);
    return a ? a.state === "pending" : undefined;
  } catch { return undefined; }
};

/** Items waiting for the user (questions first, then approvals, then start requests). */
function waitingRefs(): string[] {
  try {
    const p = pendingItems();
    return [...new Set([...p.questions, ...p.approvals.map((x) => x.task), ...p.starts].map((t) => t.source_ref ?? t.id))];
  } catch { return []; }
}

const PENDING_INPUTS = "teams.pending_inputs";
const PENDING_MS = 30 * 60_000;

/**
 * Pictures or files sent while it was unclear which item they belong to wait here until the next message names the
 * item ("KAN-52"). `onlyKey`: the reply was just the item, so it needs no further handling.
 */
function takePendingInputs(text: string, routed: string | undefined): { msg: InboundMessage; itemId: string; onlyKey: boolean } | undefined {
  const raw = getMeta(PENDING_INPUTS);
  if (!raw) return undefined;
  let p: { msg: InboundMessage; at: number } | undefined;
  try { p = JSON.parse(raw); } catch { p = undefined; }
  if (!p || Date.now() - p.at > PENDING_MS) { delMeta(PENDING_INPUTS); return undefined; }
  const keys = refsIn(text);
  const itemId = keys.length === 1 ? keys[0] : undefined;
  if (!itemId) return undefined;
  delMeta(PENDING_INPUTS);
  const rest = text.replace(/\b[A-Za-z][A-Za-z0-9]+-\d+(@[\w-]+)?\b/g, "").replace(/\b(it'?s|it is|for|this is|that'?s|the|ticket|yes|please)\b/gi, "").replace(/[\s.,!?:;-]+/g, "");
  return { msg: p.msg, itemId: itemId ?? routed!, onlyKey: !rest };
}

/**
 * Save a message's pictures and files on an item (knowledge/inputs.ts) and return the one-line confirmation.
 * Text read from a picture or file is stored as data for the agents – it never becomes a command here.
 */
async function saveMessageInputs(client: TeamsPersonalClient, chat: string, msg: InboundMessage, itemId: string): Promise<string> {
  if (!client.readAttachment) return `I can't read pictures or files with this Teams connection yet, so nothing was added to ${itemId}.`;
  const { saveInputs } = await import("../knowledge/inputs.js");
  const notes: string[] = [];
  const r = await saveInputs(msg, itemId, {
    download: (att) => client.readAttachment!(chat, msg.id, att.index),
    describeImage: (img) => describeImage(img.path, img.name, itemId),
    onSuspicious: (note) => {
      if (!note) return;
      notes.push(note);
      audit("service", "input.suspicious", itemId, { note });
    },
  });
  audit("service", "input.saved", itemId, { saved: r.saved.length, refused: r.refused.length });
  return [r.confirmation, ...new Set(notes)].join("\n");
}

/** The small "image-describer" agent: what the picture shows and any error text (data, not instructions). */
async function describeImage(file: string, name: string, itemId: string): Promise<string> {
  const { getRunner } = await import("../agents/runner.js");
  const { AGENTS } = await import("../agents/catalog.js");
  const { recordUsage } = await import("../engine/tasks.js");
  const a = AGENTS["image-describer"];
  const r = await getRunner().run({
    agent: "image-describer", tier: a.tier, system: a.system, schema: a.schema,
    prompt: `Describe the picture saved as ${path.basename(file)} (sent for ${itemId}, name "${name}"). Open it with the Read tool.`,
    tools: ["Read"], allow: ["Read"], cwd: path.dirname(file),
  });
  recordUsage("teams:image", r, { agent: "image-describer", taskId: getTask(itemId)?.id });
  if (!r.ok) return "";
  const d = r.data ?? {};
  const summary = String(d.summary ?? r.text ?? "").trim();
  const err = String(d.errorText ?? "").trim();
  return err ? `${summary} Error shown: ${err}` : summary;
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
