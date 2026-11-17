import fs from "node:fs";
import path from "node:path";
import { git } from "../git/git.js";
import { loadSettings, type ProjectConfig, type TeamMember } from "./config.js";
import { clients } from "../connectors/registry.js";

/**
 * The team: who works on a repository and who reviews its pull requests.
 * Learned at onboarding from the repository (CODEOWNERS, git history) and GitHub (contributors), then confirmed by the user.
 */

const CODEOWNERS_FILES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export interface OwnerRule { pattern: string; owners: string[] }

export function readCodeowners(repo: string): OwnerRule[] {
  for (const f of CODEOWNERS_FILES) {
    let text = "";
    try { text = fs.readFileSync(path.join(repo, f), "utf8"); } catch { continue; }
    return parseCodeowners(text);
  }
  return [];
}

export function parseCodeowners(text: string): OwnerRule[] {
  return text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean).map((l) => {
    const [pattern, ...owners] = l.split(/\s+/);
    return { pattern, owners: owners.filter((o) => o.startsWith("@")).map((o) => o.slice(1)) };
  }).filter((r) => r.owners.length);
}

/** CODEOWNERS semantics: the LAST matching rule wins for each file. */
export function ownersFor(rules: OwnerRule[], files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    let hit: OwnerRule | undefined;
    for (const r of rules) if (codeownersMatch(r.pattern, f)) hit = r;
    for (const o of hit?.owners ?? []) out.add(o);
  }
  return [...out];
}

export function codeownersMatch(pattern: string, file: string): boolean {
  let p = pattern;
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  if (p.endsWith("/")) p += "**";
  const re = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  if (p === "*") return true;
  const hasSlash = p.includes("/");
  const full = new RegExp(`^${re}(/.*)?$`);
  if (anchored || hasSlash) return full.test(file);
  // a bare name matches at any depth
  return new RegExp(`(^|/)${re}(/.*)?$`).test(file);
}

export interface TeamSuggestion {
  me?: string;
  members: { github: string; name?: string; email?: string; commits: number }[];
  codeowners: string[];
  codeownersFile: boolean;
}

/** People who worked on the repository recently (git authors over 6 months), matched to GitHub logins where possible. */
export async function suggestTeam(project: ProjectConfig): Promise<TeamSuggestion> {
  const repo = project.local.path;
  const rules = readCodeowners(repo);
  const codeowners = [...new Set(rules.flatMap((r) => r.owners))];
  const gh = clients.github();
  let me: string | undefined;
  try { me = gh ? (await gh.user()).login : undefined; } catch { /* offline */ }
  const byLogin = new Map<string, { github: string; name?: string; email?: string; commits: number }>();
  if (gh?.contributors && project.github?.repo) {
    try {
      for (const c of await gh.contributors(project.github.repo)) {
        if (/\[bot\]$|^dependabot|^renovate/i.test(c.login)) continue;
        byLogin.set(c.login.toLowerCase(), { github: c.login, commits: c.contributions, name: c.name });
      }
    } catch { /* fall back to git */ }
  }
  // names and e-mails from git history (6 months) – GitHub's noreply addresses give the login directly
  const log = git(repo, ["log", "--since=6.months", "--no-merges", "--format=%aN\t%aE"], { allowFail: true });
  const authors = new Map<string, { name: string; email: string; commits: number }>();
  for (const line of log.split("\n").filter(Boolean)) {
    const [name, email] = line.split("\t");
    const k = (email ?? name).toLowerCase();
    const a = authors.get(k) ?? { name, email, commits: 0 };
    a.commits++;
    authors.set(k, a);
  }
  for (const a of authors.values()) {
    const login = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(a.email)?.[1];
    const match = login ? byLogin.get(login.toLowerCase()) : [...byLogin.values()].find((m) => m.name && m.name.toLowerCase() === a.name.toLowerCase());
    if (match) { match.name ??= a.name; match.email ??= a.email; continue; }
    if (login) byLogin.set(login.toLowerCase(), { github: login, name: a.name, email: a.email, commits: a.commits });
  }
  const members = [...byLogin.values()].filter((m) => m.github.toLowerCase() !== me?.toLowerCase()).sort((a, b) => b.commits - a.commits).slice(0, 15);
  return { me, members, codeowners, codeownersFile: rules.length > 0 };
}

/** Reviewers for a PR: the project's list, or CODEOWNERS of the changed files – never the author themself. */
export function reviewersFor(project: ProjectConfig, changedFiles: string[], author?: string): { users: string[]; teams: string[] } {
  const r = project.reviewers;
  if (!r) return { users: [], teams: [] };
  const logins = r.from === "codeowners" ? ownersFor(readCodeowners(project.local.path), changedFiles) : r.logins;
  const me = (author ?? loadSettings().team.me?.github ?? "").toLowerCase();
  const clean = [...new Set(logins.map((l) => l.replace(/^@/, "")).filter((l) => l && l.toLowerCase() !== me))];
  return { users: clean.filter((l) => !l.includes("/")), teams: clean.filter((l) => l.includes("/")).map((l) => l.split("/")[1]) };
}

export function memberName(login: string): string {
  const m = loadSettings().team.members.find((x: TeamMember) => x.github.toLowerCase() === login.toLowerCase());
  return m?.name || login;
}

// ------------------------------------------------------------------ A9: the weekly team check

export const TEAM_CHECK_EVERY_MS = 7 * 86_400_000;
/** A newcomer is mentioned once they have this many commits in the last 6 months. */
const NEW_MEMBER_COMMITS = 3;

export interface TeamChange { project: string; joined: { github: string; name?: string; commits: number }[]; quiet: string[] }

/**
 * Who joined or went quiet on each repository, compared with your team list (settings.team). Code only: git history and
 * GitHub contributors. Nothing is changed – the message says what to reply ("add @x to the team" / "Eric left the team").
 */
export async function detectTeamChanges(projects: ProjectConfig[]): Promise<TeamChange[]> {
  const s = loadSettings();
  const known = new Set((s.team.members ?? []).map((m) => m.github.toLowerCase()));
  const me = s.team.me?.github?.toLowerCase();
  const out: TeamChange[] = [];
  const activeAnywhere = new Set<string>();
  const perProject: { p: ProjectConfig; t: TeamSuggestion }[] = [];
  for (const p of projects) {
    try {
      const t = await suggestTeam(p);
      perProject.push({ p, t });
      for (const m of t.members) activeAnywhere.add(m.github.toLowerCase());
    } catch { /* a repository that can't be read is skipped */ }
  }
  for (const { p, t } of perProject) {
    const joined = t.members.filter((m) => m.commits >= NEW_MEMBER_COMMITS && !known.has(m.github.toLowerCase()) && m.github.toLowerCase() !== me);
    if (joined.length) out.push({ project: p.id, joined: joined.map((m) => ({ github: m.github, name: m.name, commits: m.commits })), quiet: [] });
  }
  // a teammate with no commits on ANY repository for 6 months may have left (only said when every repository was read)
  if (perProject.length && perProject.length === projects.length) {
    const quiet = (s.team.members ?? []).filter((m) => !activeAnywhere.has(m.github.toLowerCase())).map((m) => m.name || m.github);
    if (quiet.length) out.push({ project: "*", joined: [], quiet });
  }
  return out;
}

/** The one-line message per change (plain, short). */
export function teamChangeLines(changes: TeamChange[]): string[] {
  const lines: string[] = [];
  for (const c of changes) {
    for (const j of c.joined) lines.push(`New on ${c.project}: @${j.github}${j.name && j.name !== j.github ? ` (${j.name})` : ""}, ${j.commits} commits. Say "add @${j.github} to the team" to add them as a reviewer.`);
    for (const q of c.quiet) lines.push(`${q} has no commits in 6 months. Say "${q} left the team" to remove them.`);
  }
  return lines;
}

/** Once a week: detect team changes and send ONE message when there are any. Returns the lines sent. */
export async function weeklyTeamCheck(now = new Date(), projects?: ProjectConfig[]): Promise<string[]> {
  const { getMeta, setMeta } = await import("./db.js");
  const last = Date.parse(getMeta("team.check.at") ?? "");
  if (Number.isFinite(last) && now.getTime() - last < TEAM_CHECK_EVERY_MS) return [];
  setMeta("team.check.at", now.toISOString());
  const { loadProjects } = await import("./config.js");
  const list = projects ?? loadProjects();
  if (!list.length) return [];
  const lines = teamChangeLines(await detectTeamChanges(list));
  if (!lines.length) return [];
  const { notify } = await import("../notify/router.js");
  await notify({ kind: "info", dedupeKey: `team-check:${now.toISOString().slice(0, 10)}`, title: "👥 Team changes", body: lines.slice(0, 8).join("\n") });
  return lines;
}
