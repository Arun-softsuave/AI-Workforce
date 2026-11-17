import "./helpers.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Browser sign-in like Claude's MCP connections, tested end to end against local fake servers:
 *  - an OAuth 2.1 MCP server (discovery, dynamic client registration, PKCE S256, token, then tool calls) for Notion,
 *  - a token-free local MCP server standing in for the Figma desktop app.
 * The "browser" is a plain fetch that follows the redirect back to the plugin's 127.0.0.1 listener.
 */
process.env.AIW_NO_BROWSER = "1";
process.env.AIW_OAUTH_PORT = String(47900 + Math.floor(Math.random() * 90));

type Tool = { name: string; params: Record<string, z.ZodTypeAny>; run: (args: any) => string };

async function readBody(req: http.IncomingMessage): Promise<string> {
  let s = ""; for await (const c of req) s += c; return s;
}

/** A fake MCP server. With `oauth`, /mcp needs a bearer token obtained through discovery → register → authorize → token. */
async function fakeMcp(tools: Tool[], oauth: boolean) {
  const stats = { registered: 0, authorized: 0, tokens: 0, calls: [] as { name: string; args: any }[] };
  let challenge = "", issued = "";
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const u = new URL(req.url ?? "/", base);
    const json = (code: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (oauth) {
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (u.pathname === "/.well-known/oauth-authorization-server") return json(200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      if (u.pathname === "/register") { stats.registered++; return json(201, { ...JSON.parse(await readBody(req)), client_id: "client-1" }); }
      if (u.pathname === "/authorize") {
        stats.authorized++;
        assert.equal(u.searchParams.get("code_challenge_method"), "S256", "PKCE is used");
        challenge = u.searchParams.get("code_challenge")!;
        const back = new URL(u.searchParams.get("redirect_uri")!);
        assert.equal(back.hostname, "127.0.0.1", "the redirect goes to this computer only");
        back.searchParams.set("code", "code-1");
        if (u.searchParams.get("state")) back.searchParams.set("state", u.searchParams.get("state")!);
        res.writeHead(302, { Location: back.toString() }); res.end(); return;
      }
      if (u.pathname === "/token") {
        const form = new URLSearchParams(await readBody(req));
        const verifier = form.get("code_verifier") ?? "";
        const ok = form.get("code") === "code-1" && crypto.createHash("sha256").update(verifier).digest("base64url") === challenge;
        if (!ok) return json(400, { error: "invalid_grant" });
        stats.tokens++; issued = `token-${stats.tokens}`;
        return json(200, { access_token: issued, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1" });
      }
      if (u.pathname === "/mcp" && req.headers.authorization !== `Bearer ${issued}`) {
        res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }); res.end(); return;
      }
    }
    if (u.pathname !== "/mcp") { res.writeHead(404); res.end(); return; }
    const mcp = new McpServer({ name: "fake", version: "1.0.0" });
    for (const t of tools) {
      mcp.registerTool(t.name, { inputSchema: t.params }, async (args: any) => { stats.calls.push({ name: t.name, args }); return { content: [{ type: "text" as const, text: t.run(args) }] }; });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    await mcp.connect(transport);
    const raw = req.method === "POST" ? await readBody(req) : "";
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, stats, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const notion = await fakeMcp([
  { name: "notion-fetch", params: { id: z.string() }, run: (a) => `# Refund policy\nRefunds above 1000 need a manager. (page ${a.id})` },
  { name: "notion-get-self", params: {}, run: () => JSON.stringify({ name: "Sneha S" }) },
], true);
const figma = await fakeMcp([
  { name: "get_metadata", params: { nodeId: z.string().optional() }, run: (a) => `<frame id="${a.nodeId ?? "selection"}" name="Checkout"><text name="Pay now"/></frame>` },
  { name: "get_variable_defs", params: { nodeId: z.string().optional() }, run: () => `{"color/primary":"#0F7A63"}` },
], false);
process.env.AIW_NOTION_MCP = notion.url;
process.env.AIW_FIGMA_DESKTOP_MCP = figma.url;
after(async () => { await notion.close(); await figma.close(); });

// imported after the env vars above, because the service URLs are read at import time
const { NOTION_MCP, notionPageText, notionAccount, notionLinksIn, figmaFileSummary } = await import("../connectors/docs.js");
const { mcpLogin, hasMcpLogin } = await import("../connectors/mcpOAuth.js");
const { figmaDesktopStatus, figmaNodeFromText } = await import("../connectors/figmaDesktop.js");
const { recordNotionOAuth, recordFigmaDesktop, isConnected, connectionMeta, disconnect } = await import("../connectors/registry.js");
const { setSecret, getSecret } = await import("../core/secrets.js");

test("Notion: browser sign-in registers the app, uses PKCE, and then reads pages – no integration token", async () => {
  setSecret("notion.token", "old-integration-token");
  let shown = "";
  await mcpLogin(NOTION_MCP, async (url) => { shown = url; await fetch(url); });   // the "browser" follows the redirect back
  assert.match(shown, /\/authorize\?/);
  assert.deepEqual([notion.stats.registered, notion.stats.authorized, notion.stats.tokens], [1, 1, 1]);
  assert.equal(hasMcpLogin(NOTION_MCP), true);

  const account = await notionAccount();
  assert.equal(account, "Sneha S");
  recordNotionOAuth(account);
  assert.equal(isConnected("notion"), true);
  assert.equal(connectionMeta("notion").auth, "notion-oauth");
  assert.equal(getSecret("notion.token"), undefined, "the old token is removed");

  const page = await notionPageText("https://www.notion.so/acme/Refund-policy-0123456789abcdef0123456789abcdef");
  assert.match(page, /Refunds above 1000 need a manager/);
  assert.deepEqual(notion.stats.calls.find((c) => c.name === "notion-fetch")?.args, { id: "https://www.notion.so/acme/Refund-policy-0123456789abcdef0123456789abcdef" });

  // signing in again reuses the saved login – no second browser round-trip
  await mcpLogin(NOTION_MCP, () => { throw new Error("must not open the browser again"); });
  assert.equal(notion.stats.authorized, 1);

  disconnect("notion");
  assert.equal(hasMcpLogin(NOTION_MCP), false, "disconnect forgets the sign-in");
});

test("Notion links are found in ticket text", () => {
  assert.deepEqual(notionLinksIn("Spec: https://www.notion.so/acme/Spec-abc123def456. Also https://acme.notion.site/Page-1 and (https://notion.so/x)"),
    ["https://www.notion.so/acme/Spec-abc123def456", "https://acme.notion.site/Page-1", "https://notion.so/x"]);
});

test("Figma: the desktop app's MCP server is used without any token; the node from the link is passed on", async () => {
  const s = await figmaDesktopStatus();
  assert.equal(s.ok, true);
  assert.deepEqual(s.tools.sort(), ["get_metadata", "get_variable_defs"]);
  recordFigmaDesktop(s.tools);
  assert.equal(connectionMeta("figma").auth, "figma-desktop");
  assert.equal(getSecret("figma.token"), undefined);
  const node = figmaNodeFromText("Design: https://www.figma.com/design/AbCdEfGhIj1234/Checkout?node-id=12-345&t=x");
  assert.equal(node, "12:345");
  const summary = await figmaFileSummary("AbCdEfGhIj1234", node);
  assert.match(summary, /Figma \(desktop app\), node 12:345/);
  assert.match(summary, /name="Checkout"/);
  assert.match(summary, /color\/primary/);
  assert.equal(figma.stats.calls.find((c) => c.name === "get_metadata")?.args.nodeId, "12:345");
});

test("agents' lookup tools: read-only Jira / GitHub PR / Figma lookups, fenced as data, only for connected services", async () => {
  const { clients } = await import("../connectors/registry.js");
  const { runLookup, lookupToolNames, lookupServer } = await import("../agents/lookup.js");
  clients.jira = () => ({
    site: "https://acme.atlassian.net", myself: async () => ({ accountId: "a", displayName: "A" }), addComment: async () => { throw new Error("must stay read-only"); },
    search: async () => [{ key: "KAN-7", status: "Done", title: "Refund limits" } as any],
    getIssue: async (k: string) => (k === "KAN-7" ? { key: "KAN-7", status: "Done", title: "Refund limits", description: "Limit is 1000.", url: "https://acme.atlassian.net/browse/KAN-7", comments: [{ author: "PM", body: "Managers can override.", created: "x" }] } as any : undefined),
  });
  clients.github = () => ({
    getPr: async (repo: string, n: number) => ({ number: n, title: "Add refund limit", state: "open", merged: false, url: `https://github.com/${repo}/pull/${n}`, author: "dev", head: "feat/x", base: "dev", body: "Adds the limit.", files: [{ path: "src/refund.ts", status: "modified", additions: 10, deletions: 2 }] }),
    prActivity: async () => [{ id: "c1", kind: "review" as const, author: "Eric", body: "Please add a test", url: "u", at: "2026-11-12", state: "CHANGES_REQUESTED" }],
  } as any);

  const names = lookupToolNames();
  assert.ok(names.includes("mcp__lookup__jira_get_issue") && names.includes("mcp__lookup__github_get_pr") && names.includes("mcp__lookup__figma_get_design"));
  assert.ok(!names.includes("mcp__lookup__notion_get_page"), "Notion was disconnected, so its tool is not offered");

  const issue = await runLookup("jira_get_issue", { key: "kan-7" });
  assert.equal(issue.isError, false);
  assert.match(issue.text, /^<untrusted source="lookup:jira_get_issue">/, "results are fenced as data, never instructions");
  assert.match(issue.text, /KAN-7 \[Done\] Refund limits[\s\S]*Limit is 1000\.[\s\S]*PM: Managers can override\./);
  assert.match((await runLookup("jira_search", { jql: "text ~ refund" })).text, /KAN-7 \[Done\] Refund limits/);

  const pr = await runLookup("github_get_pr", { pr: "119" }, { repo: "acme/shop" });
  assert.match(pr.text, /PR #119 Add refund limit \[open\][\s\S]*modified src\/refund\.ts \(\+10\/-2\)[\s\S]*Eric \(changes_requested\): Please add a test/);
  assert.match((await runLookup("github_get_pr", { pr: "https://github.com/other/repo/pull/5" })).text, /github\.com\/other\/repo\/pull\/5/, "a PR URL names its own repository");

  const design = await runLookup("figma_get_design", { link: "https://www.figma.com/design/AbCdEfGhIj1234/Checkout?node-id=12-345" });
  assert.match(design.text, /name="Checkout"/);
  assert.equal((await runLookup("notion_get_page", { url: "https://notion.so/x" })).isError, true);

  const server = await lookupServer({ repo: "acme/shop" });
  assert.equal(server.name, "lookup", "the Agent SDK accepts the tool definitions");
});

test("Figma: a clear message when the desktop app is not running", async () => {
  const saved = process.env.AIW_FIGMA_DESKTOP_MCP;
  process.env.AIW_FIGMA_DESKTOP_MCP = "http://127.0.0.1:9/mcp";
  const { figmaDesktopStatus: status } = await import(`../connectors/figmaDesktop.js?down=${Date.now()}`);
  const s = await status();
  process.env.AIW_FIGMA_DESKTOP_MCP = saved;
  assert.equal(s.ok, false);
  assert.match(s.detail ?? "", /not running|MCP server is off/);
});
