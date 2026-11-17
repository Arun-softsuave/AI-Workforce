import fs from "node:fs";
import path from "node:path";
import { paths, ensureDir } from "../core/paths.js";
import { newId } from "../core/util.js";

/**
 * The Handbook: human-readable markdown in <repo>/.ai-workforce/knowledge/.
 * Each fact is a bullet with an HTML-comment tag holding its lifecycle metadata, so the file
 * renders cleanly on GitHub while the Brain can track source, status and validity dates.
 *   - Refunds use the Stripe API. <!-- aiw:{"id":"f_1a2b","source":"PR #88","status":"verified","since":"2026-03-02"} -->
 * Facts are never deleted: a replaced fact is struck through and gets an "until" date.
 */
export const HANDBOOK_FILES = ["overview", "architecture", "standards", "decisions", "glossary"] as const;
export type HandbookFile = (typeof HANDBOOK_FILES)[number];
export type FactStatus = "unverified" | "verified" | "replaced" | "disputed";

export interface Fact { id: string; file: HandbookFile; text: string; source: string; status: FactStatus; since: string; until?: string; replacedBy?: string }
export interface HandbookDoc { file: HandbookFile; narrative: string; facts: Fact[] }

const TITLES: Record<HandbookFile, string> = {
  overview: "Project overview", architecture: "Architecture", standards: "Coding standards & team rules",
  decisions: "Decisions log", glossary: "Business glossary",
};
const TAG = /<!--\s*aiw:(\{.*?\})\s*-->/;
const today = () => new Date().toISOString().slice(0, 10);

function filePath(repo: string, f: HandbookFile) { return path.join(paths.knowledgeDir(repo), `${f}.md`); }

export function readDoc(repo: string, file: HandbookFile): HandbookDoc {
  let raw = "";
  try { raw = fs.readFileSync(filePath(repo, file), "utf8"); } catch { return { file, narrative: "", facts: [] }; }
  const [narrativePart, factsPart = ""] = raw.split(/^## Facts\s*$/m);
  const narrative = narrativePart.replace(/^# .*\n/, "").replace(/^> .*\n/m, "").trim();
  const facts: Fact[] = [];
  for (const line of factsPart.split("\n")) {
    const m = TAG.exec(line);
    if (!m || !line.trim().startsWith("-")) continue;
    let meta: any = {};
    try { meta = JSON.parse(m[1]); } catch { continue; }
    const text = line.replace(TAG, "").replace(/^\s*-\s*/, "").replace(/\s*\*\((unverified|disputed[^)]*)\)\*\s*$/, "").trim().replace(/^~~|~~$/g, "").trim();
    facts.push({ id: meta.id, file, text, source: meta.source ?? "", status: meta.status ?? "unverified", since: meta.since ?? "", until: meta.until, replacedBy: meta.replacedBy });
  }
  return { file, narrative, facts };
}

export function writeDoc(repo: string, doc: HandbookDoc): void {
  ensureDir(paths.knowledgeDir(repo));
  const lines = [`# ${TITLES[doc.file]}`, "", "> Maintained by AI Workforce and reviewed by the team. Facts marked *unverified* await human confirmation.", "",
    doc.narrative.trim(), "", "## Facts", ""];
  for (const f of doc.facts) {
    const meta: any = { id: f.id, source: f.source, status: f.status, since: f.since };
    if (f.until) meta.until = f.until;
    if (f.replacedBy) meta.replacedBy = f.replacedBy;
    const text = f.status === "replaced" ? `~~${f.text}~~` : f.text;
    const badge = f.status === "unverified" ? " *(unverified)*" : f.status === "disputed" ? " *(disputed – needs review)*" : "";
    lines.push(`- ${text}${badge} <!-- aiw:${JSON.stringify(meta)} -->`);
  }
  fs.writeFileSync(filePath(repo, doc.file), lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n");
}

export function readHandbook(repo: string): HandbookDoc[] {
  return HANDBOOK_FILES.map((f) => readDoc(repo, f));
}

export function setNarrative(repo: string, file: HandbookFile, narrative: string): void {
  const doc = readDoc(repo, file);
  doc.narrative = narrative;
  writeDoc(repo, doc);
}

const norm = (s: string) => s.toLowerCase().replace(/\s*\*\((unverified|disputed[^)]*)\)\*\s*/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Add a fact unless an equivalent active fact already exists. Returns the fact (new or existing). */
export function addFact(repo: string, file: HandbookFile, text: string, source: string, status: FactStatus = "unverified"): Fact {
  const doc = readDoc(repo, file);
  const existing = doc.facts.find((f) => f.status !== "replaced" && norm(f.text) === norm(text));
  if (existing) return existing;
  const fact: Fact = { id: newId("f"), file, text: text.trim().replace(/\s+/g, " "), source, status, since: today() };
  doc.facts.push(fact);
  writeDoc(repo, doc);
  return fact;
}

/** Mark an old fact replaced (kept for history) and add its successor. */
export function replaceFact(repo: string, factId: string, newText: string, source: string): Fact | undefined {
  for (const file of HANDBOOK_FILES) {
    const doc = readDoc(repo, file);
    const old = doc.facts.find((f) => f.id === factId);
    if (!old) continue;
    const next: Fact = { id: newId("f"), file, text: newText, source, status: "unverified", since: today() };
    old.status = "replaced"; old.until = today(); old.replacedBy = next.id;
    doc.facts.push(next);
    writeDoc(repo, doc);
    return next;
  }
  return undefined;
}

export function setFactStatus(repo: string, ids: string[] | "all-unverified", status: FactStatus): number {
  let n = 0;
  for (const file of HANDBOOK_FILES) {
    const doc = readDoc(repo, file);
    let changed = false;
    for (const f of doc.facts) {
      if ((ids === "all-unverified" && f.status === "unverified") || (Array.isArray(ids) && ids.includes(f.id))) { f.status = status; changed = true; n++; }
    }
    if (changed) writeDoc(repo, doc);
  }
  return n;
}

export function activeFacts(repo: string): Fact[] {
  return readHandbook(repo).flatMap((d) => d.facts.filter((f) => f.status !== "replaced"));
}

/** Copy the Handbook from the user's repo into a task worktree so proposed changes travel in the PR. */
export function syncHandbookInto(fromRepo: string, toWorktree: string): void {
  const src = paths.knowledgeDir(fromRepo);
  if (!fs.existsSync(src) || path.resolve(fromRepo) === path.resolve(toWorktree)) return;
  const dst = ensureDir(paths.knowledgeDir(toWorktree));
  for (const f of fs.readdirSync(src)) {
    const target = path.join(dst, f);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(src, f), target);
  }
}
