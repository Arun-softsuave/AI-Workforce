import fs from "node:fs";
import path from "node:path";
import { db } from "../core/db.js";
import { nowIso, safeJson, sha256 } from "../core/util.js";
import { git } from "../git/git.js";

/**
 * The item code note (5.13, W12 "code again"): what an agent learned about the code for one item, stamped with the
 * git SHA it read and a hash of every file it relied on. The next step (a CI fix six days later, a resume, a review
 * fix) runs `driftCheck` – plain git and hashing, no model:
 *   - nothing changed          → reuse the note (0 tokens);
 *   - some files changed       → re-read only those (delta re-read);
 *   - more than 30 % changed   → re-understand from scratch.
 * Notes live in `context_cache` (source "codenote:<item>:<repo>", version = the SHA).
 */

export const FULL_REREAD_RATIO = 0.3;

export interface CodeNote {
  itemId: string;
  repo: string;            // repository id (project id) – one note per item and repository
  sha: string;             // HEAD when the note was written
  files: Record<string, string>;   // repo-relative path → content hash ("" = did not exist)
  text: string;            // the note itself: what is where, what matters
  createdAt: string;
}

export type DriftStatus = "unchanged" | "changed" | "full" | "missing";

export interface Drift {
  status: DriftStatus;
  /** note files whose content changed or that were deleted, plus new files in the same folders since the note's SHA */
  changed: string[];
  ratio: number;
  noteSha?: string;
  headSha?: string;
  /** a one-line reason for the activity feed */
  reason: string;
}

const keyOf = (itemId: string, repo: string) => `codenote:${itemId}:${repo}`;
const rel = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

function inside(root: string, file: string): string | undefined {
  const abs = path.resolve(root, file);
  const r = path.relative(path.resolve(root), abs);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? abs : undefined;
}

/** Content hash of one file in the working tree (line endings normalised so a checkout setting is not "drift"). */
export function fileHash(root: string, file: string): string {
  const abs = inside(root, file);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return "";
  return sha256(fs.readFileSync(abs).toString("utf8").replace(/\r\n/g, "\n")).slice(0, 32);
}

const head = (root: string) => { try { return git(root, ["rev-parse", "HEAD"]); } catch { return ""; } };

/** Writes (or replaces) the note for an item and repository, stamped with HEAD and the files' hashes. */
export function writeCodeNote(itemId: string, repo: string, root: string, text: string, files: string[]): CodeNote {
  const note: CodeNote = {
    itemId, repo, sha: head(root), text: String(text ?? "").trim(), createdAt: nowIso(),
    files: Object.fromEntries([...new Set(files.map(rel).filter(Boolean))].sort().map((f) => [f, fileHash(root, f)])),
  };
  const now = nowIso();
  db().prepare(`INSERT INTO context_cache (key, source, version, text, tokens, created_at, last_used) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET version=excluded.version, text=excluded.text, tokens=excluded.tokens, created_at=excluded.created_at, last_used=excluded.last_used`)
    .run(keyOf(itemId, repo), keyOf(itemId, repo), note.sha || "no-git", JSON.stringify(note), Math.ceil(note.text.length / 4), now, now);
  return note;
}

export function readCodeNote(itemId: string, repo: string): CodeNote | undefined {
  const r = db().prepare("SELECT text FROM context_cache WHERE key=?").get(keyOf(itemId, repo)) as { text: string } | undefined;
  if (!r) return undefined;
  db().prepare("UPDATE context_cache SET last_used=? WHERE key=?").run(nowIso(), keyOf(itemId, repo));
  return safeJson<CodeNote | undefined>(r.text, undefined);
}

/** New files since the note's SHA in the folders the note covers (a new sibling may matter). Empty when the SHA is gone. */
function addedNearby(root: string, note: CodeNote): string[] {
  if (!note.sha) return [];
  const dirs = new Set(Object.keys(note.files).map((f) => path.posix.dirname(f)));
  let out = "";
  try { out = git(root, ["diff", "--name-only", "--diff-filter=A", note.sha, "--"], { allowFail: true }); } catch { return []; }
  let untracked = "";
  try { untracked = git(root, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }); } catch { /* ignore */ }
  return [...new Set([...out.split("\n"), ...untracked.split("\n")].map((s) => rel(s.trim())).filter(Boolean))]
    .filter((f) => !(f in note.files) && dirs.has(path.posix.dirname(f)));
}

/** Compares the note with the code as it is now. Pure git + hashing: never calls a model. */
export function driftCheck(itemId: string, repo: string, root: string): Drift {
  const note = readCodeNote(itemId, repo);
  const now = head(root);
  if (!note) return { status: "missing", changed: [], ratio: 1, headSha: now, reason: "no code note yet – full read" };
  const files = Object.keys(note.files);
  const changed = files.filter((f) => fileHash(root, f) !== note.files[f]);
  const added = addedNearby(root, note);
  const all = [...changed, ...added];
  const ratio = files.length ? Math.min(1, all.length / files.length) : (all.length ? 1 : 0);
  const base = { noteSha: note.sha, headSha: now, ratio, changed: all };
  if (!all.length) return { ...base, status: "unchanged", reason: `code unchanged since ${note.sha.slice(0, 7) || "the note"} – note reused` };
  if (ratio > FULL_REREAD_RATIO) return { ...base, status: "full", reason: `${all.length} of ${files.length} noted files changed – full re-read` };
  return { ...base, status: "changed", reason: `${all.length} file(s) changed – re-reading only ${all.slice(0, 3).join(", ")}${all.length > 3 ? " …" : ""}` };
}

/**
 * The text an agent starts from. unchanged → the note alone; changed → the note plus the list of files to
 * re-read (nothing else); full / missing → undefined (the step re-understands the code itself).
 */
export function noteForPrompt(itemId: string, repo: string, root: string): { text?: string; drift: Drift } {
  const drift = driftCheck(itemId, repo, root);
  const note = drift.status === "unchanged" || drift.status === "changed" ? readCodeNote(itemId, repo) : undefined;
  if (!note) return { drift };
  const reread = drift.status === "changed"
    ? `\n\nThese files changed since the note was written – re-read only these (Read with line ranges), trust the note for the rest:\n${drift.changed.map((f) => `- ${f}`).join("\n")}`
    : "\n\nThe code has not changed since this note was written – rely on it; do not re-read these files.";
  return { drift, text: `## Code note (from ${note.sha.slice(0, 7) || "the working tree"}, ${note.createdAt.slice(0, 10)})\n${note.text}\n\nFiles: ${Object.keys(note.files).join(", ")}${reread}` };
}

/** After a delta re-read: re-stamp the note (new SHA, new hashes) and optionally add what was learned. */
export function refreshCodeNote(itemId: string, repo: string, root: string, extra = "", moreFiles: string[] = []): CodeNote | undefined {
  const note = readCodeNote(itemId, repo);
  if (!note) return undefined;
  return writeCodeNote(itemId, repo, root, extra.trim() ? `${note.text}\n${extra.trim()}` : note.text, [...Object.keys(note.files), ...moreFiles]);
}

export function deleteCodeNote(itemId: string, repo: string): void {
  db().prepare("DELETE FROM context_cache WHERE key=?").run(keyOf(itemId, repo));
}
