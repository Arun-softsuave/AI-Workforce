/**
 * W5a – the elephant side: write the item's design document from what `understand` / `analyse` / `plan` / `contract`
 * produced, and read it back for the later steps. Code only, no model calls.
 *
 * The document (knowledge/designDoc.ts) is the source of truth: plan_review, implement_test, reviews and the
 * integration check start from it (plus their own step input), and the plan message is its short summary.
 * Every writer here is idempotent: writing the same output twice records no new version.
 */
import type { DatabaseSync } from "node:sqlite";
import { db } from "../../core/db.js";
import * as DD from "../../knowledge/designDoc.js";
import { untrusted } from "../../agents/runner.js";

type ItemLike = { id: string; source_ref?: string | null; title?: string | null; data?: Record<string, any> };

const asList = (x: unknown): string[] =>
  (Array.isArray(x) ? x : []).map((v) => (typeof v === "string" ? v : v && typeof v === "object" ? describe(v as any) : String(v ?? ""))).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const describe = (o: Record<string, any>): string => o.question ?? o.description ?? o.text ?? o.name ?? JSON.stringify(o);
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
const idOf = (item: ItemLike | string) => (typeof item === "string" ? item : item.id);

function titleOf(item: ItemLike): string {
  const t = item.data?.ticket;
  const ref = t?.key ?? item.source_ref ?? item.id;
  const title = t?.title ?? item.title ?? "";
  return title ? `${ref}: ${title}` : `Design: ${ref}`;
}

/** Creates the document for an item (title from the ticket) if it does not exist yet. */
export function ensureDoc(item: ItemLike, d: DatabaseSync = db()): DD.DesignDoc {
  return DD.readDoc(item.id, d) ?? DD.createDoc(item.id, { title: titleOf(item) }, d);
}

/** Writes one section only when there is something to write (an empty agent field never wipes a filled section). */
function put(itemId: string, section: DD.Section, text: string, reason: string, d: DatabaseSync): boolean {
  if (!text.trim()) return false;
  return DD.updateSection(itemId, section, text, reason, d).changed;
}

// ------------------------------------------------------------------ understand

/** Explorer findings (one repo or several) as "file:line – why" lines. */
export function findingsLines(findings: any): string[] {
  if (!findings) return [];
  const repos: any[] = Array.isArray(findings.repos) ? findings.repos : [];
  const many = repos.length > 1;
  const out: string[] = [];
  if (findings.summary) out.push(String(findings.summary));
  for (const r of repos) {
    for (const x of r.relevant ?? []) {
      const loc = `\`${many ? `${r.repo}:` : ""}${x.file}${x.line ? `:${x.line}` : ""}\``;
      out.push(`${loc}${x.symbol ? ` (${x.symbol})` : ""}${x.why ? ` – ${x.why}` : ""}`);
    }
    for (const e of r.existing ?? []) out.push(`${many ? `${r.repo}: ` : ""}exists: ${e}`);
    for (const m of r.missing ?? []) out.push(`${many ? `${r.repo}: ` : ""}missing: ${m}`);
  }
  return out;
}

/**
 * Problem and goal, acceptance criteria and "how the system works today" from the understand step
 * (analyst requirements, the lead's understanding, the explorer's findings or a code note).
 */
export function writeUnderstanding(item: ItemLike, out: { requirements?: any; understanding?: any; findings?: any; codeNote?: string } = {}, d: DatabaseSync = db()): { version: number; changed: boolean } {
  ensureDoc(item, d);
  const req = out.requirements ?? item.data?.requirements ?? {};
  const und = out.understanding ?? item.data?.understanding ?? {};
  const findings = out.findings ?? item.data?.findings;
  const goal = [und.summary, ...asList(und.requirements ?? req.requirements)].filter(Boolean);
  const criteria = asList(und.acceptanceCriteria ?? req.acceptanceCriteria);
  const today = [out.codeNote ?? item.data?.codeNote?.text ?? "", bullets(findingsLines(findings))].filter((x) => x && x.trim()).join("\n");
  let changed = false;
  changed = put(item.id, "Problem and goal", goal.length > 1 ? `${goal[0]}\n${bullets(goal.slice(1))}` : goal[0] ?? "", "understand", d) || changed;
  changed = put(item.id, "Acceptance criteria", bullets(criteria), "understand", d) || changed;
  changed = put(item.id, "How the system works today", today, "understand: code note", d) || changed;
  // questions the analyst left open are listed in the document until answered
  for (const q of asList(req.openQuestions ?? und.questions)) changed = DD.addOpenQuestion(item.id, q, d).changed || changed;
  return { version: DD.readDoc(item.id, d)!.version, changed };
}

// ------------------------------------------------------------------ plan

/** Approach, alternatives, files and tests from the planner (one repo) or the lead planner (parts). */
export function writePlan(item: ItemLike, plan: any = item.data?.plan, d: DatabaseSync = db()): { version: number; changed: boolean } {
  ensureDoc(item, d);
  if (!plan) return { version: DD.readDoc(item.id, d)!.version, changed: false };
  const parts: any[] = Array.isArray(plan.parts) ? plan.parts : [];
  const approach: string[] = [];
  if (plan.summary) approach.push(String(plan.summary));
  if (parts.length) for (const p of parts) approach.push(`**${p.repo}**: ${p.summary ?? ""}${(p.steps ?? []).length ? `\n${(p.steps as string[]).map((s, i) => `  ${i + 1}. ${s}`).join("\n")}` : ""}`);
  else if ((plan.steps ?? []).length) approach.push((plan.steps as string[]).map((s, i) => `${i + 1}. ${s}`).join("\n"));
  const risks = asList(plan.risks);
  if (risks.length) approach.push(`Risks:\n${bullets(risks)}`);
  const files = parts.length ? parts.flatMap((p) => asList(p.files).map((f) => `${p.repo}:${f}`)) : asList(plan.files);
  const tests = parts.length ? parts.flatMap((p) => asList(p.tests).map((t) => `${p.repo}: ${t}`)) : asList(plan.tests);
  const alternatives = asList(plan.alternatives ?? plan.rejected);
  let changed = false;
  changed = put(item.id, "Approach", approach.join("\n\n"), "plan", d) || changed;
  changed = put(item.id, "Alternatives rejected", bullets(alternatives), "plan", d) || changed;
  changed = put(item.id, "Files to change and why", bullets(files.map(fileLine)), "plan", d) || changed;
  changed = put(item.id, "Tests", bullets(tests), "plan", d) || changed;
  // the planner's own assumptions for unanswered questions are decisions it made
  for (const a of asList(item.data?.assumptions)) changed = DD.addOpenQuestion(item.id, a, d).changed || changed;
  return { version: DD.readDoc(item.id, d)!.version, changed };
}

/** "src/a.ts – why" keeps its why; a bare path gets backticks so goldfish checks find it. */
function fileLine(f: string): string {
  if (/`/.test(f)) return f;
  const m = /^((?:[\w.@-]+:)?[\w./@-]+\.[A-Za-z0-9]+(?::\d+)?)(.*)$/.exec(f.trim());
  return m ? `\`${m[1]}\`${m[2]}` : f;
}

// ------------------------------------------------------------------ contract

/** A two-repo contract as document text (same facts as steps.ts contractText, without importing the engine). */
export function contractDocText(c: any): string {
  if (!c) return "";
  if (typeof c === "string") return c;
  const items = (c.items ?? []).map((i: any) => `- [${i.kind ?? "item"}] ${i.name} – ${i.producer || "?"} → ${i.consumer || "?"}: ${i.details ?? ""}`.trim());
  const errors = (c.errors ?? []).map((e: string) => `- ${e}`);
  const notes = (c.notes ?? []).map((n: string) => `- ${n}`);
  const changes = (c.changes ?? []).map((x: any) => `- (agreed later, asked by ${x.from ?? "?"}) ${x.change ?? ""}`);
  return [c.summary ?? "", items.join("\n"), errors.length ? `Errors / empty cases:\n${errors.join("\n")}` : "", notes.length ? `Notes:\n${notes.join("\n")}` : "", changes.length ? `Changes agreed while building:\n${changes.join("\n")}` : ""]
    .filter(Boolean).join("\n");
}

export function writeContract(item: ItemLike, contract: any = item.data?.contract, reason = "contract", d: DatabaseSync = db()): { version: number; changed: boolean } {
  ensureDoc(item, d);
  const text = contractDocText(contract);
  if (!text.trim()) return { version: DD.readDoc(item.id, d)!.version, changed: false };
  return DD.updateSection(item.id, "Contract", text, reason, d);
}

// ------------------------------------------------------------------ whole item

/** Brings the document up to date with everything the item already has (used before a goldfish check or after a restart). */
export function syncDocFromItem(item: ItemLike, d: DatabaseSync = db()): DD.DesignDoc {
  ensureDoc(item, d);
  const data = item.data ?? {};
  if (data.requirements || data.understanding || data.findings || data.codeNote) writeUnderstanding(item, {}, d);
  if (data.plan) writePlan(item, data.plan, d);
  if (data.contract) writeContract(item, data.contract, "contract", d);
  return DD.readDoc(item.id, d)!;
}

/**
 * The document as an agent input block for a later step (plan_review, implement_test, reviews, integration_check):
 * only the sections that role needs, fenced as data. Empty string when there is no document.
 */
export function docBlock(item: ItemLike | string, role: string, d: DatabaseSync = db()): string {
  const id = idOf(item);
  const text = DD.sectionsFor(id, role, d);
  if (!text.trim()) return "";
  const v = DD.readDoc(id, d)?.version ?? 0;
  return `## Design document (v${v}) – the source of truth for this work\n${untrusted(`design-doc:${id}`, text)}`;
}

/** The plan message body for Teams: the document's ≤ 10-line summary (falls back to "" when there is no document). */
export function planSummary(item: ItemLike | string, d: DatabaseSync = db()): string {
  const id = idOf(item);
  return DD.readDoc(id, d) ? DD.summary(id, d) : "";
}
