import { httpJson } from "../core/util.js";
import { getSecret } from "../core/secrets.js";
import type { ConnectionTest } from "./types.js";

/**
 * Microsoft Teams adapter – v1 uses a Teams *Workflows* webhook ("Post to a channel when a webhook
 * request is received"). Outbound only, no admin consent, works locally.
 * Interactive buttons are NOT possible locally (they need a public bot endpoint), so messages carry
 * links/commands and approval happens in Claude Code, the local dashboard or Slack.
 * Decision: Graph-based DMs are deferred (need tenant admin consent); the adapter boundary allows adding them.
 */
export async function teamsPost(title: string, text: string, facts: [string, string][] = [], url?: string, webhookUrl?: string): Promise<void> {
  const hook = webhookUrl ?? getSecret("teams.webhookUrl");
  if (!hook) throw new Error("Teams is not connected");
  const card = {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard", version: "1.4",
        body: [
          { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
          { type: "TextBlock", text, wrap: true },
          ...(facts.length ? [{ type: "FactSet", facts: facts.map(([title, value]) => ({ title, value })) }] : []),
        ],
        actions: url ? [{ type: "Action.OpenUrl", title: "Open", url }] : [],
      },
    }],
  };
  await httpJson(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(card), retries: 2 });
}

export async function testTeams(webhookUrl: string): Promise<ConnectionTest> {
  try {
    await teamsPost("AI Workforce connected", "This channel will receive AI Workforce notifications.", [], undefined, webhookUrl);
    return { ok: true, account: "Workflows webhook" };
  } catch (e: any) {
    return { ok: false, detail: e.message };
  }
}
