import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "node:os";
import { loadSettings } from "../core/config.js";
import { api, kick, readRuntime, pidAlive } from "../core/runtime.js";
import { statusSnapshot, taskDetail, tasksList, inboxView, cost, inboxSummaryLine } from "../api/ops.js";
import { decideAndApply, cancelTask, resumeTask, startAwaiting, pauseAll, resumeAll } from "../engine/engine.js";
import { askBrain, brainSummary } from "../brain/brain.js";
import { runTicket } from "../intake/intake.js";

/**
 * aiw-mcp: lets the user operate AI Workforce conversationally inside Claude Code.
 * It is a client – the background service does the actual work.
 */
const server = new McpServer({ name: "ai-workforce", version: "0.1.0" });
const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });
const approver = () => loadSettings().profile.name || os.userInfo().username;

server.registerTool("aiw_status", { description: "AI Workforce health: service, connections, projects, task counts and inbox summary." }, async () => {
  const rt = readRuntime();
  return text({ service: rt && pidAlive(rt.pid) ? "running" : "NOT RUNNING (run `aiw service start`)", inbox: inboxSummaryLine(), ...statusSnapshot() });
});

server.registerTool("aiw_inbox", { description: "Items that need the user's attention: approvals, questions, failures, connector problems.", inputSchema: { all: z.boolean().optional() } },
  async ({ all }) => text(inboxView(!!all)));

server.registerTool("aiw_list_tasks", { description: "List AI Workforce tasks, optionally filtered by state (e.g. AWAITING_APPROVAL, RUNNING, DONE).", inputSchema: { state: z.string().optional() } },
  async ({ state }) => text(tasksList(state ? state.split(",") : undefined, 50)));

server.registerTool("aiw_task_report", { description: "Status and full detail of one AI Workforce task (ticket key like KAN-42, KAN-42@repo, or TASK-7): `now` says where it is in plain words, `waitingFor` what it needs from the user; plus plan, steps, approval, report and PR link. Use this to answer \"what's the status of KAN-42?\".", inputSchema: { ref: z.string() } },
  async ({ ref }) => text(taskDetail(ref) ?? `No task ${ref}`));

server.registerTool("aiw_approve", {
  description: "Approve the pending action (plan, requirements or pull request) for a task. Only call this when the user explicitly says to approve. When approvals are Teams-only (the default with the Teams chat) this refuses and tells the user to approve in Teams – relay that.",
  inputSchema: { ref: z.string() },
}, async ({ ref }) => {
  const r = (await api("POST", `/api/approve/${encodeURIComponent(ref)}`, { approver: approver(), channel: "claude-code" }).catch(() => undefined))
    ?? (await decideAndApply(ref, "approved", approver(), "claude-code"));
  return text(r.message);
});

server.registerTool("aiw_reject", {
  description: "Reject a pending action with feedback; the task re-runs using the feedback. Only call when the user explicitly rejects. Refused when approvals are Teams-only – relay that.",
  inputSchema: { ref: z.string(), reason: z.string() },
}, async ({ ref, reason }) => {
  const r = (await api("POST", `/api/reject/${encodeURIComponent(ref)}`, { approver: approver(), channel: "claude-code", reason }).catch(() => undefined))
    ?? (await decideAndApply(ref, "rejected", approver(), "claude-code", reason));
  return text(r.message);
});

server.registerTool("aiw_answer", {
  description: "Answer a clarification question an AI Workforce task asked (state NEEDS_INFO). Only pass what the user actually said. Refused when answers are Teams-only – relay that.",
  inputSchema: { ref: z.string().optional(), answer: z.string() },
}, async ({ ref, answer }) => {
  const r = (await api("POST", "/api/answer", { ref, answer, by: approver() }).catch(() => undefined))
    ?? (await (await import("../engine/engine.js")).answerTask(ref, answer, approver()));
  return text(r.message);
});

server.registerTool("aiw_run_ticket", {
  description: "Hand a Jira ticket (e.g. KAN-42) to AI Workforce: it analyses and plans it, sends the plan to the user's Teams chat for approval, builds and tests it, asks any questions in Teams, and raises a draft PR after a second approval in Teams. Use this instead of implementing the ticket yourself in projects managed by AI Workforce.",
  inputSchema: { key: z.string() },
}, async ({ key }) => {
  const k = key.trim().toUpperCase().split("@")[0];
  const existing = tasksList(undefined, 500).filter((t) => String(t.ref ?? "").split("@")[0] === k && !["DONE", "CANCELLED", "FAILED"].includes(t.state));
  if (existing.length) return text(`${k} is already with AI Workforce:\n${existing.map((t) => `${t.ref}: ${t.now}${t.waitingFor ? ` – waiting for ${t.waitingFor}` : ""}`).join("\n")}`);
  const r = await api("POST", "/api/tasks/run", { key: k }, 60_000);
  if (r) return text(`Started ${r.ref}. The plan will come to the user's Teams chat for approval.`);
  const t = await runTicket(k);
  return text(`Queued ${t.source_ref}; the background service will start it when running (it is not running now – suggest \`aiw service start\`).`);
});

server.registerTool("aiw_review_pr", {
  description: "Review a pull request (the user's own or a teammate's) with AI Workforce: it reads the PR, the Jira ticket with its comments, the PRD (project documents, linked pages), the team's rules and the related code, gives a verdict and line comments, and shows them in the user's Teams chat FIRST. Nothing is posted until the user replies \"post\" there; it only ever posts a comment review (never approves or merges). pr: a PR link, or \"90\" / \"90 frontend\". ticket: a Jira key instead, to review that ticket's PRs.",
  inputSchema: { pr: z.string().optional(), ticket: z.string().optional() },
}, async ({ pr, ticket }) => {
  const p = (pr ?? "").trim();
  const r = await api("POST", "/api/review", { pr: /^\d+\b/.test(p) ? `PR ${p}` : p, ticket, by: loadSettings().profile.name || os.userInfo().username }, 60_000).catch(() => undefined);
  return text(r ? `${r.message}\nThe comments will come to the user's Teams chat for review before anything is posted.` : "The AI Workforce service is not running – suggest `aiw service start`.");
});

server.registerTool("aiw_start_request", {
  description: "Hand new work that has NO Jira ticket to AI Workforce (e.g. \"add a CSV export to the orders page\"). It creates a task (TASK-n), interviews the user in their Teams chat until the requirements are complete, asks them to confirm, then plans (plan approval in Teams), builds, tests and raises a draft PR after approval in Teams. Pass the user's request in their own words. project: a project id or group; omit to use the project of the current folder.",
  inputSchema: { description: z.string(), project: z.string().optional(), cwd: z.string().optional() },
}, async ({ description, project, cwd }) => {
  const { resolveProduct, createRequest, projectForPath } = await import("../engine/requests.js");
  const here = projectForPath(cwd ?? process.cwd());
  const { project: p, choices } = resolveProduct(project, cwd ?? process.cwd());
  if (!p) return text(`Which project is this for? Ask the user and call again with project set to one of: ${choices.map((c) => c.group ?? c.id).join(", ") || "(none configured)"}.`);
  const t = createRequest(description, approver(), p, { preferRepo: here?.id, via: "claude-code" });
  await kick();
  return text(`Created ${t.source_ref} in ${p.group ?? p.id}. AI Workforce will now ask the user about the requirements in their Teams chat; plan and PR approvals also happen there. Tell the user to watch the Teams chat.`);
});

server.registerTool("aiw_task_control", {
  description: "Control a task: start (from AWAITING_START), resume (after pause/failure), or cancel.",
  inputSchema: { ref: z.string(), action: z.enum(["start", "resume", "cancel"]) },
}, async ({ ref, action }) => {
  if (action === "start") { const n = startAwaiting(ref); await kick(); return text(`Started ${n} task(s).`); }
  if (action === "resume") { const t = resumeTask(ref); await kick(); return text(t ? `${ref}: ${t.state}` : `No task ${ref}`); }
  const t = await cancelTask(ref);
  return text(t ? `${ref}: ${t.state}` : `No task ${ref}`);
});

server.registerTool("aiw_pause", { description: "Pause or resume picking up new work (e.g. during holidays).", inputSchema: { pause: z.boolean(), until: z.string().optional() } },
  async ({ pause, until }) => { if (pause) pauseAll(until); else { resumeAll(); await kick(); } return text(pause ? `Paused${until ? ` until ${until}` : ""}.` : "Resumed."); });

server.registerTool("aiw_brain_ask", { description: "Search a project's Brain (Handbook facts, past tasks, code map) for an answer.", inputSchema: { project: z.string(), question: z.string() } },
  async ({ project, question }) => text(askBrain(project, question)));

server.registerTool("aiw_brain_summary", { description: "Summary of what the Brain knows about a project.", inputSchema: { project: z.string() } },
  async ({ project }) => text(brainSummary(project)));

server.registerTool("aiw_brain_add_doc", {
  description: "Store a product document (PRD, requirements, spec: .pdf .docx .md .txt) in a project's Brain so every task gets the relevant sections. For multi-repo products it is stored for all repositories.",
  inputSchema: { project: z.string(), file: z.string(), title: z.string().optional(), private: z.boolean().optional() },
}, async ({ project, file, title, private: priv }) => {
  const { getProject, loadProjects } = await import("../core/config.js");
  const p = getProject(project);
  if (!p) return text(`No project ${project}`);
  const targets = p.group ? loadProjects().filter((x) => x.group === p.group).map((x) => x.id) : [project];
  const { addDocument } = await import("../brain/docs.js");
  const res = await addDocument(targets, file, { title, private: priv });
  return text(res.map((r) => `${r.project}: "${r.title}" – ${r.sections} sections${r.private ? " (private)" : ""} → ${r.file}`).join("\n"));
});

server.registerTool("aiw_jira_search", {
  description: "Read-only Jira search with JQL (e.g. 'project = KAN AND statusCategory = \"In Progress\"'). Returns key, status, assignee, priority and summary. Never changes Jira.",
  inputSchema: { jql: z.string(), max: z.number().optional() },
}, async ({ jql, max }) => {
  const { clients } = await import("../connectors/registry.js");
  const jira = clients.jira();
  if (!jira) return text("Jira is not connected.");
  const items = await jira.search(jql, Math.min(max ?? 50, 100));
  return text(items.length ? items.map((i) => `${i.key} [${i.status}] ${i.assigneeName ?? "unassigned"} · ${i.priority ?? "-"} · ${i.title}`).join("\n") : "No issues match.");
});

server.registerTool("aiw_cost", { description: "Token usage and cost by project, day and task.", inputSchema: { days: z.number().optional() } },
  async ({ days }) => text(cost(days ?? 7)));

server.registerTool("aiw_bench_report", {
  description: "Token and cost baseline: the costliest steps, agents and tickets. With runA and runB, compares two benchmark runs ticket by ticket (lower is better; regressions are marked).",
  inputSchema: { runA: z.string().optional(), runB: z.string().optional() },
}, async ({ runA, runB }) => {
  const B = await import("../bench/benchmark.js");
  if (runA && runB) return text(B.renderComparison(B.compareRuns(runA, runB)));
  return text(B.renderBaseline(B.baselineReport()));
});

server.registerTool("aiw_doctor", {
  description: "Environment doctor for one project: can its tests run on this computer? Checks Python/Node versions, the virtual environment and packages, .env key names (never values), the database and docker-compose services. Returns a short report and how to fix each problem.",
  inputSchema: { project: z.string(), smoke: z.boolean().optional() },
}, async ({ project, smoke }) => {
  const { getProject, loadProjects } = await import("../core/config.js");
  const p = getProject(project);
  if (!p) return text(`No project ${project}. Projects: ${loadProjects().map((x) => x.id).join(", ") || "none"}`);
  const E = await import("../engine/envDoctor.js");
  const r = await E.checkEnvironment(p.local.path, { project: p, force: true, smoke: !!smoke });
  return text({ ok: r.ok, report: E.envReport(r), checks: r.checks });
});

await server.connect(new StdioServerTransport());
