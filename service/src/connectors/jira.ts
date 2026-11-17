import { httpJson } from "../core/util.js";
import { getSecret } from "../core/secrets.js";
import { db } from "../core/db.js";
import type { WorkItem, ConnectionTest } from "./types.js";

/**
 * Jira Cloud adapter (REST v3). v1 auth = email + API token (decision D2 in the PRD):
 * works from a desktop with outbound HTTPS only and needs no shared client secret.
 */
export interface JiraClient {
  site: string;
  myself(): Promise<{ accountId: string; displayName: string }>;
  search(jql: string, max?: number): Promise<WorkItem[]>;
  getIssue(key: string): Promise<WorkItem | undefined>;
  addComment(key: string, text: string): Promise<void>;
}

export function jiraConfig(): { site: string; email: string } | undefined {
  const row = db().prepare("SELECT meta FROM connections WHERE provider='jira' AND status='connected'").get() as { meta: string } | undefined;
  if (!row) return undefined;
  const m = JSON.parse(row.meta ?? "{}");
  return m.site && m.email ? { site: m.site, email: m.email } : undefined;
}

export const JIRA_FIELDS = ["summary", "description", "status", "assignee", "priority", "labels", "issuetype", "updated", "created", "project", "comment"];

/** Map a Jira REST issue (also what Atlassian's MCP tools return) to a WorkItem. */
export function mapJiraIssue(base: string, i: any): WorkItem {
  return {
    provider: "jira",
    id: String(i.id),
    key: i.key,
    projectKey: i.fields?.project?.key ?? i.key.split("-")[0],
    title: i.fields?.summary ?? "",
    description: adfToText(i.fields?.description),
    status: i.fields?.status?.name ?? "",
    statusCategory: i.fields?.status?.statusCategory?.key,
    assignee: i.fields?.assignee?.accountId,
    assigneeName: i.fields?.assignee?.displayName,
    priority: i.fields?.priority?.name,
    labels: i.fields?.labels ?? [],
    issueType: i.fields?.issuetype?.name,
    url: `${base}/browse/${i.key}`,
    updated: i.fields?.updated,
    created: i.fields?.created,
    comments: (i.fields?.comment?.comments ?? []).slice(-10).map((c: any) => ({
      author: c.author?.displayName ?? "?", body: adfToText(c.body), created: c.created,
    })),
  };
}

let mcpFactory: ((site: string, cloudId: string) => JiraClient) | undefined;
/** Registered by the Atlassian MCP connector (browser sign-in) – avoids an import cycle. */
export function registerJiraMcpFactory(f: (site: string, cloudId: string) => JiraClient): void { mcpFactory = f; }

export function createJiraClient(site?: string, email?: string, token?: string): JiraClient | undefined {
  // Browser sign-in (Atlassian's official MCP server, OAuth) when that is how Jira was connected.
  if (!token && !email) {
    const row = db().prepare("SELECT meta FROM connections WHERE provider='jira' AND status='connected'").get() as { meta: string } | undefined;
    const m = row ? JSON.parse(row.meta ?? "{}") : {};
    if (m.auth === "atlassian-oauth" && m.cloudId && mcpFactory) return mcpFactory(m.site, m.cloudId);
  }
  const cfg = jiraConfig();
  site = site ?? cfg?.site; email = email ?? cfg?.email; token = token ?? getSecret("jira.token");
  if (!site || !email || !token) return undefined;
  const base = normaliseJiraSite(site);
  const headers = {
    Authorization: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const FIELDS = JIRA_FIELDS;
  const map = (i: any): WorkItem => mapJiraIssue(base, i);
  return {
    site: base,
    async myself() {
      const r = await httpJson(`${base}/rest/api/3/myself`, { headers });
      return { accountId: r.accountId, displayName: r.displayName };
    },
    async search(jql, max = 100) {
      const out: WorkItem[] = [];
      let nextPageToken: string | undefined;
      do {
        const r = await httpJson(`${base}/rest/api/3/search/jql`, {
          method: "POST", headers,
          body: JSON.stringify({ jql, fields: FIELDS, maxResults: Math.min(100, max - out.length), nextPageToken }),
        });
        for (const i of r.issues ?? []) out.push(map(i));
        nextPageToken = r.nextPageToken;
      } while (nextPageToken && out.length < max);
      return out;
    },
    async getIssue(key) {
      try {
        return map(await httpJson(`${base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(",")}`, { headers }));
      } catch (e: any) {
        if (e?.status === 404) return undefined;
        throw e;
      }
    },
    async addComment(key, text) {
      await httpJson(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
        method: "POST", headers, body: JSON.stringify({ body: textToAdf(text) }),
      });
    },
  };
}

export async function testJira(site: string, email: string, token: string): Promise<ConnectionTest> {
  try {
    const me = await createJiraClient(site, email, token)!.myself();
    return { ok: true, account: `${me.displayName} (${me.accountId})` };
  } catch (e: any) {
    return { ok: false, detail: e.message };
  }
}

/** Accept any pasted Jira URL ("https://x.atlassian.net/jira/for-you") and keep only the site origin. */
export function normaliseJiraSite(site: string): string {
  const raw = site.trim();
  try { return new URL(raw.startsWith("http") ? raw : `https://${raw}`).origin; } catch { return `https://${raw.replace(/\/.*$/, "")}`; }
}

/** Atlassian Document Format -> plain text (good enough for prompts and hashing). */
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  const walk = (n: any): string => {
    if (!n) return "";
    if (n.type === "text") return n.text ?? "";
    if (n.type === "hardBreak") return "\n";
    if (n.type === "mention") return n.attrs?.text ?? "@user";
    const inner = (n.content ?? []).map(walk).join("");
    switch (n.type) {
      case "paragraph": case "heading": return inner + "\n";
      case "listItem": return "- " + inner.trim() + "\n";
      case "codeBlock": return "```\n" + inner + "\n```\n";
      default: return inner;
    }
  };
  return walk(node).replace(/\n{3,}/g, "\n\n").trim();
}

export function textToAdf(text: string): any {
  return {
    type: "doc", version: 1,
    content: text.split(/\n{2,}/).map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
  };
}
