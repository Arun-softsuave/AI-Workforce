import path from "node:path";
import { getMeta, setMeta, audit, tx } from "../core/db.js";
import { loadProjects, type ProjectConfig } from "../core/config.js";
import { isGroupLead } from "./routing.js";
import { createTask, type Task } from "./tasks.js";

/**
 * Work that has no Jira ticket ("add a CSV export to the orders page"). It becomes a task with its own id (TASK-7),
 * starts with a requirements interview in Teams, and after the requester confirms the requirements it continues like
 * a ticket. No Jira issue is created.
 */

/** Products the user can ask for work in: one entry per multi-repo group (its lead) or standalone project. */
export function products(): ProjectConfig[] {
  return loadProjects().filter((p) => p.status !== "paused" && isGroupLead(p));
}

const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** The configured project whose local folder contains `dir` (e.g. Claude Code's working directory). */
export function projectForPath(dir: string | undefined): ProjectConfig | undefined {
  if (!dir) return undefined;
  const d = norm(dir);
  return loadProjects()
    .filter((p) => p.local.path && (d === norm(p.local.path) || d.startsWith(norm(p.local.path) + "/")))
    .sort((a, b) => b.local.path.length - a.local.path.length)[0];
}

/** Resolve which product a request belongs to: a named project/group, the current folder, or the only product. */
export function resolveProduct(hint?: string, cwd?: string): { project?: ProjectConfig; choices: ProjectConfig[] } {
  const all = products();
  const leadOf = (p: ProjectConfig) => (p.group ? all.find((x) => x.group === p.group) ?? p : p);
  const h = hint?.trim().toLowerCase();
  if (h) {
    const hit = loadProjects().find((p) => p.id.toLowerCase() === h || p.group?.toLowerCase() === h)
      ?? loadProjects().find((p) => p.id.toLowerCase().includes(h) || (p.group ?? "").toLowerCase().includes(h));
    if (hit) return { project: leadOf(hit), choices: all };
  }
  const here = projectForPath(cwd);
  if (here) return { project: leadOf(here), choices: all };
  if (all.length === 1) return { project: all[0], choices: all };
  return { project: undefined, choices: all };
}

export function createRequest(text: string, by: string, project: ProjectConfig, opts: { preferRepo?: string; via?: string } = {}): Task {
  const clean = text.trim();
  if (!clean) throw new Error("Please describe the work you want done.");
  const n = tx(() => {
    const next = Number(getMeta("request.seq") ?? "0") + 1;
    setMeta("request.seq", String(next));
    return next;
  });
  const key = `TASK-${n}`;
  const title = clean.split("\n")[0].replace(/\s+/g, " ").slice(0, 80);
  const t = createTask({
    projectId: project.id, source: "chat", sourceId: `chat:${key}`, sourceRef: key, title, kind: "request", priority: 3,
    data: { ticket: { key, title, description: clean }, request: { text: clean, by, via: opts.via ?? "teams", preferRepo: opts.preferRepo, at: new Date().toISOString() }, manual: true },
  });
  audit(`user:${by}`, "task.request", t.id, { key, via: opts.via });
  return t;
}
