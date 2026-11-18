import { mergeData, getTask, updateTask, transition, canTransition, type Task } from "./tasks.js";
import { audit } from "../core/db.js";
import { getPlaybook, stepIndex } from "./playbooks.js";
import { summariseChange } from "./steps/replan.js";

/**
 * C7: "adapt KAN-45" – the ticket changed in Jira while (or after) it was built, and you want the change in.
 *  - a PR is open (engine v2): a comment-fix job on the PR with the change as its request (the PR is updated);
 *  - still being built or waiting for an approval: the new ticket text is taken and the work restarts from reading the
 *    ticket and code (context_pack) – the plan comes to you again as usual.
 * Returns the reply for Teams.
 */
export const ADAPT = /^\s*(?:please\s+)?adapt\s+([A-Za-z][A-Za-z0-9]*-\d+(?:@[\w.-]+)?)\s*[.!]?\s*$/i;

const AFTER_PR = ["PR_OPEN", "BLOCKED", "MERGED", "CLOSED"];
const FINISHED = ["DONE", "CANCELLED", "FAILED", "MERGED"];

export async function adaptTicket(ref: string, who: string): Promise<string> {
  const t = getTask(ref.toUpperCase()) ?? getTask(ref);
  if (!t) return `I can't find ${ref}.`;
  const r = t.source_ref ?? t.id;
  if (FINISHED.includes(t.state)) return `${r} is ${t.state.toLowerCase()} – there is nothing to adapt.`;
  let ch = summariseChange(t, []);
  const comment = t.data.lastJiraComment as { author?: string; body: string } | undefined;
  if (!t.data.pendingTicket && comment?.body) ch = { kind: "ticket", title: `${comment.author ?? "A"} comment on ${r}`, lines: [comment.body.replace(/\s+/g, " ").slice(0, 400)] };
  else if (!t.data.pendingTicket && ch.kind === "ticket" && ch.lines[0]?.startsWith("the text changed")) return `${r}: I have no change from Jira to adapt to.`;
  mergeData(t.id, { lastJiraComment: null });
  if (AFTER_PR.includes(t.state)) {
    const { emit } = await import("../kernel/events.js");
    if (t.data.pendingTicket) mergeData(t.id, { ticket: t.data.pendingTicket, pendingTicket: null });
    emit({ type: "user_command", idemKey: `adapt:${t.id}:${Date.now()}`, itemId: t.id, payload: { command: "adapt", requests: [`${ch.title}: ${ch.lines.join("; ")}`], ours: true, by: who } });
    audit(`user:${who}`, "item.adapt", t.id, { after: "pr" });
    return `🔄 Adapting ${r}'s PR to the changed ticket. The changes come here before anything is pushed.`;
  }
  // before the PR: take the new text and start again from reading the ticket and the code
  mergeData(t.id, { ticket: t.data.pendingTicket ?? t.data.ticket, pendingTicket: null, ticketChange: null, adaptOffered: null, planIssues: null, findings: null });
  const pb = getPlaybook(t.playbook ?? "dev-feature");
  const at = Math.max(0, stepIndex(pb, "context_pack"));
  try { const { stopItemJobs } = await import("../kernel/runner.js"); stopItemJobs(t.id, "adapting to the changed ticket"); } catch { /* v1 */ }
  updateTask(t.id, { step_index: at });
  const now = getTask(t.id)!;
  if (now.state !== "QUEUED" && canTransition(now, "QUEUED")) transition(t.id, "QUEUED", "adapt to the changed ticket");
  audit(`user:${who}`, "item.adapt", t.id, { after: "build" });
  return `🔄 Re-planning ${r} with the changed ticket. The new plan comes here.`;
}

/** C7 during the build: say what changed and offer "adapt" (the build goes on as planned unless you say so). */
export function offerAdapt(t: Task): { title: string; body: string } {
  const ch = summariseChange(t, []);
  const r = t.source_ref ?? t.id;
  return { title: `${r} changed in Jira while I'm building it. Adapt?`, body: `${ch.lines.map((l) => `- ${l}`).join("\n")}\n\nSay "adapt ${r}" to re-plan with the change now; otherwise I finish as planned.` };
}
