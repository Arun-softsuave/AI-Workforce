import { db, audit, tx } from "../core/db.js";
import { newId, nowIso, safeJson } from "../core/util.js";
import { loadSettings, loadProjects, type Settings, type ProjectConfig } from "../core/config.js";

/**
 * Directives (§5 5.10, Phase 3): your standing orders ("no plan approval for KAN-45", "resolve the comments
 * without asking"), stored per scope and read by every gate.
 *
 * Precedence: item > batch > epic > sprint > global > settings.
 * Only owner channels (your Teams chat, the local dashboard and CLI) can set or clear them.
 * Hard rails (never merge, never force-push, never main/dev, secrets, protected paths) are not directives
 * and can never be relaxed by one (SITUATIONS M7).
 */

export type DirectiveScope = "item" | "batch" | "epic" | "sprint" | "global";
export const SCOPES: readonly DirectiveScope[] = ["item", "batch", "epic", "sprint", "global"];

export type DirectiveValue = string | number | boolean;

export interface Directive {
  id: string; scope: DirectiveScope; scope_id: string | null; rule: RuleName; value: DirectiveValue;
  from_msg: number | null; active: number; until_at: string | null; created_at: string;
}

interface RuleSpec {
  kind: "ask" | "bool" | "text" | "number";
  /** Short plain phrase for the echo, e.g. "no plan approval". */
  phrase: (v: any) => string;
  /** The value when no directive applies (from settings / project). undefined = no default. */
  fromSettings?: (s: Settings, p: ProjectConfig | undefined) => DirectiveValue | undefined;
}

const askPhrase = (yes: string, no: string) => (v: any) => (v === "skip" ? yes : no);
const boolPhrase = (on: string, off: string) => (v: any) => (v === true ? on : off);
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The rules a directive may set. Anything else is refused. */
export const RULES = {
  plan_approval: {
    kind: "ask", phrase: askPhrase("no plan approval", "ask before the plan"),
    fromSettings: (s, p) => (s.workflow.planApproval === "skip" ? "skip" : s.workflow.planApproval === "autonomy" ? (p?.autonomy === "plan" ? "ask" : "skip") : "ask"),
  },
  pr_approval: {
    kind: "ask", phrase: askPhrase("no PR approval", "ask before the PR"),
    fromSettings: (s, p) => (s.workflow.prApproval === "skip" || p?.autonomy === "publish-drafts" ? "skip" : "ask"),
  },
  start_approval: {
    kind: "ask", phrase: askPhrase("start without asking", "ask before starting"),
    // per-size: resolved by the gate (limits.askBeforeStart); no flat default here
  },
  auto_fix_ci: { kind: "bool", phrase: boolPhrase("fix failing CI without asking", "show CI fixes first"), fromSettings: (s) => s.pr.autoFixCi },
  auto_resolve: { kind: "bool", phrase: boolPhrase("fix review comments without asking", "show review comments first"), fromSettings: (s) => (s.pr as any).autoResolveComments === true },
  post_review: { kind: "bool", phrase: boolPhrase("post review comments without showing them first", "show review comments before posting"), fromSettings: (s) => s.pr.autoPostReview },
  create_issues: { kind: "ask", phrase: askPhrase("create GitHub issues without asking", "ask before creating GitHub issues"), fromSettings: (s) => (s.pr.autoQaIssues ? "skip" : "ask") },
  create_tickets: { kind: "ask", phrase: askPhrase("create Jira tickets without asking", "ask before creating Jira tickets"), fromSettings: () => "ask" },
  no_questions: { kind: "bool", phrase: boolPhrase("no questions - I'll assume and note it", "ask when unsure"), fromSettings: () => false },
  only: { kind: "text", phrase: (v) => `only ${v}` },
  dont_touch: { kind: "text", phrase: (v) => `don't touch ${v}` },
  budget_tokens: { kind: "number", phrase: (v) => `token budget ${fmtTokens(Number(v))}` },
} satisfies Record<string, RuleSpec>;

export type RuleName = keyof typeof RULES;
export const RULE_NAMES = Object.keys(RULES) as RuleName[];

/** Words that ask to relax a hard rail. A directive can never do that. */
const RAIL_WORDS = /\b(merge|force[\s_-]?push|push[\s_-]?(to[\s_-]?)?(main|master|dev|develop)|skip[\s_-]?hooks|no[\s_-]?verify|secret|protected|branch[\s_-]?protection)\b/i;

export const RAIL_REFUSAL = "That's a hard rule I keep: I never merge, force-push, push to main or dev, skip git hooks or push secrets.";

export function isRule(rule: string): rule is RuleName { return Object.prototype.hasOwnProperty.call(RULES, rule); }

/** Normalise a value for a rule ("yes" -> true, "no approval" -> "skip"). Returns undefined when it doesn't fit. */
export function normaliseValue(rule: RuleName, v: unknown): DirectiveValue | undefined {
  const spec: RuleSpec = RULES[rule];
  const s = typeof v === "string" ? v.trim().toLowerCase() : v;
  switch (spec.kind) {
    case "ask":
      if (s === "skip" || s === false || s === "no" || s === "off" || s === "none" || s === "never") return "skip";
      if (s === "ask" || s === true || s === "yes" || s === "on" || s === "always") return "ask";
      return undefined;
    case "bool":
      if (s === true || s === "true" || s === "yes" || s === "on" || s === 1) return true;
      if (s === false || s === "false" || s === "no" || s === "off" || s === 0) return false;
      return undefined;
    case "number": {
      const m = String(v ?? "").replace(/[_,\s]/g, "").match(/^(\d+(?:\.\d+)?)([km]?)$/i);
      const n = typeof v === "number" ? v : m ? Number(m[1]) * (m[2].toLowerCase() === "k" ? 1000 : m[2].toLowerCase() === "m" ? 1_000_000 : 1) : NaN;
      return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
    }
    case "text": {
      const t = String(v ?? "").trim();
      return t && t.length <= 200 ? t : undefined;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Store

const row2d = (r: any): Directive => ({ ...r, value: safeJson(r.value, r.value) });

export interface SetBy {
  /** where the order came from ("teams", "dashboard", "cli", "jira", ...) */
  channel: string;
  /** true only for owner channels (policy/untrusted.isOwnerOrder) */
  owner: boolean;
  fromMsg?: number;
}

export type SetResult = { ok: true; directive: Directive; echo: string; replaced?: Directive } | { ok: false; message: string };

/** Resolve a scope id: an item ref (KAN-45) becomes the item id; "global" has none. */
function resolveScopeId(scope: DirectiveScope, scopeId: string | null | undefined): string | null {
  if (scope === "global") return null;
  const ref = String(scopeId ?? "").trim();
  if (!ref) return null;
  const r = db().prepare("SELECT id FROM tasks WHERE id=? OR source_ref=? ORDER BY created_at DESC LIMIT 1").get(ref, ref) as { id: string } | undefined;
  return r?.id ?? ref;
}

/**
 * Store a directive (and replace an older one for the same scope and rule – J6 "change it mid-way").
 * Refused when the order didn't come from you, the rule is unknown, or it would relax a hard rail.
 */
export function setDirective(n: { scope: DirectiveScope; scopeId?: string | null; rule: string; value: unknown; until?: string | null }, by: SetBy): SetResult {
  if (!by.owner) return { ok: false, message: `Only your own messages can change my rules. That came from ${by.channel || "outside"}, so I ignored it.` };
  if (RAIL_WORDS.test(n.rule)) return { ok: false, message: RAIL_REFUSAL };
  if (!isRule(n.rule)) return { ok: false, message: `I don't have a rule called "${n.rule}".` };
  if (!SCOPES.includes(n.scope)) return { ok: false, message: `Unknown scope "${n.scope}".` };
  const value = normaliseValue(n.rule, n.value);
  if (value === undefined) return { ok: false, message: `"${String(n.value)}" isn't a valid value for ${n.rule}.` };
  const scopeId = resolveScopeId(n.scope, n.scopeId);
  if (n.scope !== "global" && !scopeId) return { ok: false, message: `Which ${n.scope} is this for?` };
  const until = n.until ? new Date(n.until) : undefined;
  if (until && Number.isNaN(until.getTime())) return { ok: false, message: `"${n.until}" isn't a date.` };
  return tx(() => {
    const old = activeRow(n.scope, scopeId, n.rule as RuleName);
    if (old) db().prepare("UPDATE directives SET active=0 WHERE id=?").run(old.id);
    const id = newId("dr");
    db().prepare("INSERT INTO directives (id, scope, scope_id, rule, value, from_msg, active, until_at, created_at) VALUES (?,?,?,?,?,?,1,?,?)")
      .run(id, n.scope, scopeId, n.rule, JSON.stringify(value), by.fromMsg ?? null, until ? until.toISOString() : null, nowIso());
    audit(`user:${by.channel}`, "directive.set", scopeId ?? "global", { id, rule: n.rule, value, replaced: old?.id });
    const d = getDirective(id)!;
    return { ok: true as const, directive: d, echo: echoDirective(d), replaced: old };
  });
}

export function getDirective(id: string): Directive | undefined {
  const r = db().prepare("SELECT * FROM directives WHERE id=?").get(id);
  return r ? row2d(r) : undefined;
}

function activeRow(scope: DirectiveScope, scopeId: string | null, rule: RuleName): Directive | undefined {
  const r = db().prepare(`SELECT * FROM directives WHERE active=1 AND scope=? AND rule=? AND ${scopeId === null ? "scope_id IS NULL" : "scope_id=?"}
    AND (until_at IS NULL OR until_at > ?) ORDER BY created_at DESC LIMIT 1`).get(...([scope, rule, ...(scopeId === null ? [] : [scopeId]), nowIso()] as any[]));
  return r ? row2d(r) : undefined;
}

export type ClearResult = { ok: true; cleared: Directive[]; echo: string } | { ok: false; message: string };

/** Clear by directive id, or by scope + rule. The echo says what applies now. */
export function clearDirective(ref: string | { scope: DirectiveScope; scopeId?: string | null; rule: string }, by: SetBy): ClearResult {
  if (!by.owner) return { ok: false, message: `Only your own messages can change my rules. That came from ${by.channel || "outside"}, so I ignored it.` };
  let rows: Directive[];
  if (typeof ref === "string") {
    const d = getDirective(ref);
    rows = d && d.active ? [d] : [];
  } else {
    const scopeId = resolveScopeId(ref.scope, ref.scopeId);
    rows = (db().prepare(`SELECT * FROM directives WHERE active=1 AND scope=? AND rule=? AND ${scopeId === null ? "scope_id IS NULL" : "scope_id=?"}`)
      .all(...([ref.scope, ref.rule, ...(scopeId === null ? [] : [scopeId])] as any[])) as any[]).map(row2d);
  }
  if (!rows.length) return { ok: false, message: "There's no such rule in force." };
  for (const d of rows) db().prepare("UPDATE directives SET active=0 WHERE id=?").run(d.id);
  audit(`user:${by.channel}`, "directive.cleared", rows[0].scope_id ?? "global", { ids: rows.map((d) => d.id) });
  return { ok: true, cleared: rows, echo: echoCleared(rows[0]) };
}

/** Directives in force, optionally for one scope (and scope id). Expired ones (until_at passed) are left out. */
export function activeDirectives(scope?: DirectiveScope, scopeId?: string | null): Directive[] {
  const where = ["active=1", "(until_at IS NULL OR until_at > ?)"];
  const args: any[] = [nowIso()];
  if (scope) { where.push("scope=?"); args.push(scope); }
  if (scope && scope !== "global" && scopeId != null) { where.push("scope_id=?"); args.push(resolveScopeId(scope, scopeId)); }
  return (db().prepare(`SELECT * FROM directives WHERE ${where.join(" AND ")} ORDER BY created_at`).all(...args) as any[]).map(row2d);
}

// ---------------------------------------------------------------------------------------------
// Effective value

interface Node { id: string; level: string; parent_id: string | null; source_ref: string | null; title: string | null; project_id: string; size: string | null; owner: string | null; data: Record<string, any> }

const CONTAINER: Record<string, DirectiveScope> = { batch: "batch", epic: "epic", sprint: "sprint" };

function node(id: string): Node | undefined {
  const r = db().prepare("SELECT id, level, parent_id, source_ref, title, project_id, size, owner, data FROM tasks WHERE id=? OR source_ref=? ORDER BY created_at DESC LIMIT 1").get(id, id) as any;
  return r ? { ...r, level: r.level ?? "ticket", data: safeJson(r.data, {}) } : undefined;
}

/** The item and its ancestors, nearest first (cycle-safe). */
export function chainOf(itemOrId: string | { id: string }): Node[] {
  const out: Node[] = [];
  const seen = new Set<string>();
  let cur = node(typeof itemOrId === "string" ? itemOrId : itemOrId.id);
  while (cur && !seen.has(cur.id) && out.length < 20) {
    out.push(cur); seen.add(cur.id);
    cur = cur.parent_id ? node(cur.parent_id) : undefined;
  }
  return out;
}

/** (scope, scope id) pairs to look at, highest precedence first: item > batch > epic > sprint > global. */
export function precedenceOf(chain: Node[]): { scope: DirectiveScope; id: string | null }[] {
  const list: { scope: DirectiveScope; id: string | null }[] = [];
  // item: the item itself and any non-container parent (a part inherits its ticket's rules), nearest first
  for (const n of chain) {
    if (!(!CONTAINER[n.level] || n === chain[0])) continue;
    list.push({ scope: "item", id: n.id });
    // a rule given before the item existed is stored under its key (KAN-60); a repo part "KAN-60@web" inherits it
    const key = n.source_ref?.split("@")[0];
    if (key && key !== n.id) list.push({ scope: "item", id: key });
  }
  for (const s of ["batch", "epic", "sprint"] as const) for (const n of chain) if (n.level === s) list.push({ scope: s, id: n.id });
  list.push({ scope: "global", id: null });
  return list;
}

export interface Effective {
  rule: RuleName;
  value: DirectiveValue | undefined;
  /** where the value came from */
  source: "directive" | "item-data" | "settings" | "none";
  scope?: DirectiveScope;
  directive?: Directive;
}

/**
 * The value of a rule for an item: item > batch > epic > sprint > global directive, then the item's own
 * data.directives (older v1 shape), then settings. `item` may be undefined (global / settings only).
 */
export function effective(item: string | { id: string } | undefined | null, rule: RuleName, opts: { settings?: Settings; project?: ProjectConfig } = {}): Effective {
  const chain = item ? chainOf(item) : [];
  const now = nowIso();
  for (const p of precedenceOf(chain)) {
    const r = db().prepare(`SELECT * FROM directives WHERE active=1 AND rule=? AND scope=? AND ${p.id === null ? "scope_id IS NULL" : "scope_id=?"}
      AND (until_at IS NULL OR until_at > ?) ORDER BY created_at DESC LIMIT 1`).get(...([rule, p.scope, ...(p.id === null ? [] : [p.id]), now] as any[]));
    if (r) { const d = row2d(r); return { rule, value: d.value, source: "directive", scope: p.scope, directive: d }; }
  }
  const legacy = chain[0]?.data?.directives?.[rule];
  if (legacy !== undefined) {
    const v = normaliseValue(rule, legacy);
    if (v !== undefined) return { rule, value: v, source: "item-data", scope: "item" };
  }
  const spec: RuleSpec = RULES[rule];
  if (spec.fromSettings) {
    const s = opts.settings ?? loadSettings();
    const p = opts.project ?? (chain[0] ? loadProjects().find((x) => x.id === chain[0].project_id) : undefined);
    const v = spec.fromSettings(s, p);
    if (v !== undefined) return { rule, value: v, source: "settings" };
  }
  return { rule, value: undefined, source: "none" };
}

/** Every rule set by a directive for this item (what the intake attaches, W4 step 3). */
export function directivesInForce(item: string | { id: string }): Effective[] {
  return RULE_NAMES.map((r) => effective(item, r, { settings: loadSettings() })).filter((e) => e.source === "directive" || e.source === "item-data");
}

/** One plain line per directive in force, for prompts and `aiw explain`. Empty when none. */
export function describeInForce(item: string | { id: string }): string {
  return directivesInForce(item).map((e) => `- ${(RULES[e.rule] as RuleSpec).phrase(e.value)}${e.directive ? ` (${scopeLabel(e.directive.scope, e.directive.scope_id)})` : ""}`).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Echo

/** "KAN-45", "batch KAN-45, KAN-47", "epic KAN-40", "sprint 12"; "" for global. */
export function scopeLabel(scope: DirectiveScope, scopeId: string | null): string {
  if (scope === "global" || !scopeId) return "";
  const n = node(scopeId);
  const ref = n?.source_ref ? n.source_ref.split("@")[0] : undefined;
  const name = ref ?? n?.title ?? scopeId;
  return scope === "item" ? name : `${scope} ${name}`;
}

function dateWords(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "From now on for KAN-45: no plan approval." / "From now on: no plan approval." */
export function echoDirective(d: Pick<Directive, "scope" | "scope_id" | "rule" | "value" | "until_at">): string {
  const label = scopeLabel(d.scope, d.scope_id);
  const phrase = (RULES[d.rule] as RuleSpec).phrase(d.value);
  return `From now on${label ? ` for ${label}` : ""}: ${phrase}${d.until_at ? ` (until ${dateWords(d.until_at)})` : ""}.`;
}

/** After clearing: what applies now, e.g. "Back to normal for KAN-45: ask before the plan." */
export function echoCleared(d: Pick<Directive, "scope" | "scope_id" | "rule">): string {
  const label = scopeLabel(d.scope, d.scope_id);
  const now = effective(d.scope !== "global" && d.scope_id ? d.scope_id : undefined, d.rule);
  const what = now.value === undefined ? `no ${d.rule.replace(/_/g, " ")} rule` : (RULES[d.rule] as RuleSpec).phrase(now.value);
  return `Back to normal${label ? ` for ${label}` : ""}: ${what}.`;
}
