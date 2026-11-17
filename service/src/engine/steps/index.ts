/**
 * The step functions that live in engine/steps/ (same signature as STEPS): CI watch (W9), rebase (W13), re-plan (W13),
 * close-out (W14) and the Wave 4 steps – goldfish doc readiness (W5 6a), design check (W5 / C6), scopes and batches
 * (W7 / W8), audit (W15), adopt (W16) and close-out learning (O3).
 * engine/prFix.ts adds them to FIX_STEPS, which steps.ts assigns into STEPS – so the playbooks and recipes run them.
 *
 * The Wave 4 agent definitions live next to their steps (they import AGENTS, so agents/catalog.ts cannot import them
 * back without an import cycle). They are registered into AGENTS here, once, like the Conductor registers itself;
 * their effort and turn caps are also in agents/catalog.ts AGENT_EFFORT / AGENT_MAX_TURNS.
 */
import type { StepCtx, StepResult } from "../steps.js";
import { AGENTS, type AgentDef } from "../../agents/catalog.js";
import { CI_WATCH_STEPS } from "./ci_watch.js";
import { REBASE_STEPS } from "./rebase.js";
import { REPLAN_STEPS } from "./replan.js";
import { CLOSE_STEPS } from "./close.js";
import { SCOPE_STEPS, SCOPE_AGENTS } from "./scope.js";
import { AUDIT_STEPS, AUDITOR_AGENT } from "./audit.js";
import { ADOPT_STEPS, GAP_ANALYST_AGENT } from "./adopt.js";
import { CLOSE_OUT_LEARNING_STEPS, REVIEW_LEARNER } from "./close_out.js";
import { DOC_READINESS_STEPS } from "./doc_readiness.js";
import { DESIGN_CHECK_STEPS, DESIGN_CHECK_AGENT } from "./design_check.js";
import { GOLDFISH_AGENTS } from "../../knowledge/goldfish.js";
import { KNOWLEDGE_AGENT } from "../../knowledge/askDesk.js";
import { DISTILLER } from "../../knowledge/broker.js";

/** Every Wave 4 agent, by name (tier, effort, turn cap, system prompt, schema, tools). */
export const WAVE4_AGENTS: Record<string, AgentDef> = {
  ...GOLDFISH_AGENTS,
  "design-check": DESIGN_CHECK_AGENT,
  ...SCOPE_AGENTS,
  auditor: AUDITOR_AGENT,
  "gap-analyst": GAP_ANALYST_AGENT,
  "review-learner": REVIEW_LEARNER,
  knowledge: { ...KNOWLEDGE_AGENT, tools: [] },
  distiller: { ...DISTILLER, effort: "low", maxTurns: 1, tools: [] },
};
for (const [name, def] of Object.entries(WAVE4_AGENTS)) if (!AGENTS[name]) AGENTS[name] = def;

export const AFTER_PR_STEPS: Record<string, (ctx: StepCtx) => Promise<StepResult>> = {
  ...CI_WATCH_STEPS,
  ...REBASE_STEPS,
  ...REPLAN_STEPS,
  ...CLOSE_STEPS,
  ...SCOPE_STEPS,
  ...AUDIT_STEPS,
  ...ADOPT_STEPS,
  ...CLOSE_OUT_LEARNING_STEPS,
  ...DOC_READINESS_STEPS,
  ...DESIGN_CHECK_STEPS,
};

export { CI_WATCH_STEPS, REBASE_STEPS, REPLAN_STEPS, CLOSE_STEPS, SCOPE_STEPS, AUDIT_STEPS, ADOPT_STEPS, CLOSE_OUT_LEARNING_STEPS, DOC_READINESS_STEPS, DESIGN_CHECK_STEPS };
