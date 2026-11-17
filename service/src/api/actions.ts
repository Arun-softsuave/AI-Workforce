/**
 * Dashboard actions = Teams commands. Every button on the dashboard runs exactly the code a Teams message would run
 * (the Conductor's tools and the engine's answer / approve functions), so the same checks, gates and rails apply.
 * After an action, Teams gets one short line ("✅ From the dashboard: …") so both places tell the same story, and
 * the item remembers it (data.lastAction): a late "1" in Teams for something already decided on the dashboard is
 * answered with one line instead of acting twice.
 */
import { getTask, mergeData, type Task } from "../engine/tasks.js";
import { latestApproval } from "../approvals/approvals.js";
import { normaliseQuestions, approvalChoices } from "../core/questions.js";
import { truncate } from "../core/util.js";
import { audit } from "../core/db.js";
import { notify } from "../notify/router.js";
import { logChat } from "../notify/chatLog.js";
import type { Action } from "./dashboardData.js";

export type ActionKey =
  | "start" | "answer" | "option" | "you_decide" | "approve" | "change" | "resume" | "refresh" | "takeover" | "handback"
  | "cancel" | "pause" | "fix_ci" | "resolve_comments" | "rebase" | "resolve_conflicts" | "review";

const WAITING = new Set(["NEEDS_INFO", "AWAITING_APPROVAL", "AWAITING_START"]);
const STOPPED = new Set(["PAUSED", "FAILED", "STALE", "FAILED_PUBLISH", "BLOCKED"]);
const WORKING = new Set(["DETECTED", "TRIAGED", "QUEUED", "RUNNING", "PUBLISHING", "PLANNING", "WAITING_PARTS", "WAITING_CHILDREN", "PART_READY", "ASKING_LEAD"]);
const refOf = (t: Task) => t.source_ref ?? t.id;

const act = (t: Task, action: ActionKey, label: string, more: Partial<Action> & { confirm?: string; value?: string } = {}): Action & { confirm?: string } => {
  const { value, ...rest } = more;
  return { label, method: "POST", path: "/api/act", body: { id: t.id, action, ...(value !== undefined ? { value } : {}) }, ...rest };
};

/** The next steps for an item in its current state – the same choices Teams offers, as buttons. */
export function actionsFor(t: Task): (Action & { confirm?: string })[] {
  const out: (Action & { confirm?: string })[] = [];
  const ref = refOf(t);
  if (t.state === "AWAITING_START") {
    out.push(act(t, "start", "Start", { primary: true }));
    out.push(act(t, "cancel", "Cancel", { confirm: `Cancel ${ref}? Nothing was published for it.` }));
  } else if (t.state === "NEEDS_INFO") {
    const qs = normaliseQuestions(t.data.questions, 10);
    if (qs.length === 1) qs[0].options.slice(0, 4).forEach((o, i) => out.push(act(t, "option", o, { value: String(i + 1), primary: i === 0 })));
    out.push(act(t, "answer", qs.length > 1 ? "Answer the questions" : "Write an answer", { ask: qs.length > 1 ? "Your answers (one per question, in order)" : "Your answer" }));
    out.push(act(t, "you_decide", "You decide"));
  } else if (t.state === "AWAITING_APPROVAL") {
    const a = latestApproval(t.id);
    if (a?.state === "pending") {
      out.push(act(t, "approve", approvalChoices(a.action)[0], { primary: true }));
      out.push(act(t, "change", "Change something", { ask: "What should change?" }));
    }
    out.push(act(t, "cancel", "Cancel", { confirm: `Cancel ${ref}?` }));
  } else if (STOPPED.has(t.state)) {
    out.push(act(t, t.state === "STALE" ? "refresh" : "resume", t.state === "STALE" ? "Refresh" : "Resume", { primary: true }));
    if (t.data.takenOver) out.push(act(t, "handback", "Hand back to the plugin"));
    else out.push(act(t, "takeover", "Take over"));
    out.push(act(t, "cancel", "Cancel", { confirm: `Cancel ${ref}?` }));
  } else if (t.state === "PR_OPEN") {
    const conflict = t.data.conflict?.state === "open";
    if (conflict) out.push(act(t, "resolve_conflicts", "Resolve conflicts myself", { primary: true, confirm: `Resolve the conflicts on ${ref}'s PR yourself? You'll see the result before anything is pushed. Lock files and test baselines stay with you.` }));
    out.push(act(t, "rebase", "Bring the base branch in", { primary: !conflict }));
    out.push(act(t, "fix_ci", "Fix failing CI"));
    out.push(act(t, "resolve_comments", "Resolve review comments"));
    if (t.data.takenOver) out.push(act(t, "handback", "Hand back to the plugin"));
    else out.push(act(t, "takeover", "Take over"));
    out.push(act(t, "pause", "Pause"));
  } else if (WORKING.has(t.state)) {
    out.push(act(t, "pause", "Pause"));
    out.push(act(t, "cancel", "Cancel", { confirm: `Cancel ${ref}? Work in progress stops; nothing published is changed.` }));
  } else if (t.state === "DONE" || t.state === "MERGED") {
    out.push(act(t, "review", "Review this work"));
  }
  return out;
}

export interface ActionResult { ok: boolean; message: string }

const WHAT: Record<ActionKey, string> = {
  start: "started", answer: "answered", option: "answered", you_decide: "left it to the plugin", approve: "approved", change: "asked for a change",
  resume: "resumed", refresh: "refreshed", takeover: "took it over", handback: "handed it back", cancel: "cancelled", pause: "paused",
  fix_ci: "asked to fix the failing CI", resolve_comments: "asked to resolve the review comments", rebase: "asked to bring the base branch in",
  resolve_conflicts: "asked to resolve the conflicts", review: "asked for a review",
};

/** Run one dashboard action (same code as the Teams command), then tell Teams in one line. */
export async function runDashboardAction(o: { id: string; action: ActionKey; text?: string; value?: string; who: string }): Promise<ActionResult> {
  const t = getTask(o.id);
  if (!t) return { ok: false, message: "That item no longer exists." };
  const ref = refOf(t);
  const { runTool } = await import("../conductor/tools.js");
  const tctx = { who: o.who, original: o.text ?? WHAT[o.action], confirmed: true, channel: "dashboard" };
  const tool = async (call: Parameters<typeof runTool>[0]) => {
    const r = await runTool(call, tctx);
    return { ok: r.ok, message: r.reply || r.ask?.question || (r.ok ? "Done." : "That did not work.") };
  };
  let res: ActionResult;
  let shown = o.text ?? o.value;
  switch (o.action) {
    case "start": {
      const { startAwaiting, tick } = await import("../engine/engine.js");
      const n = startAwaiting(t.id); await tick();
      res = { ok: n > 0, message: n > 0 ? `▶️ Started ${ref}.` : `${ref} is not waiting to start.` };
      break;
    }
    case "option": case "answer": case "you_decide": {
      const answer = o.action === "you_decide" ? "you decide" : o.action === "option" ? String(o.value ?? "") : String(o.text ?? "").trim();
      if (!answer) return { ok: false, message: "Please write an answer." };
      if (o.action === "option") {
        const q = normaliseQuestions(t.data.questions, 10)[0];
        shown = q?.options[Number(o.value) - 1] ?? o.value;
      }
      res = await tool({ tool: "decide", args: { ref, decision: "answer", text: answer, delegated: o.action === "you_decide" } } as any);
      if (o.action === "you_decide") shown = "you decide";
      break;
    }
    case "approve": case "change": {
      const a = latestApproval(t.id);
      if (!a || a.state !== "pending") return { ok: false, message: `${ref} has nothing waiting for your approval now.` };
      if (o.action === "change" && !String(o.text ?? "").trim()) return { ok: false, message: "Please write what should change." };
      const { decideAndApply } = await import("../engine/engine.js");
      const r = await decideAndApply(a.id, o.action === "approve" ? "approved" : "rejected", o.who, "dashboard", o.action === "change" ? o.text : undefined);
      res = { ok: r.ok, message: r.message };
      break;
    }
    case "resume": case "refresh": res = await tool({ tool: "control", args: { action: "resume", ref } } as any); break;
    case "takeover": res = await tool({ tool: "control", args: { action: "takeover", ref } } as any); break;
    case "handback": res = await tool({ tool: "control", args: { action: "handback", ref } } as any); break;
    case "cancel": res = await tool({ tool: "control", args: { action: "cancel", ref } } as any); break;
    case "pause": res = await tool({ tool: "control", args: { action: "pause", ref } } as any); break;
    case "fix_ci": res = await tool({ tool: "fix_pr", args: { ref, mode: "ci", text: `fix the failing CI on ${ref}` } } as any); break;
    case "resolve_comments": res = await tool({ tool: "fix_pr", args: { ref, mode: "comments", text: `resolve the comments on ${ref}` } } as any); break;
    case "rebase": res = await tool({ tool: "fix_pr", args: { ref, mode: "rebase", text: `bring the base branch into ${ref}` } } as any); break;
    case "resolve_conflicts": res = await tool({ tool: "fix_pr", args: { ref, mode: "rebase", resolveAll: true, text: `resolve the conflicts on ${ref} yourself` } } as any); break;
    case "review": res = await tool({ tool: "review", args: { ref, text: `review ${ref}` } } as any); break;
    default: return { ok: false, message: "Unknown action." };
  }
  audit(`user:${o.who}`, "dashboard.action", t.id, { action: o.action, ok: res.ok });
  if (res.ok) {
    try { mergeData(t.id, { lastAction: { action: o.action, what: WHAT[o.action], text: shown ? truncate(String(shown), 120) : undefined, channel: "dashboard", at: new Date().toISOString() } }); } catch { /* item gone */ }
    await echoToTeams(t, `${WHAT[o.action]}${shown && WAS_ANSWER.has(o.action) ? `: ${truncate(String(shown), 120)}` : ""}`, res.message);
  }
  return res;
}

const WAS_ANSWER = new Set<ActionKey>(["option", "answer", "change"]);

/** One short line in Teams (and the inbox) about what was just done on the dashboard. Never throws. */
export async function echoToTeams(t: Task, what: string, result?: string): Promise<void> {
  const ref = refOf(t);
  try {
    const first = String(result ?? "").split("\n").map((l) => l.replace(/\*\*|`/g, "").trim()).find(Boolean) ?? "";
    await notify({ kind: "info", taskId: t.id, taskRef: ref, dedupeKey: `dash:${t.id}:${Date.now()}`,
      title: `✅ From the dashboard – ${ref}: you ${what}`, body: first ? truncate(first, 300) : "Done." });
  } catch { /* the action itself already happened */ }
}

/** The dashboard's message box: the same handling as a message to the bot in Teams. Logged as the conversation. */
export async function dashboardMessage(text: string, who: string): Promise<{ ok: boolean; reply: string }> {
  const msg = String(text ?? "").trim();
  if (!msg) return { ok: false, reply: "Please write a message." };
  logChat("in", msg, { kind: "dashboard" });
  const { handleChatMessage } = await import("../intake/teamsIntent.js");
  const reply = await handleChatMessage(msg, who);
  logChat("out", reply, { kind: "dashboard" });
  // Teams sees the same exchange, so the chat there stays the full story
  try {
    await notify({ kind: "info", dedupeKey: `dash-msg:${Date.now()}`, title: `🖥️ From the dashboard: "${truncate(msg, 120)}"`, body: truncate(reply.replace(/\*\*/g, ""), 600) });
  } catch { /* the reply is shown on the dashboard anyway */ }
  return { ok: true, reply };
}

/** A short reply in Teams that would act on something already decided on the dashboard: say so instead. */
export function alreadyDecided(text: string, ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (!/^\s*(\d{1,2}|yes|y|no|n|ok|okay|approve|approved|go|start|reject)\s*[.!]?\s*$/i.test(String(text ?? ""))) return undefined;
  let t: Task | undefined;
  try { t = getTask(ref); } catch { t = undefined; }
  if (!t || WAITING.has(t.state)) return undefined;
  const last = t.data?.lastAction;
  if (!last || last.channel !== "dashboard" || Date.now() - Date.parse(last.at) > 6 * 3_600_000) return undefined;
  return `ℹ️ ${refOf(t)}: you already ${last.what} on the dashboard${last.text ? ` ("${last.text}")` : ""} – nothing more to do. Tell me what to change if you want something else.`;
}
