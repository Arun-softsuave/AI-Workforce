import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { db } from "../core/db.js";
import { aiwHome, ensureDir } from "../core/paths.js";
import { nowIso, sha256 } from "../core/util.js";

/**
 * W5a (5.12a): one design document per item, the single source of truth (elephant–goldfish method).
 * Lives at <AIW_HOME>/items/<itemId>/design.md, outside the repo, never pushed. Every change is versioned in `docs`.
 * Every correction goes into this document, never only into a chat.
 */

export const SECTIONS = [
  "Problem and goal",
  "Acceptance criteria",
  "How the system works today",
  "Approach",
  "Alternatives rejected",
  "Files to change and why",
  "Contract",
  "Decisions",
  "Tests",
  "Inputs from you",
  "Open questions",
] as const;
export type Section = typeof SECTIONS[number];

/** Short names accepted wherever a section is named (agents and commands use these). */
const ALIASES: Record<string, Section> = {
  problem: "Problem and goal", goal: "Problem and goal",
  acceptance: "Acceptance criteria", criteria: "Acceptance criteria", ac: "Acceptance criteria",
  today: "How the system works today", current: "How the system works today", "code note": "How the system works today",
  approach: "Approach",
  alternatives: "Alternatives rejected",
  files: "Files to change and why",
  contract: "Contract",
  decisions: "Decisions",
  tests: "Tests",
  inputs: "Inputs from you",
  questions: "Open questions", open: "Open questions",
};

const EMPTY = "_Not filled yet._";

export function sectionName(s: string): Section {
  const k = s.trim().toLowerCase().replace(/^#+\s*/, "");
  const exact = SECTIONS.find((x) => x.toLowerCase() === k);
  if (exact) return exact;
  if (ALIASES[k]) return ALIASES[k];
  throw new Error(`Unknown design document section: ${s}`);
}

export interface DesignDoc {
  itemId: string;
  path: string;
  title: string;
  sections: Record<Section, string>;   // body text, "" when not filled
  version: number;
  text: string;
}

function safeItemId(itemId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,120}$/.test(itemId) || itemId.includes("..")) throw new Error(`Invalid item id: ${itemId}`);
  return itemId;
}

export function docPath(itemId: string): string {
  return path.join(aiwHome(), "items", safeItemId(itemId), "design.md");
}

// ------------------------------------------------------------------ parse and render

function emptySections(): Record<Section, string> {
  return Object.fromEntries(SECTIONS.map((s) => [s, ""])) as Record<Section, string>;
}

export function parseDoc(text: string): { title: string; sections: Record<Section, string> } {
  const sections = emptySections();
  let title = "";
  let cur: Section | null = null;
  const buf: Record<string, string[]> = {};
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1 && !title && cur === null) { title = h1[1].trim(); continue; }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      const name = SECTIONS.find((s) => s.toLowerCase() === h2[1].trim().toLowerCase());
      if (name) { cur = name; buf[cur] = []; continue; }
    }
    if (cur) buf[cur].push(line);
  }
  for (const s of SECTIONS) {
    const body = (buf[s] ?? []).join("\n").trim();
    sections[s] = body === EMPTY ? "" : body;
  }
  return { title, sections };
}

export function renderDoc(title: string, sections: Record<Section, string>, only: readonly Section[] = SECTIONS): string {
  const parts = [`# ${title}`];
  for (const s of only) parts.push(`## ${s}\n\n${sections[s]?.trim() || EMPTY}`);
  return parts.join("\n\n") + "\n";
}

const BULLET = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/;
const bullets = (body: string): string[] => body.split("\n").map((l) => BULLET.exec(l)?.[1]).filter((x): x is string => !!x);

// ------------------------------------------------------------------ storage

function latestVersion(itemId: string, d: DatabaseSync): { version: number; sha: string } | undefined {
  return d.prepare("SELECT version, sha FROM docs WHERE item_id=? ORDER BY version DESC LIMIT 1").get(itemId) as { version: number; sha: string } | undefined;
}

/** Writes the file and records a new version when the text changed. Returns the version now current. */
function save(itemId: string, title: string, sections: Record<Section, string>, reason: string, d: DatabaseSync): { version: number; changed: boolean } {
  const file = docPath(itemId);
  const text = renderDoc(title, sections);
  const sha = sha256(text);
  const last = latestVersion(itemId, d);
  if (last && last.sha === sha && fs.existsSync(file)) return { version: last.version, changed: false };
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
  const version = (last?.version ?? 0) + 1;
  d.prepare("INSERT INTO docs (item_id, version, path, sha, reason, open_questions, readiness, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(itemId, version, file, sha, reason, bullets(sections["Open questions"]).length, null, nowIso());
  return { version, changed: true };
}

/** Creates the document with the fixed sections. If it already exists, it is returned unchanged. */
export function createDoc(itemId: string, init: { title?: string; sections?: Partial<Record<Section, string>> | Record<string, string> } = {}, d: DatabaseSync = db()): DesignDoc {
  const existing = readDoc(itemId, d);
  if (existing) return existing;
  const sections = emptySections();
  for (const [k, v] of Object.entries(init.sections ?? {})) sections[sectionName(k)] = (v ?? "").trim();
  save(itemId, init.title?.trim() || `Design: ${itemId}`, sections, "created", d);
  return readDoc(itemId, d)!;
}

export function readDoc(itemId: string, d: DatabaseSync = db()): DesignDoc | undefined {
  const file = docPath(itemId);
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  const { title, sections } = parseDoc(text);
  return { itemId, path: file, title, sections, version: latestVersion(itemId, d)?.version ?? 0, text };
}

function load(itemId: string, d: DatabaseSync): DesignDoc {
  return readDoc(itemId, d) ?? createDoc(itemId, {}, d);
}

/** Replaces one section and records why. Creates the document first if needed. */
export function updateSection(itemId: string, section: Section | string, text: string, reason: string, d: DatabaseSync = db()): { version: number; changed: boolean } {
  const s = sectionName(section);
  const doc = load(itemId, d);
  doc.sections[s] = (text ?? "").trim();
  return save(itemId, doc.title, doc.sections, reason || `updated ${s.toLowerCase()}`, d);
}

function appendLine(itemId: string, s: Section, line: string, reason: string, d: DatabaseSync, edit?: (doc: DesignDoc) => void) {
  const doc = load(itemId, d);
  edit?.(doc);
  const body = doc.sections[s].trim();
  doc.sections[s] = body ? `${body}\n- ${line}` : `- ${line}`;
  return save(itemId, doc.title, doc.sections, reason, d);
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const norm = (s: string) => oneLine(s).toLowerCase().replace(/[?.!\s]+$/, "");

/** Records question → answer → who decided. A matching open question is removed. */
export function addDecision(itemId: string, q: string, a: string, by: string, d: DatabaseSync = db()): { version: number; changed: boolean } {
  return appendLine(itemId, "Decisions", `${oneLine(q)} → ${oneLine(a)} (${oneLine(by) || "unknown"})`, `decision by ${oneLine(by) || "unknown"}`, d, (doc) => {
    const key = norm(q);
    const lines = doc.sections["Open questions"].split("\n");
    doc.sections["Open questions"] = lines.filter((l) => { const b = BULLET.exec(l)?.[1]; return !b || norm(b) !== key; }).join("\n").trim();
  });
}

/** Adds one line to "Inputs from you" (a message, a file link, a screenshot note). */
export function addInput(itemId: string, line: string, d: DatabaseSync = db()): { version: number; changed: boolean } {
  return appendLine(itemId, "Inputs from you", oneLine(line), "input from you", d);
}

/** Adds an open question (used by goldfish checks). */
export function addOpenQuestion(itemId: string, q: string, d: DatabaseSync = db()): { version: number; changed: boolean } {
  const doc = load(itemId, d);
  if (openQuestionsOf(doc).some((x) => norm(x) === norm(q))) return { version: doc.version, changed: false };
  return appendLine(itemId, "Open questions", oneLine(q), "open question", d);
}

const openQuestionsOf = (doc: DesignDoc) => bullets(doc.sections["Open questions"]);

export function openQuestions(itemId: string, d: DatabaseSync = db()): string[] {
  const doc = readDoc(itemId, d);
  return doc ? openQuestionsOf(doc) : [];
}

/** All versions of the document, newest first (dashboard drawer). */
export function docVersions(itemId: string, d: DatabaseSync = db()): { version: number; sha: string; reason: string | null; openQuestions: number; readiness: string | null; createdAt: string }[] {
  return (d.prepare("SELECT version, sha, reason, open_questions, readiness, created_at FROM docs WHERE item_id=? ORDER BY version DESC").all(itemId) as any[])
    .map((r) => ({ version: r.version, sha: r.sha, reason: r.reason, openQuestions: r.open_questions, readiness: r.readiness, createdAt: r.created_at }));
}

// ------------------------------------------------------------------ summary and per-agent views

const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const firstText = (body: string): string => oneLine(body.split("\n").map((l) => BULLET.exec(l)?.[1] ?? l).find((l) => l.trim()) ?? "");

/** The short plan message for Teams: at most 10 lines. "details" sends the full document. */
export function summary(itemId: string, d: DatabaseSync = db()): string {
  const doc = readDoc(itemId, d);
  if (!doc) return `No design document for ${itemId} yet.`;
  const s = doc.sections;
  const lines: string[] = [cut(doc.title, 120)];
  if (s["Problem and goal"]) lines.push(`Goal: ${cut(firstText(s["Problem and goal"]), 140)}`);
  if (s["Approach"]) lines.push(`Approach: ${cut(firstText(s["Approach"]), 140)}`);
  const files = bullets(s["Files to change and why"]);
  if (files.length) {
    const names = files.slice(0, 3).map((f) => (/`([^`]+)`/.exec(f)?.[1] ?? f.split(/\s[–—-]\s|:\s/)[0]).trim());
    lines.push(`Files (${files.length}): ${cut(names.join(", ") + (files.length > 3 ? ", …" : ""), 140)}`);
  }
  const tests = bullets(s["Tests"]);
  if (tests.length) lines.push(`Tests: ${tests.length} (${cut(tests[0], 100)}${tests.length > 1 ? ", …" : ""})`);
  if (s["Contract"]) lines.push(`Contract: ${cut(firstText(s["Contract"]), 120)}`);
  const decisions = bullets(s["Decisions"]);
  if (decisions.length) lines.push(`Decisions: ${decisions.length}`);
  const open = bullets(s["Open questions"]);
  lines.push(open.length ? `Open questions: ${open.length} (${cut(open[0], 100)})` : "Open questions: none");
  lines.push(`Reply "details ${itemId}" for the full document.`);
  return lines.slice(0, 10).join("\n");
}

const ALL: readonly Section[] = SECTIONS;
const ROLE_SECTIONS: Record<string, readonly Section[]> = {
  understand: ["Problem and goal", "Acceptance criteria", "How the system works today", "Decisions", "Inputs from you", "Open questions"],
  plan: ALL,
  plan_review: ["Problem and goal", "Acceptance criteria", "How the system works today", "Approach", "Alternatives rejected", "Files to change and why", "Contract", "Decisions", "Tests", "Open questions"],
  readiness: ALL,
  critic: ALL,
  goldfish: ALL,
  contract: ["Problem and goal", "Approach", "Files to change and why", "Contract", "Decisions"],
  implement: ["Problem and goal", "Acceptance criteria", "How the system works today", "Approach", "Files to change and why", "Contract", "Decisions", "Tests", "Inputs from you"],
  review: ["Problem and goal", "Acceptance criteria", "Approach", "Files to change and why", "Contract", "Decisions", "Tests"],
  qa: ["Problem and goal", "Acceptance criteria", "Decisions", "Tests", "Inputs from you"],
  report: ["Problem and goal", "Acceptance criteria", "Approach", "Decisions", "Tests"],
  explain: ["Problem and goal", "Approach", "Alternatives rejected", "Decisions"],
};
const ROLE_ALIASES: Record<string, string> = {
  implement_test: "implement", developer: "implement", fix: "implement", ci_fix: "implement", resume: "implement",
  reviewer: "review", reviews: "review", code_review: "review", pr_review: "review", integration_check: "review",
  qa_engineer: "qa", tester: "qa",
  reporter: "report", pr_text: "report",
  planner: "plan", doc_readiness: "readiness", doc_critic: "critic",
};

export function sectionsForRole(role: string): readonly Section[] {
  const k = role.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ROLE_SECTIONS[k] ?? ROLE_SECTIONS[ROLE_ALIASES[k] ?? ""] ?? ALL;
}

/** Only the sections an agent needs, as markdown. Empty sections are left out to save tokens. */
export function sectionsFor(itemId: string, role: string, d: DatabaseSync = db()): string {
  const doc = readDoc(itemId, d);
  if (!doc) return "";
  const keep = sectionsForRole(role).filter((s) => doc.sections[s].trim());
  return renderDoc(doc.title, doc.sections, keep);
}
