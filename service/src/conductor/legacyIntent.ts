import { logger } from "../core/log.js";
import { truncate } from "../core/util.js";
import { normaliseQuestions } from "../core/questions.js";
import { getRunner, untrusted } from "../agents/runner.js";
import { AGENTS } from "../agents/catalog.js";
import { listTasks, getTask, recordUsage, type Task } from "../engine/tasks.js";
import { latestApproval } from "../approvals/approvals.js";
import { ticketsForPrompt } from "../intake/ticketIndex.js";
import { chatHistoryText, getFocus } from "../notify/chatLog.js";
import { keysIn } from "./find.js";
import { approvalWhat, type Pending } from "./tools.js";

/**
 * The older "intent" model (one classification per message, decisions read back before acting). Used only while the
 * Conductor switch is off (conductor.ts conductorEnabled) – kept so engine v1 and its tests behave as before
 * (strangler rule, IMPLEMENTATION-PLAN §2.1). Remove once the Conductor is the default.
 */
export type IntentName = "start_ticket" | "start_request" | "approve" | "reject" | "answer" | "cancel" | "status" | "resume" | "review_pr" | "resolve_comments" | "fix_ci" | "fix_qa" | "qa_pr" | "send_report" | "question" | "unclear";
export interface Intent { intent: IntentName; ref?: string; refs?: string[]; text?: string; project?: string; delegated?: boolean; more?: Intent[] }

const refOf = (t: Task) => t.source_ref ?? t.id;

export async function legacyAiIntent(text: string, p: Pending): Promise<Intent | undefined> {
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
      const refs = Array.isArray(x.refs) ? x.refs.flatMap((k: string) => keysIn(String(k)).slice(0, 1)) : [];
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
export function legacyValidate(i: Intent, p: Pending, ambiguous: (p: Pending) => { reply: string }): Intent | { reply: string } {
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

export function legacyConfirmText(actions: Intent[], problems: string[]): string {
  return [
    `🤔 **Here's what I understood${actions.length > 1 ? ` – ${actions.length} things` : ""}**`,
    actions.map((a, n) => `${actions.length > 1 ? `${n + 1}. ` : "- "}${describeAction(a)}`).join("\n"),
    problems.length ? `Not done: ${problems.join(" · ")}` : "",
    `↩️ Reply **yes** to do ${actions.length > 1 ? "all of it" : "it"}, or tell me what I got wrong.`,
  ].filter(Boolean).join("\n\n");
}
