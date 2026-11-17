import { truncate } from "../core/util.js";
import {
  setDirective as policySet, clearDirective as policyClear, activeDirectives as policyActive, isRule, RULE_NAMES, RULES,
  scopeLabel, type DirectiveScope, type Directive,
} from "../policy/directives.js";

/**
 * The Conductor's view of directives ("no need to ask for approval", "only backend", "don't touch tests").
 * Storage, precedence and echo live in policy/directives.ts (the policy agent's module); this file only maps the
 * Conductor's words onto it. Every directive set here comes from your own Teams message (owner: true) – text from
 * Jira, PRs, documents or pictures never reaches this code (§11a).
 */
export type { DirectiveScope, Directive };

/** Common ways people name a rule → the policy rule name. */
const RULE_ALIASES: Record<string, string> = {
  approval: "plan_approval", plan: "plan_approval", plan_approval: "plan_approval", approve_plan: "plan_approval",
  pr: "pr_approval", pr_approval: "pr_approval", raise_pr: "pr_approval",
  start: "start_approval", start_approval: "start_approval",
  ci: "auto_fix_ci", auto_fix_ci: "auto_fix_ci", fix_ci: "auto_fix_ci",
  comments: "auto_resolve", auto_resolve: "auto_resolve", resolve_comments: "auto_resolve",
  post_review: "post_review", review: "post_review",
  issues: "create_issues", create_issues: "create_issues",
  tickets: "create_tickets", create_tickets: "create_tickets",
  questions: "no_questions", no_questions: "no_questions",
  only: "only", only_area: "only", scope: "only",
  dont_touch: "dont_touch", "don't_touch": "dont_touch", exclude: "dont_touch",
  budget: "budget_tokens", budget_tokens: "budget_tokens",
};

export function ruleName(rule: string): string | undefined {
  const k = String(rule ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const r = RULE_ALIASES[k] ?? k;
  return isRule(r) ? r : undefined;
}

export const KNOWN_RULES = RULE_NAMES;

export type DirectiveResult = { ok: true; directive: Directive; echo: string } | { ok: false; message: string };

/** Store one directive from your Teams message. scopeId: an item ref or id ("KAN-45"); none for global. */
export function setDirective(scope: DirectiveScope, scopeId: string | null, rule: string, value: unknown, fromMsg?: number | null): DirectiveResult {
  const r = ruleName(rule);
  const res = policySet({ scope, scopeId, rule: r ?? rule, value }, { channel: "teams", owner: true, fromMsg: fromMsg ?? undefined });
  return res.ok ? { ok: true, directive: res.directive, echo: res.echo } : { ok: false, message: res.message };
}

/** Undo one directive (J14 "undo that" right after it was set). Returns the echo of what applies now. */
export function revokeDirective(id: string): string | undefined {
  const r = policyClear(id, { channel: "teams", owner: true });
  return r.ok ? r.echo : undefined;
}

export function activeDirectives(): Directive[] {
  try { return policyActive(); } catch { return []; }
}

/** One line per active directive for the Conductor's stable prompt prefix (sorted, no times or ids: cache-friendly). */
export function directivesPrompt(list: Directive[] = activeDirectives()): string {
  return list.slice(0, 30).map((d) => {
    const label = d.scope === "global" ? "everything" : scopeLabel(d.scope, d.scope_id);
    return `- ${label}: ${truncate((RULES as any)[d.rule]?.phrase?.(d.value) ?? `${d.rule}=${String(d.value)}`, 120)}`;
  }).sort().join("\n");
}
