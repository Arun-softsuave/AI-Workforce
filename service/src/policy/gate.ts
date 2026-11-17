import { loadSettings, loadProjects, type Settings, type ProjectConfig } from "../core/config.js";
import { db } from "../core/db.js";
import { effective, type RuleName } from "./directives.js";

/**
 * The policy gate (§5 5.10, §2 rule 5): every push, PR, comment, issue and Jira write asks here first.
 *
 * Order of checks:
 *  1. hard rails – never merge, never force-push, never push to main/dev, no secrets, no orders from outside
 *     text. Nothing (no directive, no setting) changes these.
 *  2. protected paths – always need your OK (a directive can't skip it).
 *  3. directives (item > batch > epic > sprint > global), then settings.
 *
 * The gate never reads model text to decide: every input is a structured fact the caller measured.
 */

export type Verdict = "allow" | "ask" | "deny";

export interface GateResult {
  verdict: Verdict;
  /** short plain reason, safe to show in Teams */
  reason: string;
  /** what decided it */
  by: "rail" | "protected" | "directive" | "settings" | "default" | "owner";
  rule?: RuleName | string;
}

/** Who asked for the action. Only "owner" and "code" may cause outside effects; "outside" text is data, never orders. */
export type Origin =
  | { kind: "owner"; channel?: string }
  | { kind: "code" }
  | { kind: "outside"; source: string };

export interface ActionFacts {
  /** the branch written to (push) or the PR head */
  branch?: string;
  /** the PR base / the project's base branch */
  base?: string;
  force?: boolean;
  /** files changed by the push / PR */
  files?: string[];
  /** secret scan result: number of findings, or the findings */
  secrets?: number | unknown[] | null;
  origin?: Origin;
  /** whose PR / branch it is ("me" or a teammate's login) – defaults to the item's owner */
  owner?: string;
  /** comment target */
  target?: "own_pr" | "teammate_pr" | "jira" | "issue";
  /** why the push happens */
  purpose?: "build" | "ci_fix" | "comment_fix" | "rebase";
}

export interface GateCtx { settings?: Settings; project?: ProjectConfig }

type ItemRef = string | { id: string; project_id?: string; size?: string | null; owner?: string | null } | undefined | null;

// ---------------------------------------------------------------------------------------------
// Hard rails (pure)

/** Branches nobody pushes to directly. */
export const PROTECTED_BRANCH = /^(main|master|dev|develop|development|trunk|prod|production|staging|release([/-].*)?|hotfix\/.*)$/i;

/** Paths whose change always needs your OK (same list the publish step warns about). */
export const PROTECTED_PATH = /^(\.github\/workflows|deploy|infra|terraform|helm|k8s)\/|(^|\/)(Dockerfile[^/]*|docker-compose[^/]*)$|(^|\/)CODEOWNERS$/;

/** Files that must never be pushed (a real .env, keys). .env.example and similar templates are fine. */
export const FORBIDDEN_PATH = /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$|(^|\/)(id_rsa|id_ed25519)$|\.(pem|p12|pfx|key)$/i;

export function cleanBranch(b: string | undefined | null): string {
  return String(b ?? "").trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

export function isProtectedBranch(branch: string | undefined | null, base?: string | null): boolean {
  const b = cleanBranch(branch);
  if (!b) return false;
  return PROTECTED_BRANCH.test(b) || (!!base && b === cleanBranch(base));
}

export function protectedHits(files: string[] = []): string[] {
  return files.filter((f) => PROTECTED_PATH.test(f.replace(/\\/g, "/")));
}

export function forbiddenHits(files: string[] = []): string[] {
  return files.filter((f) => FORBIDDEN_PATH.test(f.replace(/\\/g, "/")));
}

const secretCount = (s: ActionFacts["secrets"]) => (Array.isArray(s) ? s.length : typeof s === "number" ? s : 0);

export type GateKind = "push" | "create_pr" | "comment" | "create_issue" | "jira_write" | "merge" | "force_push" | "delete_branch";

const deny = (reason: string, rule: string): GateResult => ({ verdict: "deny", reason, by: "rail", rule });

/** The hard rails. Returns a deny, or null when no rail is hit. Pure. */
export function checkRails(kind: GateKind, f: ActionFacts = {}): GateResult | null {
  if (kind === "merge") return deny("I never merge. That's always yours.", "never_merge");
  if (kind === "force_push" || f.force) return deny("I never force-push.", "never_force_push");
  if (kind === "delete_branch" && isProtectedBranch(f.branch, f.base)) return deny(`I never delete ${cleanBranch(f.branch)}.`, "protected_branch");
  if (f.origin?.kind === "outside") return deny(`That request came from ${f.origin.source || "outside text"}, not from you, so I ignored it.`, "untrusted_order");
  if ((kind === "push" || kind === "create_pr") && isProtectedBranch(f.branch, kind === "push" ? f.base : undefined))
    return deny(`I never push to ${cleanBranch(f.branch)} directly.`, "protected_branch");
  if (kind === "create_pr" && f.branch && f.base && cleanBranch(f.branch) === cleanBranch(f.base))
    return deny("The PR's branch and base are the same.", "protected_branch");
  const n = secretCount(f.secrets);
  if (n > 0) return deny(`Possible secret${n > 1 ? "s" : ""} in the change (${n}). Nothing was sent.`, "secrets");
  const bad = forbiddenHits(f.files);
  if (bad.length && kind !== "comment" && kind !== "create_issue") return deny(`The change includes files that must stay local: ${bad.slice(0, 3).join(", ")}.`, "secrets");
  return null;
}

// ---------------------------------------------------------------------------------------------
// Approvals from directives and settings

export type ApprovalKind = "plan" | "start" | "pr" | "ci_fix" | "comment_fix" | "review_post" | "issue" | "jira_ticket";

export interface ApprovalNeed { ask: boolean; by: GateResult["by"]; rule: RuleName; reason: string }

interface ItemFacts { id?: string; project_id?: string; size?: string | null; owner?: string | null }

function itemFacts(item: ItemRef): ItemFacts {
  if (!item) return {};
  if (typeof item === "object" && item.project_id !== undefined) return item;
  const id = typeof item === "string" ? item : item.id;
  const r = db().prepare("SELECT id, project_id, size, owner FROM tasks WHERE id=? OR source_ref=? ORDER BY created_at DESC LIMIT 1").get(id, id) as ItemFacts | undefined;
  return r ?? { id };
}

function projectOf(f: ItemFacts, ctx: GateCtx): ProjectConfig | undefined {
  return ctx.project ?? (f.project_id ? loadProjects().find((p) => p.id === f.project_id) : undefined);
}

const RULE_OF: Record<ApprovalKind, RuleName> = {
  plan: "plan_approval", start: "start_approval", pr: "pr_approval", ci_fix: "auto_fix_ci", comment_fix: "auto_resolve",
  review_post: "post_review", issue: "create_issues", jira_ticket: "create_tickets",
};

const WHAT: Record<ApprovalKind, string> = {
  plan: "the plan", start: "starting", pr: "the PR", ci_fix: "CI fixes", comment_fix: "review comment fixes",
  review_post: "posting review comments", issue: "creating GitHub issues", jira_ticket: "creating Jira tickets",
};

/** Does this step wait for your OK? Directives first, then settings. Hard rails are separate (checkRails). */
export function needsApproval(kind: ApprovalKind, item: ItemRef, ctx: GateCtx = {}): ApprovalNeed {
  const rule = RULE_OF[kind];
  const f = itemFacts(item);
  const settings = ctx.settings ?? loadSettings();
  const project = projectOf(f, ctx);
  const e = effective(f.id ?? null, rule, { settings, project });
  const by: GateResult["by"] = e.source === "directive" || e.source === "item-data" ? "directive" : e.source === "settings" ? "settings" : "default";
  let ask: boolean;
  if (kind === "start" && e.source !== "directive" && e.source !== "item-data") {
    ask = settings.limits.askBeforeStart.includes((f.size ?? "M") as any);
    return { ask, by: "settings", rule, reason: ask ? `size ${f.size ?? "M"} waits for "start"` : "starts straight away" };
  }
  if (typeof e.value === "boolean") ask = !e.value;           // auto_* rules: true = no approval
  else if (e.value === "skip") ask = false;
  else ask = true;                                             // "ask" or unknown: ask
  const src = by === "directive" ? "your rule" : by === "settings" ? "your settings" : "default";
  return { ask, by, rule, reason: ask ? `asks before ${WHAT[kind]} (${src})` : `no approval for ${WHAT[kind]} (${src})` };
}

const fromNeed = (n: ApprovalNeed): GateResult => ({ verdict: n.ask ? "ask" : "allow", reason: n.reason, by: n.by, rule: n.rule });

function protectedAsk(files?: string[]): GateResult | null {
  const hits = protectedHits(files);
  return hits.length ? { verdict: "ask", reason: `Touches protected paths (${hits.slice(0, 3).join(", ")}), so I'll ask first.`, by: "protected", rule: "protected_paths" } : null;
}

const isMine = (owner: string | null | undefined) => !owner || owner === "me";

// ---------------------------------------------------------------------------------------------
// The gates

/** Push to a branch. Build pushes follow the PR rule; CI/comment fixes follow their own rules. */
export function canPush(item: ItemRef, f: ActionFacts = {}, ctx: GateCtx = {}): GateResult {
  const rail = checkRails("push", f);
  if (rail) return rail;
  const p = protectedAsk(f.files);
  if (p) return p;
  const it = itemFacts(item);
  const owner = f.owner ?? it.owner;
  if (!isMine(owner)) return { verdict: "ask", reason: `It's ${owner}'s branch, so I'll ask first.`, by: "owner" };
  if (f.origin?.kind === "owner") return { verdict: "allow", reason: "you asked for it", by: "owner" };
  const purpose = f.purpose ?? "build";
  if (purpose === "ci_fix") return fromNeed(needsApproval("ci_fix", item, ctx));
  if (purpose === "comment_fix") return fromNeed(needsApproval("comment_fix", item, ctx));
  if (purpose === "rebase") return { verdict: "allow", reason: "rebase of my own branch (no force-push)", by: "default" };
  return fromNeed(needsApproval("pr", item, ctx));
}

/** Raise a PR (never merged). */
export function canCreatePr(item: ItemRef, f: ActionFacts = {}, ctx: GateCtx = {}): GateResult {
  const rail = checkRails("create_pr", f);
  if (rail) return rail;
  const p = protectedAsk(f.files);
  if (p) return p;
  if (f.origin?.kind === "owner") return { verdict: "allow", reason: "you asked for it", by: "owner" };
  return fromNeed(needsApproval("pr", item, ctx));
}

/** Post a comment: own PR replies, reviews of a teammate's PR, or Jira. */
export function canComment(item: ItemRef, f: ActionFacts = {}, ctx: GateCtx = {}): GateResult {
  const rail = checkRails("comment", f);
  if (rail) return rail;
  const settings = ctx.settings ?? loadSettings();
  if (f.target === "jira" && !settings.notifications.jiraComments) return { verdict: "deny", reason: "Jira comments are off in your settings.", by: "settings" };
  if (f.origin?.kind === "owner") return { verdict: "allow", reason: "you asked for it", by: "owner" };
  if (f.target === "own_pr") return fromNeed(needsApproval("comment_fix", item, { ...ctx, settings }));
  if (f.target === "jira") return { verdict: "allow", reason: "Jira comments are on", by: "settings" };
  return fromNeed(needsApproval("review_post", item, { ...ctx, settings }));
}

/** Create a GitHub issue (QA findings). */
export function canCreateIssue(item: ItemRef, f: ActionFacts = {}, ctx: GateCtx = {}): GateResult {
  const rail = checkRails("create_issue", f);
  if (rail) return rail;
  if (f.origin?.kind === "owner") return { verdict: "allow", reason: "you asked for it", by: "owner" };
  return fromNeed(needsApproval("issue", item, ctx));
}

/** Create a Jira ticket (epic gaps, out-of-scope review asks). */
export function canCreateTicket(item: ItemRef, f: ActionFacts = {}, ctx: GateCtx = {}): GateResult {
  const rail = checkRails("jira_write", f);
  if (rail) return rail;
  if (f.origin?.kind === "owner") return { verdict: "allow", reason: "you asked for it", by: "owner" };
  return fromNeed(needsApproval("jira_ticket", item, ctx));
}

/** Merging is never allowed – here so callers have one place to ask. */
export function canMerge(): GateResult { return checkRails("merge")!; }
