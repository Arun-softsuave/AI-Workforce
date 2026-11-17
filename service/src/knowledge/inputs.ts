import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "../core/db.js";
import { aiwHome, ensureDir, serviceRoot } from "../core/paths.js";
import { newId, nowIso, sha256, truncate, redactSecrets } from "../core/util.js";
import { redactSecrets as redactChatSecrets } from "../notify/chatLog.js";
import { wrapUntrusted, detectInjection, suspiciousNote, sanitize } from "../policy/untrusted.js";
import type { InboundMessage, AttachmentRef } from "../intake/teamsMessage.js";

/**
 * Pictures and files you send in Teams (W1a, module 5.16b).
 *  - Downloaded with a size cap and a short list of safe types; programs, scripts and archives are refused.
 *  - Saved under ~/.ai-workforce/items/<item>/inputs/ (never in a repository), with a sha256 and an `inputs` row.
 *  - A picture is described once by a small model (injected `describeImage`); the description is cached by file hash.
 *  - A document is turned into text (PDF, Word, Excel, PowerPoint, plain text) and kept next to the file.
 *  - Everything read from a picture or file is data, never orders: agents get it through inputsContext(), fenced.
 */

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const DOC_EXT = new Set(["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json", "log"]);
const TEXT_EXT = new Set(["txt", "md", "csv", "json", "log"]);
const OFFICE_EXT = new Set(["docx", "xlsx", "pptx"]);
const RISKY_EXT = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "ps1", "psm1", "vbs", "vbe", "js", "mjs", "cjs", "jse", "wsf", "wsh", "hta", "jar", "apk",
  "appx", "msix", "dll", "sys", "lnk", "reg", "iso", "img", "dmg", "app", "cpl", "sh", "bash", "zsh", "py", "pl", "rb", "php", "deb", "rpm",
  "docm", "xlsm", "pptm", "dotm", "xlam", "scf", "url", "inf",
]);
const ARCHIVE_EXT = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "cab", "arj", "lz", "zst"]);

export interface DownloadedFile {
  bytes: Uint8Array;
  /** The real file name when the source knows it (OneDrive), else the attachment name is used. */
  name?: string;
  mimeType?: string | null;
}

export interface InputDeps {
  /** Fetch one attachment's bytes (the Teams client's readAttachment in production; a fake in tests). */
  download(att: AttachmentRef, msg: InboundMessage): Promise<DownloadedFile>;
  /** Small-tier "image-describer": what the picture shows and any error text. Optional: without it no description. */
  describeImage?(input: { bytes: Uint8Array; mimeType: string; path: string; sha: string; name: string }): Promise<string>;
  /** Document text; defaults to the vendored files.js fileToText (PDF through unpdf). */
  fileToText?(bytes: Uint8Array, ext: string): Promise<{ text: string; truncated?: boolean }>;
  /** Called once per picture or file whose text seems to give orders (activity feed / owner message). */
  onSuspicious?(note: string, input: SavedInput): void;
}

export interface SavedInput {
  id: string;
  kind: "image" | "document";
  name: string;
  path: string;
  /** For documents: the extracted text file next to the original. */
  textPath?: string;
  sha: string;
  summary: string | null;
  /** True when the same file was already attached to this item (nothing new stored). */
  duplicate?: boolean;
  suspicious?: boolean;
}

export interface RefusedInput { name: string; reason: string }

export interface SaveInputsResult {
  saved: SavedInput[];
  refused: RefusedInput[];
  /** One short line for Teams, e.g. "Added screenshot to KAN-52 (error: 500 on empty list)." */
  confirmation: string;
}

export function itemInputsDir(itemId: string): string {
  return path.join(aiwHome(), "items", safeSegment(itemId), "inputs");
}

function safeSegment(s: string): string {
  return String(s ?? "item").replace(/[^A-Za-z0-9@._-]/g, "_").replace(/^\.+/, "_").slice(0, 80) || "item";
}

function safeFileName(name: string): string {
  const base = path.basename(String(name ?? "").replace(/\\/g, "/"));
  return base.replace(/[^A-Za-z0-9 ._()-]/g, "_").replace(/^\.+/, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "file";
}

const extOf = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name ?? "")?.[1] ?? "").toLowerCase();

function startsWith(b: Uint8Array, sig: number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  return sig.every((x, i) => b[at + i] === x);
}

/** The picture type from its first bytes (Teams pictures have no file extension). */
function sniffImage(b: Uint8Array): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/** Programs hide behind safe names: check the first bytes, whatever the name says. */
function looksExecutable(b: Uint8Array): boolean {
  return startsWith(b, [0x4d, 0x5a]) /* MZ: Windows program */ || startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) /* ELF */
    || startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xca, 0xfe, 0xba, 0xbe]) /* Mach-O */ || startsWith(b, [0x23, 0x21]) /* #! */;
}

/** Why a type is refused before anything is downloaded, or null when the type is fine. */
export function refuseReason(ext: string, kind: "image" | "file" = "file"): string | null {
  if (kind === "image") return null;
  if (RISKY_EXT.has(ext)) return "programs and scripts are not accepted";
  if (ARCHIVE_EXT.has(ext)) return "archives are not accepted, please send the files inside";
  if (!IMAGE_EXT[ext] && !DOC_EXT.has(ext)) return `.${ext || "?"} files are not supported (pictures, PDF, Word, Excel, PowerPoint and text files are)`;
  return null;
}

/** Check the downloaded bytes match the claimed type. */
function contentProblem(bytes: Uint8Array, ext: string): string | null {
  if (looksExecutable(bytes)) return "it is a program, not a document";
  if (IMAGE_EXT[ext]) return sniffImage(bytes) ? null : "it is not a real picture";
  if (ext === "pdf") return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]) ? null : "it is not a real PDF";
  if (OFFICE_EXT.has(ext)) {
    if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "it is not a real Office file";
    // macro-enabled parts inside an Office file
    const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 2_000_000))).toString("latin1");
    if (/vbaProject\.bin/i.test(head)) return "it contains macros";
    return null;
  }
  if (TEXT_EXT.has(ext) && bytes.subarray(0, 8192).includes(0)) return "it is not a text file";
  return null;
}

let vendorFiles: Promise<any> | undefined;
function filesJs(): Promise<any> {
  vendorFiles ??= import(pathToFileURL(path.join(serviceRoot(), "vendor", "teams-personal", "core", "files.js")).href);
  return vendorFiles;
}

async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 } as any);
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((p, i) => `--- Page ${i + 1} ---\n${p}`).join("\n\n");
}

async function defaultFileToText(bytes: Uint8Array, ext: string): Promise<{ text: string; truncated?: boolean }> {
  const f = await filesJs();
  return f.fileToText(bytes, ext, { extractPdf: pdfToText });
}

/** Secrets never reach a prompt, and outside text is cleaned of hidden parts. */
function cleanText(s: string): string {
  return redactChatSecrets(redactSecrets(sanitize(s ?? "")));
}

function cachedSummary(sha: string): string | null {
  const r = db().prepare("SELECT summary FROM inputs WHERE sha=? AND summary IS NOT NULL AND summary <> '' ORDER BY created_at DESC LIMIT 1").get(sha) as { summary: string } | undefined;
  return r?.summary ?? null;
}

function existing(itemId: string, sha: string): any {
  return db().prepare("SELECT * FROM inputs WHERE item_id=? AND sha=? LIMIT 1").get(itemId, sha);
}

/**
 * Download, check and store every picture and file of a message for one item.
 * Never throws for one bad attachment: it is listed under `refused` with a short reason.
 */
export async function saveInputs(msg: InboundMessage, itemId: string, deps: InputDeps): Promise<SaveInputsResult> {
  const saved: SavedInput[] = [];
  const refused: RefusedInput[] = [];
  const atts: AttachmentRef[] = [...msg.files, ...msg.images];
  let shot = 0;
  for (const att of atts) {
    const label = att.kind === "image" ? `picture ${att.index + 1}` : att.name;
    const preReason = att.kind === "file" ? refuseReason(extOf(att.name), "file") : null;
    if (preReason) { refused.push({ name: att.name, reason: preReason }); continue; }
    if (att.size && att.size > MAX_INPUT_BYTES) { refused.push({ name: label, reason: "it is larger than 10 MB" }); continue; }
    let file: DownloadedFile;
    try { file = await deps.download(att, msg); } catch (e: any) {
      refused.push({ name: label, reason: `it could not be downloaded (${truncate(String(e?.message ?? e), 120)})` });
      continue;
    }
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes as any);
    if (bytes.length > MAX_INPUT_BYTES) { refused.push({ name: label, reason: "it is larger than 10 MB" }); continue; }
    if (!bytes.length) { refused.push({ name: label, reason: "it is empty" }); continue; }

    let name: string, ext: string;
    if (att.kind === "image") {
      ext = sniffImage(bytes) ?? extOf(file.name ?? "") ?? "";
      if (!IMAGE_EXT[ext]) { refused.push({ name: label, reason: looksExecutable(bytes) ? "it is a program, not a picture" : "it is not a picture type I accept" }); continue; }
      name = `screenshot-${++shot}.${ext === "jpeg" ? "jpg" : ext}`;
    } else {
      name = safeFileName(file.name || att.name);
      ext = extOf(name);
      const reason = refuseReason(ext, "file");
      if (reason) { refused.push({ name, reason }); continue; }
    }
    const problem = contentProblem(bytes, ext);
    if (problem) { refused.push({ name: att.kind === "image" ? label : name, reason: problem }); continue; }

    const sha = sha256(Buffer.from(bytes));
    const kind: SavedInput["kind"] = IMAGE_EXT[ext] ? "image" : "document";
    const dup = existing(itemId, sha);
    if (dup) {
      saved.push({ id: dup.id, kind: dup.kind, name: dup.name, path: dup.path, sha, summary: dup.summary, duplicate: true,
        textPath: dup.kind === "document" ? `${dup.path}.txt` : undefined });
      continue;
    }

    const dir = ensureDir(itemInputsDir(itemId));
    const file_ = path.join(dir, `${sha.slice(0, 8)}-${name}`);
    fs.writeFileSync(file_, bytes);
    let summary: string | null = null;
    let textPath: string | undefined;
    let suspiciousText = "";

    if (kind === "image") {
      summary = cachedSummary(sha);
      if (!summary && deps.describeImage) {
        try {
          const d = await deps.describeImage({ bytes, mimeType: IMAGE_EXT[ext], path: file_, sha, name });
          summary = truncate(cleanText(d).replace(/\s+/g, " ").trim(), 600) || null;
        } catch { summary = null; }      // a description is nice to have; the picture is still saved
      }
      suspiciousText = summary ?? "";
    } else {
      try {
        const r = await (deps.fileToText ?? defaultFileToText)(bytes, ext);
        const text = cleanText(r.text);
        textPath = `${file_}.txt`;
        fs.writeFileSync(textPath, text + (r.truncated ? "\n…[the rest of the file was not read]" : ""));
        const words = text.split(/\s+/).filter(Boolean).length;
        const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
        summary = words ? `${words} words${first ? `: ${truncate(first, 100)}` : ""}` : "no readable text";
        suspiciousText = text;
      } catch (e: any) {
        summary = `text could not be read (${truncate(String(e?.message ?? e), 80)})`;
      }
    }

    const id = newId("in");
    db().prepare("INSERT INTO inputs (id, item_id, msg_id, kind, name, path, sha, summary, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, itemId, msg.id ?? null, kind, name, file_, sha, summary, nowIso());
    const entry: SavedInput = { id, kind, name, path: file_, textPath, sha, summary };
    if (suspiciousText) {
      const report = detectInjection(suspiciousText);
      if (report.suspicious) {
        entry.suspicious = true;
        try { deps.onSuspicious?.(suspiciousNote(name, report), entry); } catch { /* best effort */ }
      }
    }
    saved.push(entry);
  }
  return { saved, refused, confirmation: confirmationText(itemId, saved, refused) };
}

/** The first sentence of a summary, at most ~80 characters, for the one-line confirmation. */
function shortNote(s: string | null): string {
  if (!s) return "";
  const first = s.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, "");
  return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
}

/** One short line: what was added where, and what was refused and why. */
export function confirmationText(itemId: string, saved: SavedInput[], refused: RefusedInput[]): string {
  const parts: string[] = [];
  const fresh = saved.filter((s) => !s.duplicate);
  const dups = saved.filter((s) => s.duplicate);
  if (fresh.length === 1) {
    const f = fresh[0];
    const note = f.kind === "image" ? shortNote(f.summary) : "";
    parts.push(`Added ${f.kind === "image" ? "screenshot" : f.name} to ${itemId}${note ? ` (${note})` : ""}.`);
  }
  else if (fresh.length > 1) {
    const imgs = fresh.filter((s) => s.kind === "image").length;
    const docs = fresh.filter((s) => s.kind === "document").map((s) => s.name);
    const what = [imgs ? `${imgs} screenshot${imgs > 1 ? "s" : ""}` : "", ...docs].filter(Boolean).join(", ");
    parts.push(`Added ${what} to ${itemId}.`);
  }
  if (dups.length) parts.push(`${dups.length === 1 ? dups[0].kind === "image" ? "That screenshot" : dups[0].name : `${dups.length} of these`} ${dups.length === 1 ? "was" : "were"} already on ${itemId}.`);
  if (refused.length === 1) parts.push(`Did not save ${refused[0].name}: ${refused[0].reason}.`);
  else if (refused.length > 1) parts.push(`Did not save ${refused.map((r) => `${r.name} (${r.reason})`).join(", ")}.`);
  return parts.join(" ") || `Nothing to add to ${itemId}.`;
}

export interface InputRow { id: string; item_id: string; msg_id: string | null; kind: string; name: string | null; path: string; sha: string; summary: string | null; created_at: string }

export function listInputs(itemId: string): InputRow[] {
  return db().prepare("SELECT * FROM inputs WHERE item_id=? ORDER BY created_at, id").all(itemId) as unknown as InputRow[];
}

/**
 * The item's inputs for an agent prompt or the design document ("Inputs from you"): one fenced block per input,
 * so text read from a picture or file is data, never orders. Document text is cut to `maxCharsEach`.
 */
export function inputsContext(itemId: string, maxCharsEach = 4000): string {
  return listInputs(itemId).map((r) => {
    let body = r.summary ?? "";
    if (r.kind === "document") {
      try { body = fs.readFileSync(`${r.path}.txt`, "utf8"); } catch { /* keep the summary */ }
    }
    const head = `${r.kind === "image" ? "Screenshot" : "File"} ${r.name ?? ""} (saved at ${r.path})`;
    return `${head}\n${wrapUntrusted(`${r.kind === "image" ? "image" : "document"} ${r.name ?? r.id}`, body || "(no description)", maxCharsEach)}`;
  }).join("\n\n");
}
