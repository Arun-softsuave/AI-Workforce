import fs from "node:fs";
import YAML from "yaml";
import { paths, ensureBaseDirs } from "./paths.js";

export type Tier = "small" | "medium" | "large";
export type Autonomy = "observe" | "plan" | "prepare" | "publish-drafts";
export type Channel = "inbox" | "desktop" | "slack" | "teams" | "teams-personal";
export type Size = "S" | "M" | "L";

export interface Settings {
  profile: { name: string; timezone?: string; workingHours: string; roles: string[] };
  models: { provider: "claude" | "claude-login" | "mock"; small: string; medium: string; large: string };
  limits: {
    maxParallel: number; maxPerProject: number; burstThreshold: number;
    pollMinutes: number; pollMinutesOffHours: number; askBeforeStart: Size[];
    implementLoops: number; reviewRounds: number; maxDiffLines: number;
  };
  notifications: {
    primary: Channel; fallback: Channel[]; quietHours?: string; digestTime: string;
    jiraComments: boolean; perKind?: Partial<Record<string, Channel[]>>;
    /** true: every message goes to the primary channel only – no desktop copies, no fallback channels. */
    exclusive: boolean;
  };
  workflow: {
    /** "always": every developer task waits for plan approval before any code. "autonomy": only when the project's autonomy is "plan". */
    planApproval: "always" | "autonomy" | "skip";
    /** "ask" (default): raising the PR waits for your OK in Teams. "skip": the PR is raised as soon as it is built, tested and reviewed. */
    prApproval?: "ask" | "skip";
    /** "primary": when the primary channel is the two-way Teams chat, approvals and answers are accepted ONLY there. "any": from anywhere. */
    decisionsVia: "primary" | "any";
    /** Daily check-up message (local time, "HH:MM"), or "off". */
    checkupTime: string;
    /** How many times one task may stop and ask the user (triage, analysis, implementation, reviews together). */
    questionRounds: number;
    /** Requirement-interview rounds for work that has no ticket. */
    interviewRounds: number;
    /** When a repository's tests cannot run on this computer: "continue" (default) – build anyway, check by reading,
     *  and say clearly in Teams and in the PR that it was not tested locally; "pause" – stop until it is fixed. */
    untestedWork: "continue" | "pause";
    /** false (default): token budgets are only reported (cost line in Teams, daily check-up) and never stop a ticket.
     *  true: the per-ticket / daily token budgets pause work. */
    stopForBudget: boolean;
    /** QA runs on the PR after review fixes are pushed (default true). */
    qaAfterFix?: boolean;
    /** PDF report after every PR (default true). */
    ticketReport?: boolean;
  };
  service: { port: number };
  /** How pull requests are raised and looked after (set at onboarding: `aiw prefs`). */
  pr: {
    /** false (default): a normal, ready-for-review PR. true: a draft PR. Never merged either way. */
    draft: boolean;
    /** true (default): when CI fails on a PR the plugin raised, it fixes and pushes without asking, then reports the result. */
    autoFixCi: boolean;
    /** When a teammate asks you to review: true = review it straight away; false = tell you and wait for "review PR n". */
    autoReview: boolean;
    /** Post review comments without showing them first. */
    autoPostReview: boolean;
    /** QA findings become GitHub issues without a "create" step. */
    autoQaIssues: boolean;
  };
  /** The people you work with (both use AI Workforce): matched by GitHub login; used to request reviews and to name who did what. */
  team: { me?: { github?: string }; members: TeamMember[] };
}

export interface TeamMember { name: string; github: string; email?: string; teams?: string }

export interface ProjectConfig {
  id: string;
  jira?: { site: string; keys: string[]; jqlExtra?: string; qaStatus?: string };
  github?: { repo: string; baseBranch: string };
  local: { path: string; testCommand?: string; installCommand?: string };
  roles: string[];
  autonomy: Autonomy;
  budget: { perTaskTokens: Record<Size, number>; dailyTokens: number };
  related?: string[];
  group?: string;              // repositories sharing one Jira project (e.g. backend + frontend)
  conventions?: import("../brain/conventions.js").Conventions;   // detected per repo, user overrides win
  figma?: { fileKeys?: string[] };
  notion?: { pageIds?: string[] };
  /** PR screenshots of a frontend (on by default when the repository has a web app and Playwright). */
  screenshots?: { enabled?: boolean; buildCommand?: string; startCommand?: string; port?: number };
  /** QA engineer: a test command that works on this computer (e.g. against the test containers), when local.testCommand can't. */
  qa?: { testCommand?: string; backendStartCommand?: string; profile?: Record<string, any> };   // profile: overrides of the detected test profile
  status?: "active" | "needs-attention" | "paused";
  /** Who reviews this repository's PRs: a fixed list of GitHub logins (or "org/team"), or the owners in CODEOWNERS for the changed files. */
  reviewers?: { from: "list" | "codeowners"; logins: string[] };
}

export const DEFAULT_SETTINGS: Settings = {
  profile: { name: "", workingHours: "09:00-18:00", roles: [] },
  models: { provider: "claude", small: "claude-haiku-5-5", medium: "claude-sonnet-5-5", large: "claude-opus-5-5" },
  limits: {
    maxParallel: 3, maxPerProject: 2, burstThreshold: 5, pollMinutes: 3, pollMinutesOffHours: 3,
    askBeforeStart: ["L"], implementLoops: 3, reviewRounds: 2, maxDiffLines: 1500,
  },
  notifications: { primary: "desktop", fallback: ["inbox"], quietHours: "off", digestTime: "09:00", jiraComments: false, exclusive: true },
  workflow: { planApproval: "always", decisionsVia: "primary", checkupTime: "10:00", questionRounds: 4, interviewRounds: 5, untestedWork: "continue", stopForBudget: false, qaAfterFix: true, ticketReport: true },
  service: { port: 47821 },
  pr: { draft: false, autoFixCi: true, autoReview: false, autoPostReview: false, autoQaIssues: false },
  team: { members: [] },
};

export const DEFAULT_BUDGET: ProjectConfig["budget"] = {
  perTaskTokens: { S: 150_000, M: 600_000, L: 1_500_000 },
  dailyTokens: 4_000_000,
};

function deepMerge<T>(base: T, over: any): T {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over as T;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = k in (base as any) ? deepMerge((base as any)[k], over[k]) : over[k];
  return out;
}

/**
 * The only channel approvals and answers are accepted from, or undefined when any channel may decide.
 * With the two-way Teams chat as the primary channel, Teams is where you decide – Claude Code, the CLI,
 * the dashboard and Slack can show status but never approve.
 */
export function requiredDecisionChannel(s: Settings = loadSettings()): Channel | undefined {
  return s.workflow.decisionsVia === "primary" && s.notifications.primary === "teams-personal" ? "teams-personal" : undefined;
}

export function loadSettings(): Settings {
  ensureBaseDirs();
  if (!fs.existsSync(paths.settings())) return structuredClone(DEFAULT_SETTINGS);
  const raw = YAML.parse(fs.readFileSync(paths.settings(), "utf8")) ?? {};
  return deepMerge(structuredClone(DEFAULT_SETTINGS), raw);
}

export function saveSettings(s: Settings): void {
  ensureBaseDirs();
  fs.writeFileSync(paths.settings(), "# AI Workforce settings (managed by `aiw`; safe to edit)\n" + YAML.stringify(s));
}

export function updateSettings(patch: (s: Settings) => void): Settings {
  const s = loadSettings();
  patch(s);
  saveSettings(s);
  return s;
}

export function loadProjects(): ProjectConfig[] {
  ensureBaseDirs();
  if (!fs.existsSync(paths.projects())) return [];
  const raw = YAML.parse(fs.readFileSync(paths.projects(), "utf8")) ?? {};
  const map = raw.projects ?? {};
  return Object.entries(map).map(([id, p]: [string, any]) => normaliseProject({ ...p, id }));
}

export function normaliseProject(p: any): ProjectConfig {
  return {
    id: p.id,
    jira: p.jira ? { site: p.jira.site, keys: (p.jira.keys ?? []).map((k: string) => k.toUpperCase()), jqlExtra: p.jira.jqlExtra, qaStatus: p.jira.qaStatus ?? "Ready for QA" } : undefined,
    github: p.github ? { repo: p.github.repo, baseBranch: p.github.baseBranch ?? "main" } : undefined,
    local: { path: p.local?.path, testCommand: p.local?.testCommand, installCommand: p.local?.installCommand },
    roles: p.roles ?? [],
    autonomy: p.autonomy ?? "prepare",
    budget: deepMerge(structuredClone(DEFAULT_BUDGET), p.budget),
    related: p.related ?? [],
    group: p.group,
    conventions: p.conventions,
    figma: p.figma, notion: p.notion, screenshots: p.screenshots, qa: p.qa,
    reviewers: p.reviewers ? { from: p.reviewers.from === "codeowners" ? "codeowners" : "list", logins: (p.reviewers.logins ?? []).map(String) } : undefined,
    status: p.status ?? "active",
  };
}

export function saveProjects(list: ProjectConfig[]): void {
  ensureBaseDirs();
  const projects: Record<string, any> = {};
  for (const p of list) { const { id, ...rest } = p; projects[id] = rest; }
  fs.writeFileSync(paths.projects(), "# AI Workforce project registry (managed by `aiw project`; safe to edit)\n" + YAML.stringify({ projects }));
}

export function getProject(id: string): ProjectConfig | undefined {
  return loadProjects().find((p) => p.id === id);
}

export function upsertProject(p: ProjectConfig): void {
  const list = loadProjects().filter((x) => x.id !== p.id);
  list.push(p);
  saveProjects(list);
}

export function removeProject(id: string): boolean {
  const list = loadProjects();
  const next = list.filter((x) => x.id !== id);
  saveProjects(next);
  return next.length !== list.length;
}
