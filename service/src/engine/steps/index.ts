/**
 * The after-PR step functions (same signature as STEPS): CI watch (W9), rebase (W13), re-plan (W13), close-out (W14).
 * engine/prFix.ts adds them to FIX_STEPS, which steps.ts assigns into STEPS – so the recipes in service/recipes run.
 */
import type { StepCtx, StepResult } from "../steps.js";
import { CI_WATCH_STEPS } from "./ci_watch.js";
import { REBASE_STEPS } from "./rebase.js";
import { REPLAN_STEPS } from "./replan.js";
import { CLOSE_STEPS } from "./close.js";

export const AFTER_PR_STEPS: Record<string, (ctx: StepCtx) => Promise<StepResult>> = {
  ...CI_WATCH_STEPS,
  ...REBASE_STEPS,
  ...REPLAN_STEPS,
  ...CLOSE_STEPS,
};

export { CI_WATCH_STEPS, REBASE_STEPS, REPLAN_STEPS, CLOSE_STEPS };
