import { DatabaseSync } from "node:sqlite";
import { paths, ensureBaseDirs } from "./paths.js";
import { nowIso } from "./util.js";

/**
 * Versioned migrations. Never edit a shipped migration – append a new one.
 * All state that must survive a crash, reboot or sleep lives here (WAL mode).
 */
const MIGRATIONS: string[] = [
  /* 1: core schema */ `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE connections (
    provider TEXT PRIMARY KEY, account TEXT, scopes TEXT, status TEXT NOT NULL DEFAULT 'connected',
    meta TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE cursors (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE issue_snapshots (
    issue_id TEXT PRIMARY KEY, provider TEXT NOT NULL, project_id TEXT, issue_key TEXT,
    fields_hash TEXT, desc_hash TEXT, assignee TEXT, status TEXT, priority TEXT, summary TEXT,
    updated_at TEXT, seen_at TEXT NOT NULL);
  CREATE TABLE events (
    id TEXT PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, project_id TEXT,
    source_ref TEXT, payload TEXT, received_at TEXT NOT NULL, processed_at TEXT);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT, source_ref TEXT,
    title TEXT, kind TEXT NOT NULL, role TEXT, size TEXT, playbook TEXT, state TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 3, step_index INTEGER NOT NULL DEFAULT 0, run_no INTEGER NOT NULL DEFAULT 1,
    tokens_used INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
    worktree TEXT, branch TEXT, data TEXT NOT NULL DEFAULT '{}', error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX tasks_state ON tasks(state);
  CREATE INDEX tasks_source ON tasks(source, source_id);
  CREATE TABLE steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_no INTEGER NOT NULL, idx INTEGER NOT NULL,
    name TEXT NOT NULL, agent TEXT, model TEXT, status TEXT NOT NULL, tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, started_at TEXT, ended_at TEXT, output TEXT, error TEXT);
  CREATE INDEX steps_task ON steps(task_id);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, action TEXT NOT NULL, repo TEXT, branch TEXT,
    base_sha TEXT, head_sha TEXT, diff_hash TEXT, state TEXT NOT NULL, approver TEXT, channel TEXT,
    reason TEXT, requested_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT);
  CREATE INDEX approvals_task ON approvals(task_id);
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, task_id TEXT, channel TEXT NOT NULL, kind TEXT NOT NULL, idem_key TEXT NOT NULL UNIQUE,
    title TEXT, body TEXT, action_needed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    thread_ref TEXT, created_at TEXT NOT NULL, sent_at TEXT, read_at TEXT, error TEXT);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT, details TEXT);
  CREATE VIRTUAL TABLE brain_index USING fts5(project_id UNINDEXED, kind UNINDEXED, ref UNINDEXED, title, body);
  `,
  /* 2: onboarding progress + pause state */ `
  CREATE TABLE setup_progress (step TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT, updated_at TEXT NOT NULL);
  `,
  /* 3: the Teams conversation (both directions), so replies are understood in context */ `
  CREATE TABLE chat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, direction TEXT NOT NULL, kind TEXT, text TEXT NOT NULL,
    task_ref TEXT, refs TEXT);
  CREATE INDEX chat_log_ts ON chat_log(ts);
  `,
];

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  ensureBaseDirs();
  _db = openDb(paths.db());
  return _db;
}

export function openDb(file: string): DatabaseSync {
  const d = new DatabaseSync(file);
  d.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  migrate(d);
  return d;
}

/** For tests: close and forget the singleton so a new AIW_HOME can be used. */
export function resetDb(): void {
  try { _db?.close(); } catch { /* ignore */ }
  _db = null;
}

function migrate(d: DatabaseSync): void {
  d.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = d.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let v = row?.version ?? 0;
  if (!row) d.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (v < MIGRATIONS.length) {
    d.exec("BEGIN");
    try {
      d.exec(MIGRATIONS[v]);
      v++;
      d.prepare("UPDATE schema_version SET version = ?").run(v);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw new Error(`Database migration ${v + 1} failed: ${(e as Error).message}`);
    }
  }
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try { const r = fn(); d.exec("COMMIT"); return r; } catch (e) { d.exec("ROLLBACK"); throw e; }
}

export function audit(actor: string, action: string, target?: string, details?: unknown): void {
  db().prepare("INSERT INTO audit_log (ts, actor, action, target, details) VALUES (?,?,?,?,?)")
    .run(nowIso(), actor, action, target ?? null, details === undefined ? null : JSON.stringify(details));
}

export function getMeta(key: string): string | undefined {
  return (db().prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
}
export function setMeta(key: string, value: string): void {
  db().prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
export function delMeta(key: string): void {
  db().prepare("DELETE FROM meta WHERE key=?").run(key);
}

export function getCursor(name: string): string | undefined {
  return (db().prepare("SELECT value FROM cursors WHERE name=?").get(name) as { value: string } | undefined)?.value;
}
export function setCursor(name: string, value: string): void {
  db().prepare("INSERT INTO cursors (name,value,updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(name, value, nowIso());
}
