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
  // ---- scopes (W7/W8, plan 5.22) – optional: the browser sign-in client may not have them; see the *Of helpers below
  /** Child issues of an epic (team-managed `parent` or company-managed "Epic Link"). */
  epicChildren?(epicKey: string, max?: number): Promise<WorkItem[]>;
  /** Boards of a project (agile API). */
  boards?(projectKey: string): Promise<JiraBoard[]>;
  /** Active and future sprints of a board (agile API). */
  sprints?(boardId: number, states?: string): Promise<JiraSprint[]>;
  /** Issues of a sprint, in the board's rank order (agile API). */
  sprintIssues?(sprintId: number, max?: number): Promise<WorkItem[]>;
  /** Branches and pull requests linked to an issue (Jira's development panel). */
  devLinks?(issueId: string): Promise<DevLink[]>;
  /** Create an issue (only after your OK or a directive – callers pass the gate first). */
  createIssue?(p: NewJiraIssue): Promise<{ key: string; id: string; url: string }>;
}

export interface JiraBoard { id: number; name: string; type: string }
export interface JiraSprint { id: number; name: string; state: string; startDate?: string; endDate?: string; goal?: string }
export interface DevLink { kind: "pullrequest" | "branch"; name: string; url: string; status?: string; repo?: string; branch?: string; base?: string }
export interface NewJiraIssue { projectKey: string; summary: string; description: string; issueType?: string; parentKey?: string; labels?: string[] }

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
    async epicChildren(epicKey, max = 100) {
      return epicChildrenOf({ search: this.search }, epicKey, max);
    },
    async boards(projectKey) {
      const r = await httpJson(`${base}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`, { headers });
      return (r.values ?? []).map((b: any) => ({ id: Number(b.id), name: String(b.name ?? ""), type: String(b.type ?? "") }));
    },
    async sprints(boardId, states = "active,future") {
      const out: JiraSprint[] = [];
      let startAt = 0;
      for (let page = 0; page < 10; page++) {
        const r = await httpJson(`${base}/rest/agile/1.0/board/${boardId}/sprint?state=${encodeURIComponent(states)}&startAt=${startAt}&maxResults=50`, { headers });
        const vals = r.values ?? [];
        for (const x of vals) out.push({ id: Number(x.id), name: String(x.name ?? ""), state: String(x.state ?? ""), startDate: x.startDate, endDate: x.endDate, goal: x.goal });
        if (r.isLast !== false || !vals.length) break;
        startAt += vals.length;
      }
      return out;
    },
    async sprintIssues(sprintId, max = 100) {
      const out: WorkItem[] = [];
      let startAt = 0;
      while (out.length < max) {
        const r = await httpJson(`${base}/rest/agile/1.0/sprint/${sprintId}/issue?fields=${FIELDS.join(",")}&startAt=${startAt}&maxResults=${Math.min(50, max - out.length)}`, { headers });
        const page = r.issues ?? [];
        for (const i of page) out.push(map(i));
        if (!page.length || startAt + page.length >= Number(r.total ?? 0)) break;
        startAt += page.length;
      }
      return out;
    },
    async devLinks(issueId) {
      const out: DevLink[] = [];
      for (const dataType of ["pullrequest", "branch"] as const) {
        try {
          const r = await httpJson(`${base}/rest/dev-status/latest/issue/detail?issueId=${encodeURIComponent(issueId)}&applicationType=GitHub&dataType=${dataType}`, { headers });
          out.push(...mapDevLinks(r, dataType));
        } catch { /* no development panel (not linked to GitHub): nothing to add */ }
      }
      return out;
    },
    async createIssue(p) {
      const fields: Record<string, any> = {
        project: { key: p.projectKey }, summary: p.summary.slice(0, 250), description: textToAdf(p.description || p.summary),
        issuetype: { name: p.issueType ?? "Story" }, ...(p.labels?.length ? { labels: p.labels } : {}),
        ...(p.parentKey ? { parent: { key: p.parentKey } } : {}),
      };
      const r = await httpJson(`${base}/rest/api/3/issue`, { method: "POST", headers, body: JSON.stringify({ fields }) });
      return { key: String(r.key), id: String(r.id), url: `${base}/browse/${r.key}` };
    },
  };
}

// ------------------------------------------------------------------ scopes: epics, sprints, development links

/** A JQL string literal (quotes and backslashes escaped). */
export const jqlString = (s: string): string => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const CURRENT_SPRINT = /^(current|this|active|now|this sprint|current sprint)?$/i;

/**
 * Child issues of an epic. Team-managed projects use `parent`, company-managed ones the "Epic Link" field; both are
 * asked and merged (a query that errors is skipped). Works with any client that can search (also the browser sign-in).
 */
export async function epicChildrenOf(jira: Pick<JiraClient, "search">, epicKey: string, max = 100): Promise<WorkItem[]> {
  const key = epicKey.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error(`"${epicKey}" is not a Jira key`);
  const seen = new Map<string, WorkItem>();
  let lastError: unknown;
  let worked = false;
  for (const jql of [`parent = ${key} ORDER BY rank ASC`, `"Epic Link" = ${key} ORDER BY rank ASC`]) {
    try { for (const i of await jira.search(jql, max)) if (!seen.has(i.key)) seen.set(i.key, i); worked = true; }
    catch (e) { lastError = e; }
  }
  if (!worked && lastError) throw lastError;
  return [...seen.values()];
}

/** Children of an epic through the client's own method when it has one, else JQL. */
export function epicChildrenFor(jira: JiraClient, epicKey: string, max = 100): Promise<WorkItem[]> {
  return jira.epicChildren ? jira.epicChildren(epicKey, max) : epicChildrenOf(jira, epicKey, max);
}

/**
 * The sprint a person means: "14" / "Sprint 14" / a name, or "current" (the active one). Uses the agile API when the
 * client has it; undefined when no sprint matches (or the client can't list sprints).
 */
export async function findSprint(jira: Pick<JiraClient, "boards" | "sprints">, projectKey: string, which: string): Promise<JiraSprint | undefined> {
  if (!jira.boards || !jira.sprints) return undefined;
  const want = which.trim().toLowerCase();
  const num = /^(?:sprint\s*)?(\d+)$/.exec(want)?.[1];
  for (const b of await jira.boards(projectKey)) {
    if (b.type && b.type !== "scrum") continue;
    const list = await jira.sprints(b.id, "active,future");
    const hit = CURRENT_SPRINT.test(want) ? list.find((s) => s.state === "active")
      : list.find((s) => s.name.toLowerCase() === want)
        ?? (num ? list.find((s) => new RegExp(`(^|\\D)${num}(\\D|$)`).test(s.name)) : undefined)
        ?? list.find((s) => s.name.toLowerCase().includes(want));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Issues of a sprint: the agile API when the client has it (board rank order), else JQL (`sprint = <id>`, the sprint's
 * name, or the open sprints of the project for "current").
 */
export async function sprintIssuesOf(jira: JiraClient, projectKey: string, which: string, max = 100): Promise<{ sprint?: JiraSprint; issues: WorkItem[] }> {
  const sprint = await findSprint(jira, projectKey, which).catch(() => undefined);
  if (sprint && jira.sprintIssues) return { sprint, issues: await jira.sprintIssues(sprint.id, max) };
  const w = which.trim();
  const jql = sprint ? `sprint = ${sprint.id} ORDER BY rank ASC`
    : CURRENT_SPRINT.test(w) ? `project = ${projectKey} AND sprint in openSprints() ORDER BY rank ASC`
    : `project = ${projectKey} AND sprint = ${jqlString(/^\d+$/.test(w) ? `Sprint ${w}` : w)} ORDER BY rank ASC`;
  return { sprint, issues: await jira.search(jql, max) };
}

/** Jira's development panel answer → links (pull requests with their status, branches). */
export function mapDevLinks(r: any, dataType: "pullrequest" | "branch"): DevLink[] {
  const out: DevLink[] = [];
  for (const d of r?.detail ?? []) {
    if (dataType === "pullrequest") {
      for (const pr of d.pullRequests ?? []) out.push({ kind: "pullrequest", name: String(pr.name ?? pr.id ?? ""), url: String(pr.url ?? ""), status: pr.status,
        repo: pr.repositoryName ?? pr.source?.repository?.name, branch: pr.source?.branch, base: pr.destination?.branch });
    } else {
      for (const b of d.branches ?? []) out.push({ kind: "branch", name: String(b.name ?? ""), url: String(b.url ?? ""), repo: b.repository?.name });
    }
  }
  return out;
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
