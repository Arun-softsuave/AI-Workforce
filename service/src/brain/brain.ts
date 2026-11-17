import fs from "node:fs";
import path from "node:path";
import { getProject, loadProjects, loadSettings, type ProjectConfig } from "../core/config.js";
import { paths } from "../core/paths.js";
import { truncate } from "../core/util.js";
import { audit, getMeta, setMeta } from "../core/db.js";
import { buildRulesCard } from "./rulesCard.js";
import { logger } from "../core/log.js";
import { buildCodeMap, loadCodeMap, findInMap, mapSummary, type CodeMap } from "./codemap.js";
import { readDoc, setNarrative, addFact, activeFacts, setFactStatus, readHandbook, type HandbookFile } from "./handbook.js";
import { rebuildIndex, searchBrain, queryTerms, writeDiary, indexDiaryEntry } from "./index.js";
import { getRunner, untrusted } from "../agents/runner.js";
import { recordUsage } from "../engine/tasks.js";
import { AGENTS } from "../agents/catalog.js";
import { git } from "../git/git.js";
import { listDocuments } from "./docs.js";
import { detectConventions } from "./conventions.js";

/** Day-one study of a project (Brain Architecture doc §2). Resumable and budgeted. */
export async function onboardProject(projectId: string, opts: { useAi?: boolean; full?: boolean } = {}): Promise<{ map: CodeMap; facts: number; tokens: number; mode: "full" | "incremental" | "unchanged" | "offline" }> {
  const p = mustProject(projectId);
  const repo = p.local.path;
  // 1-3: look around, draw the map, find what matters (zero tokens)
  const map = buildCodeMap(projectId, repo, loadCodeMap(projectId));
  const readme = readFirst(repo, ["README.md", "readme.md", "README.rst", "docs/README.md"], 6000);
  let tokens = 0;
  let factCount = 0;
  let mode: "full" | "incremental" | "unchanged" | "offline" = "offline";
  // What was studied last time: re-onboarding only reads what changed since then (git diff), not the whole repository again.
  const head = git(repo, ["rev-parse", "HEAD"], { allowFail: true }).trim();
  const lastSha = getMeta(`brain.sha.${projectId}`);
  const hasHandbook = !!readDoc(repo, "overview").narrative && !!readDoc(repo, "architecture").narrative;
  const changed = lastSha && hasHandbook && !opts.full
    ? git(repo, ["diff", "--name-only", `${lastSha}..HEAD`], { allowFail: true }).split("\n").map((s) => s.trim()).filter(Boolean)
    : undefined;
  // 4-6: read closely + learn habits + learn business (AI, budgeted). The offline mock model has nothing to add here.
  if (opts.useAi !== false && loadSettings().models.provider !== "mock" && !(changed && changed.length === 0)) {
    const def = AGENTS.onboarder;
    const incremental = !!changed;
    mode = incremental ? "incremental" : "full";
    const prompt = incremental
      ? [
        `Project: ${projectId}. You studied this repository before; update the Handbook for what changed since then.`,
        "## Current Handbook", untrusted("handbook", truncate(["overview", "architecture", "standards", "glossary"].map((d) => `### ${d}\n${readDoc(repo, d as HandbookFile).narrative ?? ""}`).join("\n\n"), 12_000)),
        `## Files changed since the last study (${changed!.length})\n${changed!.slice(0, 80).join("\n")}`,
        "Read only the changed files that matter. Return the full, updated sections (keep what is still true) and only NEW facts.",
      ].join("\n\n")
      : [
        `Project: ${projectId}`, "## Code map (most important files first)", mapSummary(map, 40),
        "## README", untrusted("readme", readme || "(none)"),
        `## Files worth reading first\n${map.files.slice(0, 30).map((f) => f.path).join("\n")}`,
        "Recent merged work (commit subjects):", untrusted("git-log", recentCommits(repo)),
      ].join("\n\n");
    const r = await getRunner().run({
      agent: "onboarder", tier: def.tier, system: def.system, schema: def.schema, cwd: repo,
      tools: def.tools, maxTurns: incremental ? 12 : 20, maxBudgetUsd: incremental ? 1 : 2, prompt,
    });
    recordUsage(`brain:${projectId}`, r, { agent: "onboarder" });
    tokens = r.tokensIn + r.tokensOut;
    if (r.ok && r.data) {
      const d = r.data;
      if (d.overview) setNarrative(repo, "overview", d.overview);
      if (d.architecture) setNarrative(repo, "architecture", d.architecture);
      if (d.standards) setNarrative(repo, "standards", d.standards);
      if (d.glossary) setNarrative(repo, "glossary", d.glossary);
      for (const f of d.facts ?? []) { addFact(repo, f.file as HandbookFile, f.text, "onboarding scan"); factCount++; }
    } else {
      logger.warn("onboarding AI step failed; using offline summary", { error: r.error });
    }
  }
  // Always make sure the Handbook has at least an offline baseline.
  if (!readDoc(repo, "overview").narrative) setNarrative(repo, "overview", offlineOverview(projectId, map, readme));
  if (!readDoc(repo, "architecture").narrative) setNarrative(repo, "architecture", mapSummary(map, 20));
  if (map.stack.testCommand) addFact(repo, "standards", `Tests are run with \`${map.stack.testCommand}\`.`, "manifest detection");
  for (const fw of map.stack.frameworks) addFact(repo, "architecture", `The project uses ${fw}.`, "manifest detection");
  // Team conventions (base branch, branch/commit style, rule files, PR template, checks, docstrings, test layout, CI, Jira ticket style)
  try { await detectConventions(projectId); } catch (e: any) { logger.warn("convention detection failed", { error: e.message }); }
  // The rules card every agent starts with (one model call at most, only when the team's instruction files are long)
  try { tokens += (await buildRulesCard(projectId, { useAi: opts.useAi })).tokens; } catch (e: any) { logger.warn("rules card failed", { error: e.message }); }
  // 7: write the index; 8: user confirms via `aiw brain confirm`
  rebuildIndex(projectId, repo);
  if (head) setMeta(`brain.sha.${projectId}`, head);
  if (changed && changed.length === 0) mode = "unchanged";
  audit("service", "brain.onboarded", projectId, { files: map.files.length, facts: factCount, tokens, mode });
  return { map, facts: factCount, tokens, mode };
}

/** Re-map only changed files and refresh the index (after pulls or finished tasks). */
export function refreshProject(projectId: string): void {
  const p = mustProject(projectId);
  buildCodeMap(projectId, p.local.path, loadCodeMap(projectId));
  rebuildIndex(projectId, p.local.path);
  // Conventions are re-detected at most once a day, so new rule files or a changed workflow are picked up automatically.
  const age = Date.now() - new Date(p.conventions?.detectedAt ?? 0).getTime();
  // the rules card is rebuilt with it (a model call only when the team's instruction files changed)
  if (age > 24 * 3_600_000) detectConventions(projectId).then(() => buildRulesCard(projectId)).catch(() => {});
}

export function confirmBrain(projectId: string): number {
  const p = mustProject(projectId);
  const n = setFactStatus(p.local.path, "all-unverified", "verified");
  rebuildIndex(projectId, p.local.path);
  audit("user", "brain.confirmed", projectId, { facts: n });
  return n;
}

export interface ContextPack { text: string; files: string[]; hits: number }

/**
 * Build the small context pack an agent receives instead of the repository (Brain doc §5).
 * Always: overview + standards (+ personal prefs). Then: index hits, map files, similar past tasks. Hard size cap.
 */
export function buildContextPack(projectId: string, ticketText: string, maxChars = 12000): ContextPack {
  const p = mustProject(projectId);
  const repo = p.local.path;
  const parts: string[] = [];
  const overview = readDoc(repo, "overview").narrative;
  const standards = readDoc(repo, "standards");
  parts.push(`## Project overview\n${truncate(overview || "(not yet onboarded)", 1500)}`);
  const stdFacts = standards.facts.filter((f) => f.status !== "replaced").map((f) => `- ${f.text}${f.status === "unverified" ? " (unverified)" : ""}`);
  parts.push(`## Team standards\n${truncate([standards.narrative, ...stdFacts].filter(Boolean).join("\n"), 1500)}`);
  const prefs = readFirst(path.dirname(paths.globalPrefs()), ["me.md"], 600);
  if (prefs) parts.push(`## User preferences\n${prefs}`);

  const allHits = searchBrain(projectId, ticketText, 12, ["knowledge", "diary"]);
  const docHits = allHits.filter((h) => h.ref.startsWith("docs/")).slice(0, 4);
  const hits = allHits.filter((h) => !h.ref.startsWith("docs/")).slice(0, 8);
  if (docHits.length) parts.push(`## Product requirements (from project documents)\n${docHits.map((h) => `### ${h.title}\n${truncate(h.body, 900)}`).join("\n\n")}`);
  if (hits.length) parts.push(`## Relevant knowledge & past tasks\n${hits.map((h) => `- [${h.kind}: ${h.ref}] ${truncate(h.body.replace(/\s+/g, " "), 300)}`).join("\n")}`);

  const map = loadCodeMap(projectId);
  const files = map ? findInMap(map, queryTerms(ticketText, 15), 10) : [];
  if (files.length) parts.push(`## Likely relevant files\n${files.map((f) => `- ${f.path}${f.symbols.length ? ` — ${f.symbols.slice(0, 6).join(", ")}` : ""}${f.routes.length ? ` [${f.routes.slice(0, 3).join("; ")}]` : ""}`).join("\n")}`);
  if (map) parts.push(`## Build & test\nTest command: ${p.local.testCommand ?? map.stack.testCommand ?? "none detected"}`);

  const groupPeers = p.group ? loadProjects().filter((x) => x.group === p.group && x.id !== p.id).map((x) => x.id) : [];
  for (const rel of [...new Set([...(p.related ?? []), ...groupPeers])]) {
    const rp = getProject(rel);
    if (!rp) continue;
    const relHits = searchBrain(rel, ticketText, 3, ["knowledge"]);
    if (relHits.length) parts.push(`## Related project "${rel}" (read-only)\n${relHits.map((h) => `- ${truncate(h.body, 200)}`).join("\n")}`);
  }
  return { text: truncate(parts.join("\n\n"), maxChars), files: files.map((f) => f.path), hits: hits.length + docHits.length };
}

/** Diary entry + index update after a task (Brain doc §6). Facts are proposed into the worktree so they travel in the PR. */
export function recordTaskMemory(projectId: string, key: string, content: string, title: string): void {
  const file = writeDiary(projectId, key, content);
  indexDiaryEntry(projectId, path.basename(file), title, content);
}

export function proposeFacts(targetRepo: string, facts: { file: string; text: string }[], source: string): number {
  let n = 0;
  for (const f of facts.slice(0, 5)) { addFact(targetRepo, f.file as HandbookFile, f.text, source, "unverified"); n++; }
  return n;
}

export function brainSummary(projectId: string): string {
  const p = mustProject(projectId);
  const docs = readHandbook(p.local.path);
  const map = loadCodeMap(projectId);
  const facts = activeFacts(p.local.path);
  const unverified = facts.filter((f) => f.status === "unverified").length;
  return [
    `Brain for "${projectId}" (${p.local.path})`,
    `Map: ${map ? `${map.files.length} files, generated ${map.generatedAt}` : "not built"}`,
    `Handbook: ${docs.filter((d) => d.narrative).length}/5 sections, ${facts.length} active facts (${unverified} unverified)`,
    `Documents: ${listDocuments(projectId).map((d) => `${d.title}${d.private ? " (private)" : ""}`).join(", ") || "none – add a PRD with \`aiw brain add-doc\`"}`,
    "", truncate(docs[0].narrative, 1200),
  ].join("\n");
}

export function askBrain(projectId: string, question: string): string {
  const hits = searchBrain(projectId, question, 8);
  if (!hits.length) return "Nothing relevant found in the Brain yet.";
  return hits.map((h) => `[${h.kind}] ${h.ref}\n  ${truncate(h.body.replace(/\s+/g, " "), 400)}`).join("\n");
}

function mustProject(id: string): ProjectConfig {
  const p = getProject(id);
  if (!p) throw new Error(`Unknown project "${id}"`);
  return p;
}

function readFirst(dir: string, names: string[], max: number): string {
  for (const n of names) {
    try { return truncate(fs.readFileSync(path.join(dir, n), "utf8"), max); } catch { /* next */ }
  }
  return "";
}

function recentCommits(repo: string): string {
  return git(repo, ["log", "--no-merges", "-n", "50", "--pretty=%s"], { allowFail: true });
}

function offlineOverview(id: string, map: CodeMap, readme: string): string {
  const firstPara = readme.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith("#")) ?? "";
  return [`${id}: ${firstPara.trim() || "no README description found."}`, "", mapSummary(map, 10)].join("\n");
}
