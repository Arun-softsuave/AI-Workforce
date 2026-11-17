import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDb, SCHEMA_VERSION } from "../core/db.js";
import { DEFAULT_SETTINGS, engineVersion, loadSettings } from "../core/config.js";
import { STATES, canTransition, type Task } from "../engine/tasks.js";
import { paths } from "../core/paths.js";

const tmpFile = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiw-mig-")), name);
const cols = (d: DatabaseSync, table: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name as string);
const tables = (d: DatabaseSync) => (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name as string);
const version = (d: DatabaseSync) => (d.prepare("SELECT version FROM schema_version").get() as any).version as number;
const KERNEL_TABLES = ["edges", "jobs", "agent_cache", "decisions", "directives", "contracts", "context_cache", "connector_health"];

test("a fresh database migrates to the latest schema with the kernel tables and columns", () => {
  const d = openDb(tmpFile("fresh.db"));
  assert.equal(version(d), SCHEMA_VERSION);
  for (const t of KERNEL_TABLES) assert.ok(tables(d).includes(t), `table ${t}`);
  for (const c of ["level", "parent_id", "root_id", "areas", "owner", "priority", "due"]) assert.ok(cols(d, "tasks").includes(c), `tasks.${c}`);
  for (const c of ["agent", "activity", "progress", "activity_at", "step_index", "attempts", "trigger_event", "priority"]) assert.ok(cols(d, "jobs").includes(c), `jobs.${c}`);
  for (const c of ["item_id", "handled_by"]) assert.ok(cols(d, "events").includes(c), `events.${c}`);
  for (const c of ["job_id", "input_hash", "cache_read"]) assert.ok(cols(d, "steps").includes(c), `steps.${c}`);
  // defaults for a row written the v1 way
  d.prepare("INSERT INTO tasks (id, project_id, source, kind, state, created_at, updated_at) VALUES ('t1','p','jira','ticket','DETECTED','x','x')").run();
  const r = d.prepare("SELECT level, owner, priority, parent_id FROM tasks WHERE id='t1'").get() as any;
  assert.deepEqual({ ...r }, { level: "ticket", owner: "me", priority: 3, parent_id: null });
  d.close();
});

test("an existing database one version behind upgrades without losing rows, and is backed up first", () => {
  const file = tmpFile("old.db");
  const old = new DatabaseSync(file);
  migrate(old, undefined, SCHEMA_VERSION - 1);
  assert.equal(version(old), SCHEMA_VERSION - 1);
  assert.ok(!tables(old).includes("jobs"));
  old.prepare("INSERT INTO tasks (id, project_id, source, source_ref, kind, state, priority, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("t-lead", "nue-backend", "jira", "KAN-40", "lead", "WAITING_PARTS", 2, JSON.stringify({ targets: ["nue-backend"] }), "2026-11-01", "2026-11-01");
  old.prepare("INSERT INTO tasks (id, project_id, source, source_ref, kind, state, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("t-part", "nue-backend", "jira", "KAN-40@nue-backend", "part", "RUNNING", JSON.stringify({ leadId: "t-lead" }), "2026-11-01", "2026-11-01");
  old.prepare("INSERT INTO steps (task_id, run_no, idx, name, status, tokens_in, cache_read) VALUES ('t-part',1,0,'understand','ok',1000,800)").run();
  old.prepare("INSERT INTO events (id, idem_key, type, received_at) VALUES ('e1','jira:KAN-40:1','ticket_assigned','2026-11-01')").run();
  old.prepare("INSERT INTO meta (key, value) VALUES ('fix.ciwatch', '[]')").run();
  old.prepare("INSERT INTO chat_log (ts, direction, text, msg_id) VALUES ('2026-11-01','in','hello','m1')").run();
  old.close();

  const d = openDb(file);
  assert.equal(version(d), SCHEMA_VERSION);
  const tasks = d.prepare("SELECT * FROM tasks ORDER BY id").all() as any[];
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, "t-lead");
  assert.equal(tasks[0].state, "WAITING_PARTS");
  assert.equal(tasks[0].priority, 2);
  assert.equal(tasks[0].level, "ticket");
  assert.equal(tasks[0].owner, "me");
  assert.equal(JSON.parse(tasks[1].data).leadId, "t-lead");
  const step = d.prepare("SELECT tokens_in, cache_read, job_id FROM steps").get() as any;
  assert.deepEqual({ ...step }, { tokens_in: 1000, cache_read: 800, job_id: null });
  const ev = d.prepare("SELECT idem_key, item_id, handled_by FROM events").get() as any;
  assert.deepEqual({ ...ev }, { idem_key: "jira:KAN-40:1", item_id: null, handled_by: null });
  assert.equal((d.prepare("SELECT value FROM meta WHERE key='fix.ciwatch'").get() as any).value, "[]");
  assert.equal((d.prepare("SELECT msg_id FROM chat_log").get() as any).msg_id, "m1");
  // idempotent: opening again changes nothing
  d.close();
  const again = openDb(file);
  assert.equal(version(again), SCHEMA_VERSION);
  assert.equal((again.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n, 2);
  again.close();

  // the backup holds the old schema and the old rows
  const bakFile = `${file}.bak-schema${SCHEMA_VERSION - 1}`;
  assert.ok(fs.existsSync(bakFile), "backup written before migrating");
  const bak = new DatabaseSync(bakFile, { readOnly: true });
  assert.equal(version(bak), SCHEMA_VERSION - 1);
  assert.equal((bak.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n, 2);
  bak.close();
});

test("kernel states exist with legal transitions; every v1 transition is kept", () => {
  for (const s of ["PR_OPEN", "BLOCKED", "MERGED", "CLOSED", "PLANNING", "WAITING_CHILDREN"]) assert.ok((STATES as readonly string[]).includes(s), s);
  const t = (state: string) => ({ state } as Task);
  // v1 paths unchanged
  assert.ok(canTransition(t("PUBLISHING"), "DONE"));
  assert.ok(canTransition(t("RUNNING"), "WAITING_PARTS"));
  assert.ok(canTransition(t("PART_READY"), "DONE"));
  assert.ok(!canTransition(t("DONE"), "QUEUED"));
  // kernel paths
  assert.ok(canTransition(t("PUBLISHING"), "PR_OPEN"));
  assert.ok(canTransition(t("PR_OPEN"), "MERGED"));
  assert.ok(canTransition(t("PR_OPEN"), "CLOSED"));
  assert.ok(canTransition(t("MERGED"), "DONE"));
  assert.ok(canTransition(t("CLOSED"), "PR_OPEN"));
  assert.ok(canTransition(t("QUEUED"), "BLOCKED"));
  assert.ok(canTransition(t("BLOCKED"), "QUEUED"));
  assert.ok(canTransition(t("DETECTED"), "PLANNING"));
  assert.ok(canTransition(t("PLANNING"), "WAITING_CHILDREN"));
  assert.ok(canTransition(t("WAITING_CHILDREN"), "DONE"));
  assert.ok(!canTransition(t("PR_OPEN"), "RUNNING"));
  assert.ok(!canTransition(t("MERGED"), "PR_OPEN"));
});

test("engine.version defaults to v1 and only an explicit v2 selects the kernel", () => {
  // this test is about the settings file; AIW_ENGINE (the switch for running the suite on v2) is checked at the end
  const envBefore = process.env.AIW_ENGINE;
  delete process.env.AIW_ENGINE;
  assert.equal(DEFAULT_SETTINGS.engine.version, "v1");
  assert.equal(engineVersion(loadSettings()), "v1");
  fs.writeFileSync(paths.settings(), "engine:\n  version: v2\n");
  assert.equal(loadSettings().engine.version, "v2");
  assert.equal(engineVersion(), "v2");
  fs.writeFileSync(paths.settings(), "engine: v2\n");
  assert.equal(engineVersion(), "v2");
  fs.writeFileSync(paths.settings(), "engine:\n  version: v9\n");
  assert.equal(engineVersion(), "v1");
  // AIW_ENGINE overrides the file, both ways; any other value is ignored
  process.env.AIW_ENGINE = "v2";
  assert.equal(engineVersion(), "v2");
  fs.writeFileSync(paths.settings(), "engine: v2\n");
  process.env.AIW_ENGINE = "v1";
  assert.equal(engineVersion(), "v1");
  process.env.AIW_ENGINE = "v3";
  assert.equal(engineVersion(), "v2");
  fs.rmSync(paths.settings());
  process.env.AIW_ENGINE = "v2";
  assert.equal(engineVersion(), "v2", "also without a settings file");
  if (envBefore === undefined) delete process.env.AIW_ENGINE; else process.env.AIW_ENGINE = envBefore;
});
