import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { truncate } from "../core/util.js";

/**
 * Figma through the Figma DESKTOP app's own MCP server (no token, no sign-in: the app is already signed in).
 * Figma's online MCP server only accepts clients on Figma's allowlist, so the plugin uses the local one instead.
 * The desktop server reads the file that is OPEN in the Figma app (optionally a specific node from a Figma link).
 * Enable it in the Figma desktop app: Preferences → "Enable Dev Mode MCP Server" (Dev or Full seat).
 */
export const FIGMA_DESKTOP_URL = process.env.AIW_FIGMA_DESKTOP_MCP ?? "http://127.0.0.1:3845/mcp";

async function withClient<T>(fn: (c: Client) => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const client = new Client({ name: "ai-workforce", version: "0.2.0" });
  const transport = new StreamableHTTPClientTransport(new URL(FIGMA_DESKTOP_URL));
  let handle: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, rej) => { handle = setTimeout(() => rej(new Error("Figma desktop app did not answer")), timeoutMs); });
  try {
    await Promise.race([client.connect(transport), timer]);
    return await Promise.race([fn(client), timer]);
  } finally {
    clearTimeout(handle);
    client.close().catch(() => {});
  }
}

/** Is the Figma desktop app running with its MCP server on? Returns the tool names it offers. */
export async function figmaDesktopStatus(): Promise<{ ok: boolean; tools: string[]; detail?: string }> {
  try {
    const tools = await withClient(async (c) => ((await c.listTools()).tools ?? []).map((t: any) => t.name), 5_000);
    return { ok: true, tools };
  } catch (e: any) {
    return { ok: false, tools: [], detail: /ECONNREFUSED|fetch failed|did not answer/i.test(e.message)
      ? "The Figma desktop app is not running, or its MCP server is off (Figma → Preferences → Enable Dev Mode MCP Server)."
      : e.message };
  }
}

/** Figma links use node-id=12-345; the API uses 12:345. */
export function figmaNodeFromText(text: string): string | undefined {
  const m = /figma\.com\/[^\s]*[?&]node-id=([0-9]+[-:][0-9]+)/.exec(text);
  return m ? m[1].replace("-", ":") : undefined;
}

/** Structure of the open file (or of one node): frames, layers, variables – as text for the agents. */
export async function figmaDesktopSummary(nodeId?: string): Promise<string> {
  return withClient(async (c) => {
    const tools = (await c.listTools()).tools ?? [];
    const call = async (name: string) => {
      const t: any = tools.find((x: any) => x.name === name);
      if (!t) return "";
      const props = Object.keys(t.inputSchema?.properties ?? {});
      const args: Record<string, unknown> = {};
      if (nodeId && props.includes("nodeId")) args.nodeId = nodeId;
      if (props.includes("clientLanguages")) args.clientLanguages = "typescript";
      if (props.includes("clientFrameworks")) args.clientFrameworks = "react";
      const r: any = await c.callTool({ name, arguments: args });
      const text = (r.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
      if (r.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
      return text;
    };
    const metadata = await call("get_metadata");
    if (!metadata.trim()) throw new Error("Nothing is selected or open in the Figma desktop app.");
    const variables = await call("get_variable_defs").catch(() => "");
    return truncate(`# Figma (desktop app)${nodeId ? `, node ${nodeId}` : ", current selection"}\n\n## Layers\n${metadata}${variables ? `\n\n## Variables / styles\n${variables}` : ""}`, 20_000);
  });
}
