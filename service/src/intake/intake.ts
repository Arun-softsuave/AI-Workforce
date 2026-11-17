import { db, getCursor, setCursor, getMeta, setMeta, audit } from "../core/db.js";
import { loadProjects, loadSettings, engineVersion, type ProjectConfig } from "../core/config.js";
import { isDeveloper } from "../core/roles.js";
import { newId, nowIso, sha256, inTimeWindow, localHourMinute } from "../core/util.js";
import { logger } from "../core/log.js";
import { clients, isConnected, markConnection } from "../connectors/registry.js";
import { PRIORITY_RANK, type WorkItem } from "../connectors/types.js";
import { figmaKeyFromText } from "../connectors/docs.js";
import { createTask, activeTasksForIssue, transition, mergeData, canTransition, getTask, jiraKey, type Task } from "../engine/tasks.js";
import { groupMembers, isGroupLead } from "../engine/routing.js";
import { pollPrActivity, pollReviewedPrs } from "./prActivity.js";
import { cancelTask } from "../engine/engine.js";
import { notify } from "../notify/router.js";
import { runTimed } from "../core/timers.js";

/**
 * Event Gate (zero tokens): polls trackers, diffs against stored snapshots, emits idempotent events
 * and turns only the actionable ones into tasks. Everything else just updates snapshots.
 */
export type EventType = "assigned" | "unassigned" | "description_changed" | "status_changed" | "closed" | "ready_for_qa" | "epic_created" | "deleted";
export interface GateEvent { type: EventType; item: WorkItem; idemKey: string }

interface Snapshot { issue_id: string; desc_hash: string; fields_hash: string; assignee: string | null; status: string | null; issue_key: string; summary: string }

const descHash = (i: WorkItem) => sha256(i.description.trim());
const fieldsHash = (i: WorkItem) => sha256(JSON.stringify([i.title, i.description.trim(), i.priority, i.labels, i.status, i.assignee]));

/** Pure diff: snapshot + current item -> events. Exported for unit tests. */
export function diffItem(prev: Snapshot | undefined, item: WorkItem, me: string, project: ProjectConfig): GateEvent[] {
  const ev: GateEvent[] = [];
  const k = (t: EventType) => `jira:${item.id}:${t}:${item.updated}`;
  const mine = item.assignee === me;
  // Finished tickets never start work, even if they are (re)assigned to me.
  if (mine && item.statusCategory !== "done" && (!prev || prev.assignee !== me)) ev.push({ type: "assigned", item, idemKey: k("assigned") });
  if (prev && prev.assignee === me && !mine) ev.push({ type: "unassigned", item, idemKey: k("unassigned") });
  if (prev && prev.desc_hash !== descHash(item)) ev.push({ type: "description_changed", item, idemKey: k("description_changed") });
  if (prev && prev.status !== item.status) {
    ev.push({ type: item.statusCategory === "done" ? "closed" : "status_changed", item, idemKey: k(item.statusCategory === "done" ? "closed" : "status_changed") });
  }
  const qa = project.jira?.qaStatus;
  if (qa && project.roles.includes("qa-engineer") && item.status.toLowerCase() === qa.toLowerCase() && (!prev || prev.status?.toLowerCase() !== qa.toLowerCase()))
    ev.push({ type: "ready_for_qa", item, idemKey: k("ready_for_qa") });
  if (!prev && project.roles.includes("business-analyst") && /epic/i.test(item.issueType ?? "") && item.statusCategory !== "done")
    ev.push({ type: "epic_created", item, idemKey: `jira:${item.id}:epic_created` });
  return ev;
}

function getSnapshot(id: string): Snapshot | undefined {
  return db().prepare("SELECT * FROM issue_snapshots WHERE issue_id=?").get(id) as Snapshot | undefined;
}

function saveSnapshot(projectId: string, i: WorkItem): void {
  db().prepare(`INSERT INTO issue_snapshots (issue_id, provider, project_id, issue_key, fields_hash, desc_hash, assignee, status, priority, summary, updated_at, seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(issue_id) DO UPDATE SET project_id=excluded.project_id, issue_key=excluded.issue_key,
    fields_hash=excluded.fields_hash, desc_hash=excluded.desc_hash, assignee=excluded.assignee, status=excluded.status,
    priority=excluded.priority, summary=excluded.summary, updated_at=excluded.updated_at, seen_at=excluded.seen_at`)
    .run(i.id, "jira", projectId, i.key, fieldsHash(i), descHash(i), i.assignee ?? null, i.status, i.priority ?? null, i.title, i.updated, nowIso());
}

/** Store the event; returns false if it was already processed (idempotency). */
function recordEvent(e: GateEvent, projectId: string): boolean {
  const r = db().prepare("INSERT OR IGNORE INTO events (id, idem_key, type, project_id, source_ref, payload, received_at) VALUES (?,?,?,?,?,?,?)")
    .run(newId("e"), e.idemKey, e.type, projectId, e.item.key, JSON.stringify({ key: e.item.key, status: e.item.status }), nowIso());
  return r.changes > 0;
}

const ticketData = (i: WorkItem) => ({ key: i.key, id: i.id, title: i.title, description: i.description, url: i.url, status: i.status, priority: i.priority, labels: i.labels, comments: i.comments ?? [] });
const priorityOf = (i: WorkItem) => PRIORITY_RANK[i.priority ?? "Medium"] ?? 3;

/** Route a project's items into tasks. Returns tasks created in this pass. */
export async function processItems(project: ProjectConfig, items: WorkItem[], me: string): Promise<Task[]> {
  const created: Task[] = [];
  for (const item of items) {
    const prev = getSnapshot(item.id);
    const events = diffItem(prev, item, me, project);
    saveSnapshot(project.id, item);
    for (const e of events) {
      if (!recordEvent(e, project.id)) continue;
      const t = await handleEvent(project, e, prev);
      if (t) created.push(t);
    }
  }
  return created;
}

async function handleEvent(project: ProjectConfig, e: GateEvent, prev: Snapshot | undefined): Promise<Task | undefined> {
  const i = e.item;
  const base = { projectId: project.id, source: "jira", sourceId: i.id, sourceRef: i.key, title: i.title, priority: priorityOf(i), data: { ticket: ticketData(i) } };
  switch (e.type) {
    case "assigned": {
      if (activeTasksForIssue(i.id).some((t) => t.kind === "assigned")) return undefined;   // already handled (incl. multi-repo halves)
      if (isDeveloper(project.roles)) return createTask({ ...base, kind: "assigned", role: project.roles.find((r) => /developer$/.test(r)) });
      if (project.roles.includes("uiux-designer") && figmaKeyFromText(`${i.title}\n${i.description}`)) return createTask({ ...base, kind: "design_review", role: "uiux-designer" });
      return undefined;
    }
    case "ready_for_qa": return createTask({ ...base, kind: "ready_for_qa", role: "qa-engineer" });
    case "epic_created": return createTask({ ...base, kind: "epic_created", role: "business-analyst" });
    case "unassigned": case "closed": {
      for (const t of activeTasksForIssue(i.id)) {
        // engine v2: a raised PR is looked after until it is merged or closed – the ticket moving on does not cancel it
        if (engineVersion() === "v2" && AFTER_PR.includes(t.state)) continue;
        if (!["AWAITING_APPROVAL"].includes(t.state)) {
          await cancelTask(t.id, e.type === "closed" ? "ticket closed" : "ticket unassigned");
          await notify({ kind: "info", taskId: t.id, taskRef: i.key, title: `${i.key} stopped`, body: e.type === "closed" ? "The ticket was closed, so the work was cancelled." : "The ticket was reassigned, so the work was cancelled. Artefacts are kept for 7 days." });
        }
      }
      return undefined;
    }
    case "description_changed": {
      const major = isMajorChange(prev, i);
      for (const t of activeTasksForIssue(i.id)) {
        // engine v2: the PR is already raised – the kernel reacts to the change (reactions: ticket_changed)
        if (engineVersion() === "v2" && AFTER_PR.includes(t.state)) {
          const { emit } = await import("../kernel/events.js");
          mergeData(t.id, { pendingTicket: ticketData(i) });
          emit({ type: "ticket_changed", idemKey: `${e.idemKey}:${t.id}`, itemId: t.id, payload: { key: i.key, major } });
          continue;
        }
        await applyDescriptionChange(t, i, major, e.idemKey);
      }
      return undefined;
    }
    default: return undefined;
  }
}

/** Item states after the PR was raised (engine v2 only). */
const AFTER_PR = ["PR_OPEN", "BLOCKED", "MERGED", "CLOSED"];

async function applyDescriptionChange(t: Task, i: WorkItem, major: boolean, idemKey: string): Promise<void> {
  {
    {
      if (t.state === "NEEDS_INFO" || t.state === "DETECTED" || t.state === "TRIAGED") {
        mergeData(t.id, { ticket: ticketData(i), questions: null });
        if (t.state === "NEEDS_INFO") transition(t.id, "DETECTED", "ticket updated – re-triage");
      } else if (t.state === "AWAITING_APPROVAL" && major) {
        mergeData(t.id, { ticketChange: "major", pendingTicket: ticketData(i) });
        transition(t.id, "STALE", "ticket changed after approval request");
        await notify({ kind: "stale", taskId: t.id, taskRef: t.source_ref ?? i.key, dedupeKey: idemKey, title: `${i.key}: ticket changed after approval was requested`, body: "The prepared change may no longer match. Run `/aiw resume` to re-run from analysis or `/aiw cancel`." });
      } else {
        mergeData(t.id, { ticketChange: major ? "major" : "minor", pendingTicket: ticketData(i) });
      }
    }
  }
}

/** "Major" = the description changed substantially (not just a typo or formatting). */
export function isMajorChange(prev: Snapshot | undefined, i: WorkItem): boolean {
  if (!prev) return false;
  const oldTask = getTask(i.key);
  const before: string = oldTask?.data.ticket?.description ?? "";
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const a = words(before), b = words(i.description);
  if (!a.size) return b.size > 5;
  let same = 0; for (const w of b) if (a.has(w)) same++;
  const jaccard = same / (a.size + b.size - same);
  return jaccard < 0.7;
}

// ------------------------------------------------------------------ polling

/** Minutes to look back: since the last successful poll plus a 2-minute overlap; first run looks back 1 day. */
function lookbackMinutes(name: string): number {
  const c = getCursor(name);
  if (!c) return 24 * 60;
  return Math.min(30 * 24 * 60, Math.ceil((Date.now() - new Date(c).getTime()) / 60_000) + 2);
}

export async function pollJira(): Promise<{ items: number; tasks: Task[] }> {
  const jira = clients.jira();
  const projects = loadProjects().filter((p) => p.jira && p.status !== "paused" && isGroupLead(p));
  if (!jira || !projects.length) return { items: 0, tasks: [] };
  let me: string;
  try {
    const cached = getMeta("jira.accountId");
    me = cached ?? (await jira.myself()).accountId;
    if (!cached) setMeta("jira.accountId", me);
  } catch (e: any) {
    if (/\b401\b|\b403\b/.test(e.message)) {
      markConnection("jira", "expired", e.message);
      // the health loop marks Jira down at once: one reconnect message, work that needs Jira waits (no second notice here)
      try { const { reportConnectorError } = await import("./health.js"); await reportConnectorError("jira", e); } catch { /* best effort */ }
    }
    throw e;
  }
  const started = nowIso();
  let count = 0;
  const createdAll: Task[] = [];
  for (const p of projects) {
    const cursor = `jira:${p.id}`;
    const mins = lookbackMinutes(cursor);
    const ids = groupMembers(p).map((m) => m.id);
    const active = [...new Set((db().prepare(`SELECT json_extract(data,'$.ticket.key') AS k, source_ref FROM tasks WHERE project_id IN (${ids.map(() => "?").join(",")}) AND source='jira' AND state NOT IN ('DONE','CANCELLED','FAILED')`)
      .all(...ids) as any[]).map((r) => r.k ?? String(r.source_ref).split("@")[0]).filter(Boolean))];
    const ors = ["assignee = currentUser()"];
    if (active.length) ors.push(`issuekey in (${active.join(",")})`);
    if (p.roles.includes("qa-engineer")) ors.push(`status = "${p.jira!.qaStatus}"`);
    if (p.roles.includes("business-analyst")) ors.push("issuetype = Epic");
    const jql = `project in (${p.jira!.keys.join(",")}) AND updated >= "-${mins}m" AND (${ors.join(" OR ")})${p.jira!.jqlExtra ? ` AND (${p.jira!.jqlExtra})` : ""} ORDER BY updated ASC`;
    const items = await jira.search(jql, 200);
    count += items.length;
    createdAll.push(...(await processItems(p, items, me)));
    setCursor(cursor, started);                      // advance only after events are stored
  }
  await handleBurst(createdAll);
  await checkDeletedIssues();
  return { items: count, tasks: createdAll };
}

/** Sprint start: many tickets at once -> one batched message, user chooses. */
async function handleBurst(created: Task[]): Promise<void> {
  const s = loadSettings();
  const fresh = created.filter((t) => t.state === "DETECTED");
  if (fresh.length <= s.limits.burstThreshold) return;
  for (const t of fresh) mergeData(t.id, { burst: true });
  await notify({
    kind: "burst", dedupeKey: fresh.map((t) => t.id).join(","),
    title: `${fresh.length} new tasks arrived at once`,
    body: `${fresh.map((t) => `• ${t.source_ref} ${t.title}`).join("\n").slice(0, 1500)}\n\nReply "start all" or "start <task>" in the Teams bot chat, or run "aiw start all" / "aiw start <task>" in Claude Code.`,
  });
}

/** Every ~30 minutes: verify that tickets behind active tasks still exist. */
async function checkDeletedIssues(): Promise<void> {
  const last = getMeta("deleted_check");
  if (last && Date.now() - new Date(last).getTime() < 30 * 60_000) return;
  setMeta("deleted_check", nowIso());
  const jira = clients.jira();
  if (!jira) return;
  const active = (db().prepare("SELECT id FROM tasks WHERE source='jira' AND state NOT IN ('DONE','CANCELLED','FAILED')").all() as any[]).map((r) => getTask(r.id)!).filter(Boolean);
  for (const t of active) {
    const issue = await jira.getIssue(jiraKey(t));
    if (!issue) {
      await cancelTask(t.id, "ticket deleted");
      await notify({ kind: "info", taskId: t.id, taskRef: t.source_ref ?? undefined, title: `${jiraKey(t)} was deleted`, body: "The ticket no longer exists, so the work was cancelled." });
    }
  }
}

export async function pollCi(): Promise<Task[]> {
  const gh = clients.github();
  if (!gh) return [];
  const created: Task[] = [];
  for (const p of loadProjects().filter((x) => x.github && x.roles.some((r) => r === "devops-engineer" || /developer$/.test(r)))) {
    const cursor = `ci:${p.id}`;
    const since = getCursor(cursor) ?? new Date(Date.now() - 6 * 3_600_000).toISOString();
    const branches = p.roles.includes("devops-engineer") ? [p.github!.baseBranch, "aiw/*"] : ["aiw/*"];
    const started = nowIso();
    const runs = await gh.failedRuns(p.github!.repo, since, branches);
    for (const run of runs) {
      const idem = `ci:${run.id}:failed`;
      const r = db().prepare("INSERT OR IGNORE INTO events (id, idem_key, type, project_id, source_ref, payload, received_at) VALUES (?,?,?,?,?,?,?)")
        .run(newId("e"), idem, "ci_failed", p.id, run.id, JSON.stringify(run), nowIso());
      if (!r.changes) continue;
      created.push(createTask({ projectId: p.id, source: "github", sourceId: `ci:${run.id}`, sourceRef: `CI-${run.id}`, title: `${run.workflow} failed on ${run.branch}`, kind: "ci_failed", role: "devops-engineer", priority: 2, data: { ciRun: run } }));
    }
    setCursor(cursor, started);
  }
  return created;
}

/** Project Manager digest once per working day at the configured time. */
export function scheduleDigests(now = new Date()): Task[] {
  const s = loadSettings();
  const [h, m] = localHourMinute(now, s.profile.timezone);
  const [dh, dm] = s.notifications.digestTime.split(":").map(Number);
  if (h * 60 + m < dh * 60 + dm) return [];
  const today = now.toISOString().slice(0, 10);
  const created: Task[] = [];
  // One digest per product: for a multi-repo group only the lead project produces it.
  for (const p of loadProjects().filter((x) => x.roles.includes("project-manager") && x.jira && isGroupLead(x))) {
    const key = `digest:${p.id}`;
    if (getMeta(key) === today) continue;
    setMeta(key, today);
    created.push(createTask({ projectId: p.id, source: "schedule", sourceId: `digest:${p.id}:${today}`, sourceRef: `DIGEST-${today}`, title: `Daily digest ${today}`, kind: "daily_digest", role: "project-manager", priority: 4 }));
  }
  return created;
}

/** Manual trigger: `/aiw run PAY-142`. */
export async function runTicket(key: string): Promise<Task> {
  const jira = clients.jira();
  if (!jira) throw new Error("Jira is not connected");
  const item = await jira.getIssue(key);
  if (!item) throw new Error(`Ticket ${key} not found`);
  const project = loadProjects().find((p) => p.jira?.keys.includes(item.projectKey) && isGroupLead(p));
  if (!project) throw new Error(`No project is configured for Jira key ${item.projectKey}. Add one with \`aiw project add\`.`);
  saveSnapshot(project.id, item);
  const kind = isDeveloper(project.roles) ? "assigned" : project.roles.includes("qa-engineer") ? "ready_for_qa" : project.roles.includes("business-analyst") ? "epic_created" : "assigned";
  const t = createTask({ projectId: project.id, source: "jira", sourceId: item.id, sourceRef: item.key, title: item.title, kind, priority: priorityOf(item), data: { ticket: ticketData(item), manual: true } });
  audit("user", "task.manual_run", t.id, { key });
  return t;
}

export function isWorkingHours(now = new Date()): boolean {
  const s = loadSettings();
  return inTimeWindow(s.profile.workingHours, now, s.profile.timezone);
}

export async function pollAll(): Promise<{ items: number; tasks: number; errors: string[] }> {
  const errors: string[] = [];
  let items = 0, tasks = 0;
  if (isConnected("jira")) {
    try { const r = await pollJira(); items += r.items; tasks += r.tasks.length; } catch (e: any) { errors.push(`jira: ${e.message}`); logger.warn("jira poll failed", { error: e.message }); }
  }
  if (isConnected("github")) {
    // one "PR watcher" row on the dashboard for the PR polls; each poll keeps its own error handling
    await runTimed("PR watcher", async () => {
      try { tasks += (await pollCi()).length; } catch (e: any) { errors.push(`github: ${e.message}`); logger.warn("ci poll failed", { error: e.message }); }
      try { await pollPrActivity(); } catch (e: any) { logger.warn("PR activity poll failed", { error: e.message }); }
      try { await pollReviewedPrs(); } catch (e: any) { logger.warn("reviewed PR poll failed", { error: e.message }); }
    }).catch(() => {});
    // engine v2: GitHub producers (conditional requests) -> kernel events -> reactions; a no-op on v1, which keeps the polls above
    try { const { runGitHubProducers } = await import("./github.js"); const r = await runGitHubProducers(); if (r?.errors?.length) errors.push(...r.errors.map((x) => `github: ${x}`)); }
    catch (e: any) { logger.warn("GitHub events failed", { error: e.message }); }
    try { const { pollCiWatches } = await import("../engine/prFix.js"); await runTimed("CI watch", () => pollCiWatches()); } catch (e: any) { logger.warn("CI watch failed", { error: e.message }); }
  }
  if (isConnected("jira")) {
    // open tickets by name, for Teams messages like "start the invite email task" (one search every 15 minutes)
    try { const { refreshTicketIndex } = await import("./ticketIndex.js"); await runTimed("Ticket index", () => refreshTicketIndex()); } catch (e: any) { logger.warn("ticket index refresh failed", { error: e.message }); }
  }
  tasks += scheduleDigests().length;
  setMeta("last_poll", JSON.stringify({ at: nowIso(), items, tasks, errors }));
  return { items, tasks, errors };
}

export { canTransition };
