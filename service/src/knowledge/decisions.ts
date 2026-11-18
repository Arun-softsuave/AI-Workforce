import { db } from "../core/db.js";
import { newId, nowIso, safeJson, sha256 } from "../core/util.js";
import { chainOf, precedenceOf, type DirectiveScope } from "../policy/directives.js";

/**
 * The decision log (W11 step 1, O4): every question that was answered – by you, by the knowledge agent with
 * evidence, or decided by an agent after "you decide" – is stored once with its scope. The same question in the
 * same scope or a parent scope (item > batch > epic > sprint > global) is never asked again.
 *
 * Matching is exact on a normalised key (lower case, no punctuation, no filler words, word order kept).
 * There is no similarity matching on purpose (§9.1 "rejected": a question that only looks similar can get a wrong answer).
 */

export type DecisionScope = DirectiveScope;
export const DECISION_SCOPES: readonly DecisionScope[] = ["item", "batch", "epic", "sprint", "global"];

/** Who settled it. "user" = your typed answer; "delegated" = you said "you decide"; "knowledge" = the ask-desk with evidence. */
export type DecisionSource = "user" | "delegated" | "knowledge" | "assumed" | "agent";
export type Confidence = "high" | "medium" | "low";

export interface Evidence { source: string; ref?: string; quote?: string }

export interface Decision {
  id: string;
  scope: DecisionScope;
  scope_id: string | null;
  question_key: string;
  question: string;
  answer: string;
  source: DecisionSource | string;
  confidence: Confidence | null;
  evidence: Evidence[];
  created_at: string;
}

const FILLER = new Set(
  ("a an the is are was were be been do does did should would could can will we i you it its this that these those " +
    "to of in on for with please which what whether or and").split(" "),
);

/** Normalised question → key. "Should the chip be BLUE?" and "should the chip be blue" give the same key. */
export function questionKey(question: string): string {
  const words = String(question ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_\s-]/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w));
  const norm = words.join(" ");
  return norm ? sha256(norm).slice(0, 24) : "";
}

const row2d = (r: any): Decision => ({ ...r, evidence: safeJson<Evidence[]>(r.evidence, []) });

export interface NewDecision {
  scope: DecisionScope;
  scopeId?: string | null;
  question: string;
  answer: string;
  source: DecisionSource | string;
  confidence?: Confidence;
  evidence?: Evidence[];
}

/** Stores a decision. A newer answer to the same question in the same scope replaces the older one. */
export function recordDecision(n: NewDecision): Decision {
  if (!DECISION_SCOPES.includes(n.scope)) throw new Error(`Unknown decision scope: ${n.scope}`);
  const key = questionKey(n.question);
  if (!key) throw new Error("Empty question");
  if (!String(n.answer ?? "").trim()) throw new Error("Empty answer");
  const scopeId = n.scope === "global" ? null : (n.scopeId ?? null);
  if (n.scope !== "global" && !scopeId) throw new Error(`A ${n.scope} decision needs a scope id`);
  const d = db();
  d.prepare(`DELETE FROM decisions WHERE question_key=? AND scope=? AND ${scopeId === null ? "scope_id IS NULL" : "scope_id=?"}`)
    .run(...([key, n.scope, ...(scopeId === null ? [] : [scopeId])] as any[]));
  const rec = {
    id: newId("dec"), scope: n.scope, scope_id: scopeId, question_key: key, question: n.question.trim(), answer: n.answer.trim(),
    source: n.source, confidence: n.confidence ?? null, evidence: JSON.stringify(n.evidence ?? []), created_at: nowIso(),
  };
  d.prepare(`INSERT INTO decisions (id, scope, scope_id, question_key, question, answer, source, confidence, evidence, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(rec.id, rec.scope, rec.scope_id, rec.question_key, rec.question, rec.answer, rec.source, rec.confidence, rec.evidence, rec.created_at);
  return row2d(rec);
}

/** The scopes an item sees, nearest first: the item (and its ticket for a part), batch, epic, sprint, global. */
export function scopesOf(itemId: string | undefined | null): { scope: DecisionScope; id: string | null }[] {
  return precedenceOf(itemId ? chainOf(itemId) : []);
}

/** The id to store a decision under: the nearest ancestor at that level (the item itself for "item"). */
export function scopeIdFor(itemId: string, scope: DecisionScope): string | null | undefined {
  if (scope === "global") return null;
  return scopesOf(itemId).find((s) => s.scope === scope)?.id ?? undefined;
}

/** The answer already given for this question in the item's scope or a parent scope (nearest wins). */
export function findDecision(itemId: string | undefined | null, question: string): Decision | undefined {
  const key = questionKey(question);
  if (!key) return undefined;
  for (const s of scopesOf(itemId)) {
    const r = db().prepare(`SELECT * FROM decisions WHERE question_key=? AND scope=? AND ${s.id === null ? "scope_id IS NULL" : "scope_id=?"}
      ORDER BY created_at DESC LIMIT 1`).get(...([key, s.scope, ...(s.id === null ? [] : [s.id])] as any[]));
    if (r) return row2d(r);
  }
  // O4: the same question in other words ("Show cancelled orders?" / "Should cancelled orders be shown in the list?") –
  // most of its meaningful words in common with an answered one in the same scopes (no model call)
  const mine = keyWords(question);
  if (mine.size < 2) return undefined;
  for (const s of scopesOf(itemId)) {
    const rows = db().prepare(`SELECT * FROM decisions WHERE scope=? AND ${s.id === null ? "scope_id IS NULL" : "scope_id=?"} ORDER BY created_at DESC LIMIT 200`)
      .all(...([s.scope, ...(s.id === null ? [] : [s.id])] as any[])) as any[];
    let best: { r: any; score: number } | undefined;
    for (const r of rows) {
      const theirs = keyWords(r.question);
      const common = [...mine].filter((w) => theirs.has(w)).length;
      const score = common / Math.max(mine.size, theirs.size);
      if (common >= 2 && score >= 0.6 && (!best || score > best.score)) best = { r, score };
    }
    if (best) return row2d(best.r);
  }
  return undefined;
}

/** The meaningful words of a question, roughly stemmed ("orders" → "order", "shown" → "show"). */
function keyWords(q: string): Set<string> {
  const stop = new Set([...FILLER, "should", "would", "shall", "be", "being", "show", "list", "page", "screen", "use", "how", "when", "where", "who", "why", "yes", "no"]);
  return new Set(String(q ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w)).map((w) => w.replace(/(ing|ed|es|s|n)$/, "")).filter((w) => w.length > 2));
}

/** Every decision in force for an item (nearest scope first; a nearer answer hides the same question further out). */
export function decisionsFor(itemId: string | undefined | null): Decision[] {
  const seen = new Set<string>();
  const out: Decision[] = [];
  for (const s of scopesOf(itemId)) {
    const rows = db().prepare(`SELECT * FROM decisions WHERE scope=? AND ${s.id === null ? "scope_id IS NULL" : "scope_id=?"} ORDER BY created_at`)
      .all(...([s.scope, ...(s.id === null ? [] : [s.id])] as any[])) as any[];
    for (const r of rows) if (!seen.has(r.question_key)) { seen.add(r.question_key); out.push(row2d(r)); }
  }
  return out;
}

/** Medium-confidence answers the plan and PR must list as assumptions. */
export function assumptionsFor(itemId: string): Decision[] {
  return decisionsFor(itemId).filter((d) => d.confidence === "medium" || d.source === "assumed");
}

export function deleteDecision(id: string): boolean {
  return Number(db().prepare("DELETE FROM decisions WHERE id=?").run(id).changes) > 0;
}

/** Short block for prompts and `aiw explain`: one line per decision, with where it came from. */
export function decisionsBlock(itemId: string, max = 30): string {
  const list = decisionsFor(itemId).slice(0, max);
  if (!list.length) return "";
  const by = (d: Decision) => d.source === "user" ? "you" : d.source === "delegated" ? "decided for you" : d.source === "assumed" ? "assumed" : d.source;
  return list.map((d) => `- ${d.question} → ${d.answer} (${by(d)}${d.scope !== "item" ? `, ${d.scope}` : ""}${d.confidence === "medium" ? ", assumption" : ""})`).join("\n");
}
