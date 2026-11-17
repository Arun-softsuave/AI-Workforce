import { makeRepo } from "../helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { saveSettings, loadSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../../core/config.js";
import { createItem } from "../../kernel/items.js";
import { createTask, mergeData } from "../../engine/tasks.js";
import { activeDirectives } from "../../policy/directives.js";
import { main } from "../../cli/main.js";

/** The wave-3 commands on this computer: aiw rules (list/add/remove), aiw explain, aiw items (tree), aiw config engine. */
const { repo } = makeRepo("shop");
saveSettings({ ...structuredClone(DEFAULT_SETTINGS), profile: { name: "Owner", workingHours: "00:00-23:59", roles: ["backend-developer"] },
  models: { ...DEFAULT_SETTINGS.models, provider: "mock" }, notifications: { ...DEFAULT_SETTINGS.notifications, primary: "inbox", fallback: [] } });
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" }, local: { path: repo }, roles: ["backend-developer"], autonomy: "prepare" }));

async function aiw(...args: string[]): Promise<{ code: number; out: string }> {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...a: any[]) => { printed.push(a.join(" ")); };
  try { const code = await main(args); return { code, out: printed.join("\n") }; } finally { console.log = log; }
}

test("aiw rules: add for one ticket, list with the plain echo, remove → back to normal", async () => {
  createTask({ projectId: "shop", source: "jira", sourceId: "id-KAN-45", sourceRef: "KAN-45", title: "Invite email", kind: "assigned" });
  const add = await aiw("rules", "add", "plan_approval", "skip", "--ref", "KAN-45");
  assert.equal(add.code, 0, add.out);
  assert.equal(add.out, "From now on for KAN-45: no plan approval.");
  const list = await aiw("rules");
  assert.match(list.out, /^d\S*\s+From now on for KAN-45: no plan approval\./m);
  const id = activeDirectives()[0].id;
  const rm = await aiw("rules", "remove", id);
  assert.equal(rm.code, 0);
  assert.match(rm.out, /Back to normal for KAN-45/);
  assert.match((await aiw("rules")).out, /No rules in force/);
  assert.equal((await aiw("rules", "add", "auto_merge", "yes")).code, 1, "rails can't be lifted");
});

test("aiw explain <ticket>: plan, your answers, rules in force", async () => {
  const t = createTask({ projectId: "shop", source: "jira", sourceId: "id-KAN-46", sourceRef: "KAN-46", title: "Template", kind: "assigned" });
  mergeData(t.id, { plan: { summary: "Reuse the existing mail template" }, clarifications: [{ reply: "keep the old copy", answer: "keep the old copy" }] });
  await aiw("rules", "add", "dont_touch", "the migrations folder", "--ref", "KAN-46");
  const r = await aiw("explain", "KAN-46");
  assert.equal(r.code, 0);
  assert.match(r.out, /KAN-46/);
  assert.match(r.out, /Reuse the existing mail template/);
  assert.match(r.out, /You said: keep the old copy/);
  assert.match(r.out, /Rules in force: .*don't touch the migrations folder/);
  assert.equal((await aiw("explain", "KAN-999")).code, 1);
});

test("aiw items: the tree (epic → tickets), with levels and states", async () => {
  const epic = createItem({ projectId: "shop", source: "jira", sourceId: "id-KAN-40", sourceRef: "KAN-40", title: "Team invites", kind: "epic", level: "epic" });
  createItem({ projectId: "shop", source: "jira", sourceId: "id-KAN-41", sourceRef: "KAN-41", title: "Invite API", kind: "assigned", parentId: epic.id });
  const r = await aiw("items");
  assert.match(r.out, /^KAN-40 \[epic\] DETECTED – Team invites\n  KAN-41 \[ticket\] DETECTED – Invite API$/m);
  assert.match((await aiw("items", "KAN-40")).out, /^KAN-40[\s\S]*KAN-41/);
});

test("aiw config engine v1|v2", async () => {
  // this test is about the setting itself: the AIW_ENGINE test override (whole-suite runs on v2) would hide it
  const env = process.env.AIW_ENGINE;
  delete process.env.AIW_ENGINE;
  try {
    assert.match((await aiw("config", "engine")).out, /^engine v2$/);   // the kernel is the default since 1.0
    assert.equal((await aiw("config", "engine", "v1")).code, 0);
    assert.equal(loadSettings().engine.version, "v1");
    assert.equal((await aiw("config", "engine", "v3")).code, 1);
    await aiw("config", "engine", "v2");
    assert.equal(loadSettings().engine.version, "v2");
  } finally { if (env !== undefined) process.env.AIW_ENGINE = env; }
});
