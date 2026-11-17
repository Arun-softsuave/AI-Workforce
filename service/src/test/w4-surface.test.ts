import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECTIONS } from "../knowledge/designDoc.js";

// <plugin root>/service/<build dir>/test/this.js → plugin root is three levels up
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8");
const mdFiles = (dir: string): string[] => {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? mdFiles(path.join(dir, e.name)) : e.name.endsWith(".md") ? [path.join(dir, e.name)] : []);
};
const surface = [...mdFiles("commands"), ...mdFiles("skills"), ...mdFiles("agents")];

/** CLI commands that a surface file may name although the CLI doesn't have them yet (each has a hook-in). */
const PENDING_CLI = new Set<string>([]);

test("w4-surface: every slash command has a description and allowed tools", () => {
  const cmds = mdFiles("commands");
  for (const name of ["aiw-explain", "aiw-rules", "aiw-bench", "aiw-adopt", "aiw-doctor", "aiw-status", "aiw-tasks", "aiw-dashboard"]) {
    assert.ok(cmds.some((f) => path.basename(f) === `${name}.md`), `commands/${name}.md exists`);
  }
  for (const f of cmds) {
    const text = read(f);
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, "\n"));
    assert.ok(fm, `${f} has front matter`);
    assert.match(fm![1], /^description: .{10,}/m, `${f} has a description`);
    assert.match(fm![1], /^allowed-tools: .*Bash\(aiw:\*\)/m, `${f} may run aiw`);
  }
});

test("w4-surface: every `aiw <command>` named in commands, skills and agents exists in the CLI", () => {
  const main = read("service", "src", "cli", "main.ts");
  const known = new Set([...main.matchAll(/case "([a-z][a-z-]*)"/g)].map((m) => m[1]));
  assert.ok(known.has("explain") && known.has("rules") && known.has("items") && known.has("doctor") && known.has("bench"));
  const missing: string[] = [];
  for (const f of surface) {
    for (const m of read(f).matchAll(/`aiw ([a-z][a-z-]*)/g)) {
      if (!known.has(m[1]) && !PENDING_CLI.has(m[1])) missing.push(`${f}: aiw ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("w4-surface: every MCP tool named in commands, skills and agents exists", () => {
  const tools = read("service", "src", "mcp", "tools.ts");
  const known = new Set([...tools.matchAll(/registerTool\("(aiw_[a-z_]+)"/g)].map((m) => m[1]));
  const missing: string[] = [];
  for (const f of surface) for (const m of read(f).matchAll(/\b(aiw_[a-z_]+)\b/g)) if (!known.has(m[1])) missing.push(`${f}: ${m[1]}`);
  assert.deepEqual(missing, []);
});

test("w4-surface: helper agents work on the item's design document with its exact headings", () => {
  for (const a of ["aiw-planner", "aiw-reviewer", "aiw-memory-keeper"]) {
    const text = read("agents", `${a}.md`);
    assert.match(text, /items\/<id>\/design\.md/, `${a} names the design document`);
    assert.match(text, /aiw show <ticket> --json/, `${a} finds the item id`);
    assert.match(text, /^tools: .*Edit/m, `${a} can write the document`);
  }
  const planner = read("agents", "aiw-planner.md");
  for (const s of SECTIONS) assert.ok(planner.includes(`## ${s}`), `planner names "## ${s}"`);
  assert.ok(read("agents", "aiw-reviewer.md").includes("## Open questions"));
  assert.ok(read("agents", "aiw-memory-keeper.md").includes("## Decisions"));
  assert.match(read("commands", "aiw-explain.md"), /design\.md/);
});

test("w4-surface: README daily use has no draft PRs and lists the new commands", () => {
  const readme = read("README.md");
  const daily = readme.slice(readme.indexOf("## Daily use"), readme.indexOf("## Working from Teams"));
  assert.ok(daily.length > 100);
  assert.doesNotMatch(daily, /draft/i);
  for (const c of ["aiw-explain", "aiw-rules", "aiw-doctor", "aiw-bench", "aiw-adopt", "aiw-dashboard"]) assert.ok(daily.includes(c), c);
  assert.match(readme, /## What's new in 1\.0/);
  assert.match(read("QUICKSTART.md"), /## 5a\. How to test 1\.0/);
  assert.match(read("ARCHITECTURE.md"), /^# AI Workforce – Architecture \(1\.0\)/);
});

test("w4-surface: the onboarding skill covers team, preferences, ready check, environment doctor, Figma token first and dashboard", () => {
  const s = read("skills", "aiw-onboarding", "SKILL.md");
  for (const needle of ["aiw team detect", "aiw prefs", "aiw ready", "aiw doctor <project> --smoke", "Figma – token first", "`aiw connect figma`", "aiw dashboard"]) {
    assert.ok(s.includes(needle), needle);
  }
  assert.doesNotMatch(s, /Coming later: a deeper \*\*environment doctor/);
});

test("w4-surface: the real-message replay seed is anonymised and ready for labelling", () => {
  const file = path.join(root, "service", "src", "test", "fixtures", "replay-real.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(doc.messages));
  assert.ok(doc.messages.length > 0 && doc.messages.length <= 60);
  assert.equal(doc.count, doc.messages.length);
  const ids = new Set<string>();
  for (const m of doc.messages) {
    assert.equal(typeof m.text, "string");
    assert.equal(m.expect, "", "expect is left empty for labelling");
    assert.ok(!ids.has(m.id)); ids.add(m.id);
    assert.doesNotMatch(m.text, /https?:\/\//i, "no links");
    assert.doesNotMatch(m.text, /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, "no emails");
    assert.doesNotMatch(m.text, /[A-Za-z0-9+/_-]{32,}/, "nothing token-like");
    assert.doesNotMatch(m.text, /\b(gh[pousr]_|sk-|xox[abprs]-|eyJ)[A-Za-z0-9]/, "no known token prefixes");
    assert.doesNotMatch(m.text, /[A-Za-z]:\\Users\\/i, "no home paths");
  }
});
