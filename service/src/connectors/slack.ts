import { httpJson } from "../core/util.js";
import { getSecret } from "../core/secrets.js";
import { logger } from "../core/log.js";
import type { ConnectionTest } from "./types.js";

/**
 * Slack adapter.
 *  - Messages: bot token + chat.postMessage (DM to the user; one thread per task).
 *  - Buttons: Socket Mode – an OUTBOUND WebSocket from this machine, so approvals work with no public URL.
 */
export interface SlackPost { channel: string; text: string; blocks?: any[]; thread_ts?: string }

async function slackApi(method: string, token: string, body: any): Promise<any> {
  const r = await httpJson(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Slack ${method} failed: ${r.error}`);
  return r;
}

export async function slackPost(p: SlackPost): Promise<{ ts: string; channel: string }> {
  const token = getSecret("slack.botToken");
  if (!token) throw new Error("Slack is not connected");
  const r = await slackApi("chat.postMessage", token, { ...p, unfurl_links: false });
  return { ts: r.ts, channel: r.channel };
}

export async function slackOpenDm(userId: string): Promise<string> {
  const token = getSecret("slack.botToken");
  if (!token) throw new Error("Slack is not connected");
  const r = await slackApi("conversations.open", token, { users: userId });
  return r.channel.id;
}

export async function testSlack(botToken: string): Promise<ConnectionTest> {
  try {
    const r = await slackApi("auth.test", botToken, {});
    return { ok: true, account: `${r.user} @ ${r.team}` };
  } catch (e: any) {
    return { ok: false, detail: e.message };
  }
}

export type SlackAction = { actionId: string; value: string; userId: string; userName?: string };

/** Socket Mode listener with automatic reconnect. Calls onAction for every button click. */
export class SlackSocket {
  private ws?: WebSocket;
  private stopped = false;
  constructor(private onAction: (a: SlackAction) => Promise<string>) {}

  async start(): Promise<void> {
    const appToken = getSecret("slack.appToken");
    if (!appToken) return;
    this.stopped = false;
    try {
      const r = await slackApi("apps.connections.open", appToken, {});
      const ws = new WebSocket(r.url);
      this.ws = ws;
      ws.onmessage = (ev) => this.handle(String(ev.data));
      ws.onclose = () => { if (!this.stopped) setTimeout(() => this.start(), 5_000); };
      ws.onerror = () => logger.warn("slack socket error");
      logger.info("slack socket mode connected");
    } catch (e: any) {
      logger.warn("slack socket mode unavailable", { error: e.message });
      if (!this.stopped) setTimeout(() => this.start(), 60_000);
    }
  }

  stop(): void { this.stopped = true; try { this.ws?.close(); } catch { /* ignore */ } }

  private async handle(raw: string): Promise<void> {
    let env: any;
    try { env = JSON.parse(raw); } catch { return; }
    if (env.type === "disconnect") { try { this.ws?.close(); } catch { /* reconnects */ } return; }
    if (env.envelope_id) this.ws?.send(JSON.stringify({ envelope_id: env.envelope_id })); // ack within 3s
    if (env.type !== "interactive" || env.payload?.type !== "block_actions") return;
    const p = env.payload;
    for (const a of p.actions ?? []) {
      try {
        const reply = await this.onAction({ actionId: a.action_id, value: a.value, userId: p.user?.id, userName: p.user?.username });
        if (p.response_url && reply) {
          await fetch(p.response_url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: reply, replace_original: false }) });
        }
      } catch (e: any) {
        logger.error("slack action failed", { error: e.message });
      }
    }
  }
}

/** Manifest the user pastes at api.slack.com/apps -> "Create from manifest". */
export const SLACK_APP_MANIFEST = {
  display_information: { name: "AI Workforce", description: "Your local AI team member", background_color: "#14284b" },
  features: { bot_user: { display_name: "AI Workforce", always_online: false } },
  oauth_config: { scopes: { bot: ["chat:write", "im:write"] } },
  settings: { interactivity: { is_enabled: true }, socket_mode_enabled: true, org_deploy_enabled: false, token_rotation_enabled: false },
};
