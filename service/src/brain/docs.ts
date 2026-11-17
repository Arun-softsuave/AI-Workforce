import fs from "node:fs";
import path from "node:path";
import { paths, ensureDir } from "../core/paths.js";
import { slugify, truncate, nowIso } from "../core/util.js";
import { db, audit } from "../core/db.js";
import { getProject, loadSettings, type ProjectConfig } from "../core/config.js";
import { addFact, type HandbookFile } from "./handbook.js";
import { getRunner, untrusted } from "../agents/runner.js";
import { AGENTS } from "../agents/catalog.js";

/**
 * Product documents (PRD, requirements, specs) in the Brain.
 *  - Text is extracted (.md .txt .pdf .docx), stored as markdown and split into sections.
 *  - Shared docs live in <repo>/.ai-workforce/knowledge/docs/ (reviewed with the team like the Handbook);
 *    `private` docs live in ~/.ai-workforce/projects/<id>/docs/ and never enter the repository.
 *  - Sections are indexed, so each task's context pack receives only the relevant parts.
 */
export const SUPPORTED_DOCS = [".md", ".markdown", ".txt", ".pdf", ".docx"];
const MAX_DOC_CHARS = 400_000;

export async function extractText(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (!SUPPORTED_DOCS.includes(ext)) throw new Error(`Unsupported document type ${ext} – use ${SUPPORTED_DOCS.join(", ")}`);
  if (ext === ".pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)), { verbosity: 0 } as any);   // silence font-hinting warnings
    const { text } = await pdfText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).map((p, i) => `\n\n<!-- page ${i + 1} -->\n${p}`).join("").trim();
  }
  if (ext === ".docx") {
    const mammoth: any = await import("mammoth");
    const r = await (mammoth.default ?? mammoth).convertToMarkdown?.({ path: file }) ?? await (mammoth.default ?? mammoth).extractRawText({ path: file });
    return String(r.value ?? "").trim();
  }
  return fs.readFileSync(file, "utf8").trim();
}

export interface DocSection { heading: string; body: string }

/** Split markdown/plain text into sections of at most ~1800 chars, keeping headings with their text. */
export function splitSections(text: string, maxChars = 1800): DocSection[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const raw: DocSection[] = [];
  let heading = "Introduction", buf: string[] = [];
  const flush = () => { const b = buf.join("\n").trim(); if (b) raw.push({ heading, body: b }); buf = []; };
  for (const l of lines) {
    const h = /^(#{1,4})\s+(.+)$/.exec(l) ?? /^((?:\d+\.)+\d*)\s+([A-Z][^\n]{2,80})$/.exec(l.trim());
    if (h) { flush(); heading = h[2].trim(); continue; }
    buf.push(l);
  }
  flush();
  const out: DocSection[] = [];
  for (const s of raw) {
    if (s.body.length <= maxChars) { out.push(s); continue; }
    const paras = s.body.split(/\n\s*\n/);
    let cur = "", part = 1;
    for (const p of paras) {
      if (cur && cur.length + p.length > maxChars) { out.push({ heading: `${s.heading} (part ${part++})`, body: cur.trim() }); cur = ""; }
      cur += (cur ? "\n\n" : "") + (p.length > maxChars ? p.slice(0, maxChars) : p);
    }
    if (cur.trim()) out.push({ heading: part > 1 ? `${s.heading} (part ${part})` : s.heading, body: cur.trim() });
  }
  return out;
}

export function docsDir(p: ProjectConfig, privateDoc: boolean): string {
  return privateDoc ? path.join(paths.projectDir(p.id), "docs") : path.join(paths.knowledgeDir(p.local.path), "docs");
}

export interface StoredDoc { project: string; file: string; title: string; sections: number; chars: number; private: boolean; facts: number }

/**
 * Store a document for one or more projects (all members of a multi-repo product share the same PRD).
 * The source file is never modified; a markdown copy with a provenance header is written.
 */
export async function addDocument(projectIds: string[], source: string, opts: { title?: string; private?: boolean } = {}): Promise<StoredDoc[]> {
  if (!fs.existsSync(source)) throw new Error(`File not found: ${source}`);
  let text = await extractText(source);
  if (!text) throw new Error("No text could be extracted (scanned PDF images are not supported – export the document as text or .docx)");
  const truncated = text.length > MAX_DOC_CHARS;
  text = text.slice(0, MAX_DOC_CHARS);
  const title = opts.title ?? path.basename(source).replace(/\.[^.]+$/, "");
  const slug = slugify(title, 60);
  const sections = splitSections(text);
  let facts: { file: string; text: string }[] = [];
  if (loadSettings().models.provider !== "mock" && !opts.private) facts = await extractFacts(title, text);   // private docs: no fact extraction into the shared Handbook
  const results: StoredDoc[] = [];
  for (const id of projectIds) {
    const p = getProject(id);
    if (!p) throw new Error(`Unknown project "${id}"`);
    const dir = ensureDir(docsDir(p, !!opts.private));
    const file = path.join(dir, `${slug}.md`);
    const header = `<!-- aiw-doc: ${JSON.stringify({ title, source: path.basename(source), added: nowIso(), private: !!opts.private, truncated })} -->\n# ${title}\n\n`;
    fs.writeFileSync(file, header + text + "\n");
    indexDocument(id, file, title);
    let n = 0;
    if (!opts.private) for (const f of facts.slice(0, 15)) { addFact(p.local.path, f.file as HandbookFile, f.text, `document: ${title}`, "unverified"); n++; }
    results.push({ project: id, file, title, sections: sections.length, chars: text.length, private: !!opts.private, facts: n });
    audit("user", "brain.add_doc", id, { title, sections: sections.length, private: !!opts.private });
  }
  return results;
}

/** (Re)index one stored document's sections into the Brain search index. */
export function indexDocument(projectId: string, file: string, title?: string): number {
  const text = fs.readFileSync(file, "utf8");
  const meta = /<!-- aiw-doc: (\{.*?\}) -->/.exec(text);
  const docTitle = title ?? (meta ? JSON.parse(meta[1]).title : path.basename(file, ".md"));
  const body = text.replace(/<!-- aiw-doc:.*?-->\n?/, "").replace(/^# .*\n/, "");
  const ref = `docs/${path.basename(file)}`;
  db().prepare("DELETE FROM brain_index WHERE project_id=? AND ref LIKE ?").run(projectId, `${ref}#%`);
  const ins = db().prepare("INSERT INTO brain_index (project_id, kind, ref, title, body) VALUES (?,?,?,?,?)");
  const sections = splitSections(body);
  sections.forEach((s, i) => ins.run(projectId, "knowledge", `${ref}#${i + 1}`, `${docTitle} › ${s.heading}`, `${s.heading}\n${s.body}`));
  return sections.length;
}

export function listDocuments(projectId: string): { title: string; file: string; private: boolean; added?: string }[] {
  const p = getProject(projectId);
  if (!p) return [];
  const out: { title: string; file: string; private: boolean; added?: string }[] = [];
  for (const priv of [false, true]) {
    const dir = docsDir(p, priv);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const file = path.join(dir, f);
      const head = fs.readFileSync(file, "utf8").slice(0, 600);
      const m = /<!-- aiw-doc: (\{.*?\}) -->/.exec(head);
      const meta = m ? JSON.parse(m[1]) : {};
      out.push({ title: meta.title ?? f, file, private: priv, added: meta.added });
    }
  }
  return out;
}

export function reindexDocuments(projectId: string): number {
  return listDocuments(projectId).reduce((n, d) => n + indexDocument(projectId, d.file, d.title), 0);
}

/** With a real model: pull durable product facts (business rules, glossary, constraints) out of the document. */
async function extractFacts(title: string, text: string): Promise<{ file: string; text: string }[]> {
  const def = AGENTS["doc-reader"];
  const r = await getRunner().run({
    agent: "doc-reader", tier: def.tier, system: def.system, schema: def.schema,
    prompt: `Document: ${title}\n\n${untrusted(`document:${title}`, truncate(text, 60_000))}`,
  });
  return r.ok ? (r.data?.facts ?? []) : [];
}
