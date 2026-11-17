import { makeRepo } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject } from "../core/config.js";
import { extractText, splitSections, addDocument, listDocuments } from "../brain/docs.js";
import { buildContextPack, brainSummary } from "../brain/brain.js";
import { rebuildIndex, searchBrain } from "../brain/index.js";
import { agentEnv } from "../agents/runner.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test-fixtures");
saveSettings({ ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" } });
const be = makeRepo("doc-backend"), fe = makeRepo("doc-frontend");
upsertProject(normaliseProject({ id: "d-backend", group: "nue", jira: { site: "x", keys: ["KAN"] }, local: { path: be.repo }, roles: ["fullstack-developer"] }));
upsertProject(normaliseProject({ id: "d-frontend", group: "nue", jira: { site: "x", keys: ["KAN"] }, local: { path: fe.repo }, roles: ["fullstack-developer"] }));

test("text is extracted from PDF, Word and Markdown", async () => {
  const pdf = await extractText(path.join(fixtures, "prd-sample.pdf"));
  assert.match(pdf, /Requests over 2000 characters are rejected/);
  const docx = await extractText(path.join(fixtures, "requirements-sample.docx"));
  assert.match(docx, /at most 5000 products/);
  const md = path.join(os.tmpdir(), "aiw-prd.md");
  fs.writeFileSync(md, "# PRD\n\n## Login\nUsers sign in with email.\n");
  assert.match(await extractText(md), /sign in with email/);
  await assert.rejects(extractText("x.pptx"), /Unsupported/);
});

test("documents are split into heading-based sections with a size cap", () => {
  const s = splitSections("# A\nalpha\n## B\n" + "word ".repeat(1000) + "\n\nmore " .repeat(400));
  assert.equal(s[0].heading, "A");
  assert.ok(s.every((x) => x.body.length <= 1800 + 10));
  assert.ok(s.some((x) => x.heading.startsWith("B (part")));
});

test("a PRD stored for a multi-repo product reaches every repo's task context", async () => {
  const res = await addDocument(["d-backend", "d-frontend"], path.join(fixtures, "prd-sample.pdf"), { title: "Nue PRD" });
  assert.equal(res.length, 2);
  assert.ok(fs.existsSync(path.join(be.repo, ".ai-workforce", "knowledge", "docs", "nue-prd.md")));
  assert.ok(fs.existsSync(path.join(fe.repo, ".ai-workforce", "knowledge", "docs", "nue-prd.md")));
  const pack = buildContextPack("d-frontend", "KAN-42 Input guard: validate buyer input and reject long requests");
  assert.match(pack.text, /Product requirements \(from project documents\)/);
  assert.match(pack.text, /2000 characters/);
  assert.match(brainSummary("d-backend"), /Documents: Nue PRD/);
  // survives a full index rebuild
  rebuildIndex("d-backend", be.repo);
  assert.ok(searchBrain("d-backend", "saved cards digits").some((h) => h.ref.startsWith("docs/")));
});

test("private documents stay out of the repository", async () => {
  const r = await addDocument(["d-backend"], path.join(fixtures, "requirements-sample.docx"), { title: "Supplier rules", private: true });
  assert.ok(!r[0].file.startsWith(be.repo));
  assert.ok(!fs.existsSync(path.join(be.repo, ".ai-workforce", "knowledge", "docs", "supplier-rules.md")));
  assert.ok(listDocuments("d-backend").some((d) => d.title === "Supplier rules" && d.private));
  assert.match(buildContextPack("d-backend", "supplier catalog product limit").text, /5000 products/);
});

test("claude-login passes no API key so Claude Code uses the signed-in account", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-be-used";
  const env = agentEnv("claude-login");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(agentEnv("claude").ANTHROPIC_API_KEY, "sk-ant-should-not-be-used");
  delete process.env.ANTHROPIC_API_KEY;
});
