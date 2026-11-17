import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { paths, ensureDir } from "../core/paths.js";
import { truncate } from "../core/util.js";
import { db, audit } from "../core/db.js";
import { stripAttribution } from "../core/attribution.js";
import { getTask, jiraKey, partsOf, stepsFor, listTasks, mergeData, addUsage, type Task } from "../engine/tasks.js";
import { getProject, loadSettings } from "../core/config.js";
import { getRunner } from "../agents/runner.js";
import { notify } from "../notify/router.js";
import type { StepCtx } from "../engine/steps.js";
import { shareInTeams } from "../notify/files.js";

/**
 * After the PR is raised: one PDF per ticket – what was asked, what was decided, what changed in each repository and
 * why, diagrams of the change, tests, reviews, screenshots, PR links, time and cost. Built locally (HTML printed to PDF
 * by Edge / Chrome on this computer), sent to Teams as a link, and kept in the project's reports folder.
 */

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ------------------------------------------------------------------ diagrams (plain SVG, no scripts)

const LAYERS = ["ui", "api", "service", "data", "external"] as const;
const LAYER_NAME: Record<string, string> = { ui: "Screens", api: "API", service: "Logic", data: "Data", external: "Outside services" };

interface FlowNode { id: string; label: string; layer: string; changed?: boolean }
interface FlowEdge { from: string; to: string; label?: string }

/** Layered left-to-right flow: one column per layer, changed parts highlighted. */
export function flowSvg(nodes: FlowNode[], edges: FlowEdge[]): string {
  if (!nodes.length) return "";
  const cols = LAYERS.filter((l) => nodes.some((n) => n.layer === l));
  const W = 190, H = 52, GX = 70, GY = 26, TOP = 34, LEFT = 10;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((l, c) => nodes.filter((n) => n.layer === l).forEach((n, r) => pos.set(n.id, { x: LEFT + c * (W + GX), y: TOP + r * (H + GY) })));
  const rows = Math.max(...cols.map((l) => nodes.filter((n) => n.layer === l).length));
  const width = LEFT * 2 + cols.length * W + (cols.length - 1) * GX, height = TOP + rows * (H + GY) + 10;
  const parts: string[] = [];
  cols.forEach((l, c) => parts.push(`<text x="${LEFT + c * (W + GX) + W / 2}" y="18" class="col">${esc(LAYER_NAME[l] ?? l)}</text>`));
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const forward = b.x >= a.x;
    const x1 = forward ? a.x + W : a.x, x2 = forward ? b.x : b.x + W;
    const y1 = a.y + H / 2, y2 = b.y + H / 2;
    const same = a.x === b.x;
    const d = same ? `M${a.x + W} ${y1} C${a.x + W + 40} ${y1}, ${b.x + W + 40} ${y2}, ${b.x + W} ${y2}` : `M${x1} ${y1} C${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
    parts.push(`<path d="${d}" class="edge" marker-end="url(#arr)"/>`);
    if (e.label) parts.push(`<text x="${same ? a.x + W + 44 : (x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" class="elabel">${esc(cut(e.label, 30))}</text>`);
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="9" class="${n.changed ? "node changed" : "node"}"/>`);
    parts.push(`<text x="${p.x + W / 2}" y="${p.y + H / 2 + 4}" class="nlabel">${esc(cut(n.label, 28))}</text>`);
    if (n.changed) parts.push(`<text x="${p.x + W - 8}" y="${p.y + 13}" class="tag">changed</text>`);
  }
  return svg(width, height, parts);
}

/** Who provides what to whom across the repositories (from the contract). */
export function contractSvg(contract: any, repos: string[]): string {
  const items = (contract?.items ?? []).slice(0, 10);
  if (!items.length || repos.length < 2) return "";
  const W = 170, gap = 400, TOP = 40, RH = 34;
  const x = (repo: string) => (repos.indexOf(repo) <= 0 ? 10 : 10 + W + gap);
  const height = TOP + items.length * RH + 20;
  const parts = [
    `<rect x="10" y="${TOP - 26}" width="${W}" height="${height - TOP + 16}" rx="10" class="node"/><text x="${10 + W / 2}" y="${TOP - 8}" class="col">${esc(repos[0])}</text>`,
    `<rect x="${10 + W + gap}" y="${TOP - 26}" width="${W}" height="${height - TOP + 16}" rx="10" class="node"/><text x="${10 + W + gap + W / 2}" y="${TOP - 8}" class="col">${esc(repos[1])}</text>`,
  ];
  items.forEach((it: any, i: number) => {
    const y = TOP + 20 + i * RH;
    const from = x(it.producer || repos[0]) === 10 ? 10 + W : 10 + W + gap;
    const to = from === 10 + W ? 10 + W + gap : 10 + W;
    parts.push(`<path d="M${from} ${y} L${to} ${y}" class="edge" marker-end="url(#arr)"/>`);
    parts.push(`<text x="${10 + W + gap / 2}" y="${y - 6}" class="elabel">${esc(cut(`${it.kind ? `[${it.kind}] ` : ""}${it.name}`, 58))}</text>`);
  });
  return svg(10 * 2 + W * 2 + gap, height, parts);
}

/** What happened, in order: steps, approvals and the PR. */
export function timelineSvg(events: { at: string; label: string; kind: "step" | "you" | "pr" | "problem" }[]): string {
  if (!events.length) return "";
  const RH = 30, TOP = 16, width = 760;
  const parts = [`<line x1="120" y1="${TOP}" x2="120" y2="${TOP + (events.length - 1) * RH}" class="line"/>`];
  events.forEach((e, i) => {
    const y = TOP + i * RH;
    const t = new Date(e.at);
    parts.push(`<text x="104" y="${y + 4}" class="time">${esc(isNaN(+t) ? "" : `${t.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${t.toTimeString().slice(0, 5)}`)}</text>`);
    parts.push(`<circle cx="120" cy="${y}" r="6" class="dot ${e.kind}"/>`);
    parts.push(`<text x="136" y="${y + 4}" class="event">${esc(cut(e.label, 95))}</text>`);
  });
  return svg(width, TOP + events.length * RH, parts);
}

const svg = (w: number, h: number, parts: string[]) => `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" xmlns="http://www.w3.org/2000/svg" role="img">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#5b6472"/></marker></defs>
${parts.join("\n")}</svg>`;

// ------------------------------------------------------------------ the data

const STEP_NAME: Record<string, string> = {
  triage: "Ticket sized up", understand: "Ticket, PRD and code understood", analyse: "Requirements analysed", contract: "Contract between repositories agreed",
  lead_plan: "Plan written", plan: "Plan written", plan_review: "Plan reviewed", plan_gate: "Plan sent for approval", prepare_workspace: "Workspace prepared",
  context_pack: "Project knowledge gathered", implement_test: "Built and tested", reviews: "Code, security and QA reviews", prepublish: "Rebased and re-checked",
  report: "PR description and screenshots", run_parts: "Repositories built", integration_check: "Integration check", request_approval: "Sent for PR approval",
  publish: "Draft PR raised", publish_parts: "Draft PRs raised", propose_memory: "Lessons proposed",
};

/** Shorten for a diagram or a list – a clean "…", never a "[truncated]" marker. */
const cut = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
/** "Q → answer" stored for a clarification: only the answer part. */
const answerOf = (c: any) => {
  let a = String(c.answer ?? "");
  const q = (c.questions ?? []).join(" / ");
  if (q && a.startsWith(q)) a = a.slice(q.length).replace(/^\s*→\s*/, "");
  return cut(a, 160);
};
/** Escaped text with the little markdown the agents write: **bold** and `code`. */
const md = (s: unknown) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");

const GATES = new Set(["plan_gate", "request_approval"]);

function timeline(lead: Task, parts: Task[]): { at: string; label: string; kind: "step" | "you" | "pr" | "problem" }[] {
  const ev: { at: string; label: string; kind: "step" | "you" | "pr" | "problem" }[] = [{ at: lead.created_at, label: "Ticket received", kind: "step" }];
  const seen = new Set<string>();
  const add = (t: Task, prefix: string) => {
    for (const s of stepsFor(t.id)) {
      if (!STEP_NAME[s.name] || ["running", "wait"].includes(s.status)) continue;
      const at = s.ended_at ?? s.started_at;
      // approval stops: shown once, when it was sent to you (your decision is its own line)
      if (GATES.has(s.name)) { if (s.status === "await_approval") ev.push({ at, label: `${prefix}${STEP_NAME[s.name]}`, kind: "step" }); continue; }
      if (s.status === "need_info") { ev.push({ at, label: `${prefix}${STEP_NAME[s.name]} – asked you a question`, kind: "you" }); continue; }
      if (s.status !== "ok") { ev.push({ at, label: `${prefix}${STEP_NAME[s.name]} – failed once, retried`, kind: "problem" }); continue; }
      const label = `${prefix}${STEP_NAME[s.name]}`;
      if (seen.has(label)) continue;                                   // repeated rounds: show the first
      seen.add(label);
      ev.push({ at, label, kind: /^publish/.test(s.name) ? "pr" : "step" });
    }
  };
  add(lead, "");
  for (const p of parts) add(p, `${p.project_id}: `);
  for (const a of db().prepare("SELECT action, state, decided_at, approver FROM approvals WHERE task_id=? AND decided_at IS NOT NULL").all(lead.id) as any[]) {
    const what = a.action === "implement_plan" ? "plan" : a.action === "create_pr" ? "PR" : a.action.replace(/_/g, " ");
    ev.push({ at: a.decided_at, label: `You ${a.state === "approved" ? "approved" : "asked to change"} the ${what}`, kind: "you" });
  }
  for (const c of lead.data.clarifications ?? []) if (c.at) ev.push({ at: c.at, label: c.delegated ? "You left a decision to the agent" : `You answered: ${cut(answerOf(c), 70)}`, kind: "you" });
  return ev.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 45);
}

const imgData = (file?: string) => {
  try { if (file && fs.existsSync(file) && fs.statSync(file).size < 3 * 1024 * 1024) return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`; } catch { /* skip */ }
  return "";
};

function testsText(t: Task): string {
  const d = t.data;
  if (d.testsUnavailable) return `Not run on this computer – ${d.testsUnavailable.reason}. Checked by reading; CI must pass before merging.`;
  if (!d.tests) return "–";
  return d.tests.ran ? (d.tests.passed ? `Passed${d.tests.attempts ? ` (attempt ${d.tests.attempts})` : ""}` : "Failing") : "No test command in this repository";
}

// ------------------------------------------------------------------ HTML

export function reportHtml(lead: Task, w: any, parts: Task[]): string {
  const d = lead.data;
  const key = jiraKey(lead) || lead.source_ref || lead.id;
  const repos: Task[] = parts.length ? parts : [lead];
  const prs: { repo: string; number: number; url: string }[] = d.prs ?? (d.pr ? [{ repo: lead.project_id, ...d.pr }] : []);
  const usd = lead.cost_usd + parts.reduce((n, p) => n + p.cost_usd, 0);
  const tokens = lead.tokens_used + parts.reduce((n, p) => n + p.tokens_used, 0);
  const decisions: string[] = [
    ...(d.clarifications ?? []).map((c: any) => (c.delegated ? "You left this decision to the agent – its choice is listed below" : `Your answer: ${answerOf(c)}`)),
    ...(d.understanding?.decisions ?? []),
    ...(d.assumptions ?? []).map((a: string) => `Assumed: ${a}`),
  ];
  const changeBlocks = repos.map((p) => {
    const ai = (w.changes ?? []).find((c: any) => c.repo === p.project_id) ?? (repos.length === 1 ? (w.changes ?? [])[0] : undefined);
    const files: { file: string; why: string }[] = ai?.files?.length ? ai.files : (p.data.changedFiles ?? []).map((f: string) => ({ file: f, why: "" }));
    const reviews = Object.entries(p.data.reviews ?? {}).map(([k, v]: any) => `${k}: ${v.pass ? "passed" : "issues"}`).join(" · ") || "–";
    const shots = p.data.screenshots?.taken ? (p.data.screenshots.pages ?? []).map((s: any) => `<figure><div class="shots">${s.desktop ? `<img src="${imgData(s.desktop)}" class="desk">` : ""}${s.mobile ? `<img src="${imgData(s.mobile)}" class="mob">` : ""}</div><figcaption>${esc(s.name)}${s.state ? ` – ${esc(s.state)}` : ""}${s.route ? ` <code>${esc(s.route)}</code>` : ""}</figcaption></figure>`).join("") : "";
    return `<section class="repo"><h3>${esc(p.project_id)}</h3>
<p>${md(ai?.what ?? p.data.implementation?.summary ?? p.data.plan?.summary ?? "")}</p>
<table><thead><tr><th>File</th><th>Why</th></tr></thead><tbody>${files.slice(0, 40).map((f) => `<tr><td><code>${esc(f.file)}</code></td><td>${esc(f.why)}</td></tr>`).join("") || `<tr><td colspan="2">–</td></tr>`}</tbody></table>
<dl class="facts"><dt>Branch</dt><dd><code>${esc(p.branch ?? "–")}</code></dd><dt>Size</dt><dd>${p.data.diffStat ? `${p.data.diffStat.files} files, +${p.data.diffStat.added} / −${p.data.diffStat.removed}` : "–"}</dd>
<dt>Tests</dt><dd>${esc(testsText(p))}</dd><dt>Reviews</dt><dd>${esc(reviews)}</dd></dl>
${(p.data.unresolvedIssues ?? []).length ? `<p class="warn">Open review findings: ${esc(p.data.unresolvedIssues.map((x: any) => x.description).join("; "))}</p>` : ""}
${shots ? `<h4>Screenshots</h4>${shots}` : p.data.screenshots && !p.data.screenshots.taken ? `<p class="muted">Screenshots could not be taken: ${esc(p.data.screenshots.reason)}</p>` : ""}
</section>`;
  }).join("\n");
  const flow = flowSvg(w.flow?.nodes ?? [], w.flow?.edges ?? []);
  const contract = contractSvg(d.contract, d.targets ?? parts.map((p) => p.project_id));
  const tl = timelineSvg(timeline(lead, parts));
  const integ = d.integration && !d.integration.single ? `<h2>Integration check</h2><p>${d.integration.pass ? "✔ The repositories fit together." : "⚠ Open points remain:"} ${md(d.integration.summary ?? "")}</p>${(d.integration.issues ?? []).length ? `<ul>${d.integration.issues.map((x: any) => `<li>${md(`[${x.repo}] ${x.description}`)}</li>`).join("")}</ul>` : ""}` : "";
  const criteria: string[] = d.requirements?.acceptanceCriteria ?? [];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(key)} – ${esc(lead.title ?? "")}</title><style>
@page { size: A4; margin: 16mm 14mm; }
body { font: 10.5pt/1.5 "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color: #1d2330; margin: 0; }
header { border-bottom: 3px solid #2f6fdf; padding-bottom: 10px; margin-bottom: 14px; }
header .key { color: #2f6fdf; font-weight: 700; letter-spacing: .02em; }
h1 { font-size: 19pt; margin: 2px 0 6px; line-height: 1.2; } h2 { font-size: 13pt; margin: 22px 0 8px; color: #18315f; border-bottom: 1px solid #dfe5ef; padding-bottom: 3px; }
h3 { font-size: 11.5pt; margin: 14px 0 6px; } h4 { font-size: 10.5pt; margin: 10px 0 6px; }
.meta { color: #5b6472; font-size: 9.5pt; } .muted { color: #5b6472; } .warn { color: #a3470b; }
.summary { background: #f2f6fd; border-left: 4px solid #2f6fdf; padding: 10px 12px; border-radius: 4px; }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin: 6px 0; } th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #e6eaf1; vertical-align: top; } th { background: #f6f8fb; }
code { font: 9pt Consolas, "Cascadia Mono", monospace; background: #f3f4f7; padding: 0 3px; border-radius: 3px; word-break: break-all; }
dl.facts { display: grid; grid-template-columns: 90px 1fr; gap: 2px 10px; margin: 8px 0; font-size: 9.5pt; } dl.facts dt { color: #5b6472; } dl.facts dd { margin: 0; }
section.repo { break-inside: avoid-page; } figure { margin: 8px 0 12px; break-inside: avoid; } figcaption { font-size: 9pt; color: #5b6472; }
.shots { display: flex; gap: 10px; align-items: flex-start; } .shots img { border: 1px solid #d5dbe6; border-radius: 4px; } .shots .desk { width: 72%; } .shots .mob { width: 22%; }
.diagram { break-inside: avoid; margin: 8px 0; }
svg text { font-family: "Segoe UI", Arial, sans-serif; } .col { font-size: 11px; font-weight: 700; fill: #18315f; text-anchor: middle; }
.node { fill: #f6f8fb; stroke: #9aa6b8; stroke-width: 1.2; } .node.changed { fill: #e7f0ff; stroke: #2f6fdf; stroke-width: 2; }
.nlabel { font-size: 11px; fill: #1d2330; text-anchor: middle; } .tag { font-size: 8px; fill: #2f6fdf; text-anchor: end; font-weight: 700; }
.edge { fill: none; stroke: #5b6472; stroke-width: 1.3; } .elabel { font-size: 9.5px; fill: #3b4352; text-anchor: middle; }
.line { stroke: #c8d0dd; stroke-width: 2; } .time { font-size: 9.5px; fill: #5b6472; text-anchor: end; } .event { font-size: 10.5px; fill: #1d2330; }
.dot { fill: #9aa6b8; } .dot.you { fill: #e08a00; } .dot.pr { fill: #1f9d55; } .dot.problem { fill: #c43d3d; }
ul { margin: 4px 0 4px 18px; padding: 0; } li { margin: 2px 0; }
</style></head><body>
<header><div class="key">${esc(key)}</div><h1>${esc(lead.title ?? "")}</h1>
<div class="meta">${esc(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }))} · ${esc(repos.map((p) => p.project_id).join(" + "))} · ${prs.length} draft PR${prs.length === 1 ? "" : "s"}${d.ticket?.url ? ` · <a href="${esc(d.ticket.url)}">${esc(d.ticket.url)}</a>` : ""}</div></header>
<p class="summary">${md(w.summary ?? d.plan?.summary ?? "")}</p>
<h2>What was asked</h2><p>${esc(w.asked ?? d.ticket?.title ?? "")}</p>
${criteria.length ? `<h4>Done when</h4><ul>${criteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
${decisions.length ? `<h2>Decisions</h2><ul>${decisions.slice(0, 20).map((x) => `<li>${md(x)}</li>`).join("")}</ul>` : ""}
<h2>How the change works</h2>${flow ? `<div class="diagram">${flow}</div><p class="muted">Highlighted boxes were added or changed by this ticket.</p>` : ""}
<p>${md(w.outcome ?? "")}</p>
${contract ? `<h3>Between the repositories</h3><div class="diagram">${contract}</div>` : ""}
<h2>What changed</h2>${changeBlocks}
${integ}
<h2>Pull requests</h2><ul>${prs.map((p) => `<li>${esc(p.repo)} – <a href="${esc(p.url)}">PR #${esc(p.number)}</a> (draft, not merged)</li>`).join("") || "<li>–</li>"}</ul>
${(w.followUps ?? []).length ? `<h2>Follow-ups</h2><ul>${w.followUps.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
<h2>What happened</h2><div class="diagram">${tl}</div>
<p class="meta">Effort: ${tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`} tokens · $${usd.toFixed(2)} · started ${esc(new Date(lead.created_at).toLocaleString("en-GB"))}</p>
</body></html>`;
}

// ------------------------------------------------------------------ PDF

/** Edge or Chrome on this computer (or AIW_BROWSER); both print HTML to PDF headless. */
export function findBrowser(): string | undefined {
  const env = process.env.AIW_BROWSER;
  const list = env ? [env] : process.platform === "win32" ? [
    `${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles ?? "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  ] : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return list.find((p) => p && fs.existsSync(p));
}

export function htmlToPdf(htmlFile: string, pdfFile: string): Promise<void> {
  const browser = findBrowser();
  if (!browser) return Promise.reject(new Error("no Edge or Chrome found to print the PDF"));
  const profile = ensureDir(path.join(paths.worktrees(), ".pdf-profile"));
  return new Promise((resolve, reject) => {
    execFile(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--no-pdf-header-footer", "--print-to-pdf-no-header",
      `--print-to-pdf=${pdfFile}`, pathToFileURL(htmlFile).href], { timeout: 120_000, windowsHide: true }, (err) => {
      if (fs.existsSync(pdfFile) && fs.statSync(pdfFile).size > 0) return resolve();
      reject(new Error(`the browser could not print the PDF${err ? `: ${err.message}` : ""}`));
    });
  });
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 90);

/** Build the report of a finished ticket (lead or single-repository task). Returns the PDF (or HTML) file. */
export async function buildTicketReport(ctx: StepCtx): Promise<{ file: string; pdf: boolean; summary: string; error?: string }> {
  const lead = getTask(ctx.task.id) ?? ctx.task;
  const parts = lead.playbook === "dev-lead" ? partsOf(lead.id) : [];
  const repos = parts.length ? parts : [lead];
  const d = lead.data;
  const key = jiraKey(lead) || lead.source_ref || lead.id;
  const input = {
    ticket: { key, title: lead.title, description: truncate(d.ticket?.description ?? "", 3000) },
    acceptanceCriteria: d.requirements?.acceptanceCriteria ?? [],
    answers: (d.clarifications ?? []).map((c: any) => ({ q: c.questions, a: c.answer, delegated: !!c.delegated })),
    decisions: d.understanding?.decisions ?? [], plan: d.plan?.summary, contract: d.contract ? { summary: d.contract.summary, items: (d.contract.items ?? []).slice(0, 12) } : undefined,
    repositories: repos.map((p) => ({ repo: p.project_id, summary: p.data.implementation?.summary ?? p.data.plan?.summary, files: (p.data.changedFiles ?? []).slice(0, 40), planFiles: p.data.plan?.files ?? [], tests: testsText(p) })),
    prs: d.prs ?? (d.pr ? [d.pr] : []),
  };
  let w: any = {};
  try {
    w = (await ctx.agent("report-writer", `## The finished ticket\n${JSON.stringify(input, null, 1)}`, { maxTurns: 3 })).data ?? {};
  } catch (e: any) {
    w = { summary: d.plan?.summary ?? "", asked: d.ticket?.title ?? "", outcome: "", changes: [], flow: { nodes: [], edges: [] }, followUps: [], error: e.message };
  }
  for (const k of ["summary", "asked", "outcome"]) if (typeof w[k] === "string") w[k] = stripAttribution(w[k]);
  const dir = ensureDir(path.join(paths.projectDir(lead.project_id), "reports", key));
  const base = safeName(`${key} – ${lead.title ?? "report"}`);
  const html = path.join(dir, `${base}.html`);
  fs.writeFileSync(html, reportHtml(lead, w, parts));
  const pdf = path.join(dir, `${base}.pdf`);
  try {
    if (fs.existsSync(pdf)) fs.rmSync(pdf, { force: true });
    await htmlToPdf(html, pdf);
    audit("service", "report.pdf", lead.id, { file: pdf });
    return { file: pdf, pdf: true, summary: w.summary ?? "" };
  } catch (e: any) {
    return { file: html, pdf: false, summary: w.summary ?? "", error: e.message };
  }
}

/** Upload the report for Teams (view link); undefined when Teams file sharing is not available. */
export async function shareReport(file: string, key: string): Promise<string | undefined> {
  return (await shareInTeams(`${key} report`, [{ local: file, name: path.basename(file) }]))?.url;
}

/** Build the report, share it and post it in Teams (the playbook step and "give me the PDF of KAN-52" both use this). */
export async function deliverTicketReport(ctx: StepCtx, dedupeKey: string): Promise<{ file: string; pdf: boolean }> {
  const key = jiraKey(ctx.task) || ctx.task.source_ref || ctx.task.id;
  const r = await buildTicketReport(ctx);
  const url = await shareReport(r.file, key);
  ctx.save({ ticketReport: { file: r.file, pdf: r.pdf, url, at: new Date().toISOString() } });
  const lines = [url ? `- **${r.pdf ? "PDF" : "Report"}:** ${url}` : "", `- **Saved on this computer:** ${r.file}`].filter(Boolean).join("\n");
  await notify({ kind: "report_ready", taskId: ctx.task.id, taskRef: ctx.task.source_ref ?? undefined, dedupeKey,
    title: `📄 ${key} – ${r.pdf ? "report (PDF)" : "report"} ready`,
    body: `${truncate(r.summary || "What was asked, what was decided and what changed – with diagrams, tests, reviews, screenshots and the PR links.", 600)}\n\n${lines}${r.error ? `\n\n⚠️ The PDF could not be printed (${r.error}) – the report is saved as a web page instead.` : ""}`,
    url });
  return { file: r.file, pdf: r.pdf };
}

/**
 * "Give me the PDF of KAN-52" in Teams: a finished ticket gets its report (the one already made, or a new one – built in
 * the background and posted when ready). An unfinished ticket gets its report automatically after its PR is raised.
 */
export async function requestTicketReport(key: string): Promise<string> {
  const all = listTasks({ limit: 2000 }).filter((t) => t.kind !== "part" && t.kind !== "pr_review" && (t.data.ticket?.key ?? String(t.source_ref).split("@")[0]).toUpperCase() === key);
  if (!all.length) return `I don't have a task for ${key}.`;
  const finished = all.filter((t) => t.data.pr || t.data.prs?.length).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!finished) {
    const now = all.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    return `📄 ${key} has no PR yet, so there is no report. It is made automatically after the PR is raised (now: ${now.state.toLowerCase().replace(/_/g, " ")}).`;
  }
  const existing = finished.data.ticketReport;
  if (existing?.file && fs.existsSync(existing.file) && existing.pdf) {
    const url = existing.url ?? await shareReport(existing.file, key);
    if (url && !existing.url) mergeData(finished.id, { ticketReport: { ...existing, url } });
    return `📄 **${key} – report**\n\n${url ? `- **PDF:** ${url}\n` : ""}- **Saved on this computer:** ${existing.file}`;
  }
  // build it now, in the background (one AI call for the text and the diagram, then Edge prints it)
  const project = getProject(finished.project_id);
  if (!project) return `${key}'s project is no longer configured.`;
  const { makeAgentCaller } = await import("../engine/steps.js");
  const ctx: any = {
    task: finished, project, settings: loadSettings(), runner: getRunner(), params: {}, usage: { tokensIn: 0, tokensOut: 0, cost: 0, agents: [] },
    save(p: Record<string, any>) { const t = mergeData(finished.id, p); ctx.task = { ...ctx.task, data: t.data }; return ctx.task; },
  };
  ctx.agent = makeAgentCaller(() => ctx);
  void deliverTicketReport(ctx, `report:request:${Date.now()}`)
    .catch((e) => notify({ kind: "failed", taskId: finished.id, taskRef: finished.source_ref ?? undefined, dedupeKey: `report-failed:${Date.now()}`, title: `${key}: the report could not be made`, body: truncate(String(e.message), 400) }).catch(() => {}))
    .finally(() => addUsage(finished.id, ctx.usage.tokensIn + ctx.usage.tokensOut, ctx.usage.cost));
  return `📄 Making the report for **${key}** – the PDF comes here in a minute or two.`;
}
