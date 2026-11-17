import { logChat, setFocus } from "./chatLog.js";
import { execFile } from "node:child_process";
import { slackPost, slackOpenDm } from "../connectors/slack.js";
import { teamsPost } from "../connectors/teams.js";
import { connectionMeta, isConnected } from "../connectors/registry.js";
import { teamsPersonal, NOTES_CHAT, AIW_PREFIX } from "../connectors/teamsPersonal.js";
import { db } from "../core/db.js";
import type { Channel } from "../core/config.js";
import { formatQuestions, formatChoices, type Question } from "../core/questions.js";

export interface Notice {
  kind: string;                 // picked_up | needs_info | approval_needed | pr_created | failed | paused | connector_problem | digest | burst | info
  taskId?: string;
  taskRef?: string;             // e.g. PAY-142
  title: string;
  body: string;
  facts?: [string, string][];
  url?: string;                 // Jira/PR link (never a local-only link without saying so)
  approvalId?: string;
  approvalAction?: string;      // implement_plan | create_pr | confirm_requirements – decides the numbered choices
  questions?: Question[];       // needs_info: questions with numbered options
  urgent?: boolean;
  dedupeKey?: string;           // extra uniqueness (e.g. approval id, run number)
}

/** The interactive part of a message: numbered options for a question or an approval. */
export function replyBlock(n: Notice): string {
  if (n.questions?.length) return formatQuestions(n.questions);
  if (n.approvalId) return formatChoices(n.approvalAction ?? "create_pr");
  return "";
}

/**
 * Split a long Teams message so nothing is cut off (each part stays well under Teams' limit). It splits between
 * sections (blank lines) first, so a section is never torn apart; only a section longer than a whole part is split by line.
 */
export function splitMessage(text: string, max = 3500): string[] {
  if (text.length <= max) return [text];
  const pieces: { text: string; sep: string }[] = [];
  for (const block of text.split(/\n{2,}/)) {
    if (block.length <= max) { pieces.push({ text: block, sep: "\n\n" }); continue; }
    let first = true;
    for (const line of block.split("\n")) {
      for (const p of line.length > max ? line.match(new RegExp(`[\\s\\S]{1,${max}}`, "g"))! : [line]) {
        pieces.push({ text: p, sep: first ? "\n\n" : "\n" });
        first = false;
      }
    }
  }
  const parts: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + p.sep.length + p.text.length > max) { parts.push(cur); cur = ""; }
    cur = cur ? `${cur}${p.sep}${p.text}` : p.text;
  }
  if (cur) parts.push(cur);
  return parts.map((p, i) => (parts.length > 1 ? `(${i + 1}/${parts.length})\n\n${p}` : p));
}

/**
 * The chat layout of a notice: a bold title, then each part as its own block with a blank line between them
 * (Teams shows a visible gap), facts as a short list, the link, and the numbered choices last.
 */
export function chatText(n: Notice): string {
  const blocks = [`**${n.title}**`];
  if (n.body?.trim()) blocks.push(n.body.trim());
  if (n.facts?.length) blocks.push(n.facts.map(([k, v]) => `- **${k}:** ${v}`).join("\n"));
  if (n.url) blocks.push(`🔗 ${n.url}`);
  const reply = replyBlock(n);
  if (reply) blocks.push("───────────", reply);
  // When several tasks wait at once, starting the reply with the ticket tells them apart ("KAN-42 1").
  if (reply && n.taskRef) blocks.push(`(If several things are waiting, start your reply with ${n.taskRef}.)`);
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface Sender { send(n: Notice, threadRef?: string): Promise<string | undefined> }

export const ACTION_KINDS = new Set(["needs_info", "approval_needed", "failed", "paused", "burst", "connector_problem", "stale", "pr_changes_requested"]);

const commandHint = (n: Notice) =>
  n.approvalId ? `Approve: \`/aiw approve ${n.taskRef ?? n.taskId}\` · Reject: \`/aiw reject ${n.taskRef ?? n.taskId} "reason"\` (Claude Code or local dashboard on your machine)` : "";

export const senders: Record<Exclude<Channel, "inbox">, Sender> = {
  slack: {
    async send(n, threadRef) {
      if (!isConnected("slack")) throw new Error("slack not connected");
      const meta = connectionMeta("slack");
      let channel: string | undefined = meta.dmChannel;
      if (!channel) {
        channel = await slackOpenDm(meta.userId);
        db().prepare("UPDATE connections SET meta=json_set(meta,'$.dmChannel',?) WHERE provider='slack'").run(channel);
      }
      const [tCh, tTs] = (threadRef ?? "").split("|");
      const blocks: any[] = [
        { type: "section", text: { type: "mrkdwn", text: `*${n.title}*\n${n.body}${n.questions?.length ? `\n\n${formatQuestions(n.questions)}` : ""}`.slice(0, 2900) } },
      ];
      if (n.facts?.length) blocks.push({ type: "section", fields: n.facts.slice(0, 10).map(([k, v]) => ({ type: "mrkdwn", text: `*${k}*\n${v}` })) });
      if (n.url) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${n.url}|Open>` }] });
      if (n.approvalId && meta.socketMode) {
        blocks.push({ type: "actions", elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve & create PR" }, action_id: "aiw_approve", value: n.approvalId },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: "aiw_reject", value: n.approvalId },
        ] });
      } else if (n.approvalId) {
        blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: commandHint(n) }] });
      }
      const r = await slackPost({ channel: tCh || channel, text: `${n.title} – ${n.body}`.slice(0, 2900), blocks, thread_ts: tTs || undefined });
      return tTs ? threadRef : `${r.channel}|${r.ts}`;
    },
  },
  teams: {
    async send(n) {
      if (!isConnected("teams")) throw new Error("teams not connected");
      const hint = commandHint(n);
      const qs = n.questions?.length ? `\n\n${formatQuestions(n.questions)}` : "";
      await teamsPost(n.title, hint ? `${n.body}${qs}\n\n${hint}` : `${n.body}${qs}`, n.facts ?? [], n.url);
      return undefined;
    },
  },
  "teams-personal": {
    async send(n) {
      if (!isConnected("teams-personal")) throw new Error("teams-personal not connected");
      const meta = connectionMeta("teams-personal");
      const chat = meta.chatId ?? NOTES_CHAT;
      const client = await teamsPersonal();
      const text = chatText(n);
      // In bot mode the sender's name already says who it is; in your own Notes chat EVERY part carries the prefix,
      // so our own messages are never read back as your commands.
      for (const part of splitMessage(text)) await client.sendMessage(chat, meta.mode === "bot" ? part : `${AIW_PREFIX}\n${part}`);
      // remember the conversation: a reply like "1" or "you decide" is about the last thing we asked
      logChat("out", text, { kind: n.kind, taskRef: n.taskRef });
      if (n.taskRef && ["needs_info", "approval_needed", "burst", "paused", "failed", "stale"].includes(n.kind)) setFocus(n.taskRef);
      return undefined;
    },
  },
  desktop: {
    async send(n) {
      await desktopToast(n.title, n.body);
      return undefined;
    },
  },
};

/** Native OS notification, best effort, no extra dependencies. */
export function desktopToast(title: string, body: string): Promise<void> {
  if (process.env.AIW_DISABLE_DESKTOP === "1") return Promise.resolve();
  const t = title.slice(0, 120), b = body.slice(0, 240);
  return new Promise((resolve, reject) => {
    const done = (err: any) => (err ? reject(new Error(`desktop notification failed: ${err.message}`)) : resolve());
    if (process.platform === "win32") {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "''");
      const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${esc(t)}</text><text>${esc(b)}</text></binding></visual></toast>')
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 15_000 }, done);
    } else if (process.platform === "darwin") {
      execFile("osascript", ["-e", `display notification ${JSON.stringify(b)} with title ${JSON.stringify(t)}`], { timeout: 15_000 }, done);
    } else {
      execFile("notify-send", [t, b], { timeout: 15_000 }, done);
    }
  });
}
