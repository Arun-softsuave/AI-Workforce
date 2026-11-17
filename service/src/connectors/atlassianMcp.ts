import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { readSecure, writeSecure, deleteSecure } from "../core/secureStore.js";
import { logger } from "../core/log.js";
import { mapJiraIssue, JIRA_FIELDS, registerJiraMcpFactory, type JiraClient } from "./jira.js";
import type { WorkItem } from "./types.js";

/**
 * Jira via Atlassian's official remote MCP server (mcp.atlassian.com) – sign in with your Atlassian account in the
 * browser (OAuth 2.1, dynamic client registration, PKCE). No API token and no client secret.
 * The browser redirects back to a short-lived listener on 127.0.0.1, so it works with the local-only design.
 * Tokens: encrypted file + key in the OS vault (secureStore). The SDK refreshes them automatically.
 */
export const ATLASSIAN_MCP_URL = process.env.AIW_ATLASSIAN_MCP ?? "https://mcp.atlassian.com/v1/mcp";
const CALLBACK_PORT = Number(process.env.AIW_OAUTH_PORT ?? 47831);
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/oauth/atlassian/callback`;
const STORE = "atlassian-oauth";

interface Stored { client?: any; tokens?: any; verifier?: string; redirect?: string }

class Provider implements OAuthClientProvider {
  authUrl?: URL;
  constructor(private interactive: boolean) {}
  private get s(): Stored { return readSecure<Stored>(STORE) ?? {}; }
  private save(p: Partial<Stored>) { writeSecure(STORE, { ...this.s, ...p, redirect: REDIRECT }); }
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() {
    return { client_name: "AI Workforce (local)", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none" } as any;
  }
  // a registration made for another redirect URL can't be reused
  clientInformation() { const s = this.s; return s.redirect === REDIRECT ? s.client : undefined; }
  saveClientInformation(c: any) { this.save({ client: c }); }
  tokens() { return this.s.tokens; }
  saveTokens(t: any) { this.save({ tokens: t }); }
  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new Error("Atlassian sign-in expired – run `aiw connect jira` to sign in again");
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) { this.save({ verifier: v }); }
  codeVerifier() { const v = this.s.verifier; if (!v) throw new Error("missing PKCE verifier"); return v; }
}

export const hasAtlassianLogin = () => !!readSecure<Stored>(STORE)?.tokens;
export const forgetAtlassianLogin = () => deleteSecure(STORE);

async function connect(interactive = false): Promise<{ client: Client; provider: Provider; transport: StreamableHTTPClientTransport }> {
  const provider = new Provider(interactive);
  const transport = new StreamableHTTPClientTransport(new URL(ATLASSIAN_MCP_URL), { authProvider: provider });
  const client = new Client({ name: "ai-workforce", version: "0.1.0" });
  await client.connect(transport);
  return { client, provider, transport };
}

/**
 * Interactive browser sign-in. `onUrl` receives the Atlassian sign-in URL (also opened in the default browser).
 * Resolves once the user approved access and the first MCP connection succeeded.
 */
export async function atlassianLogin(onUrl: (url: string) => void, timeoutMs = 10 * 60_000): Promise<void> {
  const provider = new Provider(true);
  const transport = new StreamableHTTPClientTransport(new URL(ATLASSIAN_MCP_URL), { authProvider: provider });
  const client = new Client({ name: "ai-workforce", version: "0.1.0" });
  try {
    await client.connect(transport);           // already signed in (valid/refreshable tokens)
    await client.close();
    return;
  } catch (e) {
    if (!(e instanceof UnauthorizedError) && !provider.authUrl) throw e;
  }
  if (!provider.authUrl) throw new Error("Atlassian did not return a sign-in URL");
  const code = await waitForCallback(provider.authUrl.toString(), onUrl, timeoutMs);
  await transport.finishAuth(code);
  const again = await connect(false);          // proves the tokens work
  await again.client.close();
}

function waitForCallback(authUrl: string, onUrl: (url: string) => void, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT);
      if (u.pathname !== "/oauth/atlassian/callback") { res.writeHead(404).end(); return; }
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error_description") ?? u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:system-ui;padding:40px"><h2>${code ? "Signed in to Atlassian ✔" : "Sign-in failed"}</h2><p>${code ? "You can close this tab and return to Claude Code." : String(err ?? "No code received")}</p></body></html>`);
      clearTimeout(timer); server.close();
      if (code) resolve(code); else reject(new Error(`Atlassian sign-in failed: ${err ?? "no code"}`));
    });
    const timer = setTimeout(() => { server.close(); reject(new Error("Sign-in timed out (10 minutes)")); }, timeoutMs);
    server.once("error", (e: any) => reject(new Error(e.code === "EADDRINUSE" ? `Port ${CALLBACK_PORT} is busy – close the other sign-in or set AIW_OAUTH_PORT` : e.message)));
    server.listen(CALLBACK_PORT, "127.0.0.1", () => { onUrl(authUrl); openBrowser(authUrl); });
  });
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url.replace(/&/g, "^&")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch { /* the URL is printed too */ }
}

// ------------------------------------------------------------------ tool calls

let shared: Promise<Client> | undefined;
async function client(): Promise<Client> {
  if (!shared) shared = connect(false).then((c) => c.client).catch((e) => { shared = undefined; throw e; });
  return shared;
}

/** Call an Atlassian MCP tool and parse its JSON text result. One reconnect on failure (expired session). */
export async function callAtlassian(name: string, args: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const c = await client();
      const r: any = await c.callTool({ name, arguments: args });
      const text = (r.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
      if (r.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
      try { return JSON.parse(text); } catch { return text; }
    } catch (e: any) {
      shared = undefined;
      if (attempt >= 1 || /expired|sign in again/i.test(e.message)) throw e;
    }
  }
}

export async function listAtlassianTools(): Promise<string[]> {
  return ((await (await client()).listTools()).tools ?? []).map((t) => t.name);
}

/** Atlassian sites (cloud ids) this login can access. */
export async function accessibleSites(): Promise<{ id: string; url: string; name: string }[]> {
  const r = await callAtlassian("getAccessibleAtlassianResources", {});
  const list = Array.isArray(r) ? r : r?.resources ?? r?.sites ?? [];
  return list.map((x: any) => ({ id: x.id ?? x.cloudId, url: x.url, name: x.name ?? x.url }));
}

export async function atlassianUser(): Promise<{ accountId: string; displayName: string; email?: string }> {
  const r = await callAtlassian("atlassianUserInfo", {});
  return { accountId: r.account_id ?? r.accountId, displayName: r.name ?? r.displayName ?? r.email, email: r.email };
}

/** JiraClient on top of Atlassian's MCP tools – same interface the rest of the plugin already uses. */
export function createJiraMcpClient(site: string, cloudId: string): JiraClient {
  const base = site.startsWith("http") ? site.replace(/\/$/, "") : `https://${site}`;
  const issues = (r: any): any[] => (Array.isArray(r) ? r : r?.issues ?? r?.values ?? []);
  return {
    site: base,
    async myself() { const u = await atlassianUser(); return { accountId: u.accountId, displayName: u.displayName }; },
    async search(jql, max = 100) {
      const out: WorkItem[] = [];
      let nextPageToken: string | undefined;
      do {
        const r = await callAtlassian("searchJiraIssuesUsingJql", { cloudId, jql, fields: JIRA_FIELDS, maxResults: Math.min(100, max - out.length), ...(nextPageToken ? { nextPageToken } : {}) });
        for (const i of issues(r)) out.push(mapJiraIssue(base, i));
        nextPageToken = r?.nextPageToken;
      } while (nextPageToken && out.length < max);
      return out;
    },
    async getIssue(key) {
      try { const r = await callAtlassian("getJiraIssue", { cloudId, issueIdOrKey: key, fields: JIRA_FIELDS }); return r?.key ? mapJiraIssue(base, r) : undefined; }
      catch (e: any) { if (/404|does not exist|not found/i.test(e.message)) return undefined; throw e; }
    },
    async addComment(key, text) { await callAtlassian("addCommentToJiraIssue", { cloudId, issueIdOrKey: key, commentBody: text }); },
  };
}

registerJiraMcpFactory(createJiraMcpClient);
logger.debug("atlassian mcp connector loaded");
