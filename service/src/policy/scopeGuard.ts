import { effective } from "./directives.js";
import { loadProjects, type ProjectConfig } from "../core/config.js";

/**
 * "only backend", "don't touch tests", "don't touch the migrations" (B20, J6, R-DIR): your area rules reach the
 * planner and the coding agent, a repository outside "only …" is not changed at all, and before anything is
 * published the changed files are checked – a file the rules keep out is put back as it was, and listed.
 */

export interface ScopeRules { only?: string; dontTouch?: string }

/** The area rules in force for an item (item > batch > epic > sprint > global). */
export function scopeRules(item: string | { id: string } | undefined | null): ScopeRules {
  if (!item) return {};
  const only = effective(item, "only").value;
  const dont = effective(item, "dont_touch").value;
  return { only: only ? String(only) : undefined, dontTouch: dont ? String(dont) : undefined };
}

/** Words that name a kind of repository rather than a folder. */
const REPO_WORDS: Record<string, RegExp> = {
  backend: /back|api|server|service/i,
  frontend: /front|web|ui|client|app\b|portal/i,
  mobile: /mobile|ios|android|app$/i,
  admin: /admin/i,
};

const parts = (v: string) => v.split(/\s*(?:,|;|\band\b|\bor\b|&|\+)\s*/i).map((x) => x.trim().replace(/^(the|my|our)\s+/i, "")).filter(Boolean);

/** A repository word ("backend") that this project matches – or undefined when the word names no repository kind. */
function repoWord(w: string): RegExp | undefined {
  const k = w.toLowerCase().replace(/\s+(repo|repository|side|part|code)$/, "");
  return REPO_WORDS[k];
}

/**
 * Is this repository outside "only …"? True only when the rule names repository kinds ("only backend"), none of them
 * matches this project, and at least one other configured project does match (so the rule is really about repos).
 */
export function repoExcluded(project: Pick<ProjectConfig, "id">, rules: ScopeRules, all: Pick<ProjectConfig, "id">[] = loadProjects()): boolean {
  if (!rules.only) return false;
  const words = parts(rules.only).map(repoWord).filter((x): x is RegExp => !!x);
  if (!words.length) return false;
  if (words.some((re) => re.test(project.id))) return false;
  return all.some((p) => p.id !== project.id && words.some((re) => re.test(p.id)));
}

/** Path patterns for one area word: a glob, a folder, a file, or a plain word ("tests", "migrations", "styles"). */
function matcher(area: string): (file: string) => boolean {
  const a = area.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (/^tests?$|^test files?$|^specs?$/i.test(a)) return (f) => /(^|\/)(tests?|__tests__|specs?)\/|[._-](test|spec)\.[a-z]+$|^test_|\/test_[^/]+$/i.test(f);
  if (/^migrations?$/i.test(a)) return (f) => /(^|\/)(migrations?|alembic\/versions)\//i.test(f);
  if (/^(ci|workflows?|pipelines?)$/i.test(a)) return (f) => /^\.github\/workflows\/|^\.gitlab-ci|(^|\/)ci\//i.test(f);
  if (/^(docs?|documentation)$/i.test(a)) return (f) => /(^|\/)docs?\/|\.md$/i.test(f);
  if (/[*?]/.test(a)) {
    const re = new RegExp(`^${a.split("**").map((x) => x.split("*").map((y) => y.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join("[^/]*")).join(".*")}$`, "i");
    return (f) => re.test(f) || re.test(f.split("/").pop() ?? "");
  }
  if (a.includes("/") || /\.[a-z0-9]+$/i.test(a)) {
    const p = a.replace(/\/+$/, "");
    return (f) => f === p || f.startsWith(`${p}/`) || f.endsWith(`/${p}`) || f.includes(`/${p}/`);
  }
  const w = a.toLowerCase().replace(/\s+/g, "[-_ ]?");
  const re = new RegExp(`(^|/)[^/]*${w}[^/]*(/|$)`, "i");
  return (f) => re.test(f);
}

/** The changed files the rules keep out, with the reason for each. */
export function scopeViolations(files: string[], rules: ScopeRules): { file: string; why: string }[] {
  const out: { file: string; why: string }[] = [];
  const dont = rules.dontTouch ? parts(rules.dontTouch).map((a) => ({ a, m: matcher(a) })) : [];
  // "only" with folder / area words (not repository words) limits the files too
  const onlyAreas = rules.only ? parts(rules.only).filter((w) => !repoWord(w)) : [];
  const only = onlyAreas.map((a) => matcher(a));
  for (const f of files) {
    const hit = dont.find((d) => d.m(f));
    if (hit) { out.push({ file: f, why: `you said don't touch ${hit.a}` }); continue; }
    if (only.length && !only.some((m) => m(f))) out.push({ file: f, why: `you said only ${onlyAreas.join(", ")}` });
  }
  return out;
}

/** The block for the planner and the coding agent (empty when no area rule is in force). */
export function scopePrompt(rules: ScopeRules): string {
  const lines: string[] = [];
  if (rules.only) lines.push(`- Change ONLY: ${rules.only}. Leave everything else exactly as it is.`);
  if (rules.dontTouch) lines.push(`- Do NOT change: ${rules.dontTouch} (not even small edits). If the work needs it, say so in your notes instead.`);
  return lines.length ? `## The developer's rules for this work (must be followed)\n${lines.join("\n")}` : "";
}
