import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { readSecure, writeSecure, deleteSecure } from "../core/secureStore.js";

/**
 * "Sign in with the browser" for any official remote MCP server that supports OAuth 2.1 with dynamic client
 * registration and PKCE – the same way Claude connects to MCP servers. No API token, no client secret:
 *   1. the plugin registers itself with the server (once),
 *   2. the browser opens the service's own sign-in / consent page,
 *   3. the service redirects back to a short-lived listener on 127.0.0.1 (local only),
 *   4. tokens are kept encrypted (key in the OS vault) and refreshed automatically.
 * Used for Notion (mcp.notion.com). Jira uses the same flow in atlassianMcp.ts.
 */
export interface McpService { id: string; label: string; url: string; store: string }

const CALLBACK_PORT = Number(process.env.AIW_OAUTH_PORT ?? 47831);
interface Stored { client?: any; tokens?: any; verifier?: string; redirect?: string }

const redirectFor = (svc: McpService) => `http://127.0.0.1:${CALLBACK_PORT}/oauth/${svc.id}/callback`;

class Provider implements OAuthClientProvider {
  authUrl?: URL;
  constructor(private svc: McpService, private interactive: boolean) {}
  private get s(): Stored { return readSecure<Stored>(this.svc.store) ?? {}; }
  private save(p: Partial<Stored>) { writeSecure(this.svc.store, { ...this.s, ...p, redirect: this.redirectUrl }); }
  get redirectUrl() { return redirectFor(this.svc); }
  get clientMetadata() {
    return { client_name: "AI Workforce (local)", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none" } as any;
  }
  clientInformation() { const s = this.s; return s.redirect === this.redirectUrl ? s.client : undefined; }   // registered for this redirect only
  saveClientInformation(c: any) { this.save({ client: c }); }
  tokens() { return this.s.tokens; }
  saveTokens(t: any) { this.save({ tokens: t }); }
  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new Error(`${this.svc.label} sign-in expired – run \`aiw connect ${this.svc.id}\` to sign in again`);
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) { this.save({ verifier: v }); }
  codeVerifier() { const v = this.s.verifier; if (!v) throw new Error("missing PKCE verifier"); return v; }
}

export const hasMcpLogin = (svc: McpService) => !!readSecure<Stored>(svc.store)?.tokens;
export const forgetMcpLogin = (svc: McpService) => { deleteSecure(svc.store); shared.delete(svc.id); };

async function open(svc: McpService, interactive: boolean) {
  const provider = new Provider(svc, interactive);
  const transport = new StreamableHTTPClientTransport(new URL(svc.url), { authProvider: provider });
  const client = new Client({ name: "ai-workforce", version: "0.2.0" });
  return { client, provider, transport };
}

/** Interactive browser sign-in. Resolves once access was granted and a real MCP connection works. */
export async function mcpLogin(svc: McpService, onUrl: (url: string) => void, timeoutMs = 10 * 60_000): Promise<void> {
  const { client, provider, transport } = await open(svc, true);
  try {
    await client.connect(transport);            // already signed in (valid or refreshable tokens)
    await client.close();
    return;
  } catch (e) {
    if (!(e instanceof UnauthorizedError) && !provider.authUrl) throw e;
  }
  if (!provider.authUrl) throw new Error(`${svc.label} did not return a sign-in URL`);
  const code = await waitForCallback(svc, provider.authUrl.toString(), onUrl, timeoutMs);
  await transport.finishAuth(code);
  const again = await open(svc, false);
  await again.client.connect(again.transport);  // proves the tokens work
  await again.client.close();
}

function waitForCallback(svc: McpService, authUrl: string, onUrl: (url: string) => void, timeoutMs: number): Promise<string> {
  const redirect = redirectFor(svc);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirect);
      if (u.pathname !== `/oauth/${svc.id}/callback`) { res.writeHead(404).end(); return; }
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error_description") ?? u.searchParams.get("error");
      const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:system-ui;padding:40px"><h2>${code ? `Signed in to ${esc(svc.label)} ✔` : "Sign-in failed"}</h2><p>${code ? "You can close this tab and return to Claude Code." : esc(String(err ?? "No code received"))}</p></body></html>`);
      clearTimeout(timer); server.close();
      if (code) resolve(code); else reject(new Error(`${svc.label} sign-in failed: ${err ?? "no code"}`));
    });
    const timer = setTimeout(() => { server.close(); reject(new Error("Sign-in timed out (10 minutes)")); }, timeoutMs);
    server.once("error", (e: any) => reject(new Error(e.code === "EADDRINUSE" ? `Port ${CALLBACK_PORT} is busy – close the other sign-in or set AIW_OAUTH_PORT` : e.message)));
    server.listen(CALLBACK_PORT, "127.0.0.1", () => { onUrl(authUrl); openBrowser(authUrl); });
  });
}

export function openBrowser(url: string): void {
  if (process.env.AIW_NO_BROWSER === "1") return;        // tests and headless runs: the URL is printed / handled instead
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url.replace(/&/g, "^&")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch { /* the URL is printed too */ }
}

// ------------------------------------------------------------------ tool calls (shared connection per service)

const shared = new Map<string, Promise<Client>>();

async function clientFor(svc: McpService): Promise<Client> {
  let c = shared.get(svc.id);
  if (!c) {
    c = open(svc, false).then(async (o) => { await o.client.connect(o.transport); return o.client; });
    c.catch(() => shared.delete(svc.id));
    shared.set(svc.id, c);
  }
  return c;
}

export interface ToolInfo { name: string; params: string[] }

export async function listMcpTools(svc: McpService): Promise<ToolInfo[]> {
  const r = await (await clientFor(svc)).listTools();
  return (r.tools ?? []).map((t: any) => ({ name: t.name, params: Object.keys(t.inputSchema?.properties ?? {}) }));
}

/** Call a tool; returns its text content (JSON-parsed when possible). One reconnect on failure (expired session). */
export async function callMcp(svc: McpService, name: string, args: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r: any = await (await clientFor(svc)).callTool({ name, arguments: args });
      const text = (r.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
      if (r.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
      try { return JSON.parse(text); } catch { return text; }
    } catch (e: any) {
      shared.delete(svc.id);
      if (attempt >= 1 || /expired|sign in again/i.test(e.message)) throw e;
    }
  }
}
