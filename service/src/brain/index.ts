import fs from "node:fs";
import path from "node:path";
import { db } from "../core/db.js";
import { paths, ensureDir } from "../core/paths.js";
import { readHandbook } from "./handbook.js";
import { loadCodeMap } from "./codemap.js";
import { reindexDocuments } from "./docs.js";

/**
 * The Index: SQLite FTS5 (BM25) over Handbook, Diary and Map. It is a derived copy –
 * delete it any time and `rebuildIndex` restores it from the other three parts.
 * Decision: v1 is keyword (BM25) only; an embedding index can be added behind `searchBrain`.
 */
export interface Hit { kind: "knowledge" | "diary" | "code"; ref: string; title: string; body: string; score: number }

export function rebuildIndex(projectId: string, repoPath: string): number {
  const d = db();
  d.prepare("DELETE FROM brain_index WHERE project_id=?").run(projectId);
  const ins = d.prepare("INSERT INTO brain_index (project_id, kind, ref, title, body) VALUES (?,?,?,?,?)");
  let n = 0;
  for (const doc of readHandbook(repoPath)) {
    if (doc.narrative) { ins.run(projectId, "knowledge", `${doc.file}.md`, `${doc.file} (summary)`, doc.narrative); n++; }
    for (const f of doc.facts.filter((x) => x.status !== "replaced")) { ins.run(projectId, "knowledge", `${doc.file}.md#${f.id}`, `${doc.file} fact`, f.text); n++; }
  }
  for (const e of readDiary(projectId)) { ins.run(projectId, "diary", e.file, e.title, e.body); n++; }
  n += reindexDocuments(projectId);
  const map = loadCodeMap(projectId);
  for (const f of map?.files ?? []) {
    ins.run(projectId, "code", f.path, f.path, `${f.path.replace(/[/._-]/g, " ")} ${f.symbols.join(" ")} ${f.routes.join(" ")}`);
    n++;
  }
  return n;
}

export function indexDiaryEntry(projectId: string, file: string, title: string, body: string): void {
  db().prepare("DELETE FROM brain_index WHERE project_id=? AND ref=?").run(projectId, file);
  db().prepare("INSERT INTO brain_index (project_id, kind, ref, title, body) VALUES (?,?,?,?,?)").run(projectId, "diary", file, title, body);
}

const STOP = new Set("the a an and or to of in on for with is are be this that it as at by from should must can will user users when then into not no all any".split(" "));

export function queryTerms(text: string, max = 12): string[] {
  const words = (text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((w) => !STOP.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

export function searchBrain(projectId: string, text: string, limit = 10, kinds?: Hit["kind"][]): Hit[] {
  const terms = queryTerms(text);
  if (!terms.length) return [];
  const match = terms.map((t) => `"${t}"*`).join(" OR ");
  const rows = db().prepare(
    `SELECT kind, ref, title, body, bm25(brain_index) AS score FROM brain_index
     WHERE brain_index MATCH ? AND project_id = ? ORDER BY score LIMIT ?`,
  ).all(match, projectId, limit * 3) as any[];
  return rows.filter((r) => !kinds || kinds.includes(r.kind)).slice(0, limit)
    .map((r) => ({ kind: r.kind, ref: r.ref, title: r.title, body: r.body, score: -r.score }));
}

// ---------------- Diary ----------------

export interface DiaryEntry { file: string; title: string; body: string }

export function writeDiary(projectId: string, key: string, content: string): string {
  const dir = ensureDir(paths.diaryDir(projectId));
  const file = path.join(dir, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.md`);
  fs.writeFileSync(file, content);
  return file;
}

export function readDiary(projectId: string): DiaryEntry[] {
  const dir = paths.diaryDir(projectId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const body = fs.readFileSync(path.join(dir, f), "utf8");
    return { file: f, title: body.split("\n")[0].replace(/^#\s*/, ""), body };
  });
}
