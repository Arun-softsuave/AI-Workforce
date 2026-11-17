import { db, audit } from "../core/db.js";
import { setSecret, deleteSecret, type SecretName } from "../core/secrets.js";
import { nowIso } from "../core/util.js";
import { createJiraClient, testJira, normaliseJiraSite, type JiraClient } from "./jira.js";
import { forgetAtlassianLogin } from "./atlassianMcp.js";   // also registers the browser-sign-in Jira client
import { createGitHubClient, testGitHub, tokenFromGhCli, type GitHubClient } from "./github.js";
import { testSlack, slackOpenDm } from "./slack.js";
import { testTeams } from "./teams.js";
import { testNotion, testFigma, NOTION_MCP } from "./docs.js";
import { forgetMcpLogin } from "./mcpOAuth.js";
import { teamsPersonal, NOTES_CHAT, AIW_PREFIX } from "./teamsPersonal.js";

const TEAMS_HELP_SHORT = 'Reply here with "aiw help" to see commands, e.g. "aiw inbox" or "aiw approve KAN-42@nue-backend".';
import type { ConnectionTest } from "./types.js";
import { publish } from "../live/bus.js";

export const PROVIDERS = ["jira", "github", "slack", "teams", "teams-personal", "notion", "figma"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ConnectionRow { provider: string; account: string | null; scopes: string | null; status: string; meta: string | null; updated_at: string }

/** Injection points so tests (and future adapters) can replace real clients. */
export const clients = {
  jira: (): JiraClient | undefined => createJiraClient(),
  github: (): GitHubClient | undefined => createGitHubClient(),
};

export function listConnections(): ConnectionRow[] {
  return db().prepare("SELECT * FROM connections ORDER BY provider").all() as unknown as ConnectionRow[];
}

export function isConnected(p: Provider): boolean {
  return !!db().prepare("SELECT 1 FROM connections WHERE provider=? AND status='connected'").get(p);
}

export function connectionMeta(p: Provider): any {
  const r = db().prepare("SELECT meta FROM connections WHERE provider=?").get(p) as { meta: string } | undefined;
  return r?.meta ? JSON.parse(r.meta) : {};
}

function record(p: Provider, t: ConnectionTest, meta: Record<string, unknown>, status = "connected"): void {
  db().prepare(`INSERT INTO connections (provider, account, scopes, status, meta, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(provider) DO UPDATE SET account=excluded.account, scopes=excluded.scopes, status=excluded.status, meta=excluded.meta, updated_at=excluded.updated_at`)
    .run(p, t.account ?? null, (t.scopes ?? []).join(","), status, JSON.stringify(meta), nowIso());
  audit("user", "connector.connect", p, { account: t.account, status });
  publish("connector", { provider: p, status });
}

export function markConnection(p: Provider, status: "connected" | "expired" | "pending-admin" | "error", detail?: string): void {
  db().prepare("UPDATE connections SET status=?, meta=json_set(coalesce(meta,'{}'),'$.lastError',?), updated_at=? WHERE provider=?")
    .run(status, detail ?? null, nowIso(), p);
  publish("connector", { provider: p, status });
}

export interface ConnectParams {
  site?: string; email?: string; token?: string; fromGh?: boolean;
  botToken?: string; appToken?: string; userId?: string; webhookUrl?: string; pendingAdmin?: boolean;
  chatId?: string; chatTitle?: string; mode?: "self" | "bot"; ownerId?: string; ownerName?: string;
}

/** Test credentials, then store secrets in the OS vault and record the connection. Nothing is stored if the test fails. */
export async function connect(p: Provider, c: ConnectParams): Promise<ConnectionTest> {
  const put = (n: SecretName, v?: string) => { if (v) setSecret(n, v); };
  let t: ConnectionTest;
  switch (p) {
    case "jira": {
      if (!c.site || !c.email || !c.token) return { ok: false, detail: "site, email and API token are required" };
      const site = new URL(normaliseJiraSite(c.site)).host;
      t = await testJira(site, c.email.trim(), c.token.trim());
      if (t.ok) { put("jira.token", c.token.trim()); record(p, t, { site, email: c.email.trim() }); }
      return t;
    }
    case "github": {
      const token = c.token ?? (c.fromGh ? tokenFromGhCli() : undefined);
      if (!token) return { ok: false, detail: "Provide a token or log in with `gh auth login` and use --from-gh" };
      t = await testGitHub(token);
      if (t.ok) { put("github.token", token); record(p, t, { source: c.fromGh ? "gh-cli" : "token" }); }
      return t;
    }
    case "slack": {
      if (c.pendingAdmin) { record(p, { ok: true, account: "pending admin approval" }, {}, "pending-admin"); return { ok: true, detail: "Marked pending admin approval" }; }
      if (!c.botToken || !c.userId) return { ok: false, detail: "bot token (xoxb-…) and your Slack member ID are required" };
      t = await testSlack(c.botToken);
      if (t.ok) {
        put("slack.botToken", c.botToken); put("slack.appToken", c.appToken);
        let dm: string | undefined;
        try { dm = await slackOpenDm(c.userId); } catch { /* opened lazily later */ }
        record(p, t, { userId: c.userId, dmChannel: dm, socketMode: !!c.appToken });
      }
      return t;
    }
    case "teams": {
      if (!c.webhookUrl) return { ok: false, detail: "Teams Workflows webhook URL is required" };
      t = await testTeams(c.webhookUrl);
      if (t.ok) { put("teams.webhookUrl", c.webhookUrl); record(p, t, { mode: "workflows-webhook" }); }
      return t;
    }
    case "teams-personal": {
      // Sign-in happens beforehand (device code, see `aiw connect teams-personal`); here we verify and record the chat.
      const tp = await teamsPersonal();
      if (!tp.hasSavedLogin()) return { ok: false, detail: "Not signed in to Teams (personal) yet" };
      try {
        const me = await tp.whoAmI();
        const mode = c.mode ?? "self";
        const chatId = c.chatId ?? NOTES_CHAT;
        if (mode === "bot" && (!c.ownerId || chatId === NOTES_CHAT)) return { ok: false, detail: "Bot mode needs the 1:1 chat with your own account" };
        const hello = mode === "bot"
          ? `${AIW_PREFIX}\nHi${c.ownerName ? ` ${c.ownerName}` : ""}! I'm your AI Workforce assistant. I'll send your task updates here.\n\n${TEAMS_HELP_SHORT}`
          : `${AIW_PREFIX}\nConnected. Notifications will arrive here.\n\n${TEAMS_HELP_SHORT}`;
        await tp.sendMessage(chatId, hello);
        t = { ok: true, account: me.mri };
        record(p, t, { mode, chatId, chatTitle: c.chatTitle ?? (chatId === NOTES_CHAT ? "Notes (your private chat)" : chatId), self: me.mri, ownerId: c.ownerId, ownerName: c.ownerName });
      } catch (e: any) { t = { ok: false, detail: e.message }; }
      return t;
    }
    case "notion": {
      if (!c.token) return { ok: false, detail: "Notion integration token is required" };
      t = await testNotion(c.token);
      if (t.ok) { put("notion.token", c.token); record(p, t, {}); }
      return t;
    }
    case "figma": {
      if (!c.token) return { ok: false, detail: "Figma personal access token is required" };
      t = await testFigma(c.token);
      if (t.ok) { put("figma.token", c.token); record(p, t, {}); }
      return t;
    }
  }
}

/** Jira connected through the browser sign-in (Atlassian MCP, OAuth). */
export function recordJiraOAuth(site: string, cloudId: string, account: string, email?: string): void {
  record("jira", { ok: true, account }, { auth: "atlassian-oauth", site, cloudId, email });
  deleteSecret("jira.token");            // the API token is no longer needed – don't keep unused credentials
}

/** Notion connected through the browser sign-in (Notion's MCP server, OAuth). */
export function recordNotionOAuth(account: string): void {
  record("notion", { ok: true, account }, { auth: "notion-oauth" });
  deleteSecret("notion.token");          // the integration token is no longer needed
}

/** Figma through the desktop app's MCP server (no token). An existing token is kept as a fallback for files not open in the app. */
export function recordFigmaDesktop(tools: string[]): void {
  record("figma", { ok: true, account: "Figma desktop app" }, { auth: "figma-desktop", tools });
}

/** GitHub through the GitHub CLI's browser sign-in (`gh auth login --web`). */
export function recordGitHubBrowser(t: ConnectionTest, token: string): void {
  setSecret("github.token", token);
  record("github", t, { source: "gh-cli", auth: "browser" });
}

export function disconnect(p: Provider): void {
  const names: Record<Provider, SecretName[]> = {
    jira: ["jira.token"], github: ["github.token"], slack: ["slack.botToken", "slack.appToken"],
    teams: ["teams.webhookUrl"], "teams-personal": [], notion: ["notion.token"], figma: ["figma.token"],
  };
  names[p].forEach(deleteSecret);
  if (p === "jira") forgetAtlassianLogin();
  if (p === "notion") forgetMcpLogin(NOTION_MCP);
  if (p === "teams-personal") teamsPersonal().then((tp) => tp.logout()).catch(() => {});
  db().prepare("DELETE FROM connections WHERE provider=?").run(p);
  audit("user", "connector.disconnect", p);
}
