/**
 * W5a step 6a – `doc_readiness`: goldfish checks on the item's design document, scaled by size.
 *
 *   S → none (ok at once); M → readiness, max 2 rounds; L / two-repo → readiness + critic, 2 rounds each;
 *   batch / epic / sprint → readiness + critic on the scope document; a part → none (its lead's document is checked).
 *
 * Returns ok when the document is ready (anything left open is listed in the plan message through data.assumptions),
 * or need_info with the product questions for the owner. After the owner answers, the step runs again: the answers are
 * written INTO the document and a new goldfish checks it. The goldfish sees only the document and the files it names.
 */
import type { StepCtx, StepResult } from "../steps.js";
import { goldfishProfile, runGoldfish, type GoldfishState } from "../../knowledge/goldfish.js";
import { syncDocFromItem } from "./design_doc.js";
import { readDoc } from "../../knowledge/designDoc.js";
import { groupMembers } from "../routing.js";

/** Folders the goldfish may read named files from: the item's workspace first, then its project (and group repos). */
function rootsOf(ctx: StepCtx): { id?: string; path: string }[] {
  const roots: { id?: string; path: string }[] = [];
  if (ctx.task.worktree) roots.push({ id: ctx.project.id, path: ctx.task.worktree });
  if (ctx.project.local?.path) roots.push({ id: ctx.project.id, path: ctx.project.local.path });
  if ((ctx.task.data.targets ?? []).length > 1 || ctx.task.playbook === "dev-lead") {
    try { for (const m of groupMembers(ctx.project)) if (m.id !== ctx.project.id && m.local?.path) roots.push({ id: m.id, path: m.local.path }); } catch { /* no group */ }
  }
  return roots;
}

async function noQuestions(ctx: StepCtx): Promise<boolean> {
  if (ctx.task.data.directives?.no_questions) return true;
  try {
    const { effective } = await import("../../policy/directives.js");
    const e = effective(ctx.task.id, "no_questions" as any, { settings: ctx.settings, project: ctx.project });
    return e.value === true || e.value === "yes";
  } catch { return false; }
}

export const DOC_READINESS_STEPS: Record<string, (ctx: StepCtx) => Promise<StepResult>> = {
  async doc_readiness(ctx) {
    const profile = goldfishProfile(ctx.task);
    if (!profile.checks.length) return { status: "ok", note: `no goldfish check: ${profile.reason}` };
    // the document is the source of truth: bring it up to date with what understand / plan / contract produced
    syncDocFromItem(ctx.task);
    if (!readDoc(ctx.task.id)?.sections.Approach.trim() && profile.row !== "scope") return { status: "ok", note: "no plan in the design document yet – nothing to check" };
    const out = await runGoldfish(profile, {
      itemId: ctx.task.id,
      projectId: ctx.project.id,
      data: ctx.task.data,
      roots: rootsOf(ctx),
      call: (agent, prompt) => ctx.agent(agent, prompt, { tools: [], maxTurns: 2 }),
      save: (state: GoldfishState, extra = {}) => { ctx.save({ goldfish: state, ...extra }); },
      noQuestions: await noQuestions(ctx),
    });
    if (out.status === "ask") return { status: "need_info", questions: out.questions, context: "Checking the design document before building" };
    return { status: "ok", note: out.note };
  },
};
