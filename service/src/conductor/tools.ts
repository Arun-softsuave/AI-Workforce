import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { audit, db } from "../core/db.js";
import { updateItem } from "../kernel/items.js";
import { truncate } from "../core/util.js";
import { loadSettings, updateSettings, loadProjects, upsertProject, engineVersion, type ProjectConfig, type TeamMember } from "../core/config.js";
import { normaliseQuestions } from "../core/questions.js";
import { listTasks, getTask, mergeData, transition, canTransition, stepsFor, type Task } from "../engine/tasks.js";
import { latestApproval, type Approval } from "../approvals/approvals.js";
import { decideAndApply, answerTask, cancelTask, startAwaiting, resumeTask, pauseAll, resumeAll, isPaused, tick } from "../engine/engine.js";
import { createRequest, resolveProduct } from "../engine/requests.js";
import { statusText, taskNow, inboxSummaryLine } from "../api/ops.js";
import { runTicket } from "../intake/intake.js";
import { getFocus, setFocus, redactSecrets } from "../notify/chatLog.js";
import { find, foundLine, itemForKey, keysIn, projectForKey, indexed, type Found } from "./find.js";
import { setDirective, revokeDirective, ruleName } from "./directives.js";
import { recordUndo, lastUndo, clearUndo, type ConductorCall } from "./state.js";

/**
 * The Conductor's tools (IMPLEMENTATION-PLAN W1 step 3, 5.14). Each tool is plain code that calls the existing engine
 * functions; the model only chooses which tool and with what arguments. Destructive or ambiguous calls come back with
 * one short question (`ask`) instead of acting; the caller stores it and a "yes" (or a number) runs it.
 */
export const TOOL_NAMES = ["find", "preview_scope", "start", "decide", "set_directive", "prefs", "control", "fix_pr", "review", "qa", "adopt", "status", "explain", "lookup"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** Tools that only read: their results can be fed back to the Conductor for a second round. */
export const READ_TOOLS = new Set<string>(["find", "preview_scope", "status", "explain", "lookup"]);

export interface ToolArgs {
  ref?: string; refs?: string[]; text?: string; query?: string;
  /** decide */ decision?: "approve" | "reject" | "answer" | "approve_with_change"; delegated?: boolean;
  /** control */ action?: "pause" | "resume" | "cancel" | "priority" | "takeover" | "handback" | "undo" | "revert"; until?: string; priority?: number | string; due?: string;
  /** set_directive */ scope?: "global" | "item" | "batch" | "epic" | "sprint"; rule?: string; value?: string;
  /** prefs */ key?: string; name?: string; github?: string;
  /** fix_pr */ mode?: "comments" | "ci" | "issues" | "rebase"; /** rebase: you told it to resolve the conflicts itself */ resolveAll?: boolean;
  /** start */ project?: string; takeOver?: boolean; again?: boolean; /** several keys on v2: one per ticket instead of one batch */ separately?: boolean;
}
export type ToolCall = ConductorCall & { tool: ToolName | "clone_repo"; args: ToolArgs };

export interface ToolCtx {
  who: string;
  /** The owner's message as typed. */
  original: string;
  /** The item (and question) of a quoted bot message: it beats focus (W1a). */
  quotedItem?: string;
  quotedQuestion?: string;
  /** The user already said "yes" to this call (a confirmed destructive action is not asked again). */
  confirmed?: boolean;
  fromMsg?: number | null;
  /** Where the order came from ("teams-personal" by default; "dashboard" for the dashboard's buttons). */
  channel?: string;
}

export interface ToolAsk { question: string; calls?: ToolCall[]; options?: { label: string; key?: string; calls: ToolCall[] }[] }
export interface ToolResult { ok: boolean; reply: string; ask?: ToolAsk; data?: unknown }

const refOf = (t: Task) => t.source_ref ?? t.id;
const said = (reply: string, ok = true, data?: unknown): ToolResult => ({ ok, reply, ...(data !== undefined ? { data } : {}) });
const asking = (question: string, more: Omit<ToolAsk, "question"> = {}): ToolResult => ({ ok: true, reply: "", ask: { question, ...more } });

// ------------------------------------------------------------------ what waits for you

export interface Pending { approvals: { task: Task; approval: Approval }[]; questions: Task[]; starts: Task[] }

export function pendingItems(): Pending {
  const mine = (t: Task) => t.kind !== "part";          // a repository part never waits for the user – its lead does
  const approvals = listTasks({ states: ["AWAITING_APPROVAL"] }).filter(mine)
    .map((task) => ({ task, approval: latestApproval(task.id)! }))
    .filter((x) => x.approval?.state === "pending");
  return { approvals, questions: listTasks({ states: ["NEEDS_INFO"] }).filter(mine), starts: listTasks({ states: ["AWAITING_START"] }).filter(mine) };
}

export const approvalWhat = (a: Approval) => a.action === "implement_plan" ? "plan approval" : a.action === "confirm_requirements" ? "confirm requirements" : a.action === "create_pr" ? "raise the PR?" : a.action === "post_review" ? "post the review?" : a.action === "push_fixes" ? "push the fixes?" : a.action === "create_issues" ? "create the issues?" : "approval";
export const questionWhat = (t: Task) => `question: ${truncate(normaliseQuestions(t.data.questions, 1)[0]?.question ?? "", 70)}`;

/** A task for a ref: an exact task ref/id first, else our newest item for the ticket key. */
export function taskFor(ref: string | undefined): Task | undefined {
  if (!ref) return undefined;
  const r = ref.trim();
  const keys = keysIn(r);
  const norm = keys.length === 1 && keys[0].toUpperCase() === r.toUpperCase() ? keys[0] : r;
  return getTask(norm) ?? getTask(r) ?? (keys[0] ? itemForKey(keys[0]) : undefined);
}

/** Every open task of one ticket (the lead, or the per-repository halves of older tickets). */
export function tasksOfTicket(ref: string): Task[] {
  const key = ref.toUpperCase().split("@")[0];
  return listTasks({ states: ["DETECTED", "TRIAGED", "NEEDS_INFO", "AWAITING_START", "QUEUED", "RUNNING", "PAUSED", "AWAITING_APPROVAL", "PUBLISHING", "STALE", "REJECTED", "FAILED_PUBLISH", "WAITING_PARTS", "FAILED", "PR_OPEN", "BLOCKED", "PLANNING", "WAITING_CHILDREN"] })
    .filter((t) => t.kind !== "part" && (t.data.ticket?.key ?? String(t.source_ref).split("@")[0]).toUpperCase() === key && (!ref.includes("@") || refOf(t) === ref));
}

/**
 * The waiting item a decision is for: the named ref, else the quoted bot message's item (beats focus), else the focus,
 * else the only one waiting. Several waiting and none named → undefined (the caller asks).
 */
function decisionTarget(list: Task[], args: ToolArgs, ctx: ToolCtx): Task | undefined {
  const byRef = (ref?: string) => { const t = taskFor(ref); return t ? list.find((x) => x.id === t.id) : undefined; };
  if (args.ref) return byRef(args.ref);
  return byRef(ctx.quotedItem) ?? byRef(getFocus() ?? undefined) ?? (list.length === 1 ? list[0] : undefined);
}

function whichOne(p: Pending, decision: string, extra: ToolArgs): ToolResult {
  const items = [
    ...p.approvals.map((x) => ({ ref: refOf(x.task), what: approvalWhat(x.approval) })),
    ...p.questions.map((t) => ({ ref: refOf(t), what: questionWhat(t) })),
    ...p.starts.map((t) => ({ ref: refOf(t), what: "waiting to start" })),
  ].slice(0, 4);
  if (!items.length) return said(decision === "answer" ? "No task is waiting for an answer right now." : "Nothing is waiting for your approval right now.");
  return asking(`Which one? ${items.map((x, n) => `${n + 1}. ${x.ref} (${x.what})`).join(" · ")}`,
    { options: items.map((x) => ({ label: x.ref, key: x.ref, calls: [{ tool: "decide", args: { ...extra, ref: x.ref } }] })) });
}

// ------------------------------------------------------------------ start (B1-B3, B5, B6, B17, M6, J3)

type StartOne =
  | { kind: "new" | "started"; ref: string; title: string }
  | { kind: "busy"; detail: string; short: string }
  | { kind: "has_pr"; ref: string; detail: string }
  | { kind: "error"; detail: string }
  | { kind: "ask"; ask: ToolAsk };

/** Tests: replace `git clone` (no network in tests). */
let cloner = (repoUrl: string, dir: string): void => { execFileSync("git", ["clone", "--quiet", repoUrl, dir], { stdio: "ignore", timeout: 10 * 60_000 }); };
export function setCloner(fn: ((repoUrl: string, dir: string) => void) | undefined): void {
  cloner = fn ?? ((u, d) => { execFileSync("git", ["clone", "--quiet", u, d], { stdio: "ignore", timeout: 10 * 60_000 }); });
}

/** Repositories of a ticket's project that are not on this computer (M6). */
function missingClones(project: ProjectConfig): ProjectConfig[] {
  const members = project.group ? loadProjects().filter((p) => p.group === project.group && p.status !== "paused") : [project];
  return members.filter((p) => !p.local?.path || !fs.existsSync(p.local.path));
}

async function startOne(key: string, args: ToolArgs, ctx: ToolCtx): Promise<StartOne> {
  const k = key.toUpperCase().split("@")[0];
  // "start KAN-42@nue-backend": exactly that half of an older two-repository ticket, when it waits to start
  const exact = key.includes("@") ? getTask(key) : undefined;
  if (exact?.state === "AWAITING_START") { startAwaiting(refOf(exact)); return { kind: "started", ref: refOf(exact), title: exact.title ?? "" }; }
  if (!k.startsWith("TASK-")) {
    const project = projectForKey(k);
    // B17: a ticket in a project that isn't set up
    if (!project) return { kind: "error", detail: `${k}'s project isn't set up. Add it with \`aiw project add\`.` };
    // M6: the repository isn't cloned here – offer to clone (with permission)
    const missing = missingClones(project);
    if (missing.length && !ctx.confirmed) {
      const first = missing[0];
      return { kind: "ask", ask: { question: `${first.github?.repo ?? first.id} isn't on this computer. Clone it to ${first.local?.path ?? "(no folder set)"} and start ${k}?`,
        calls: [...missing.map((m) => ({ tool: "clone_repo" as const, args: { project: m.id } })), { tool: "start", args: { ref: k, takeOver: args.takeOver, again: args.again } }] } };
    }
  }
  // B6: never a duplicate – say where it stands
  const existing = itemForKey(k);
  if (existing && !args.again) {
    const ref = refOf(existing);
    if (existing.state === "AWAITING_START") { startAwaiting(ref); return { kind: "started", ref, title: existing.title ?? "" }; }
    const pr = existing.data.pr?.url ?? existing.data.prs?.map((x: any) => x.url).join(" ");
    if (["PR_OPEN", "MERGED"].includes(existing.state) || (existing.state === "DONE" && pr)) {
      return { kind: "has_pr", ref: k, detail: `${k} already has a PR${pr ? `: ${pr}` : ""} (${taskNow(existing).now}). I can fix its CI or comments ("fix the CI on ${k}"), review it ("review ${k}"), or start over ("start ${k} again").` };
    }
    if (existing.state === "FAILED") return { kind: "has_pr", ref: k, detail: `${k} stopped earlier: ${truncate(existing.error ?? "unknown reason", 160)}. Say "resume ${k}" to continue, or "start ${k} again".` };
    if (!["DONE", "CANCELLED", "CLOSED"].includes(existing.state)) {
      const all = tasksOfTicket(k);
      const list = all.length ? all : [existing];
      return { kind: "busy", detail: list.map((t) => statusText(refOf(t)) ?? "").join("\n\n"), short: list.map((t) => taskNow(t).now).join("; ") };
    }
  }
  // B5: assigned to someone else – ask once, never start silently
  const ix = indexed(k);
  if (ix && !ix.mine && ix.assignee && !args.takeOver && !ctx.confirmed) {
    return { kind: "ask", ask: { question: `${k} is ${ix.assignee}'s. Take it over?`, calls: [{ tool: "start", args: { ref: k, takeOver: true, again: args.again } }] } };
  }
  try {
    const t = await runTicket(k);
    if (args.takeOver && ix?.assignee) mergeData(t.id, { takenOverFrom: ix.assignee });
    recordUndo({ kind: "start", itemId: t.id, ref: refOf(t), at: Date.now() });
    return { kind: "new", ref: refOf(t), title: t.title ?? "" };
  } catch (e: any) { return { kind: "error", detail: e.message }; }
}

/** Words that ask for several tickets as one batch (W7) rather than side by side. */
export const BATCH_WORDS = /\b(as (a|one) batch|batch|together|in (the right )?order|one plan|stack(ed)?|depends? on|dependenc(y|ies)|merge order)\b/i;

/** Start one or more tickets ("plan for KAN-42", "work on KAN-60, KAN-61 and KAN-62", "do the invite email task"). */
export async function toolStart(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  let keys = [...new Set([...(args.refs ?? []), ...(args.ref ? [args.ref] : [])].flatMap((r) => keysIn(String(r))))];
  const text = (args.text ?? args.query ?? "").trim();
  if (!keys.length && text) {
    // B2: by name or description – confirm only if two match
    const f = find(text);
    const tickets = f.matches.filter((m) => m.kind === "ticket");
    if (f.ambiguous && f.question) {
      return asking(f.question, { options: f.matches.slice(0, 3).map((m) => ({ label: m.ref, key: m.ref, calls: [{ tool: "start", args: { ref: m.ref, takeOver: args.takeOver } }] })) });
    }
    if (tickets.length) keys = tickets.map((m) => m.ref);
    else return startRequest(text, args, ctx);
  }
  if (!keys.length) return said("Which ticket? For example: plan for KAN-42");
  if (keys.length === 1) {
    const r = await startOne(keys[0], args, ctx);
    await tick();
    if (r.kind === "ask") return { ok: true, reply: "", ask: r.ask };
    if (r.kind === "new" || r.kind === "started") setFocus(r.ref);
    return said(r.kind === "busy" ? `${keys[0]} is already in progress:\n\n${r.detail}`
      : r.kind === "has_pr" ? r.detail
      : r.kind === "error" ? (/isn't set up/.test(r.detail) ? r.detail : `I couldn't start ${keys[0]}: ${r.detail}`)
      : r.kind === "started" ? `👍 Starting ${r.ref}. The plan comes here for your approval.`
      : `👍 On it – **${r.ref}**: ${r.title}\n\nI'll read the ticket, the PRD and the code, and send you the plan here for approval before writing any code.`, r.kind !== "error");
  }
  // W7 (engine v2): several tickets asked for TOGETHER ("as a batch", "in order", "they depend on each other") become ONE
  // batch – overlap check, waves, stacked PRs, merge order, one approval. A plain list still starts each ticket on its own.
  if (engineVersion() === "v2" && keys.length >= 2 && !args.separately && BATCH_WORDS.test(`${ctx.original} ${text}`)) {
    const { startBatch } = await import("../engine/steps/scope.js");
    const r = await startBatch(keys, ctx.who, ctx.original);
    if (r.itemId) { const t = getTask(r.itemId); if (t) setFocus(refOf(t)); await tick(); }
    if (r.ask) return { ok: r.ok !== false, reply: r.reply, ask: { question: r.ask.question, calls: r.ask.calls as ToolCall[] } };
    return said(r.reply, r.ok !== false);
  }
  // several tickets: each becomes its own item with its own plan, questions and PR – worked on side by side
  const lines: string[] = [];
  const asks: ToolAsk[] = [];
  let started = 0;
  for (const key of keys) {
    const r = await startOne(key, args, ctx);
    if (r.kind === "new" || r.kind === "started") started++;
    if (r.kind === "ask") { asks.push(r.ask); lines.push(`- **${key}** – ${r.ask.question}`); continue; }
    lines.push(r.kind === "new" ? `- **${r.ref}** – ${r.title} (new)`
      : r.kind === "started" ? `- **${r.ref}** – started (it was waiting to start)`
      : r.kind === "busy" ? `- **${key}** – already in progress: ${r.short}`
      : r.kind === "has_pr" ? `- **${key}** – ${truncate(r.detail, 160)}`
      : `- **${key}** – could not start: ${(r as { detail: string }).detail}`);
  }
  await tick();
  const reply = `👍 **Starting ${started} of ${keys.length} tickets**\n\n${lines.join("\n")}\n\nThey are worked on side by side. Each plan comes here separately for your approval, then each PR. When several things wait, start your reply with the ticket, e.g. "${keys[0]} 1".`;
  if (!asks.length) return said(reply);
  return { ok: true, reply, ask: { question: asks.length === 1 ? asks[0].question : `Reply "yes" to do those too.`, calls: asks.flatMap((a) => a.calls ?? []) } };
}

/** New work without a ticket: the request interview starts (one question when several projects could own it). */
async function startRequest(text: string, args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const { project, choices } = resolveProduct(args.project);
  if (!project) {
    if (!choices.length) return said("No projects are set up yet – add one with `aiw project add`.");
    return asking(`Which project is this for? ${choices.map((c, n) => `${n + 1}. ${c.group ?? c.id}`).join(" · ")}`,
      { options: choices.map((c) => ({ label: c.group ?? c.id, key: c.id, calls: [{ tool: "start", args: { text, project: c.id } }] })) });
  }
  const t = createRequest(text, ctx.who, project, { via: "teams" });
  recordUndo({ kind: "start", itemId: t.id, ref: refOf(t), at: Date.now() });
  setFocus(refOf(t));
  await tick();
  return said(`📝 Got it – ${refOf(t)} (${project.group ?? project.id}). Before planning, I'll ask you a few questions here so the requirements are complete.`);
}

function cloneRepo(args: ToolArgs): ToolResult {
  const p = loadProjects().find((x) => x.id === args.project);
  if (!p) return said(`I don't know the project ${args.project}.`, false);
  if (p.local?.path && fs.existsSync(p.local.path)) return said(`${p.id} is already on this computer.`);
  if (!p.github?.repo || !p.local?.path) return said(`I don't know where ${p.id} comes from. Clone it yourself and run \`aiw project add\` again.`, false);
  try {
    fs.mkdirSync(path.dirname(p.local.path), { recursive: true });
    cloner(`https://github.com/${p.github.repo}.git`, p.local.path);
    audit("user", "repo.cloned", undefined, { project: p.id });
    return said(`📥 Cloned ${p.github.repo} to ${p.local.path}.`);
  } catch (e: any) { return said(`Couldn't clone ${p.github.repo}: ${truncate(e.message, 200)}`, false); }
}

// ------------------------------------------------------------------ decide (D2-D4, D8, C10)

/** Text that looks like a secret value (token, key, password line). Never stored as an answer (C10). */
export function looksLikeSecret(text: string): boolean {
  return redactSecrets(text) !== text || /\b(sk|pk|ghp|gho|xox[abp]|AKIA)[-_][A-Za-z0-9_-]{12,}/.test(text) || /\b[A-Za-z0-9+/_-]{32,}\b/.test(text);
}
const SECRET_QUESTION = /\b(secret|api[ -]?key|token|password|credential|private key|client[ _-]?secret|\.env|env(ironment)? var(iable)?)\b/i;

/** The safe way to give a secret (C10): the vault command, never the value in chat. */
export function secretInstruction(name = "NAME"): string {
  return `Please don't send it here. On this computer run \`aiw secret set ${name}\`, then reply "done".`;
}

export async function toolDecide(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const p = pendingItems();
  const decision = args.decision ?? "approve";
  if (decision === "answer") {
    const t = decisionTarget(p.questions, args, ctx);
    if (!t) return p.questions.length ? whichOne({ approvals: [], starts: [], questions: p.questions }, "answer", args) : said("No task is waiting for an answer right now.");
    const text = (args.text ?? ctx.original).trim();
    const q = normaliseQuestions(t.data.questions, 4).map((x) => x.question).join(" ");
    if (looksLikeSecret(text)) return said(`${refOf(t)}: ${secretInstruction(/\b([A-Z][A-Z0-9_]{3,})\b/.exec(q)?.[1])}`, false);
    let answer = text;
    if (SECRET_QUESTION.test(q) && /^(done|added|set|stored|it'?s (set|in the vault))\b/i.test(text)) answer = "The value is stored in the AI Workforce vault (aiw secret set); read it from there, never print it.";
    const r = await answerTask(refOf(t), answer, ctx.who, ctx.channel ?? "teams-personal", { delegated: args.delegated });
    if (r.ok) setFocus(refOf(t));
    return said(r.message, r.ok);
  }
  if (args.ref && /^all$/i.test(args.ref) && decision === "approve") {
    // D8: "approve all" – read back first
    const all = p.approvals.filter((x) => ["implement_plan", "create_pr", "confirm_requirements"].includes(x.approval.action));
    if (!all.length) return said("Nothing is waiting for your approval right now.");
    if (!ctx.confirmed) return asking(`Approve all ${all.length}: ${all.map((x) => `${refOf(x.task)} (${approvalWhat(x.approval)})`).join(", ")}?`,
      { calls: all.map((x) => ({ tool: "decide", args: { decision: "approve", ref: refOf(x.task) } })) });
  }
  const list = [...p.approvals.map((x) => x.task), ...(decision === "approve" ? p.starts : [])];
  const t = decisionTarget(list, args, ctx);
  if (!t) {
    if (args.ref) {
      const named = taskFor(args.ref);
      return said(named ? `${refOf(named)} isn't waiting for a decision – ${taskNow(named).now}.` : `I can't find ${args.ref}.`, false);
    }
    return list.length ? whichOne({ approvals: p.approvals, questions: [], starts: decision === "approve" ? p.starts : [] }, decision, args) : said("Nothing is waiting for your approval right now.");
  }
  const ref = refOf(t);
  setFocus(ref);
  if (t.state === "AWAITING_START") {
    if (decision !== "approve") return said(`${ref} hasn't started yet – say "start ${ref}", or "cancel ${ref}".`);
    startAwaiting(ref); await tick();
    return said(`👍 Starting ${ref}.`);
  }
  if (decision === "reject") {
    const why = (args.text ?? "").trim();
    if (why.length < 3) return asking(`What should I change for ${ref}?`);
    const r = await decideAndApply(ref, "rejected", ctx.who, "teams-personal", why);
    return said(r.message, r.ok);
  }
  if (decision === "approve_with_change") {
    // D4: approve + a small change, without another round
    const change = (args.text ?? "").trim();
    if (change.length < 3) return asking(`What should I change for ${ref}?`);
    mergeData(t.id, { planChanges: [...(t.data.planChanges ?? []), { text: change, by: ctx.who, at: new Date().toISOString() }] });
    try { const { addDecision } = await import("../knowledge/designDoc.js"); addDecision(t.id, "Change asked when approving", change, ctx.who); } catch { /* no design document yet */ }
    const r = await decideAndApply(ref, "approved", ctx.who, "teams-personal");
    return said(r.ok ? `✅ Approved ${ref} with your change: "${truncate(change, 120)}". Building now.` : r.message, r.ok);
  }
  const r = await decideAndApply(ref, "approved", ctx.who, "teams-personal");
  return said(r.message, r.ok);
}

// ------------------------------------------------------------------ set_directive (B20, J6), prefs (A9, A10)

export async function toolSetDirective(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const rule = ruleName(args.rule ?? "");
  if (!rule) return said(`I can't keep that as a rule ("${truncate(args.rule ?? "", 40)}"). I can: skip plan or PR approval, only touch an area, not touch something, fix CI or comments without asking, decide small questions myself.`, false);
  let scope = args.scope ?? (args.ref ? "item" : "global");
  let target = scope === "item" ? taskFor(args.ref ?? ctx.quotedItem ?? getFocus() ?? undefined) : undefined;
  if (scope === "item" && !target) {
    if (args.ref) return said(`I can't find ${args.ref}.`, false);
    scope = "global";
  }
  const r = setDirective(scope as any, target ? target.id : null, rule, args.value ?? "skip", ctx.fromMsg ?? null);
  if (!r.ok) return said(r.message, false);
  recordUndo({ kind: "directive", id: r.directive.id, text: r.echo, at: Date.now() });
  const out = [r.echo];
  // the rule applies to the work that waits right now too (J6): "no need to ask for approval" approves the waiting plan
  const now = target ?? taskFor(ctx.quotedItem ?? getFocus() ?? undefined);
  const a = now ? latestApproval(now.id) : undefined;
  const skip = String(r.directive.value) === "skip";
  if (now && a?.state === "pending" && now.state === "AWAITING_APPROVAL" && skip
    && ((rule === "plan_approval" && ["implement_plan", "confirm_requirements"].includes(a.action)) || (rule === "pr_approval" && a.action === "create_pr"))) {
    const d = await decideAndApply(refOf(now), "approved", ctx.who, "teams-personal");
    out.push(d.message);
  }
  return said(out.join("\n"));
}

const PREFS: Record<string, { path: string[]; kind: "bool" | "enum" | "text"; values?: string[]; text: (v: any) => string }> = {
  "pr.draft": { path: ["pr", "draft"], kind: "bool", text: (v) => v ? "raise draft PRs" : "raise normal (ready for review) PRs" },
  "pr.autoFixCi": { path: ["pr", "autoFixCi"], kind: "bool", text: (v) => v ? "fix failing CI without asking" : "show CI fixes before pushing" },
  "pr.autoReview": { path: ["pr", "autoReview"], kind: "bool", text: (v) => v ? "review teammates' PRs as soon as I'm asked" : "tell you about review requests and wait" },
  "pr.autoPostReview": { path: ["pr", "autoPostReview"], kind: "bool", text: (v) => v ? "post review comments without showing them first" : "show review comments before posting" },
  "pr.autoQaIssues": { path: ["pr", "autoQaIssues"], kind: "bool", text: (v) => v ? "create QA issues without asking" : "show QA issues before creating them" },
  "workflow.planApproval": { path: ["workflow", "planApproval"], kind: "enum", values: ["always", "autonomy", "skip"], text: (v) => v === "skip" ? "no plan approval" : v === "always" ? "ask me to approve every plan" : "ask for plan approval per project" },
  "workflow.prApproval": { path: ["workflow", "prApproval"], kind: "enum", values: ["ask", "skip"], text: (v) => v === "skip" ? "raise PRs without asking" : "ask before raising a PR" },
  "workflow.qaAfterFix": { path: ["workflow", "qaAfterFix"], kind: "bool", text: (v) => v ? "run QA after review fixes" : "no QA after review fixes" },
  "workflow.ticketReport": { path: ["workflow", "ticketReport"], kind: "bool", text: (v) => v ? "make a PDF report after each PR" : "no PDF report after each PR" },
  "workflow.stopForBudget": { path: ["workflow", "stopForBudget"], kind: "bool", text: (v) => v ? "pause work when a budget is used up" : "only report budgets, never stop" },
  "notifications.quietHours": { path: ["notifications", "quietHours"], kind: "text", text: (v) => v === "off" ? "no quiet hours" : `quiet hours ${v}` },
  "notifications.digestTime": { path: ["notifications", "digestTime"], kind: "text", text: (v) => `morning digest at ${v}` },
  "workflow.checkupTime": { path: ["workflow", "checkupTime"], kind: "text", text: (v) => v === "off" ? "no daily check-up" : `daily check-up at ${v}` },
  "profile.workingHours": { path: ["profile", "workingHours"], kind: "text", text: (v) => `working hours ${v}` },
};
const PREF_ALIASES: Record<string, string> = { draft: "pr.draft", draft_pr: "pr.draft", draft_prs: "pr.draft", quiet_hours: "notifications.quietHours", digest: "notifications.digestTime", working_hours: "profile.workingHours",
  plan_approval: "workflow.planApproval", pr_approval: "workflow.prApproval", auto_fix_ci: "pr.autoFixCi", auto_review: "pr.autoReview", report: "workflow.ticketReport" };

function boolOf(v: unknown): boolean | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  if (["true", "yes", "on", "1", "draft"].includes(s)) return true;
  if (["false", "no", "off", "0", "ready", "normal"].includes(s)) return false;
  return undefined;
}

export function toolPrefs(args: ToolArgs, ctx: ToolCtx): ToolResult {
  const key = String(args.key ?? "").trim();
  // A9: "Eric left the team", "add Priya (github priya-k) to the team"
  if (/^team\.(add|remove)$/i.test(key)) return teamChange(key.toLowerCase().endsWith("add") ? "add" : "remove", args);
  const k = PREFS[key] ? key : PREF_ALIASES[key.toLowerCase().replace(/[\s-]+/g, "_")];
  const spec = k ? PREFS[k] : undefined;
  if (!spec || !k) return said(`I can't change "${truncate(key, 40)}" from the chat. I can change: draft PRs, CI auto-fix, review posting, QA issues, plan/PR approval, quiet hours, digest time, working hours, the team.`, false);
  let value: any = args.value;
  if (spec.kind === "bool") { value = boolOf(args.value); if (value === undefined) return said(`Should ${spec.text(true)} be on or off?`, false); }
  if (spec.kind === "enum" && !spec.values!.includes(String(value))) return said(`${k} can be ${spec.values!.join(", ")}.`, false);
  if (spec.kind === "text") {
    value = String(value ?? "").trim();
    if (!/^(off|\d{1,2}:\d{2}(-\d{1,2}:\d{2})?)$/.test(value)) return said(`Please give a time like 09:00 or a range like 22:00-07:00${k === "notifications.quietHours" ? ", or off" : ""}.`, false);
  }
  let old: unknown;
  updateSettings((s: any) => {
    let o = s;
    for (const part of spec.path.slice(0, -1)) o = o[part] ??= {};
    old = o[spec.path.at(-1)!];
    o[spec.path.at(-1)!] = value;
  });
  const text = `From now on: ${spec.text(value)}.`;
  recordUndo({ kind: "prefs", path: k, old, text, at: Date.now() });
  audit(`user:${ctx.who}`, "prefs.changed", undefined, { key: k, value });
  return said(text);
}

function teamChange(op: "add" | "remove", args: ToolArgs): ToolResult {
  const s = loadSettings();
  const members: TeamMember[] = s.team?.members ?? [];
  const name = String(args.name ?? args.value ?? "").trim();
  const login = String(args.github ?? "").trim().replace(/^@/, "");
  if (!name && !login) return said(op === "add" ? "Who should I add? e.g. \"add Priya (GitHub priya-k) to the team\"." : "Who left the team?", false);
  const same = (m: TeamMember) => (login && m.github.toLowerCase() === login.toLowerCase()) || (name && (m.name.toLowerCase() === name.toLowerCase() || m.github.toLowerCase() === name.toLowerCase()));
  if (op === "add") {
    if (!login) return said(`What is ${name}'s GitHub login?`, false);
    if (members.some(same)) return said(`${name || login} is already on the team.`);
    updateSettings((x) => { x.team = { ...(x.team ?? { members: [] }), members: [...(x.team?.members ?? []), { name: name || login, github: login }] }; });
    recordUndo({ kind: "team", old: members, text: `added ${name || login}`, at: Date.now() });
    return said(`👥 Added ${name || login} (${login}) to the team. They can be picked as a reviewer now.`);
  }
  const gone = members.filter(same);
  if (!gone.length) return said(`${name || login} isn't on the team list.`);
  updateSettings((x) => { x.team = { ...(x.team ?? { members: [] }), members: (x.team?.members ?? []).filter((m) => !same(m)) }; });
  // reviewers recomputed: a fixed reviewer list no longer names them
  const logins = new Set(gone.map((m) => m.github.toLowerCase()));
  let changed = 0;
  for (const p of loadProjects()) {
    if (p.reviewers?.from !== "list") continue;
    const left = p.reviewers.logins.filter((l) => !logins.has(l.replace(/^@/, "").toLowerCase()));
    if (left.length !== p.reviewers.logins.length) { upsertProject({ ...p, reviewers: { ...p.reviewers, logins: left } }); changed++; }
  }
  recordUndo({ kind: "team", old: members, text: `removed ${gone.map((m) => m.name).join(", ")}`, at: Date.now() });
  return said(`👥 Removed ${gone.map((m) => m.name).join(", ")} from the team${changed ? ` and from the reviewers of ${changed} project(s)` : ""}.`);
}

// ------------------------------------------------------------------ control (J7, B19, J5, J14, W16)

const ACTIVE_STATES = ["DETECTED", "TRIAGED", "NEEDS_INFO", "AWAITING_START", "QUEUED", "RUNNING", "PAUSED", "AWAITING_APPROVAL", "PUBLISHING", "STALE", "REJECTED", "FAILED_PUBLISH", "WAITING_PARTS", "PR_OPEN", "BLOCKED", "PLANNING", "WAITING_CHILDREN"] as const;

export async function toolControl(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const action = args.action;
  const all = !args.ref || /^(all|everything)$/i.test(args.ref);
  const t = all ? undefined : taskFor(args.ref);
  if (!all && !t && action !== "undo") return said(`I can't find ${args.ref}.`, false);
  switch (action) {
    case "pause": {
      if (!t) {
        pauseAll(args.until);
        recordUndo({ kind: "pause", all: true, at: Date.now() });
        return said(`⏸️ Paused – no new work starts${args.until ? ` until ${args.until}` : ""}. Running steps finish first. Say "resume" to continue.`);
      }
      const ref = refOf(t);
      const { stopItemJobs } = await import("../kernel/runner.js");
      stopItemJobs(t.id, "paused by you");
      if (canTransition(t, "PAUSED")) transition(t.id, "PAUSED", "paused by you");
      mergeData(t.id, { pausedByUser: true });
      recordUndo({ kind: "pause", itemId: t.id, ref, at: Date.now() });
      return said(`⏸️ Paused ${ref}. Say "resume ${ref}" to continue.`);
    }
    case "resume": {
      if (!t) {
        if (isPaused()) { resumeAll(); await tick(); return said("▶️ Resumed – new work starts again."); }
        const stopped = listTasks({ states: ["PAUSED", "FAILED", "STALE"] }).filter((x) => x.kind !== "part");
        if (!stopped.length) return said("Nothing is paused or failed right now.");
        if (stopped.length > 1) return asking(`Which one should I resume? ${stopped.slice(0, 4).map(refOf).join(", ")}`, { options: stopped.slice(0, 4).map((x) => ({ label: refOf(x), key: refOf(x), calls: [{ tool: "control", args: { action: "resume", ref: refOf(x) } }] })) });
        return resumeOne(stopped[0]);
      }
      return resumeOne(t);
    }
    case "cancel": {
      if (!t) {
        const active = listTasks({ states: [...ACTIVE_STATES] }).filter((x) => x.kind !== "part" && x.state !== "PR_OPEN");
        if (!active.length) return said("Nothing is in progress to cancel.");
        if (!ctx.confirmed) return asking(`Cancel all ${active.length}: ${active.slice(0, 6).map(refOf).join(", ")}${active.length > 6 ? "…" : ""}? Nothing was published for them.`, { calls: active.map((x) => ({ tool: "control", args: { action: "cancel", ref: refOf(x) } })) });
        for (const x of active) await cancelTask(refOf(x), `cancelled by ${ctx.who} in Teams`);
        return said(`🛑 Cancelled ${active.length} item(s).`);
      }
      if (!ctx.confirmed) return asking(`Cancel ${refOf(t)}${t.title ? ` (${truncate(t.title, 60)})` : ""}?`, { calls: [{ tool: "control", args: { action: "cancel", ref: refOf(t) } }] });
      const c = await cancelTask(refOf(t), `cancelled by ${ctx.who} in Teams`);
      return said(c?.state === "CANCELLED" ? `🛑 Cancelled ${refOf(t)}. Nothing was published.` : `${refOf(t)} can't be cancelled now (${taskNow(t).now}).`, c?.state === "CANCELLED");
    }
    case "priority": {
      if (!t) return said("Which item should go first?", false);
      return setPriority(t, args);
    }
    case "takeover": {
      // I3: jobs stopped, folder and branch kept, unsent notices cancelled, a short summary of where it stands
      if (!t) return said("Which item do you want to take over?", false);
      const { takeOver } = await import("../engine/steps/adopt.js");
      return said(await takeOver(refOf(t), ctx.who));
    }
    case "handback": {
      // I4: your commits become the new base (uncommitted changes refuse it); the item resumes itself
      if (!t) return said("Which item should I continue?", false);
      const { handBack } = await import("../engine/steps/adopt.js");
      const r = await handBack(refOf(t), ctx.who);
      await tick();
      return said(r);
    }
    case "revert": {
      // J14: pushed work is never rewritten – a revert commit on a new PR, only after you said yes
      if (!t || !args.value) return said("Which change should I revert?", false);
      if (!ctx.confirmed) return asking(`Revert ${String(args.value).slice(0, 7)} on ${refOf(t)} with a new commit (nothing is rewritten)?`, { calls: [{ tool: "control", args: { action: "revert", ref: refOf(t), value: args.value } }] });
      const { createRevertPr } = await import("../engine/steps/adopt.js");
      return said(await createRevertPr(refOf(t), String(args.value), ctx.who));
    }
    case "undo": {
      // J14 for an item: un-start it, or remove my last local unpushed commit; pushed work asks first (revert, never rewrite)
      const u = lastUndo();
      const ref = t ? refOf(t) : u?.kind === "start" ? u.ref : undefined;
      if (ref && (t || u?.kind === "start")) {
        if (u?.kind === "start" && u.ref === ref) clearUndo();
        const { undoForItem } = await import("../engine/steps/adopt.js");
        const r = await undoForItem(ref, ctx.who);
        if (r.ask) return asking(r.ask.question, { calls: [{ tool: "control", args: { action: "revert", ref, value: r.ask.sha } }] });
        return said(r.reply);
      }
      return undoLast(ctx);
    }
    default: return said(`I can pause, resume, cancel, move first, take over, hand back or undo.`, false);
  }
}

async function resumeOne(t: Task): Promise<ToolResult> {
  const ref = refOf(t);
  if (t.data.takenOver) mergeData(t.id, { takenOver: null, handedBack: { at: new Date().toISOString() } });
  const list = ["PAUSED", "FAILED", "STALE", "FAILED_PUBLISH", "NEEDS_INFO"].includes(t.state) ? [t] : tasksOfTicket(ref).filter((x) => ["PAUSED", "FAILED", "STALE", "FAILED_PUBLISH"].includes(x.state));
  if (!list.length) return said(`${ref} isn't paused – ${taskNow(t).now}.`);
  const done = list.map((x) => resumeTask(refOf(x))).filter((x): x is Task => !!x);
  if (t.data.pausedByUser) mergeData(t.id, { pausedByUser: null });
  await tick();
  return said(`▶️ Resumed ${done.map(refOf).join(", ")} – continuing from where it stopped.`);
}

function setPriority(t: Task, args: ToolArgs): ToolResult {
  const ref = refOf(t);
  const p = Math.max(1, Math.min(5, Number(args.priority ?? 1) || 1));
  const due = args.due && !Number.isNaN(Date.parse(args.due)) ? new Date(args.due).toISOString().slice(0, 10) : undefined;
  const oldDue = (t as any).due ?? null;
  const ahead = listTasks({ states: ["DETECTED", "TRIAGED", "AWAITING_START", "QUEUED", "RUNNING", "NEEDS_INFO", "AWAITING_APPROVAL", "WAITING_PARTS"] })
    .filter((x) => x.kind !== "part" && x.id !== t.id && x.priority >= p && x.priority <= t.priority);
  // the tasks row carries priority / due on both engines; the scheduler picks lower numbers first
  updateItemSafe(t.id, due ? { priority: p, due } : { priority: p });
  recordUndo({ kind: "priority", itemId: t.id, ref, old: { priority: t.priority, due: oldDue }, at: Date.now() });
  audit("user", "item.priority", t.id, { priority: p, due });
  // what it delays: the same project's work first (it shares the repository slots), then the rest
  const sorted = [...ahead.filter((x) => x.project_id === t.project_id), ...ahead.filter((x) => x.project_id !== t.project_id)].map(refOf);
  const shown = sorted.slice(0, 5);
  const more = sorted.length - shown.length;
  return said(`⏫ ${ref} goes first${due ? ` (due ${due})` : ""}.${shown.length ? ` It delays ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.` : " Nothing else waits behind it."}`);
}

function updateItemSafe(id: string, patch: { priority?: number; due?: string | null }): void {
  updateItem(id, patch);
}

async function undoLast(ctx: ToolCtx): Promise<ToolResult> {
  const u = lastUndo();
  if (!u) return said("There's nothing I can undo safely right now. Approvals and pushed work can't be undone – say \"cancel KAN-x\" to stop an item.");
  clearUndo();
  switch (u.kind) {
    case "start": {
      const t = getTask(u.itemId);
      if (!t) return said(`I can't find ${u.ref}.`);
      // only safe before anything left the machine
      if (t.data.pr?.url || t.data.prs?.length || ["PUBLISHING", "PR_OPEN", "MERGED", "DONE"].includes(t.state)) return said(`${u.ref} already has a PR, so I can't undo it. Say "cancel ${u.ref}" to stop work on it.`, false);
      await cancelTask(u.itemId, `undone by ${ctx.who} in Teams`);
      return said(`↩️ Undone – stopped ${u.ref}. Nothing was published.`);
    }
    case "directive": {
      const echo = revokeDirective(u.id);
      return said(echo ? `↩️ Undone. ${echo}` : "That rule was already gone.");
    }
    case "prefs": {
      const spec = PREFS[u.path];
      updateSettings((s: any) => { let o = s; for (const part of spec.path.slice(0, -1)) o = o[part] ??= {}; o[spec.path.at(-1)!] = u.old; });
      return said(`↩️ Undone. Back to: ${spec.text(u.old)}.`);
    }
    case "team": {
      updateSettings((s) => { s.team = { ...(s.team ?? { members: [] }), members: u.old as TeamMember[] }; });
      return said(`↩️ Undone (${u.text}). Team list restored.`);
    }
    case "priority": {
      updateItemSafe(u.itemId, { priority: u.old.priority, due: u.old.due });
      return said(`↩️ Undone – ${u.ref} is back in its place.`);
    }
    case "pause": {
      if (u.all) { resumeAll(); await tick(); return said("↩️ Undone – work starts again."); }
      const t = u.itemId ? getTask(u.itemId) : undefined;
      if (t) return resumeOne(t);
      return said("Nothing to undo.");
    }
  }
}

// ------------------------------------------------------------------ PR work, adopt, scopes

async function toolFixPr(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const { startFixFromText } = await import("../engine/prFix.js");
  // "KAN-52@nue-backend" names one repository's part – keep it; "KAN-52" is the ticket
  const ref = args.ref && keysIn(args.ref).length ? (/@[w.-]+/.test(args.ref) ? args.ref.trim().split(/s+/)[0] : keysIn(args.ref)[0].split("@")[0]) : undefined;
  const ticketKey = ref?.split("@")[0];
  const text = [args.text ?? ctx.original, args.ref && !ref ? args.ref : ""].filter(Boolean).join(" ");
  // engine v2: a ticket of yours with an open PR gets the fix as a job on its own item (W9/W10, G8 "recheck and resolve")
  // "resolve the conflicts yourself / by yourself": your explicit OK for bigger conflicts (still shown before any push)
  const resolveAll = args.resolveAll === true || (args.mode === "rebase" && /(by )?yourself|resolve (them|all|the conflicts|every)/i.test(String(args.text ?? ctx.original ?? "")));
  const command = args.mode === "ci" ? "fix_ci" : args.mode === "rebase" ? "rebase" : args.mode === "issues" ? undefined : "resolve";
  let item = ref && command && engineVersion() === "v2" ? taskFor(ref) : undefined;
  // a PR link or number: the ticket item that raised it (a ticket finished by the old engine with its PR still
  // open is looked after again – state PR_OPEN), so the job runs with the ticket's context, not as a loose fix task
  if (!item && command && engineVersion() === "v2") {
    try {
      const { resolvePrTargets } = await import("../engine/targets.js");
      const found = await resolvePrTargets(text, ticketKey);
      if (!("error" in found) && found.targets.length === 1) {
        const { itemForPr, reopenForOpenPr } = await import("../kernel/prs.js");
        const hit = itemForPr(found.targets[0].repo, found.targets[0].num);
        if (hit && hit.owner === "me") item = (reopenForOpenPr(hit.id) ?? hit) as any;
      }
    } catch { /* fall back to the fix task below */ }
  }
  // the PRs to act on: a two-repo ticket acts on each repository's open PR; a ticket the old engine ended at DONE
  // while its PR is still open is looked after again first (DONE → PR_OPEN)
  let targets: Task[] = [];
  if (item && command) {
    const { prParts, prOpen } = await import("../api/actions.js");
    const { reopenForOpenPr } = await import("../kernel/prs.js");
    const parts = prParts(item as Task);
    targets = (parts.length ? parts : prOpen(item as Task) ? [item as Task] : [])
      .map((x) => (x.state === "DONE" ? ((reopenForOpenPr(x.id) as any) ?? x) : x))
      .filter((x) => x.state === "PR_OPEN" && ((x as any).owner ?? "me") === "me");
  }
  if (targets.length) {
    const { emit } = await import("../kernel/events.js");
    for (const x of targets) emit({ type: "user_command", idemKey: `cmd:${x.id}:${command}:${Date.now()}`, itemId: x.id, payload: { command, by: ctx.who, ours: true, ...(command === "rebase" && resolveAll ? { resolveAll: true } : {}) } });
    await tick();
    const r = targets.map(refOf).join(" and ");
    return said(command === "fix_ci"
      ? `🛠️ Fixing the failing CI checks on ${r}'s PR. You'll hear from me here when it's done.`
      : command === "rebase"
        ? resolveAll
          ? `🔀 Resolving the conflicts on ${r}'s PR myself (your OK). I'll run the tests and show you the result before anything is pushed. Lock files and recorded test baselines stay with you. Nothing is force-pushed.`
          : `🔀 Bringing the base branch into ${r}'s PR. Small conflicts I resolve; bigger ones come to you (say \"resolve them yourself\" and I will, shown to you before pushing). Nothing is force-pushed.`
        : `🛠️ Fixing the review comments (and any failing check) on ${r}'s PR. You'll hear from me here when the fixes are ready.`, true, { ref: r });
  }
  if (command === "rebase") return said("❓ Which PR should I update from its base branch? Give me the PR link or the ticket key.");
  const r = await startFixFromText(text, ticketKey, ctx.who, (args.mode === "rebase" ? undefined : args.mode) ?? "comments");
  await tick();
  return said(r);
}

/** W15: a review of old or merged work, a branch, a commit range, "is the X epic complete" or "QA the X feature KAN-n". */
export function wantsAudit(text: string, ref?: string): boolean {
  const t = String(text ?? "");
  if (/\bbranch\s+[\w./-]+/i.test(t) || /\b[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40}\b/i.test(t)) return true;
  if (/\bepic\b[\s\S]*\b(complete|done|finished)\b|\b(complete|done|finished)\b[\s\S]*\bepic\b/i.test(t)) return true;
  if (/\bQA\b[\s\S]*\bfeature\b/i.test(t)) return true;
  if (/\b(merged|old|last (month|week|sprint)|already (shipped|merged|done))\b/i.test(t)) return true;
  if (ref) {
    const it = taskFor(ref);
    if (it && ["DONE", "MERGED"].includes(it.state)) return true;
  }
  return false;
}

async function toolReview(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const ref = args.ref && keysIn(args.ref).length ? keysIn(args.ref)[0].split("@")[0] : undefined;
  const text = [args.text ?? ctx.original, args.ref && !ref ? args.ref : ""].filter(Boolean).join(" ");
  if (!/github\.com\/[^\s]+\/pull\/\d+|\bPR[\s#-]*\d+\b/i.test(text) && wantsAudit(text, ref)) {
    const { startAuditFromText } = await import("../engine/steps/audit.js");
    const r = await startAuditFromText(ref && !text.includes(ref) ? `${text} ${ref}` : text, ctx.who);
    await tick();
    return said(r);
  }
  const { startReviewFromText } = await import("../engine/prReview.js");
  const r = await startReviewFromText([args.text ?? ctx.original, args.ref && !ref ? args.ref : ""].filter(Boolean).join(" "), ref, ctx.who);
  await tick();
  return said(r);
}

async function toolQa(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const { startQaFromText } = await import("../engine/qa.js");
  const ref = args.ref && keysIn(args.ref).length ? keysIn(args.ref)[0].split("@")[0] : undefined;
  const r = await startQaFromText([args.text ?? ctx.original, args.ref && !ref ? args.ref : ""].filter(Boolean).join(" "), ref, ctx.who);
  await tick();
  return said(r);
}

/** Optional modules built by other waves; a stub reply until they exist. */
async function optional(spec: string, fn: string): Promise<((...a: any[]) => any) | undefined> {
  try { const m: any = await import(spec); return typeof m?.[fn] === "function" ? m[fn] : undefined; } catch { return undefined; }
}

/** W16: finish my branch – build on your commits, never rewrite them, never force-push (v2 only; v1 answers honestly). */
async function toolAdopt(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const { startAdoptFromText } = await import("../engine/steps/adopt.js");
  const text = [ctx.original, args.text, args.ref].filter(Boolean).join(" ");
  const r = await startAdoptFromText(text, ctx.who);
  await tick();
  return said(String(r));
}

/** W8 step 1 / B9–B12: the scope preview (engine/steps/scope.ts). A sprint or "all my tickets" asks once to start. */
async function toolPreviewScope(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const { previewScope } = await import("../engine/steps/scope.js");
  // the owner's own words decide sprint / epic / batch and "no approvals"; the args only name the target
  const target = [args.ref, ...(args.refs ?? []), args.text].filter(Boolean).join(" ");
  const r = await previewScope(target && !ctx.original.includes(target) ? `${ctx.original} ${target}` : ctx.original || target, ctx.who);
  if (r.itemId) { const t = getTask(r.itemId); if (t) setFocus(refOf(t)); }
  if (r.ask) return { ok: r.ok !== false, reply: r.reply, ask: { question: r.ask.question, calls: r.ask.calls as ToolCall[] }, data: { itemId: r.itemId } };
  if (r.itemId) await tick();
  return said(r.reply, r.ok !== false, r.itemId ? { itemId: r.itemId } : undefined);
}

// ------------------------------------------------------------------ read tools: find, status, explain, lookup

function toolFind(args: ToolArgs, ctx: ToolCtx): ToolResult {
  const q = args.query ?? args.text ?? ctx.original;
  const f = find(q, { history: true });
  if (!f.matches.length) return said(`I found nothing for "${truncate(q, 60)}".`, true, { matches: [] });
  if (f.ambiguous && f.question) return { ok: true, reply: f.question, data: { matches: f.matches } };
  return said(f.matches.slice(0, 5).map((m: Found) => `- ${foundLine(m)}`).join("\n"), true, { matches: f.matches });
}

/** One line about a PR's conflict state as last checked (data.conflict, written by the rebase job and the PR watcher). */
export function conflictLine(t: Task): string | undefined {
  const c = (t.data as any)?.conflict;
  if (!c?.state) return undefined;
  const when = String(c.at ?? "").slice(11, 16);
  const pr = c.num ? `PR #${c.num}` : "The PR";
  if (c.state === "resolved") return `✅ ${pr} (${refOf(t)}): no conflicts with ${c.base ?? "its base"} now${when ? ` (${when})` : ""}`;
  const files = Array.isArray(c.files) && c.files.length ? ` – ${c.files.length} file${c.files.length === 1 ? "" : "s"}` : "";
  return `⚠️ ${pr} (${refOf(t)}): still not merged with ${c.base ?? "its base"}${files}${c.why ? ` · ${truncate(String(c.why), 120)}` : ""}${when ? ` (checked ${when})` : ""}`;
}

/** PR conflict state of every item checked in the last 7 days, still-open ones first. */
function conflictSection(): string {
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const rows = db().prepare("SELECT id FROM tasks WHERE json_extract(data,'$.conflict.at') >= ? ORDER BY json_extract(data,'$.conflict.state') = 'resolved', updated_at DESC").all(since) as { id: string }[];
    const lines = rows.map((r) => getTask(r.id)).filter((t): t is Task => !!t).map(conflictLine).filter(Boolean);
    return lines.length ? `**PR conflicts**\n${lines.slice(0, 8).map((l) => `- ${l}`).join("\n")}` : "";
  } catch { return ""; }
}

export function toolStatus(args: ToolArgs): ToolResult {
  const ref = args.ref && !/^(all|everything)$/i.test(args.ref) ? args.ref : undefined;
  if (ref) {
    const t = taskFor(ref);
    const all = tasksOfTicket(ref);
    const withConflict = (x: Task) => [conflictLine(x), statusText(refOf(x)) ?? ""].filter(Boolean).join("\n");
    if (all.length > 1) return said(all.map(withConflict).join("\n\n"));
    if (t) return said([withConflict(t), treeLines(t)].filter(Boolean).join("\n\n"));
    return said(`I don't have anything for ${ref}. Say "plan for ${ref}" to start it.`);
  }
  const conflicts = conflictSection();
  // J2: one line per item; what waits on you and what is blocked first
  const active = listTasks({ states: [...ACTIVE_STATES] }).filter((t) => t.kind !== "part" && !(t as any).parent_id);
  if (!active.length) return said([conflicts, isPaused() ? "⏸️ Paused – nothing is in progress." : "Nothing is in progress right now."].filter(Boolean).join("\n\n"));
  const rank = (t: Task) => taskNow(t).waitingFor ? 0 : ["BLOCKED", "PAUSED", "FAILED_PUBLISH", "STALE"].includes(t.state) ? 1 : 2;
  const lines = active.sort((a, b) => rank(a) - rank(b)).slice(0, 10).map((t) => `- **${refOf(t)}** – ${taskNow(t).now}`);
  return said(`${conflicts ? `${conflicts}\n\n` : ""}📋 **${inboxSummaryLine()}**${isPaused() ? " · ⏸️ paused" : ""}\n\n${lines.join("\n")}${active.length > 10 ? `\n- and ${active.length - 10} more` : ""}`);
}

/** Status by tree (v2 batches, epics, sprints): one line per child. */
function treeLines(t: Task): string {
  try {
    const rows = db().prepare("SELECT id FROM tasks WHERE parent_id=? AND state != 'CANCELLED' ORDER BY created_at").all(t.id) as { id: string }[];
    if (!rows.length) return "";
    return rows.slice(0, 12).map((r) => { const c = getTask(r.id)!; return `  - ${refOf(c)}: ${taskNow(c).now}`; }).join("\n");
  } catch { return ""; }
}

/** J8: "why did you do X?" – from the design document, the decision log and the step history. No model call. */
export async function toolExplain(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const t = taskFor(args.ref ?? ctx.quotedItem ?? getFocus() ?? undefined);
  if (!t) return said("Which item? e.g. \"why did you change the validator in KAN-45?\"", false);
  const ref = refOf(t);
  const parts: string[] = [`**${ref}** – ${t.title ?? ""}`];
  try {
    const { readDoc } = await import("../knowledge/designDoc.js");
    const doc = readDoc(t.id) ?? (t.source_ref ? readDoc(t.source_ref) : undefined);
    if (doc) {
      const s = doc.sections;
      if (s["Approach"]) parts.push(`Approach: ${truncate(s["Approach"].replace(/\s+/g, " "), 400)}`);
      if (s["Decisions"]) parts.push(`Decisions:\n${truncate(s["Decisions"].trim(), 600)}`);
      if (s["Alternatives rejected"]) parts.push(`Not chosen: ${truncate(s["Alternatives rejected"].replace(/\s+/g, " "), 300)}`);
    }
  } catch { /* no design document */ }
  if (parts.length === 1) {
    if (t.data.plan?.summary) parts.push(`Plan: ${truncate(t.data.plan.summary, 400)}`);
    if (t.data.understanding?.summary) parts.push(`What I found: ${truncate(t.data.understanding.summary, 300)}`);
  }
  for (const c of (t.data.clarifications ?? []).slice(-3)) parts.push(`You said: ${truncate(String(c.reply ?? c.answer ?? ""), 140)}`);
  for (const f of (t.data.feedback ?? []).slice(-2)) parts.push(`Your feedback: ${truncate(String(f), 140)}`);
  for (const c of (t.data.planChanges ?? []).slice(-2)) parts.push(`Change you asked for: ${truncate(String(c.text ?? c), 140)}`);
  const steps = stepsFor(t.id).slice(-6).map((s) => `${s.name} ${s.status}${s.error ? ` (${truncate(s.error, 80)})` : ""}`);
  if (steps.length) parts.push(`Last steps: ${steps.join(" → ")}`);
  if (args.query || args.text) parts.push(`(Question: ${truncate(args.query ?? args.text ?? "", 120)})`);
  return said(parts.join("\n"), true, { ref });
}

/** J1: a question about the code or the product – the read-only assistant (it can't change anything). */
async function toolLookup(args: ToolArgs, ctx: ToolCtx): Promise<ToolResult> {
  const { answerQuestion } = await import("../chat/assistant.js");
  const t = taskFor(args.ref ?? ctx.quotedItem ?? undefined);
  return said(await answerQuestion(args.query ?? args.text ?? ctx.original, ctx.who, t ? { task: t } : {}));
}

// ------------------------------------------------------------------ dispatch

export async function runTool(call: ToolCall, ctx: ToolCtx): Promise<ToolResult> {
  const args = (call.args ?? {}) as ToolArgs;
  try {
    let r: ToolResult;
    switch (call.tool) {
      case "find": r = toolFind(args, ctx); break;
      case "preview_scope": r = await toolPreviewScope(args, ctx); break;
      case "start": r = await toolStart(args, ctx); break;
      case "decide": r = await toolDecide(args, ctx); break;
      case "set_directive": r = await toolSetDirective(args, ctx); break;
      case "prefs": r = toolPrefs(args, ctx); break;
      case "control": r = await toolControl(args, ctx); break;
      case "fix_pr": r = await toolFixPr(args, ctx); break;
      case "review": r = await toolReview(args, ctx); break;
      case "qa": r = await toolQa(args, ctx); break;
      case "adopt": r = await toolAdopt(args, ctx); break;
      case "status": r = toolStatus(args); break;
      case "explain": r = await toolExplain(args, ctx); break;
      case "lookup": r = await toolLookup(args, ctx); break;
      case "clone_repo": r = cloneRepo(args); break;
      default: r = said(`(unknown tool ${String((call as any).tool)})`, false);
    }
    audit(`user:${ctx.who}`, "conductor.tool", args.ref ?? undefined, { tool: call.tool, ok: r.ok, asked: !!r.ask, confirmed: ctx.confirmed || undefined });
    return r;
  } catch (e: any) {
    return said(`${call.tool}: ${truncate(e.message ?? String(e), 200)}`, false);
  }
}
