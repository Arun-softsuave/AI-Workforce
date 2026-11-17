import { getMeta, setMeta, delMeta, audit } from "../core/db.js";
import { loadSettings, loadProjects } from "../core/config.js";
import { logger } from "../core/log.js";
import { truncate } from "../core/util.js";
import { normaliseQuestions, formatChoices, optionNumber, plainNumbers } from "../core/questions.js";
import { getRunner, untrusted } from "../agents/runner.js";
import { AGENTS } from "../agents/catalog.js";
import { listTasks, getTask, recordUsage, type Task } from "../engine/tasks.js";
import { latestApproval, type Approval } from "../approvals/approvals.js";
import { decideAndApply, answerTask, cancelTask, startAwaiting, resumeTask, tick } from "../engine/engine.js";
import { createRequest, resolveProduct } from "../engine/requests.js";
import { statusText, taskNow, inboxSummaryLine } from "../api/ops.js";
import { runTicket } from "./intake.js";
import { answerQuestion, answerWithSuggestion } from "../chat/assistant.js";
import { chatHistoryText, getFocus, setFocus } from "../notify/chatLog.js";
import { parsePrRef, reviewCommand, startReviewFromText, REVIEW_EDIT } from "../engine/prReview.js";
import { personIn } from "../engine/targets.js";
import { qaCommand, QA_EDIT } from "../engine/qa.js";
import { ticketsForPrompt } from "./ticketIndex.js";

/**
 * Plain-language Teams chat: "plan for KAN-42", "yes", "2", "no – use the existing validator", "add a CSV export".
 *
 * Order: a pending follow-up ("what should I change?") -> exact words and numbers (no AI) -> the small "intent" model
 * -> the read-only assistant. Approving, rejecting and cancelling only ever happen when it is unambiguous which item
 * the message is about; otherwise the bot asks. Every action is confirmed in one line.
 */
export type IntentName = "start_ticket" | "start_request" | "approve" | "reject" | "answer" | "cancel" | "status" | "resume" | "review_pr" | "resolve_comments" | "fix_ci" | "fix_qa" | "qa_pr" | "send_report" | "question" | "unclear";
/** refs: several tickets in one message ("work on KAN-60, KAN-61 and KAN-62"). more: further actions in the same message. */
export interface Intent { intent: IntentName; ref?: string; refs?: string[]; text?: string; project?: string; delegated?: boolean; more?: Intent[] }

interface Pending { approvals: { task: Task; approval: Approval }[]; questions: Task[]; starts: Task[] }

export function pendingItems(): Pending {
  const mine = (t: Task) => t.kind !== "part";          // a repository part never waits for the user – its lead does
  const approvals = listTasks({ states: ["AWAITING_APPROVAL"] }).filter(mine)
    .map((task) => ({ task, approval: latestApproval(task.id)! }))
    .filter((x) => x.approval?.state === "pending");
  return { approvals, questions: listTasks({ states: ["NEEDS_INFO"] }).filter(mine), starts: listTasks({ states: ["AWAITING_START"] }).filter(mine) };
}

const refOf = (t: Task) => t.source_ref ?? t.id;
const KEY = /\b([A-Z][A-Z0-9]+-\d+(?:@[\w-]+)?)\b/;
const YES = /^(y|ya|yes|yeah|yep|yup|ok|okay|k|sure|approve|approved|go|go ahead|go for it|looks good|looks great|lgtm|ship it|proceed|do it|confirm|confirmed|correct|perfect|fine|raise it|raise the pr|create the pr|start|start it)[\s.!👍✅]*$/i;
const NO = /^(no|nope|nah|reject|don'?t|do not|change|instead|not quite|wrong|not like that)\b[\s,:.\-–]*([\s\S]*)$/i;
const CANCEL = /^(cancel|stop|abort|drop|kill)\b/i;
const NUMBERS = /^\d+(\s*[,;/ ]\s*\d+)*\.?$/;
const STATUS = /\b(status|progress|how('?s| is| are)? .*(going|doing)|update on|what('?s| is) happening|where are we|done yet|any news|how long|how many (minutes|hours)|when will)\b/i;
/** "status?", "any updates?", "how is it going?" – about AI Workforce's own work. Wider questions go to the assistant. */
const STATUS_GENERAL = /^(what('?s| is) the )?(status|progress|updates?)\s*\??$|^(how('?s| is) it going|any (news|updates?)|where are we|what are you (doing|working on))\s*\??$/i;
const START = /\b(plan|work on|work|pick up|pick|start|do|implement|fix|take|handle|begin|run|build|develop|look at|look into|resolve|finish|complete|go ahead|proceed)\b/i;
const IMPERATIVE = /^(please\s+)?((can|could|would) you\s+)?(please\s+)?(add|build|create|implement|make|change|update|remove|delete|fix|refactor|rename|introduce|support|allow)\b/i;
const NEVER_MIND = /^(never ?mind|nothing|forget it|skip)\b/i;
const RESUME = /^(please\s+)?(\/?aiw\s+)?(resume|retry|try again|continue it|unpause)\b/i;

/** A ticket key in any case ("kan-52", "KAN-52@nue-backend"), normalised – only for configured Jira keys or TASK-n. */
function ticketKeyIn(text: string): string | undefined {
  const m = /\b([A-Za-z][A-Za-z0-9]+-\d+)(@[\w-]+)?\b/.exec(text);
  if (!m) return undefined;
  const prefix = m[1].split("-")[0].toUpperCase();
  const known = new Set(["TASK", ...loadProjects().flatMap((p) => p.jira?.keys ?? []).map((k) => k.toUpperCase())]);
  if (!known.has(prefix) && !KEY.test(m[0])) return undefined;
  return `${m[1].toUpperCase()}${(m[2] ?? "").toLowerCase()}`;
}

/** Every ticket key in a message, in order, without repeats ("KAN-60, kan-61 and KAN-62"). */
export function ticketKeysIn(text: string): string[] {
  const out: string[] = [];
  const re = /\b([A-Za-z][A-Za-z0-9]+-\d+)(@[\w-]+)?\b/g;
  for (const m of text.matchAll(re)) {
    const k = ticketKeyIn(m[0]);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

const REPORT = /\b(pdf|pdfs|report|reports|document|summary document)\b/i;

/** Every open task of one ticket (the lead, or the per-repository halves of older tickets). */
function tasksOfTicket(ref: string): Task[] {
  const key = ref.toUpperCase().split("@")[0];
  return listTasks({ states: ["DETECTED", "TRIAGED", "NEEDS_INFO", "AWAITING_START", "QUEUED", "RUNNING", "PAUSED", "AWAITING_APPROVAL", "PUBLISHING", "STALE", "REJECTED", "FAILED_PUBLISH", "WAITING_PARTS", "FAILED"] })
    .filter((t) => t.kind !== "part" && (t.data.ticket?.key ?? String(t.source_ref).split("@")[0]).toUpperCase() === key && (!ref.includes("@") || refOf(t) === ref));
}
/** "I don't know, you check the code and decide" – the user leaves the decision to the agent. */
const DELEGATE = /\b(you decide|you can decide|decide (it )?yourself|your call|up to you|i (really )?(do ?n'?t|dont) know|no idea|you choose|choose (the )?best|pick (the )?best|(you )?check the codes?|figure (it )?out|whatever you think|as you see fit|(your|a|the) better (plan|implementation|option|approach)|go with your (plan|recommendation|choice)|your recommendation|recommended (one|option))\b/i;

// --------------------------------------------------------------- follow-up state ("what should I change?")

type Awaiting =
  | { type: "reject_reason"; ref: string; at: number }
  | { type: "confirm_cancel"; ref: string; at: number }
  | { type: "pick_project"; text: string; choices: string[]; at: number }
  | { type: "confirm_answer"; ref: string; text: string; at: number }
  | { type: "confirm_actions"; actions: Intent[]; at: number };

const AWAIT_KEY = "teams.awaiting";
const AWAIT_MS = 60 * 60_000;
function getAwaiting(): Awaiting | undefined {
  try {
    const a = JSON.parse(getMeta(AWAIT_KEY) ?? "null") as Awaiting | null;
    if (!a || Date.now() - a.at > AWAIT_MS) return undefined;
    return a;
  } catch { return undefined; }
}
const setAwaiting = (a: Awaiting) => setMeta(AWAIT_KEY, JSON.stringify(a));
const clearAwaiting = () => delMeta(AWAIT_KEY);

// --------------------------------------------------------------- rules (no AI)

const approvalWhat = (a: Approval) => a.action === "implement_plan" ? "plan approval" : a.action === "confirm_requirements" ? "confirm requirements" : a.action === "create_pr" ? "raise the PR?" : "approval";
const questionWhat = (t: Task) => `question: ${truncate(normaliseQuestions(t.data.questions, 1)[0]?.question ?? "", 70)}`;

/** What is waiting, one line per ticket (the conversation's current item first), at most `max` lines. */
function describePending(p: Pending, max = 5): string {
  const focus = getFocus();
  const items = [
    ...p.approvals.map((x) => ({ ref: refOf(x.task), what: approvalWhat(x.approval) })),
    ...p.questions.map((t) => ({ ref: refOf(t), what: questionWhat(t) })),
  ];
  const decisions = items.sort((a, b) => (a.ref === focus ? -1 : b.ref === focus ? 1 : 0)).map((x) => `• ${x.ref} – ${x.what}`);
  // tickets waiting to be started: one line per ticket, not per repository
  const starts = [...new Set(p.starts.map((t) => refOf(t).split("@")[0]))];
  const lines = decisions.slice(0, max);
  const room = Math.max(0, max - lines.length);
  if (starts.length) lines.push(room >= 1 ? `• waiting to start: ${starts.slice(0, 6).join(", ")}${starts.length > 6 ? ` and ${starts.length - 6} more` : ""}` : `• and ${starts.length} ticket(s) waiting to start`);
  if (decisions.length > max) lines.push(`• and ${decisions.length - max} more waiting for you`);
  return lines.join("\n");
}

const ambiguous = (p: Pending) => ({ reply: `🤔 **Several things are waiting** – start your reply with the ticket, e.g. "${refOf(p.approvals[0]?.task ?? p.questions[0] ?? p.starts[0])} 1"\n\n${describePending(p)}` });

/** The waiting item the conversation is about right now (the last thing we asked, or the ticket the user last named). */
function focusItem(p: Pending): ReturnType<typeof itemFor> {
  const f = getFocus();
  return f ? itemFor(p, f) : undefined;
}

/** Find the pending item a ref points to ("KAN-42", "KAN-42@nue-backend", "TASK-7"). */
function itemFor(p: Pending, ref: string): { kind: "approval"; task: Task; approval: Approval } | { kind: "question" | "start"; task: Task } | undefined {
  const t = getTask(ref);
  if (!t) return undefined;
  const a = p.approvals.find((x) => x.task.id === t.id);
  if (a) return { kind: "approval", ...a };
  if (p.questions.some((x) => x.id === t.id)) return { kind: "question", task: t };
  if (p.starts.some((x) => x.id === t.id)) return { kind: "start", task: t };
  return undefined;
}

type RuleResult = { intent: Intent } | { reply: string } | { option: { ref: string; action: string; n: number } } | undefined;

/** Deterministic understanding of common replies. Exported for tests. */
export function ruleIntent(text: string, p: Pending = pendingItems(), aiAvailable = true): RuleResult {
  const t = text.trim();
  if (!t) return undefined;

  // Word-matching only decides SHORT, typical replies. Anything longer or unusual is read by Claude with the whole
  // conversation – except edits of a waiting review ("change 2: <a long new comment>"), which are exact commands.
  if (aiAvailable) {
    const reviewWaiting = p.approvals.some((x) => x.approval.action === "post_review");
    const reviewEdit = reviewWaiting && (REVIEW_EDIT.test(t) || /^PR-\d+@[\w-]+\s+(post|drop|remove|delete|skip|change|edit|reword)\b/i.test(t));
    const long = t.length > 90 || t.split(/\s+/).length > 12;
    if (long && !reviewEdit) return undefined;
    // several tickets AND an action ("approve KAN-60 and answer KAN-61: …", "KAN-60 1 and KAN-61 2") – Claude splits it
    if (ticketKeysIn(t).length >= 2 && /\b(approve|approved|reject|cancel|answer|change|yes|no|post|decide)\b|(^|\s)[123](\s|$|[,.])/i.test(t)) return undefined;
  }

  // "KAN-42 1", "KAN-42: yes", "TASK-7 only admins" – a reply aimed at one waiting item
  const pre = /^((?:[A-Z][A-Z0-9]+|TASK)-\d+(?:@[\w-]+)?)\s*[:,\-–]?\s+([\s\S]+)$/i.exec(t);
  if (pre) {
    const item = itemFor(p, pre[1].toUpperCase().replace(/@(.*)$/, (_m, r) => `@${r.toLowerCase()}`));
    if (item) return replyTo(item, pre[2].trim());
  }

  // a waiting review: "post", "post 1, 3", "drop 2", "change 2: …" (before "drop" could be read as cancel)
  if (REVIEW_EDIT.test(t)) {
    const reviews = p.approvals.filter((x) => x.approval.action === "post_review");
    const f = getFocus();
    const target = reviews.find((x) => refOf(x.task) === f) ?? (reviews.length === 1 ? reviews[0] : undefined);
    if (target) return replyTo({ kind: "approval", ...target }, t);
    if (reviews.length > 1 && /^post\b/i.test(t)) return { reply: `Several reviews are waiting – start with the one you mean, e.g. "${refOf(reviews[0].task)} post".` };
  }

  // a waiting QA result: "create 1, 3", "create all", "report only"
  if (QA_EDIT.test(t)) {
    const qas = p.approvals.filter((x) => x.approval.action === "create_issues");
    const f = getFocus();
    const target = qas.find((x) => refOf(x.task) === f) ?? (qas.length === 1 ? qas[0] : undefined);
    if (target) return replyTo({ kind: "approval", ...target }, t);
  }

  // Work on PRs – yours or a teammate's; the PR is found from a link, "PR 90", a ticket key or a person ("Eric's PR")
  const key = ticketKeyIn(t);
  const prNamed = !!parsePrRef(t) || !!key || !!personIn(t);
  const prRef = parsePrRef(t) ? undefined : key;
  if (prNamed && /\b(fix|resolve|solve|address)\b/i.test(t) && /\b(qa|q\.a\.)\b/i.test(t) && /\b(issues?|bugs?|findings?)\b/i.test(t)) return { intent: { intent: "fix_qa", text: t, ref: prRef } };
  if (prNamed && /\b(fix|resolve|solve|address|handle)\b/i.test(t) && /\b(comments?|review|feedback|remarks?|suggestions?)\b/i.test(t)) return { intent: { intent: "resolve_comments", text: t, ref: prRef } };
  // "PR 134 failed, fix it", "fix the CI on KAN-40", "make the checks pass", "fix PR 134"
  if (prNamed && /\b(fix|solve|repair|make .{0,20}(pass|green))\b/i.test(t) && (CI_WORDS.test(t) || !!parsePrRef(t))) return { intent: { intent: "fix_ci", text: t, ref: prRef } };
  if (prNamed && (/^\s*(please\s+)?(run\s+|do\s+)?(the\s+)?qa\b/i.test(t) || /\b(run|do|start)\s+(the\s+)?qa\b/i.test(t) || /\bqa\s+(the\s+|for\s+|on\s+)?(pr|pull|ticket|it)\b/i.test(t))) return { intent: { intent: "qa_pr", text: t, ref: prRef } };
  // "review PR 90", a PR link, "review KAN-52's PR", "add comments on KAN-60" (a teammate's ticket), "review Eric's PR"
  if (prNamed && /\b(review|add (review |some )?comments?|put (some |review )?comments?|leave (some )?comments?|comment on)\b/i.test(t)) return { intent: { intent: "review_pr", text: t, ref: prRef } };

  if (key && STATUS.test(t)) return { intent: { intent: "status", ref: key } };

  // "resume", "retry", "try again", "resume KAN-52" – continue a paused / failed task
  if (RESUME.test(t)) {
    if (key) return { intent: { intent: "resume", ref: key } };
    const stopped = listTasks({ states: ["PAUSED", "FAILED", "STALE"] }).filter((x) => x.kind !== "part");
    const f = getFocus();
    const target = stopped.find((x) => refOf(x) === f) ?? (stopped.length === 1 ? stopped[0] : undefined);
    if (target) return { intent: { intent: "resume", ref: refOf(target) } };
    if (!stopped.length) return { reply: "Nothing is paused or failed right now." };
    return { reply: `Which one should I resume? ${stopped.slice(0, 5).map(refOf).join(", ")} – e.g. "resume ${refOf(stopped[0])}".` };
  }
  // "give me the PDF of KAN-52", "send the reports of KAN-52 and KAN-60"
  if (REPORT.test(t) && /\b(give|send|share|get|make|create|need|want|show|where)\b/i.test(t)) {
    const keys = ticketKeysIn(t);
    const f = getFocus();
    const refs = keys.length ? keys : f ? [f.split("@")[0]] : [];
    if (refs.length) return { intent: { intent: "send_report", ref: refs[0], refs } };
    return { reply: "Which ticket's report do you want? e.g. \"PDF of KAN-52\"." };
  }
  if (key && START.test(t) && (!/\?\s*$/.test(t) || /^(please\s+)?(can|could|would|will) you\b/i.test(t))) {
    const keys = ticketKeysIn(t);
    return { intent: keys.length > 1 ? { intent: "start_ticket", ref: keys[0], refs: keys } : { intent: "start_ticket", ref: key } };
  }
  if (!key && STATUS_GENERAL.test(t)) return { intent: { intent: "status" } };

  const total = p.approvals.length + p.questions.length;
  // A short reply goes to the only waiting item – or, when several wait, to the one the conversation is about.
  const focus = focusItem(p);
  const single = total === 1 ? (p.approvals[0] ? { kind: "approval" as const, ...p.approvals[0] } : { kind: "question" as const, task: p.questions[0] }) : undefined;
  const only = single ?? (focus && focus.kind !== "start" ? focus : undefined);

  // "I don't know – you check the code and decide" → the agent decides (and shows its choice in the plan)
  if (!key && DELEGATE.test(t) && t.length < 300) {
    const target = only?.kind === "question" ? only : focus?.kind === "question" ? focus : undefined;
    if (target) return { intent: { intent: "answer", ref: refOf(target.task), text: t, delegated: true } };
  }

  if (NUMBERS.test(t)) {
    if (only) return replyTo(only, t);
    if (total === 0 && p.starts.length === 1 && t === "1") return { intent: { intent: "approve", ref: refOf(p.starts[0]) } };
    if (total === 0) return { reply: "Nothing is waiting for a choice right now." };
    return ambiguous(p);
  }
  if (YES.test(t)) {
    if (only) return replyTo(only, t);
    if (focus?.kind === "start") return { intent: { intent: "approve", ref: refOf(focus.task) } };
    if (total === 0 && p.starts.length === 1) return { intent: { intent: "approve", ref: refOf(p.starts[0]) } };
    if (total > 1) return ambiguous(p);
    return { reply: "Nothing is waiting for your approval right now." };
  }
  if (CANCEL.test(t) && !key) {
    if (only) return { intent: { intent: "cancel", ref: refOf(only.task) } };
    if (total > 1) return ambiguous(p);
  }
  if (CANCEL.test(t) && key) return { intent: { intent: "cancel", ref: key } };
  if (NO.test(t) && only) return replyTo(only, t);

  // Without the AI model (offline/mock mode) a few more cases are decided by rules.
  if (!aiAvailable) {
    if (only?.kind === "question" && !/\?$/.test(t)) return { intent: { intent: "answer", ref: refOf(only.task), text: t } };
    if (!key && IMPERATIVE.test(t) && t.length >= 15) return { intent: { intent: "start_request", text: t } };
  }
  return undefined;
}

function replyTo(item: NonNullable<ReturnType<typeof itemFor>>, reply: string): RuleResult {
  const ref = refOf(item.task);
  if (STATUS.test(reply) && reply.length < 60) return { intent: { intent: "status", ref } };
  if (item.kind === "question") return { intent: { intent: "answer", ref, text: reply, ...(DELEGATE.test(reply) && reply.length < 300 && !NUMBERS.test(reply) ? { delegated: true } : {}) } };
  if (item.kind !== "approval") {
    if (/\?\s*$/.test(reply)) return undefined;                // "KAN-42 what is this about?" – a question for the assistant
    return YES.test(reply) || reply === "1" || START.test(reply) ? { intent: { intent: "approve", ref } } : { reply: `Reply "yes" to start ${ref}.` };
  }
  // a QA result waiting: "create 1, 3", "create all", "report only"
  if (item.approval.action === "create_issues") {
    const r = qaCommand(item.task, reply);
    if (r && "approve" in r) return { intent: { intent: "approve", ref } };
    if (r) return { reply: r.reply };
  }
  // a review waiting to be posted: "post", "post 1, 3", "drop 2", "change 2: …"
  if (item.approval.action === "post_review") {
    const r = reviewCommand(item.task, reply);
    if (r && "approve" in r) return { intent: { intent: "approve", ref } };
    if (r) return { reply: r.reply };
  }
  // approval: numbers map to the choices, words to approve / change
  if (NUMBERS.test(reply)) {
    const n = Number(reply.replace(/\D.*$/, ""));
    if (n >= 1 && n <= 3) return { option: { ref, action: item.approval.action, n } };
    return { reply: `For ${ref}:\n\n${formatChoices(item.approval.action)}` };
  }
  if (YES.test(reply)) return { intent: { intent: "approve", ref } };
  const no = NO.exec(reply);
  if (no) return no[2].trim().length >= 3 ? { intent: { intent: "reject", ref, text: no[2].trim() } } : { option: { ref, action: item.approval.action, n: 2 } };
  if (CANCEL.test(reply)) return { intent: { intent: "cancel", ref } };
  if (/\?\s*$/.test(reply)) return undefined;                  // "KAN-42 why this approach?" is a question, not a decision
  return { intent: { intent: "reject", ref, text: reply } };   // "KAN-42 use the existing validator" = change request
}

// --------------------------------------------------------------- the small intent model

async function aiIntent(text: string, p: Pending): Promise<Intent | undefined> {
  const def = AGENTS.intent;
  const focus = getFocus();
  const context = [
    `FOCUS (the item the conversation is about right now): ${focus ?? "none"}`,
    `Waiting for approval:\n${p.approvals.map((x) => `- ${refOf(x.task)} (${x.approval.action}): ${x.task.title ?? ""}`).join("\n") || "none"}`,
    `Waiting for an answer:\n${p.questions.map((t) => `- ${refOf(t)}: ${normaliseQuestions(t.data.questions, 4).map((q) => `${q.question}${q.options.length ? ` [options: ${q.options.join(" / ")}]` : ""}`).join(" / ")}`).join("\n") || "none"}`,
    `Waiting to start:\n${[...new Set(p.starts.map((t) => refOf(t)))].slice(0, 30).join(", ") || "none"}`,
    `Open Jira tickets that may be meant (map a ticket NAME or description to its key – "the invite email task" → its key):\n${ticketsForPrompt(text) || "none indexed"}`,
    `Recent tasks:\n${listTasks({ limit: 500 }).filter((t) => t.kind !== "part").slice(-8).map((t) => `- ${refOf(t)} [${t.state}] ${t.title ?? ""}`).join("\n") || "none"}`,
    `Recent conversation (oldest first; the last USER line is the message to classify):\n${untrusted("teams-history", chatHistoryText(20, 300)) || "none"}`,
  ].join("\n\n");
  try {
    const r = await getRunner().run({ agent: "intent", tier: def.tier, system: def.system, schema: def.schema, maxTurns: 2,
      prompt: `${context}\n\nThe message:\n${untrusted("teams-message", truncate(text, 2000))}` });
    recordUsage("teams:intent", r, { agent: "intent" });
    if (!r.ok || !r.data?.intent) return undefined;
    const one = (x: any): Intent => {
      const refs = Array.isArray(x.refs) ? x.refs.map((k: string) => ticketKeyIn(String(k))).filter((k: string | undefined): k is string => !!k) : [];
      return { intent: x.intent, ref: x.ref || refs[0] || undefined, refs: refs.length > 1 ? refs : undefined, text: x.text || undefined, project: x.project || undefined, delegated: !!x.delegated };
    };
    const more = (Array.isArray(r.data.more) ? r.data.more : []).filter((x: any) => x?.intent).slice(0, 5).map(one);
    return { ...one(r.data), more: more.length ? more : undefined };
  } catch (e: any) {
    logger.warn("intent model failed", { error: e.message });
    return undefined;
  }
}

/** Only act on an AI-detected approval/answer when the target is certain. */
function validate(i: Intent, p: Pending): Intent | { reply: string } {
  const focus = getFocus();
  const byRef = (list: Task[], ref: string) => list.find((t) => t.id === getTask(ref)?.id);
  const pick = (list: Task[]) => (i.ref ? byRef(list, i.ref) : list.length === 1 ? list[0] : focus ? byRef(list, focus) : undefined);
  switch (i.intent) {
    case "approve": case "reject": {
      const t = pick(p.approvals.map((x) => x.task)) ?? (i.intent === "approve" ? pick(p.starts) : undefined);
      if (!t) return p.approvals.length > 1 ? ambiguous(p) : { reply: "Nothing is waiting for your approval right now." };
      if (i.intent === "reject" && !i.text?.trim()) return { reply: `What should I change for ${refOf(t)}?` };
      return { ...i, ref: refOf(t) };
    }
    case "answer": {
      const t = pick(p.questions);
      if (!t) return p.questions.length > 1 ? ambiguous(p) : { reply: "No task is waiting for an answer right now." };
      return { ...i, ref: refOf(t), text: i.text?.trim() || undefined };
    }
    default: return i;
  }
}

// --------------------------------------------------------------- execution

async function execute(i: Intent, who: string, original: string): Promise<string> {
  switch (i.intent) {
    case "start_ticket": {
      const keys = [...new Set((i.refs?.length ? i.refs : [i.ref ?? ""]).map((k) => k.toUpperCase().split("@")[0]).filter(Boolean))];
      if (!keys.length) return "Which ticket? For example: plan for KAN-42";
      if (keys.length === 1) {
        const r = await startOneTicket(keys[0]);
        await tick();
        return r.kind === "busy" ? `${keys[0]} is already in progress:\n\n${r.detail}`
          : r.kind === "error" ? `I couldn't start ${keys[0]}: ${r.detail}`
          : r.kind === "started" ? `👍 Starting ${r.ref}. The plan comes here for your approval.`
          : `👍 On it – **${r.ref}**: ${r.title}\n\nI'll read the ticket, the PRD and the code, and send you the plan here for approval before writing any code.`;
      }
      // several tickets: each becomes its own task with its own plan, questions and PR – worked on side by side
      const lines: string[] = [];
      let started = 0;
      for (const key of keys) {
        const r = await startOneTicket(key);
        if (r.kind === "new" || r.kind === "started") started++;
        lines.push(r.kind === "new" ? `- **${r.ref}** – ${r.title} (new)`
          : r.kind === "started" ? `- **${r.ref}** – started (it was waiting to start)`
          : r.kind === "busy" ? `- **${key}** – already in progress: ${r.short}`
          : `- **${key}** – could not start: ${"detail" in r ? r.detail : "unknown error"}`);
      }
      await tick();
      return `👍 **Starting ${started} of ${keys.length} tickets**\n\n${lines.join("\n")}\n\nThey are worked on side by side. Each plan comes here separately for your approval, then each PR. When several things wait, start your reply with the ticket, e.g. "${keys[0]} 1".`;
    }
    case "send_report": {
      const { requestTicketReport } = await import("../report/ticketReport.js");
      const keys = [...new Set((i.refs?.length ? i.refs : [i.ref ?? ""]).map((k) => k.toUpperCase().split("@")[0]).filter(Boolean))];
      if (!keys.length) return "Which ticket's report do you want? e.g. \"PDF of KAN-52\".";
      const replies: string[] = [];
      for (const k of keys) replies.push(await requestTicketReport(k));
      return replies.join("\n\n");
    }
    case "start_request": {
      const text = i.text?.trim() || original.trim();
      const { project, choices } = resolveProduct(i.project);
      if (!project) {
        if (!choices.length) return "No projects are set up yet – add one with `aiw project add`.";
        setAwaiting({ type: "pick_project", text, choices: choices.map((c) => c.id), at: Date.now() });
        return `❓ **Which project is this for?**\n\n${choices.map((c, n) => `${optionNumber(n)}  ${c.group ?? c.id}`).join("\n\n")}\n\n↩️ Reply with a number.`;
      }
      return startRequestReply(text, who, project.id);
    }
    case "approve": {
      const t = getTask(i.ref ?? "");
      if (t?.state === "AWAITING_START") { startAwaiting(refOf(t)); await tick(); return `👍 Starting ${refOf(t)}.`; }
      return (await decideAndApply(i.ref ?? "", "approved", who, "teams-personal")).message;
    }
    case "reject": return (await decideAndApply(i.ref ?? "", "rejected", who, "teams-personal", i.text)).message;
    case "answer": return (await answerTask(i.ref, i.text ?? original, who, "teams-personal", { delegated: i.delegated })).message;
    case "cancel": {
      const t = getTask(i.ref ?? "");
      if (!t) return `I can't find ${i.ref}.`;
      setAwaiting({ type: "confirm_cancel", ref: refOf(t), at: Date.now() });
      return `Cancel ${refOf(t)} (${t.title ?? ""})? Reply "yes" to cancel, anything else keeps it.`;
    }
    case "status": {
      if (i.ref) {
        const direct = getTask(i.ref) ? statusText(i.ref) : undefined;
        if (direct) return direct;
        const all = tasksOfTicket(i.ref);        // e.g. the backend and frontend halves of an older ticket
        if (all.length) return all.map((t) => statusText(refOf(t))).join("\n\n");
        return `I don't have a task for ${i.ref}. Say "plan for ${i.ref}" to start it.`;
      }
      const active = listTasks({ states: ["NEEDS_INFO", "AWAITING_START", "QUEUED", "RUNNING", "PAUSED", "AWAITING_APPROVAL", "PUBLISHING", "STALE", "WAITING_PARTS"] }).filter((t) => t.kind !== "part");
      if (!active.length) return "Nothing is in progress right now.";
      return `📋 **${inboxSummaryLine()}**\n\n${active.slice(0, 10).map((t) => { const n = taskNow(t); return `- **${refOf(t)}** – ${n.now}`; }).join("\n")}`;
    }
    case "resume": {
      const list = getTask(i.ref ?? "") ? [getTask(i.ref ?? "")!] : tasksOfTicket(i.ref ?? "");
      const stopped = list.filter((t) => ["PAUSED", "FAILED", "STALE", "FAILED_PUBLISH"].includes(t.state));
      if (!stopped.length) return list.length ? `${i.ref} isn't paused – ${list.map((t) => `${refOf(t)}: ${taskNow(t).now}`).join("; ")}` : `I can't find ${i.ref}.`;
      const done = stopped.map((t) => resumeTask(refOf(t))).filter((t): t is Task => !!t);
      await tick();
      // Only say "resumed" when it really keeps going: give it a moment, then look again.
      await new Promise((r) => setTimeout(r, 1500));
      const after = done.map((t) => getTask(t.id) ?? t);
      const stuck = after.filter((t) => ["PAUSED", "FAILED"].includes(t.state));
      const going = after.filter((t) => !stuck.includes(t));
      return [
        going.length ? `▶️ Resumed ${going.map(refOf).join(", ")} – continuing from where it stopped.` : "",
        ...stuck.map((t) => `⚠️ ${refOf(t)} stopped again right away: ${truncate(t.error ?? "unknown reason", 300)}`),
      ].filter(Boolean).join("\n");
    }
    case "review_pr": { const r = await startReviewFromText(i.text ?? original, i.ref, who); await tick(); return r; }
    case "resolve_comments": case "fix_qa": case "fix_ci": {
      const { startFixFromText } = await import("../engine/prFix.js");
      const r = await startFixFromText(i.text ?? original, i.ref, who, i.intent === "fix_qa" ? "issues" : i.intent === "fix_ci" ? "ci" : "comments");
      await tick();
      return r;
    }
    case "qa_pr": {
      const { startQaFromText } = await import("../engine/qa.js");
      const r = await startQaFromText(i.text ?? original, i.ref, who);
      await tick();
      return r;
    }
    case "unclear": return unclearReply(pendingItems());
    default: return questionReply(original, who, i.ref);
  }
}

type StartResult = { kind: "new" | "started"; ref: string; title: string } | { kind: "busy"; detail: string; short: string } | { kind: "error"; detail: string };

/** Start one ticket: a new task, or start one that waits to start; an active one is left alone. */
async function startOneTicket(key: string): Promise<StartResult> {
  const active = listTasks({ states: ["DETECTED", "TRIAGED", "NEEDS_INFO", "AWAITING_START", "QUEUED", "RUNNING", "PAUSED", "AWAITING_APPROVAL", "PUBLISHING", "STALE", "REJECTED", "FAILED_PUBLISH", "WAITING_PARTS"] }).filter((t) => t.kind !== "part")
    .filter((t) => (t.data.ticket?.key ?? String(t.source_ref).split("@")[0]).toUpperCase() === key);
  if (active.length) {
    const waiting = active.find((t) => t.state === "AWAITING_START");
    if (waiting) { startAwaiting(refOf(waiting)); return { kind: "started", ref: refOf(waiting), title: waiting.title ?? "" }; }
    return { kind: "busy", detail: active.map((t) => statusText(refOf(t))).join("\n\n"), short: active.map((t) => taskNow(t).now).join("; ") };
  }
  try {
    const t = await runTicket(key);
    return { kind: "new", ref: refOf(t), title: t.title ?? "" };
  } catch (e: any) { return { kind: "error", detail: e.message }; }
}

/** One short question instead of a long list: "Do you mean KAN-52 (question: …) or KAN-35 (…)?" */
function unclearReply(p: Pending): string {
  const focus = getFocus();
  const items = [
    ...p.approvals.map((x) => ({ ref: refOf(x.task), what: approvalWhat(x.approval) })),
    ...p.questions.map((t) => ({ ref: refOf(t), what: questionWhat(t) })),
  ].sort((a, b) => (a.ref === focus ? -1 : b.ref === focus ? 1 : 0)).slice(0, 3);
  if (!items.length) return "I'm not sure what you mean – nothing is waiting for your decision right now. Ask me anything, or say e.g. \"plan for KAN-42\".";
  return `Do you mean ${items.map((x) => `${x.ref} (${x.what})`).join(" or ")}? Start your reply with the ticket, e.g. "${items[0].ref} 1" or "${items[0].ref} you decide".`;
}

/**
 * A question for the assistant. When it is about a task that is waiting for an answer, the assistant also proposes an
 * answer, and the user can send it to the task with one "yes".
 */
async function questionReply(text: string, who: string, ref?: string): Promise<string> {
  const t = getTask(ref ?? getFocus() ?? "");
  const waiting = t && t.state === "NEEDS_INFO" && t.kind !== "part" ? t : undefined;
  if (!waiting) return answerQuestion(text, who, t ? { task: t } : {});
  const r = await answerWithSuggestion(text, who, waiting);
  if (!r.suggested) return r.text;
  setAwaiting({ type: "confirm_answer", ref: refOf(waiting), text: r.suggested, at: Date.now() });
  return `${r.text}\n\nSend this to ${refOf(waiting)} as your answer?\n"${truncate(r.suggested, 400)}"\nReply "yes" to send it, "no" to keep it waiting, or write your own answer.`;
}

async function startRequestReply(text: string, who: string, projectId: string): Promise<string> {
  const { getProject } = await import("../core/config.js");
  const project = getProject(projectId);
  if (!project) return `Project ${projectId} is not configured.`;
  const t = createRequest(text, who, project, { via: "teams" });
  await tick();
  return `📝 Got it – ${refOf(t)} (${project.group ?? project.id}). Before planning, I'll ask you a few questions here so the requirements are complete.`;
}

async function handleAwaiting(a: Awaiting, text: string, who: string): Promise<string | undefined> {
  const t = text.trim();
  if (a.type === "reject_reason") {
    // A new instruction ("plan for KAN-50", "status") is not the change request – handle it normally, keep waiting.
    if ((KEY.test(t) && !t.toUpperCase().includes(a.ref.split("@")[0])) || (STATUS.test(t) && t.length < 60)) return undefined;
    clearAwaiting();
    if (NEVER_MIND.test(t)) return `OK – ${a.ref} is still waiting for your decision.`;
    if (YES.test(t)) return (await decideAndApply(a.ref, "approved", who, "teams-personal")).message;
    return (await decideAndApply(a.ref, "rejected", who, "teams-personal", t)).message;
  }
  if (a.type === "confirm_cancel") {
    clearAwaiting();
    if (!YES.test(t)) return `OK – ${a.ref} was not cancelled.`;
    const c = await cancelTask(a.ref, `cancelled by ${who} in Teams`);
    return c ? `🛑 Cancelled ${a.ref}. Nothing was published.` : `I can't find ${a.ref}.`;
  }
  if (a.type === "confirm_actions") {
    if (YES.test(t) || /^(do it all|all|both|go)\b/i.test(t)) { clearAwaiting(); return runActions(a.actions, who, t); }
    if (NEVER_MIND.test(t) || /^(no|nope|nah|cancel|stop|don'?t)\b[\s.!]*$/i.test(t)) { clearAwaiting(); return "OK – nothing was done."; }
    clearAwaiting();
    return undefined;                                // a correction or a new message – read it again normally
  }
  if (a.type === "confirm_answer") {
    clearAwaiting();
    if (YES.test(t)) return (await answerTask(a.ref, a.text, who, "teams-personal")).message;
    if (NEVER_MIND.test(t) || /^(no|nope|nah|don'?t)\b[\s.!]*$/i.test(t)) return `OK – not sent. ${a.ref} is still waiting for your answer.`;
    return undefined;                                // their own answer or a new message – handle it normally
  }
  if (a.type === "pick_project") {
    const n = Number(t);
    const id = Number.isInteger(n) && n >= 1 && n <= a.choices.length ? a.choices[n - 1] : a.choices.find((c) => c.toLowerCase() === t.toLowerCase());
    if (!id) return undefined;                       // not an answer to the project question – handle the message normally
    clearAwaiting();
    return startRequestReply(a.text, who, id);
  }
  return undefined;
}

/** Understand and act on one message from the owner in the Teams chat. Returns the reply to post. */
export async function handleChatMessage(text: string, who: string): Promise<string> {
  text = plainNumbers(text);                       // "1️⃣" copied back from our message means "1"
  const awaiting = getAwaiting();
  if (awaiting) {
    const r = await handleAwaiting(awaiting, text, who);
    if (r) { audit(`user:${who}`, "teams.followup", undefined, { type: awaiting.type }); return r; }
  }
  const p = pendingItems();
  const aiAvailable = loadSettings().models.provider !== "mock";
  const rule = ruleIntent(text, p, aiAvailable);
  if (rule && "reply" in rule) return rule.reply;
  if (rule && "option" in rule) {
    const { ref, n } = rule.option;
    audit(`user:${who}`, "teams.option", ref, { n });
    if (n === 1) return execute({ intent: "approve", ref }, who, text);
    if (n === 2) { setAwaiting({ type: "reject_reason", ref, at: Date.now() }); return `✏️ What should I change for ${ref}?`; }
    return execute({ intent: "cancel", ref }, who, text);
  }
  let intent: Intent | { reply: string } | undefined = rule && "intent" in rule ? rule.intent : undefined;
  if (!intent && aiAvailable) {
    const ai = await aiIntent(text, p);
    if (ai) {
      // Claude read the message: several actions are done in order; approving or rejecting is repeated back first
      const all = [ai, ...(ai.more ?? [])].map((x) => validate({ ...x, more: undefined }, p));
      const ok = all.filter((x): x is Intent => !("reply" in x) && x.intent !== "unclear" && x.intent !== "question");
      if (all.length > 1 || ok.some((x) => DECISIONS.has(x.intent))) {
        if (!ok.length) return "reply" in all[0] ? all[0].reply : unclearReply(p);
        const problems = all.filter((x): x is { reply: string } => "reply" in x).map((x) => x.reply);
        if (ok.some((x) => DECISIONS.has(x.intent)) || ok.length > 1) {
          setAwaiting({ type: "confirm_actions", actions: ok, at: Date.now() });
          if (ok[0].ref) setFocus(ok[0].ref);
          return confirmText(ok, problems);
        }
        intent = ok[0];
      } else intent = all[0];
    }
  }
  if (intent && "reply" in intent) return intent.reply;
  if (!intent) return questionReply(text, who);
  audit(`user:${who}`, "teams.intent", intent.ref, { intent: intent.intent, delegated: intent.delegated || undefined });
  if (intent.ref && intent.intent !== "unclear") setFocus(intent.ref);     // the conversation is now about this item
  return execute(intent, who, text);
}

/** Decisions that change a task – repeated back for a "yes" when Claude (not an exact rule) understood them. */
const DECISIONS = new Set<IntentName>(["approve", "reject", "cancel"]);
/** A pull request's CI: "failed", "red", "checks", "pipeline", "build", "tests failing", "lint". */
const CI_WORDS = /\b(ci|checks?|pipelines?|builds?|workflows?|actions|failed|failing|fails|broken|red|green|lint|tests?)\b/i;

function describeAction(i: Intent): string {
  const t = i.ref ? getTask(i.ref) : undefined;
  const a = t ? latestApproval(t.id) : undefined;
  const what = a?.state === "pending" ? approvalWhat(a).replace("raise the PR?", "raise the PR") : t?.state === "AWAITING_START" ? "start" : "it";
  switch (i.intent) {
    case "approve": return t?.state === "AWAITING_START" ? `Start **${i.ref}**` : `Approve **${i.ref}** – ${what}`;
    case "reject": return `Ask for changes on **${i.ref}**: "${truncate(i.text ?? "", 200)}"`;
    case "answer": return `Answer **${i.ref}**${i.delegated ? " – leave the decision to the agent" : `: "${truncate(i.text ?? "", 200)}"`}`;
    case "cancel": return `Cancel **${i.ref}**`;
    case "start_ticket": return `Start ${(i.refs ?? [i.ref]).map((r) => `**${r}**`).join(", ")}`;
    case "status": return `Show the status${i.ref ? ` of **${i.ref}**` : ""}`;
    case "resume": return `Resume **${i.ref}**`;
    case "review_pr": return `Review ${i.ref ? `the PR of **${i.ref}**` : "the PR"} and show you the comments first`;
    case "resolve_comments": return `Fix the review comments on ${i.ref ? `**${i.ref}**` : "the PR"} and show you the fixes first`;
    case "fix_ci": return `Fix the failing CI checks on ${i.ref ? `**${i.ref}**` : "the PR"}, show you the fixes first, then watch CI until it passes`;
    case "fix_qa": return `Fix the QA issues on ${i.ref ? `**${i.ref}**` : "the PR"} and show you the fixes first`;
    case "qa_pr": return `Run QA on ${i.ref ? `**${i.ref}**` : "the PR"}`;
    case "send_report": return `Send the PDF of ${(i.refs ?? [i.ref]).map((r) => `**${r}**`).join(", ")}`;
    case "start_request": return `Start new work: "${truncate(i.text ?? "", 160)}"`;
    default: return i.intent;
  }
}

function confirmText(actions: Intent[], problems: string[]): string {
  return [
    `🤔 **Here's what I understood${actions.length > 1 ? ` – ${actions.length} things` : ""}**`,
    actions.map((a, n) => `${actions.length > 1 ? `${n + 1}. ` : "- "}${describeAction(a)}`).join("\n"),
    problems.length ? `Not done: ${problems.join(" · ")}` : "",
    `↩️ Reply **yes** to do ${actions.length > 1 ? "all of it" : "it"}, or tell me what I got wrong.`,
  ].filter(Boolean).join("\n\n");
}

/** Run confirmed actions in order (a confirmed cancel is not asked again). */
async function runActions(actions: Intent[], who: string, original: string): Promise<string> {
  const out: string[] = [];
  for (const a of actions) {
    try {
      if (a.intent === "cancel") {
        const c = await cancelTask(a.ref ?? "", `cancelled by ${who} in Teams`);
        out.push(c ? `🛑 Cancelled ${a.ref}. Nothing was published.` : `I can't find ${a.ref}.`);
      } else out.push(await execute(a, who, original));
    } catch (e: any) { out.push(`${a.ref ?? a.intent}: ${e.message}`); }
    audit(`user:${who}`, "teams.intent", a.ref, { intent: a.intent, confirmed: true });
  }
  return out.join("\n\n");
}
