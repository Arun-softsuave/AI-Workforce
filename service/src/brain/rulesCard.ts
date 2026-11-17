import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getProject, loadSettings, type ProjectConfig } from "../core/config.js";
import { paths } from "../core/paths.js";
import { truncate } from "../core/util.js";
import { audit } from "../core/db.js";
import { getRunner, untrusted } from "../agents/runner.js";
import { recordUsage } from "../engine/tasks.js";
import { AGENTS } from "../agents/catalog.js";
import { docstringLine, NEVER_PUSH } from "./standards.js";
import { ciSummaryLines } from "./ciPipeline.js";

/**
 * The rules card: everything an agent must follow in this repository, in ~1,500 tokens.
 * Built once per repository (and again only when its inputs change); every coding, review and fix prompt
 * starts with it, so it is a stable, cacheable prefix instead of the raw instruction files pasted each time.
 *
 * Everything is learned by code from the repository except the "Team rules": when the team's instruction files
 * (CLAUDE.md, CONTRIBUTING.md, …) are long, ONE model call condenses them to short rules, cached by content hash.
 */

const INLINE_LIMIT = 2500;        // instruction files up to this size are used word for word
const CARD_LIMIT = 7000;          // characters (~1,700 tokens)

export function rulesCardPath(projectId: string): string { return path.join(paths.projectDir(projectId), "rules-card.md"); }
function teamRulesCache(projectId: string): string { return path.join(paths.projectDir(projectId), "team-rules.json"); }

function readRepo(repo: string, rel: string): string { try { return fs.readFileSync(path.join(repo, rel), "utf8"); } catch { return ""; } }

/** The team's own instruction files, condensed when they are long (one cached model call). */
export async function teamRules(p: ProjectConfig, opts: { useAi?: boolean } = {}): Promise<{ text: string; source: "verbatim" | "condensed" | "cached" | "truncated" | "none"; tokens: number }> {
  const files = p.conventions?.instructionFiles ?? [];
  if (!files.length) return { text: "", source: "none", tokens: 0 };
  const raw = files.map((f) => `### ${f}\n${readRepo(p.local.path, f).trim()}`).join("\n\n");
  if (raw.length <= INLINE_LIMIT) return { text: raw, source: "verbatim", tokens: 0 };
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  try {
    const c = JSON.parse(fs.readFileSync(teamRulesCache(p.id), "utf8"));
    if (c.hash === hash && c.text) return { text: c.text, source: "cached", tokens: 0 };
  } catch { /* not cached yet */ }
  if (opts.useAi !== false && loadSettings().models.provider !== "mock") {
    const def = AGENTS["rules-writer"];
    const r = await getRunner().run({
      agent: "rules-writer", tier: def.tier, system: def.system, schema: def.schema, tools: [], maxTurns: 2, maxBudgetUsd: 0.5,
      prompt: `Repository: ${p.id}\n\n${untrusted("instruction-files", truncate(raw, 40_000))}`,
    });
    recordUsage(`rules-card:${p.id}`, r, { agent: "rules-writer" });
    const rules: string[] = Array.isArray(r.data?.rules) ? r.data.rules.map(String).filter(Boolean) : [];
    if (r.ok && rules.length) {
      const text = rules.map((x) => `- ${x.replace(/^[-•]\s*/, "")}`).join("\n");
      fs.mkdirSync(path.dirname(teamRulesCache(p.id)), { recursive: true });
      fs.writeFileSync(teamRulesCache(p.id), JSON.stringify({ hash, text, files, at: new Date().toISOString() }, null, 1));
      return { text, source: "condensed", tokens: r.tokensIn + r.tokensOut };
    }
  }
  return { text: truncate(raw, INLINE_LIMIT), source: "truncated", tokens: 0 };
}

/** Render the card from what was learned. Pure – no I/O except reading the team rules text passed in. */
export function renderRulesCard(p: ProjectConfig, team: string): string {
  const c = p.conventions;
  const s = loadSettings();
  const lines: string[] = [`# Repository rules – ${p.id}${p.github?.repo ? ` (${p.github.repo})` : ""}`, "Follow these exactly; they are the team's own conventions.", ""];
  lines.push("## Git and pull requests");
  if (c) {
    lines.push(`- Base branch: \`${c.baseBranch}\`. Pull requests go to \`${c.baseBranch}\`${s.pr?.draft ? " as drafts" : ""}; nothing is ever merged by you.`);
    lines.push(`- Branch names: \`${c.branchTemplate}\`${Object.keys(c.branchTypes).length ? ` (${Object.entries(c.branchTypes).map(([k, v]) => `${k} → ${v}`).join(", ")})` : ""}.`);
    lines.push(`- Commit subjects: \`${c.commitTemplate}\` – imperative, specific, ≤ 72 characters, no trailing period.`);
    if (c.prTemplate) lines.push(`- PR description: fill in the team's template \`${c.prTemplate}\` section by section.`);
  }
  lines.push("- Never mention Claude, AI or any assistant in code, comments, commits, branches or PRs.");
  const std = c?.standards;
  if (std) {
    lines.push("", "## Code style");
    for (const d of std.docstrings) lines.push(`- ${docstringLine(d)}`);
    const ex = std.docstrings.find((d) => d.example);
    if (ex) lines.push("", `Example from \`${ex.exampleFile}\` – copy this shape:`, "```", ex.example!.trim(), "```");
    if (c?.checks.length) lines.push(`- Lint / format / types must pass: ${c.checks.map((x) => `\`${x.replace(/\{(py|js|all)\}/g, "<files>")}\``).join(", ")}.`);
    lines.push("", "## Tests");
    if (std.tests.count) {
      lines.push(`- Tests live in ${std.tests.dirs.map((d) => `\`${d}\``).join(", ")}${std.tests.patterns.length ? ` and are named ${std.tests.patterns.map((x) => `\`${x}\``).join(" / ")}` : ""} (${std.tests.count} test files, e.g. \`${std.tests.example}\`).`);
      lines.push("- Add or update tests there, next to the existing tests for the same area; follow their fixtures and style.");
    } else lines.push("- The repository has no test suite yet; add tests only if the ticket asks for them.");
  }
  lines.push("", "## Never commit");
  lines.push(`- ${[...new Set(NEVER_PUSH.map((n) => n.why))].join("; ")}.`);
  lines.push("- Test files outside the test layout above, one-off scripts used to check something, and anything you created only to debug.");
  const ci = c?.ci;
  if (ci?.jobs.length) {
    lines.push("", "## CI on every pull request");
    for (const l of ciSummaryLines(ci)) lines.push(`- ${l}`);
    lines.push("- Never weaken or delete a test, edit a CI workflow, or re-record a baseline to make CI pass.");
  }
  if (team.trim()) lines.push("", "## Team rules (from the repository's own instruction files)", team.trim());
  return truncate(lines.join("\n"), CARD_LIMIT);
}

/** Build (or rebuild) and store the card. Cheap: one model call at most, and only when the instruction files changed. */
export async function buildRulesCard(projectId: string, opts: { useAi?: boolean } = {}): Promise<{ card: string; file: string; teamRules: string; tokens: number }> {
  const p = getProject(projectId);
  if (!p) throw new Error(`Unknown project ${projectId}`);
  const team = await teamRules(p, opts);
  const card = renderRulesCard(p, team.text);
  const file = rulesCardPath(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, card);
  audit("service", "rules_card.built", projectId, { chars: card.length, teamRules: team.source, tokens: team.tokens });
  return { card, file, teamRules: team.source, tokens: team.tokens };
}

export function readRulesCard(projectId: string): string | undefined {
  try { return fs.readFileSync(rulesCardPath(projectId), "utf8"); } catch { return undefined; }
}
