import { httpJson, truncate } from "../core/util.js";
import { getSecret } from "../core/secrets.js";
import { hasMcpLogin, callMcp, listMcpTools, type McpService } from "./mcpOAuth.js";
import { figmaDesktopSummary } from "./figmaDesktop.js";
import { preferredFigmaMode } from "./registry.js";
import type { ConnectionTest } from "./types.js";

// ------------------------------------------------------------------ Notion

/** Notion's official MCP server: "Sign in with Notion" in the browser (OAuth, no integration token). */
export const NOTION_MCP: McpService = { id: "notion", label: "Notion", url: process.env.AIW_NOTION_MCP ?? "https://mcp.notion.com/mcp", store: "notion-oauth" };

/** Links to Notion pages in a ticket or document. */
export function notionLinksIn(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/(?:www\.)?[\w-]*\.?notion\.(?:so|site)\/[^\s)>\]"']+/g) ?? []).map((u) => u.replace(/[.,;]+$/, "")))];
}

/** Which tool argument carries the page id/URL (Notion has renamed it before – read it from the tool's schema). */
async function fetchTool(): Promise<{ name: string; param: string }> {
  const tools = await listMcpTools(NOTION_MCP);
  const t = tools.find((x) => x.name === "notion-fetch") ?? tools.find((x) => /fetch/.test(x.name));
  if (!t) throw new Error("Notion's MCP server offers no fetch tool");
  return { name: t.name, param: t.params.find((p) => /^(id|url|page_?id|uri)$/i.test(p)) ?? t.params[0] ?? "id" };
}

/** Notion (read-only): page text for business context. Uses the browser sign-in; an integration token is the fallback. */
export async function notionPageText(pageIdOrUrl: string): Promise<string> {
  if (hasMcpLogin(NOTION_MCP)) {
    const f = await fetchTool();
    const r = await callMcp(NOTION_MCP, f.name, { [f.param]: pageIdOrUrl });
    const text = typeof r === "string" ? r : r?.text ?? r?.content ?? JSON.stringify(r);
    return truncate(String(text), 20_000);
  }
  const token = getSecret("notion.token");
  if (!token) throw new Error("Notion is not connected – run `aiw connect notion` to sign in");
  const pageId = /([0-9a-f]{32}|[0-9a-f-]{36})(?:[?#].*)?$/i.exec(pageIdOrUrl)?.[1] ?? pageIdOrUrl;
  const headers = { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" };
  const page = await httpJson(`https://api.notion.com/v1/pages/${pageId}`, { headers });
  const titleProp: any = Object.values(page.properties ?? {}).find((p: any) => p.type === "title");
  const title = (titleProp?.title ?? []).map((t: any) => t.plain_text).join("") || pageId;
  const blocks = await httpJson(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, { headers });
  const lines = (blocks.results ?? []).map((b: any) => {
    const rich = b[b.type]?.rich_text ?? [];
    const text = rich.map((t: any) => t.plain_text).join("");
    return b.type.startsWith("heading") ? `## ${text}` : b.type.includes("list_item") ? `- ${text}` : text;
  });
  return truncate(`# ${title}\n\n${lines.filter(Boolean).join("\n")}`, 20_000);
}

/** Who is signed in to Notion (for `aiw connections`). */
export async function notionAccount(): Promise<string> {
  const tools = await listMcpTools(NOTION_MCP);
  const self = tools.find((t) => t.name === "notion-get-self");
  if (self) {
    const r = await callMcp(NOTION_MCP, self.name, {});
    return r?.name ?? r?.user?.name ?? r?.email ?? "Notion user";
  }
  return `Notion (${tools.length} tools available)`;
}

export async function testNotion(token: string): Promise<ConnectionTest> {
  try {
    const r = await httpJson("https://api.notion.com/v1/users/me", { headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" } });
    return { ok: true, account: r.name ?? r.bot?.owner?.type ?? "integration" };
  } catch (e: any) { return { ok: false, detail: e.message }; }
}

// ------------------------------------------------------------------ Figma

/**
 * Figma (read-only): pages, frames, components and styles for design review.
 * With a personal access token any file can be read by its key; without one, the Figma desktop app's MCP server
 * reads the file that is open in the app (no token, no sign-in).
 */
export async function figmaFileSummary(fileKey: string, nodeId?: string): Promise<string> {
  const token = getSecret("figma.token");
  // token first; the desktop app's MCP server when there is no token or you chose it (`aiw connect figma --desktop`)
  if (!token || preferredFigmaMode() === "desktop") return figmaDesktopSummary(nodeId);
  if (nodeId) return figmaNodeSummary(fileKey, nodeId, token);
  const f = await httpJson(`https://api.figma.com/v1/files/${fileKey}?depth=3`, { headers: { "X-Figma-Token": token } });
  const out: string[] = [`# Figma file: ${f.name} (last modified ${f.lastModified})`];
  for (const page of f.document?.children ?? []) {
    out.push(`## Page: ${page.name}`);
    for (const frame of (page.children ?? []).slice(0, 40)) {
      const kids = (frame.children ?? []).slice(0, 15).map((c: any) => `${c.type}:${c.name}`).join(", ");
      out.push(`- ${frame.type} "${frame.name}" ${kids ? `→ ${kids}` : ""}`);
    }
  }
  const comps = Object.values(f.components ?? {}).slice(0, 60).map((c: any) => c.name);
  if (comps.length) out.push(`## Components\n${comps.join(", ")}`);
  const styles = Object.values(f.styles ?? {}).slice(0, 60).map((s: any) => `${s.styleType}:${s.name}`);
  if (styles.length) out.push(`## Styles\n${styles.join(", ")}`);
  return truncate(out.join("\n"), 20_000);
}

/** One frame/node from a Figma link: its layer tree with names, sizes, text content, colours and auto-layout. */
async function figmaNodeSummary(fileKey: string, nodeId: string, token: string): Promise<string> {
  const r = await httpJson(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=6`, { headers: { "X-Figma-Token": token } });
  const doc = r.nodes?.[nodeId]?.document;
  if (!doc) throw new Error(`Figma node ${nodeId} not found in file ${fileKey}`);
  const hex = (c: any) => (c ? `#${[c.r, c.g, c.b].map((v: number) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}` : "");
  const lines: string[] = [`# Figma: ${r.name ?? fileKey} – ${doc.type} "${doc.name}" (node ${nodeId})`];
  const walk = (n: any, depth: number) => {
    if (lines.length > 250 || n.visible === false) return;
    const box = n.absoluteBoundingBox ? ` ${Math.round(n.absoluteBoundingBox.width)}×${Math.round(n.absoluteBoundingBox.height)}` : "";
    const fill = n.fills?.find((f: any) => f.type === "SOLID" && f.visible !== false)?.color;
    const layout = n.layoutMode ? ` layout=${n.layoutMode.toLowerCase()} gap=${n.itemSpacing ?? 0}` : "";
    const text = n.type === "TEXT" && n.characters ? ` "${truncate(n.characters.replace(/\s+/g, " "), 120)}"${n.style?.fontSize ? ` ${n.style.fontSize}px ${n.style.fontWeight ?? ""}` : ""}` : "";
    lines.push(`${"  ".repeat(depth)}- ${n.type} ${n.name}${box}${fill ? ` fill=${hex(fill)}` : ""}${layout}${text}`);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(doc, 0);
  return truncate(lines.join("\n"), 20_000);
}

/**
 * Frames (and sections) of a file whose NAME mentions a ticket key – e.g. "KAN-38, KAN-39, KAN-41 · Chat with Need
 * Summary". Teams often name frames after tickets, so a ticket without a link still finds its design. API-token mode
 * only (the desktop app has no file listing); [] otherwise.
 */
export async function figmaFramesFor(fileKey: string, ticketKey: string): Promise<{ id: string; name: string; page: string }[]> {
  const token = getSecret("figma.token");
  if (!token || !ticketKey) return [];
  const headers = { "X-Figma-Token": token };
  const f = await httpJson(`https://api.figma.com/v1/files/${fileKey}?depth=2`, { headers });
  const re = new RegExp(`(^|[^A-Za-z0-9])${ticketKey.replace(/[^A-Za-z0-9-]/g, "")}(?![0-9])`, "i");
  const out: { id: string; name: string; page: string }[] = [];
  // never old / discarded designs
  const archived = /\b(bin|trash|archive[ds]?|old|deprecated|unused|graveyard|scratch|sandbox|playground)\b|🗑/i;
  // sections can hold sections: open them level by level (only sections – never the layers inside frames)
  let level: { node: any; page: string }[] = (f.document?.children ?? []).filter((p: any) => !archived.test(p.name ?? "")).map((p: any) => ({ node: p, page: p.name }));
  for (let depth = 0; depth < 5 && level.length; depth++) {
    const sections: { id: string; page: string }[] = [];
    for (const { node, page } of level) {
      for (const c of node.children ?? []) {
        if (["FRAME", "SECTION", "COMPONENT", "COMPONENT_SET", "GROUP"].includes(c.type) && re.test(c.name ?? "")) out.push({ id: c.id, name: c.name, page });
        else if (c.type === "SECTION" && !archived.test(c.name ?? "")) sections.push({ id: c.id, page });
      }
    }
    if (!sections.length) break;
    const next: { node: any; page: string }[] = [];
    for (let i = 0; i < sections.length; i += 50) {
      const batch = sections.slice(i, i + 50);
      const r = await httpJson(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(batch.map((s) => s.id).join(","))}&depth=1`, { headers });
      for (const s of batch) { const doc = r.nodes?.[s.id]?.document; if (doc) next.push({ node: doc, page: s.page }); }
    }
    level = next;
  }
  return out;
}

export function figmaKeyFromText(text: string): string | undefined {
  return /figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]{10,})/.exec(text)?.[1];
}

export async function testFigma(token: string): Promise<ConnectionTest> {
  try {
    const r = await httpJson("https://api.figma.com/v1/me", { headers: { "X-Figma-Token": token } });
    return { ok: true, account: r.handle ?? r.email };
  } catch (e: any) { return { ok: false, detail: e.message }; }
}
