import { audit } from "../core/db.js";
import { loadSettings } from "../core/config.js";
import { truncate } from "../core/util.js";
import { formatChoices, optionNumber, plainNumbers } from "../core/questions.js";
import { listTasks, getTask, type Task } from "../engine/tasks.js";
import { decideAndApply, answerTask, cancelTask, resumeTask, tick, isPaused, resumeAll } from "../engine/engine.js";
import { createRequest, resolveProduct } from "../engine/requests.js";
import { statusText, taskNow, inboxSummaryLine } from "../api/ops.js";
import { answerQuestion, answerWithSuggestion } from "../chat/assistant.js";
import { getFocus, setFocus, catchUpText } from "../notify/chatLog.js";
import { parsePrRef, reviewCommand, startReviewFromText, REVIEW_EDIT } from "../engine/prReview.js";
import { personIn } from "../engine/targets.js";
import { qaCommand, QA_EDIT } from "../engine/qa.js";
import { keysIn, branchesIn } from "../conductor/find.js";
import { pendingItems, approvalWhat, questionWhat, tasksOfTicket, toolStart, type Pending } from "../conductor/tools.js";
import { getAwaiting, setAwaiting, clearAwaiting, type Awaiting } from "../conductor/state.js";
import { conductorEnabled, conductorTurn, runConfirmed, type TurnContext } from "../conductor/conductor.js";
import { legacyAiIntent, legacyValidate, legacyConfirmText, type Intent, type IntentName } from "../conductor/legacyIntent.js";

/**
 * Teams messages, the FAST PATH (IMPLEMENTATION-PLAN W1 step 1, 5.16): plain rules, no model call, under a second.
 *  - a pending follow-up ("what should I change?", "Cancel KAN-45?", a Conductor question) is answered first;
 *  - yes / no / 1..n / approve / status / details X / exact commands with a key, when the target is known (a quoted
 *    bot message – which sets the focus – a single waiting item, or the focus item);
 *  - thanks / ok / hi: a short reply, no action (J11).
 * Everything else goes to the Conductor (conductor/conductor.ts). While the Conductor switch is off, the older intent
 * model (conductor/legacyIntent.ts) and the read-only assistant handle it as before.
 * Approving, rejecting and cancelling only ever happen when it is unambiguous which item the message is about.
 */
export type { Intent, IntentName, Pending };
export { pendingItems };

const refOf = (t: Task) => t.source_ref ?? t.id;
const KEY = /\b([A-Z][A-Z0-9]+-\d+(?:@[\w-]+)?)\b/;
const YES = /^(y|ya|yes|yeah|yep|yup|ok|okay|k|sure|approve|approved|go|go ahead|go for it|looks good|looks great|lgtm|ship it|proceed|do it|confirm|confirmed|correct|perfect|fine|raise it|raise the pr|create the pr|start|start it)[\s.!👍✅]*$/i;
// "no need to ask", "no problem", "no rush" are not a "no" (the old rules read "no need to ask for approval" as a rejection)
const NO = /^(no|nope|nah|reject|don'?t|do not|change|instead|not quite|wrong|not like that)\b(?!\s+(?:need|problem|worries|rush|hurry|pressure|issues?)\b)[\s,:.\-–]*([\s\S]*)$/i;
const CANCEL = /^(cancel|stop|abort|drop|kill)\b/i;
const NUMBERS = /^\d+(\s*[,;/ ]\s*\d+)*\.?$/;
const STATUS = /\b(status|progress|how('?s| is| are)? .*(going|doing)|update on|what('?s| is) happening|where are we|done yet|any news|how long|how many (minutes|hours)|when will)\b/i;
/** "status?", "any updates?", "how is it going?" – about AI Workforce's own work. Wider questions go further. */
const STATUS_GENERAL = /^(what('?s| is) the )?(status|progress|updates?)\s*\??$|^(how('?s| is) it going|any (news|updates?)|where are we|what are you (doing|working on))\s*\??$/i;
const START = /\b(plan|work on|work|pick up|pick|start|do|implement|fix|take|handle|begin|run|build|develop|look at|look into|resolve|finish|complete|go ahead|proceed)\b/i;
const IMPERATIVE = /^(please\s+)?((can|could|would) you\s+)?(please\s+)?(add|build|create|implement|make|change|update|remove|delete|fix|refactor|rename|introduce|support|allow)\b/i;
const NEVER_MIND = /^(never ?mind|nothing|forget it|skip)\b/i;
const RESUME = /^(please\s+)?(\/?aiw\s+)?(resume|retry|try again|continue it|unpause)\b/i;
/** J11: small talk – a short reply, never an action, never a model call. */
const THANKS = /^(thanks|thank you|thank u|thx|ty|cheers|many thanks|thanks a lot|thank you so much|ok(ay)?,? thanks?( you)?|great,? thanks?|perfect,? thanks?)[\s.!🙂😊👍🙏]*$/i;
const PRAISE = /^(great|nice|cool|awesome|good job|well done|brilliant|excellent|super|wow)[\s.!🙂😊👍🙏🎉]*$/i;
const HELLO = /^(hi|hello|hey|hiya|good (morning|afternoon|evening)|morning)[\s.!🙂😊👋]*$/i;
const OK_ONLY = /^(ok|okay|k|fine|perfect|alright|got it|noted|👍|🙏)[\s.!]*$/i;
const TAKEOVER = /\b(take (it |this |that )?over|taking over|myself|i'?ll (do|finish|handle|take) (it|this|that)|hand(ing)? (it |this )?back|give (it )?back)\b/i;
/** J10: back after being away – one catch-up summary from the chat history. */
const BACK = /^(i'?m back|back( now)?|what did i miss\??|catch me up|anything new( while i was away)?\??)[\s.!]*$/i;

/** Every ticket key in a message, in order, without repeats ("KAN-60, kan-61 and KAN-62"). */
export function ticketKeysIn(text: string): string[] { return keysIn(text); }
function ticketKeyIn(text: string): string | undefined { return keysIn(text)[0]; }

const REPORT = /\b(pdf|pdfs|report|reports|document|summary document)\b/i;
/** "I don't know, you check the code and decide" – the user leaves the decision to the agent. */
const DELEGATE = /\b(you decide|you can decide|decide (it )?yourself|your call|up to you|i (really )?(do ?n'?t|dont) know|no idea|you choose|choose (the )?best|pick (the )?best|(you )?check the codes?|figure (it )?out|whatever you think|as you see fit|(your|a|the) better (plan|implementation|option|approach)|go with your (plan|recommendation|choice)|your recommendation|recommended (one|option))\b/i;

// --------------------------------------------------------------- rules (no AI)

/** What is waiting, one line per ticket (the conversation's current item first), at most `max` lines. */
function describePending(p: Pending, max = 5): string {
  const focus = getFocus();
  const items = [
    ...p.approvals.map((x) => ({ ref: refOf(x.task), what: approvalWhat(x.approval) })),
    ...p.questions.map((t) => ({ ref: refOf(t), what: questionWhat(t) })),
  ];
  const decisions = items.sort((a, b) => (a.ref === focus ? -1 : b.ref === focus ? 1 : 0)).map((x) => `• ${x.ref} – ${x.what}`);
  const starts = [...new Set(p.starts.map((t) => refOf(t).split("@")[0]))];
  const lines = decisions.slice(0, max);
  const room = Math.max(0, max - lines.length);
  if (starts.length) lines.push(room >= 1 ? `• waiting to start: ${starts.slice(0, 6).join(", ")}${starts.length > 6 ? ` and ${starts.length - 6} more` : ""}` : `• and ${starts.length} ticket(s) waiting to start`);
  if (decisions.length > max) lines.push(`• and ${decisions.length - max} more waiting for you`);
  return lines.join("\n");
}

const ambiguous = (p: Pending) => ({ reply: `🤔 **Several things are waiting** – start your reply with the ticket, e.g. "${refOf(p.approvals[0]?.task ?? p.questions[0] ?? p.starts[0])} 1"\n\n${describePending(p)}` });

/** The waiting item the conversation is about right now (a quoted message, the last thing we asked, or the ticket last named). */
function focusItem(p: Pending): ReturnType<typeof itemFor> {
  const f = getFocus();
  return f ? itemFor(p, f) : undefined;
}

/** Find the pending item a ref points to ("KAN-42", "KAN-42@nue-backend", "TASK-7"). */
function itemFor(p: Pending, ref: string): { kind: "approval"; task: Task; approval: Pending["approvals"][number]["approval"] } | { kind: "question" | "start"; task: Task } | undefined {
  const t = getTask(ref);
  if (!t) return undefined;
  const a = p.approvals.find((x) => x.task.id === t.id);
  if (a) return { kind: "approval", ...a };
  if (p.questions.some((x) => x.id === t.id)) return { kind: "question", task: t };
  if (p.starts.some((x) => x.id === t.id)) return { kind: "start", task: t };
  return undefined;
}

type RuleResult = { intent: Intent } | { reply: string } | { option: { ref: string; action: string; n: number } } | undefined;

/** Deterministic understanding of common replies (the fast path). Exported for tests. */
export function ruleIntent(text: string, p: Pending = pendingItems(), aiAvailable = true): RuleResult {
  const t = text.trim();
  if (!t) return undefined;

  // J11 small talk and J10 "I'm back": short replies, no action
  if (THANKS.test(t) || PRAISE.test(t)) return { reply: "You're welcome 👍" };
  if (HELLO.test(t)) return { reply: `Hi 👋 ${inboxSummaryLine()}` };
  if (BACK.test(t)) return { reply: catchUpText() };

  // Word-matching only decides SHORT, typical replies. Anything longer or unusual is read by the model with the whole
  // conversation – except edits of a waiting review ("change 2: <a long new comment>"), which are exact commands.
  if (aiAvailable) {
    const reviewWaiting = p.approvals.some((x) => x.approval.action === "post_review");
    const reviewEdit = reviewWaiting && (REVIEW_EDIT.test(t) || /^PR-\d+@[\w-]+\s+(post|drop|remove|delete|skip|change|edit|reword)\b/i.test(t));
    const long = t.length > 90 || t.split(/\s+/).length > 12;
    if (long && !reviewEdit) return undefined;
    // several tickets AND an action ("approve KAN-60 and answer KAN-61: …", "KAN-60 1 and KAN-61 2") – the model splits it
    if (ticketKeysIn(t).length >= 2 && /\b(approve|approved|reject|cancel|answer|change|yes|no|post|decide)\b|(^|\s)[123](\s|$|[,.])/i.test(t)) return undefined;
  }

  // a branch name ("finish my branch feat/KAN-106-coupons") is not a ticket to start, and "take over" / "I'll finish it
  // myself" may mean either direction – the Conductor reads those with the conversation
  if (aiAvailable && (branchesIn(t).length || TAKEOVER.test(t))) return undefined;

  // "details KAN-45" – the full text behind a short message (messenger/details.ts), no model call
  const details = /^\s*(?:show\s+)?(?:full\s+)?details?\s+(?:for\s+|of\s+|on\s+)?([A-Za-z][A-Za-z0-9]*-\d+(?:@[\w.-]+)?)\s*[.!?]?\s*$/i.exec(t);
  if (details) return { intent: { intent: "status", ref: details[1].toUpperCase(), text: "details" } };

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
    if (isPaused()) return { intent: { intent: "resume" } };      // "pause everything" earlier: lift it
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
    if (OK_ONLY.test(t)) return { reply: "👍" };                // J11: "ok" with nothing waiting is just an acknowledgement
    return { reply: "Nothing is waiting for your approval right now." };
  }
  if (OK_ONLY.test(t)) return { reply: "👍" };
  // "cancel", "stop it", "cancel KAN-48": short exact words only. "stop working on KAN-97, I'll do it" (a takeover) or
  // "drop the CSV export work" (a name) are read by the Conductor.
  const shortCancel = CANCEL.test(t) && (!aiAvailable || t.split(/\s+/).length <= 4);
  if (shortCancel && !key) {
    if (only) return { intent: { intent: "cancel", ref: refOf(only.task) } };
    if (total > 1) return ambiguous(p);
  }
  if (shortCancel && key) return { intent: { intent: "cancel", ref: key } };
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
    if (/\?\s*$/.test(reply)) return undefined;                // "KAN-42 what is this about?" – a question, not a start
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

// --------------------------------------------------------------- execution of rule results

async function execute(i: Intent, who: string, original: string): Promise<string> {
  switch (i.intent) {
    case "start_ticket": {
      // one place decides how a ticket starts (B5 someone else's, B6 already has a PR, B17 project not set up, M6 not cloned)
      const r = await toolStart({ ref: i.ref, refs: i.refs }, { who, original });
      if (r.ask) { storeQuestion(r.ask); return [r.reply, r.ask.question].filter(Boolean).join("\n\n"); }
      return r.reply;
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
      if (t?.state === "AWAITING_START") {
        const { startAwaiting } = await import("../engine/engine.js");
        startAwaiting(refOf(t)); await tick(); return `👍 Starting ${refOf(t)}.`;
      }
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
      if (i.ref && i.text === "details") {
        try {
          const { detailsReply } = await import("../messenger/details.js");
          const d = detailsReply(`details ${i.ref}`);
          if (d && !/^I have no details/.test(d)) return truncate(d, 6000);
        } catch { /* messenger not available: plain status */ }
      }
      if (i.ref) {
        const direct = getTask(i.ref) ? statusText(i.ref) : undefined;
        if (direct) return direct;
        const all = tasksOfTicket(i.ref);        // e.g. the backend and frontend halves of an older ticket
        if (all.length) return all.map((t) => statusText(refOf(t))).join("\n\n");
        return `I don't have a task for ${i.ref}. Say "plan for ${i.ref}" to start it.`;
      }
      const active = listTasks({ states: ["NEEDS_INFO", "AWAITING_START", "QUEUED", "RUNNING", "PAUSED", "AWAITING_APPROVAL", "PUBLISHING", "STALE", "WAITING_PARTS", "PR_OPEN", "BLOCKED"] }).filter((t) => t.kind !== "part");
      if (!active.length) return "Nothing is in progress right now.";
      return `📋 **${inboxSummaryLine()}**\n\n${active.slice(0, 10).map((t) => { const n = taskNow(t); return `- **${refOf(t)}** – ${n.now}`; }).join("\n")}`;
    }
    case "resume": {
      if (!i.ref && isPaused()) { resumeAll(); await tick(); return "▶️ Resumed – new work starts again."; }
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

function storeQuestion(ask: { question: string; calls?: any[]; options?: any[] }): void {
  if (ask.calls?.length || ask.options?.length) setAwaiting({ type: "conductor", question: ask.question, calls: ask.calls, options: ask.options, at: Date.now() });
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
    if (YES.test(t) || /^(do it all|all|both|go)\b/i.test(t)) { clearAwaiting(); return runActions(a.actions as Intent[], who, t); }
    if (NEVER_MIND.test(t) || /^(no|nope|nah|cancel|stop|don'?t)\b[\s.!]*$/i.test(t)) { clearAwaiting(); return "OK – nothing was done."; }
    clearAwaiting();
    return undefined;                                // a correction or a new message – read it again normally
  }
  if (a.type === "conductor") {
    // the Conductor's one short question: a number or a named option picks; "yes" runs it; "no" drops it
    if (a.options?.length) {
      const n = Number(t.replace(/[.!\s]+$/, ""));
      const byKey = a.options.find((o) => o.key && t.toUpperCase().replace(/[.!\s]+$/, "") === o.key.toUpperCase());
      const pick = Number.isInteger(n) && n >= 1 && n <= a.options.length ? a.options[n - 1] : byKey;
      if (pick) { clearAwaiting(); return runConfirmed(pick.calls as any, who, t); }
      // "yes" to a choice is not a choice – never guess, and never let it approve something else
      if (YES.test(t)) return `Which one? Reply with the number (1–${a.options.length}).`;
    } else if (a.calls?.length && YES.test(t)) { clearAwaiting(); return runConfirmed(a.calls as any, who, t); }
    if (NEVER_MIND.test(t) || /^(no|nope|nah|cancel|don'?t|keep it)\b[\s.!]*$/i.test(t)) { clearAwaiting(); return "OK – nothing was done."; }
    clearAwaiting();
    return undefined;                                // something else – read it normally
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

/** What the poller knows about a message beyond its text (W1a): the quoted bot message's item, a quoted teammate's text. */
export type MessageContext = TurnContext;

/** Understand and act on one message from the owner in the Teams chat. Returns the reply to post. */
export async function handleChatMessage(text: string, who: string, ctx: MessageContext = {}): Promise<string> {
  text = plainNumbers(text);                       // "1️⃣" copied back from our message means "1"
  const awaiting = getAwaiting();
  if (awaiting) {
    const r = await handleAwaiting(awaiting, text, who);
    if (r) { audit(`user:${who}`, "teams.followup", undefined, { type: awaiting.type }); return r; }
  }
  // a quoted bot message sets the item exactly (W1a) – it beats the focus for this message and the next short replies
  if (ctx.quotedItem) setFocus(ctx.quotedItem);
  const p = pendingItems();
  const aiAvailable = loadSettings().models.provider !== "mock";
  // a quote of someone's message carries context: the Conductor reads it with the words ("fix this in KAN-52")
  const rule = ctx.quotedContext && aiAvailable && conductorEnabled() ? undefined : ruleIntent(text, p, aiAvailable);
  if (rule && "reply" in rule) return rule.reply;
  if (rule && "option" in rule) {
    const { ref, n } = rule.option;
    audit(`user:${who}`, "teams.option", ref, { n });
    if (n === 1) return execute({ intent: "approve", ref }, who, text);
    if (n === 2) { setAwaiting({ type: "reject_reason", ref, at: Date.now() }); return `✏️ What should I change for ${ref}?`; }
    return execute({ intent: "cancel", ref }, who, text);
  }
  if (rule && "intent" in rule) {
    const intent = rule.intent;
    audit(`user:${who}`, "teams.intent", intent.ref, { intent: intent.intent, delegated: intent.delegated || undefined, path: "fast" });
    if (intent.ref && intent.intent !== "unclear") setFocus(intent.ref);
    return execute(intent, who, text);
  }
  // Everything else: the Conductor (one model call with tools)
  if (aiAvailable && conductorEnabled()) return (await conductorTurn(text, who, ctx)).reply;
  return legacyPath(text, who, p, aiAvailable);
}

/** The older path while the Conductor is off: the intent model reads it; decisions are read back first. */
async function legacyPath(text: string, who: string, p: Pending, aiAvailable: boolean): Promise<string> {
  let intent: Intent | { reply: string } | undefined;
  if (aiAvailable) {
    const ai = await legacyAiIntent(text, p);
    if (ai) {
      const all = [ai, ...(ai.more ?? [])].map((x) => legacyValidate({ ...x, more: undefined }, p, ambiguous));
      const ok = all.filter((x): x is Intent => !("reply" in x) && x.intent !== "unclear" && x.intent !== "question");
      if (all.length > 1 || ok.some((x) => DECISIONS.has(x.intent))) {
        if (!ok.length) return "reply" in all[0] ? all[0].reply : unclearReply(p);
        const problems = all.filter((x): x is { reply: string } => "reply" in x).map((x) => x.reply);
        if (ok.some((x) => DECISIONS.has(x.intent)) || ok.length > 1) {
          setAwaiting({ type: "confirm_actions", actions: ok, at: Date.now() });
          if (ok[0].ref) setFocus(ok[0].ref);
          return legacyConfirmText(ok, problems);
        }
        intent = ok[0];
      } else intent = all[0];
    }
  }
  if (intent && "reply" in intent) return intent.reply;
  if (!intent) return questionReply(text, who);
  audit(`user:${who}`, "teams.intent", intent.ref, { intent: intent.intent, delegated: intent.delegated || undefined });
  if (intent.ref && intent.intent !== "unclear") setFocus(intent.ref);
  return execute(intent, who, text);
}

/** Decisions that change a task – repeated back for a "yes" when the model (not an exact rule) understood them. */
const DECISIONS = new Set<IntentName>(["approve", "reject", "cancel"]);
/** A pull request's CI: "failed", "red", "checks", "pipeline", "build", "tests failing", "lint". */
const CI_WORDS = /\b(ci|checks?|pipelines?|builds?|workflows?|actions|failed|failing|fails|broken|red|green|lint|tests?)\b/i;

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
