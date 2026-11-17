import { execFileSync } from "node:child_process";
import { httpJson, truncate } from "../core/util.js";
import { getSecret } from "../core/secrets.js";
import type { CiRun, ConnectionTest } from "./types.js";

/**
 * GitHub adapter. Auth: a token pasted via the local connect page, or reuse of an existing `gh` CLI login.
 * The GitHub WRITE credential is used only by the Approval Service (publish) – agents never receive it.
 */
export interface GitHubClient {
  user(): Promise<{ login: string }>;
  repo(fullName: string): Promise<{ defaultBranch: string; private: boolean }>;
  findOpenPr(repo: string, branch: string): Promise<{ number: number; url: string } | undefined>;
  createPr(repo: string, p: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<{ number: number; url: string }>;
  updatePr(repo: string, num: number, p: { title?: string; body?: string }): Promise<{ number: number; url: string }>;
  /** Ask people (logins) and teams (slugs) to review a PR. */
  requestReviewers?(repo: string, num: number, r: { users: string[]; teams: string[] }): Promise<{ requested: string[] }>;
  /** People who contributed to the repository (most commits first). */
  contributors?(repo: string): Promise<{ login: string; contributions: number; name?: string }[]>;
  /** What the signed-in user may do in the repository. */
  permissions?(repo: string): Promise<{ push: boolean; admin: boolean }>;
  failedRuns(repo: string, sinceIso: string, branches?: string[]): Promise<CiRun[]>;
  failedJobLog(repo: string, runId: string): Promise<string>;
  /** Value for `git -c http.extraheader=...` so the token never appears in a URL or the process list of git remotes. */
  gitAuthHeader(): string;
  recentPrBases(repo: string, n: number): Promise<string[]>;
  prActivity(repo: string, num: number, sinceIso: string): Promise<PrActivity[]>;
  /** Read-only: one PR with its changed files (used by the agents' lookup tools). Optional so test fakes may omit it. */
  getPr?(repo: string, num: number): Promise<PrInfo>;
  /** Everything needed to review someone's PR: head/base commits, each file's patch, CI state, existing comments. */
  prForReview?(repo: string, num: number): Promise<PrReviewInfo>;
  /** One review with line comments, ALWAYS as a plain comment – never "approve" or "request changes". */
  createReview?(repo: string, num: number, r: { commitId: string; body: string; comments: ReviewComment[] }): Promise<{ id: number; url: string }>;
  /** PRs in these repositories that mention a text (a ticket key) in the title or description. */
  searchPrs?(repos: string[], text: string): Promise<PrRefInfo[]>;
  /** Open PRs of one repository (for "Eric's PR"). */
  openPrs?(repo: string): Promise<PrRefInfo[]>;
  /** The review comment threads of a PR, with whether each is resolved. */
  reviewThreads?(repo: string, num: number): Promise<ReviewThread[]>;
  /** General comments on a PR (the conversation tab), and the review summaries. */
  prConversation?(repo: string, num: number): Promise<{ id: string; kind: "comment" | "review"; author: string; body: string; at: string; url: string }[]>;
  /** Every CI check of a commit (GitHub Actions check runs and classic commit statuses). */
  prChecks?(repo: string, sha: string): Promise<CiCheck[]>;
  /** What a failing check printed: the failing job step, its command and the log around the error (Actions), or the check's summary. */
  checkFailure?(repo: string, check: CiCheck): Promise<string>;
  replyToReviewComment?(repo: string, num: number, commentId: number, body: string): Promise<{ url: string }>;
  commentOnPr?(repo: string, num: number, body: string): Promise<{ url: string }>;
  createIssue?(repo: string, i: { title: string; body: string }): Promise<{ number: number; url: string }>;
  searchIssues?(repo: string, text: string): Promise<{ number: number; title: string; url: string; state: string }[]>;
  getIssue?(repo: string, num: number): Promise<{ number: number; title: string; body: string; url: string; state: string; author: string }>;
  commentOnIssue?(repo: string, num: number, body: string): Promise<{ url: string }>;
}

export interface PrRefInfo { repo: string; number: number; title: string; url: string; author: string; state: string; headRef?: string; updated?: string }
export interface ReviewThread {
  id: string; resolved: boolean; outdated: boolean; path: string; line: number | null;
  comments: { id: number; author: string; body: string; at: string; url: string }[];
}

export interface ReviewComment { path: string; line: number; side: "RIGHT"; body: string }

export interface PrReviewInfo {
  number: number; title: string; body: string; url: string; author: string; state: string; draft: boolean; merged: boolean;
  headRef: string; headSha: string; baseRef: string; baseSha: string; headRepo?: string;
  files: { path: string; status: string; additions: number; deletions: number; patch?: string }[];
  checks: { name: string; conclusion: string | null }[];
  comments: { author: string; path?: string; line?: number; body: string }[];
}

/** One CI check of a commit. state: pending (queued / running), passed (success, skipped, neutral) or failed. */
export interface CiCheck { id: string; name: string; state: "pending" | "passed" | "failed"; conclusion: string; url: string; jobId?: number; summary?: string }

export interface PrInfo {
  number: number; title: string; state: string; merged: boolean; url: string; author: string; head: string; base: string; body: string;
  files: { path: string; status: string; additions: number; deletions: number }[];
}

export interface PrActivity { id: string; kind: "comment" | "review_comment" | "review"; author: string; body: string; url: string; at: string; state?: string; path?: string }

const API = process.env.AIW_GITHUB_API ?? "https://api.github.com";

export function tokenFromGhCli(): string | undefined {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch { return undefined; }
}

export function createGitHubClient(token?: string): GitHubClient | undefined {
  token = token ?? getSecret("github.token");
  if (!token) return undefined;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ai-workforce" };
  const gh = <T = any>(p: string, init: RequestInit = {}) => httpJson<T>(`${API}${p}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  return {
    async user() { return { login: (await gh("/user")).login }; },
    async repo(fullName) {
      const r = await gh(`/repos/${fullName}`);
      return { defaultBranch: r.default_branch, private: r.private };
    },
    async findOpenPr(repo, branch) {
      const owner = repo.split("/")[0];
      const list = await gh<any[]>(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      return list[0] ? { number: list[0].number, url: list[0].html_url } : undefined;
    },
    async createPr(repo, p) {
      const r = await gh(`/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify(p) });
      return { number: r.number, url: r.html_url };
    },
    async requestReviewers(repo, num, r) {
      const body: any = {};
      if (r.users.length) body.reviewers = r.users;
      if (r.teams.length) body.team_reviewers = r.teams;
      if (!r.users.length && !r.teams.length) return { requested: [] };
      const out = await gh(`/repos/${repo}/pulls/${num}/requested_reviewers`, { method: "POST", body: JSON.stringify(body) });
      return { requested: [...(out.requested_reviewers ?? []).map((u: any) => u.login), ...(out.requested_teams ?? []).map((t: any) => t.slug)] };
    },
    async contributors(repo) {
      const list = await gh<any[]>(`/repos/${repo}/contributors?per_page=30`);
      return (Array.isArray(list) ? list : []).filter((c) => c.type !== "Bot").map((c) => ({ login: c.login, contributions: c.contributions }));
    },
    async permissions(repo) {
      const r = await gh(`/repos/${repo}`);
      return { push: !!r.permissions?.push, admin: !!r.permissions?.admin };
    },
    async updatePr(repo, num, p) {
      const r = await gh(`/repos/${repo}/pulls/${num}`, { method: "PATCH", body: JSON.stringify(p) });
      return { number: r.number, url: r.html_url };
    },
    async failedRuns(repo, sinceIso, branches) {
      const r = await gh(`/repos/${repo}/actions/runs?status=failure&per_page=30&created=${encodeURIComponent(">=" + sinceIso.slice(0, 19) + "Z")}`);
      return (r.workflow_runs ?? [])
        .filter((w: any) => !branches?.length || branches.some((b) => matchBranch(b, w.head_branch)))
        .map((w: any) => ({
          id: String(w.id), repo, branch: w.head_branch, workflow: w.name, conclusion: w.conclusion,
          url: w.html_url, headSha: w.head_sha, updated: w.updated_at,
        }));
    },
    async failedJobLog(repo, runId) {
      const jobs = await gh(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest`);
      const failed = (jobs.jobs ?? []).filter((j: any) => j.conclusion === "failure");
      const parts: string[] = [];
      for (const j of failed.slice(0, 2)) {
        const steps = (j.steps ?? []).filter((s: any) => s.conclusion === "failure").map((s: any) => s.name);
        let text = "";
        try {
          const res = await fetch(`${API}/repos/${repo}/actions/jobs/${j.id}/logs`, { headers, redirect: "follow" });
          text = await res.text();
        } catch { /* logs may be expired */ }
        parts.push(`## Job: ${j.name}\nFailed steps: ${steps.join(", ")}\n${failingSection(text)}`);
      }
      return parts.join("\n\n") || "No failed job logs available.";
    },
    async recentPrBases(repo, n) {
      const list = await gh<any[]>(`/repos/${repo}/pulls?state=all&per_page=${Math.min(n, 100)}&sort=created&direction=desc`);
      return list.filter((p) => !String(p.head?.ref ?? "").startsWith("aiw/")).map((p) => p.base?.ref).filter(Boolean);
    },
    async getPr(repo, num) {
      const [p, files] = await Promise.all([gh(`/repos/${repo}/pulls/${num}`), gh<any[]>(`/repos/${repo}/pulls/${num}/files?per_page=100`)]);
      return {
        number: p.number, title: p.title, state: p.state, merged: !!p.merged, url: p.html_url, author: p.user?.login, head: p.head?.ref, base: p.base?.ref,
        body: p.body ?? "", files: files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
      };
    },
    async prForReview(repo, num) {
      const p = await gh(`/repos/${repo}/pulls/${num}`);
      const files: any[] = [];
      for (let page = 1; page <= 5; page++) {
        const batch = await gh<any[]>(`/repos/${repo}/pulls/${num}/files?per_page=100&page=${page}`);
        files.push(...batch);
        if (batch.length < 100) break;
      }
      const [runs, reviewComments] = await Promise.all([
        gh(`/repos/${repo}/commits/${p.head.sha}/check-runs?per_page=50`).catch(() => ({ check_runs: [] })),
        gh<any[]>(`/repos/${repo}/pulls/${num}/comments?per_page=100`).catch(() => []),
      ]);
      return {
        number: p.number, title: p.title, body: p.body ?? "", url: p.html_url, author: p.user?.login, state: p.state, draft: !!p.draft, merged: !!p.merged,
        headRef: p.head?.ref, headSha: p.head?.sha, baseRef: p.base?.ref, baseSha: p.base?.sha, headRepo: p.head?.repo?.full_name,
        files: files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })),
        checks: (runs.check_runs ?? []).map((c: any) => ({ name: c.name, conclusion: c.conclusion ?? c.status })),
        comments: reviewComments.map((c) => ({ author: c.user?.login, path: c.path, line: c.line ?? undefined, body: c.body ?? "" })),
      };
    },
    async searchPrs(repos, text) {
      const q = `${JSON.stringify(text)} is:pr ${repos.map((r) => `repo:${r}`).join(" ")}`;
      const r = await gh(`/search/issues?per_page=30&sort=updated&q=${encodeURIComponent(q)}`);
      return (r.items ?? []).map((i: any) => ({
        repo: String(i.repository_url ?? "").split("/repos/")[1] ?? "", number: i.number, title: i.title, url: i.html_url,
        author: i.user?.login ?? "", state: i.pull_request?.merged_at ? "merged" : i.state, updated: i.updated_at,
      }));
    },
    async openPrs(repo) {
      const list = await gh<any[]>(`/repos/${repo}/pulls?state=open&per_page=100`);
      return list.map((p) => ({ repo, number: p.number, title: p.title, url: p.html_url, author: p.user?.login ?? "", state: "open", headRef: p.head?.ref, updated: p.updated_at }));
    },
    async reviewThreads(repo, num) {
      const [owner, name] = repo.split("/");
      const query = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:30){nodes{databaseId author{login} body createdAt url}}}}}}}`;
      const r = await gh(`/graphql`, { method: "POST", body: JSON.stringify({ query, variables: { o: owner, n: name, p: num } }) });
      if (r.errors?.length) throw new Error(`GitHub: ${r.errors[0].message}`);
      return (r.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((t: any) => ({
        id: t.id, resolved: !!t.isResolved, outdated: !!t.isOutdated, path: t.path, line: t.line ?? null,
        comments: (t.comments?.nodes ?? []).map((c: any) => ({ id: c.databaseId, author: c.author?.login ?? "", body: c.body ?? "", at: c.createdAt, url: c.url })),
      }));
    },
    async prConversation(repo, num) {
      const [comments, reviews] = await Promise.all([
        gh<any[]>(`/repos/${repo}/issues/${num}/comments?per_page=100`),
        gh<any[]>(`/repos/${repo}/pulls/${num}/reviews?per_page=100`),
      ]);
      return [
        ...comments.map((c) => ({ id: `c${c.id}`, kind: "comment" as const, author: c.user?.login ?? "", body: c.body ?? "", at: c.created_at, url: c.html_url })),
        ...reviews.filter((r) => (r.body ?? "").trim()).map((r) => ({ id: `v${r.id}`, kind: "review" as const, author: r.user?.login ?? "", body: r.body ?? "", at: r.submitted_at, url: r.html_url })),
      ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    },
    async prChecks(repo, sha) {
      const [runs, statuses] = await Promise.all([
        gh(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
        gh(`/repos/${repo}/commits/${sha}/status`).catch(() => ({ statuses: [] })),
      ]);
      const out: CiCheck[] = [];
      // the newest run of each check name (a re-run replaces the old result)
      const latest = new Map<string, any>();
      for (const c of runs.check_runs ?? []) { const prev = latest.get(c.name); if (!prev || String(c.started_at ?? "") > String(prev.started_at ?? "")) latest.set(c.name, c); }
      for (const c of latest.values()) {
        const conclusion = c.status === "completed" ? String(c.conclusion ?? "") : String(c.status ?? "queued");
        const state = c.status !== "completed" ? "pending" : ["success", "skipped", "neutral"].includes(conclusion) ? "passed" : "failed";
        const job = /\/job\/(\d+)/.exec(c.details_url ?? c.html_url ?? "")?.[1];
        out.push({ id: `run:${c.id}`, name: c.name, state, conclusion, url: c.html_url ?? c.details_url ?? "", jobId: job ? Number(job) : undefined,
          summary: [c.output?.title, c.output?.summary, c.output?.text].filter(Boolean).join("\n").slice(0, 4000) || undefined });
      }
      for (const st of statuses.statuses ?? []) {
        if (out.some((x) => x.name === st.context)) continue;
        const state = st.state === "pending" ? "pending" : st.state === "success" ? "passed" : "failed";
        out.push({ id: `status:${st.context}`, name: st.context, state, conclusion: st.state, url: st.target_url ?? "", summary: st.description ?? undefined });
      }
      return out;
    },
    async checkFailure(repo, check) {
      if (!check.jobId) return check.summary ?? "No log available for this check – open its link.";
      let steps: string[] = [];
      try {
        const j = await gh(`/repos/${repo}/actions/jobs/${check.jobId}`);
        steps = (j.steps ?? []).filter((s: any) => s.conclusion === "failure").map((s: any) => s.name);
      } catch { /* the log still helps */ }
      let text = "";
      try { const res = await fetch(`${API}/repos/${repo}/actions/jobs/${check.jobId}/logs`, { headers, redirect: "follow" }); if (res.ok) text = await res.text(); } catch { /* logs may be expired */ }
      return truncate(describeFailure(text, steps, check.summary), 14_000);
    },
    async replyToReviewComment(repo, num, commentId, body) {
      const r = await gh(`/repos/${repo}/pulls/${num}/comments/${commentId}/replies`, { method: "POST", body: JSON.stringify({ body }) });
      return { url: r.html_url };
    },
    async commentOnPr(repo, num, body) {
      const r = await gh(`/repos/${repo}/issues/${num}/comments`, { method: "POST", body: JSON.stringify({ body }) });
      return { url: r.html_url };
    },
    async createIssue(repo, i) {
      const r = await gh(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title: i.title, body: i.body }) });
      return { number: r.number, url: r.html_url };
    },
    async searchIssues(repo, text) {
      const q = `${text.replace(/["\\]/g, " ").slice(0, 200)} is:issue repo:${repo}`;
      const r = await gh(`/search/issues?per_page=10&q=${encodeURIComponent(q)}`);
      return (r.items ?? []).map((i: any) => ({ number: i.number, title: i.title, url: i.html_url, state: i.state }));
    },
    async getIssue(repo, num) {
      const i = await gh(`/repos/${repo}/issues/${num}`);
      return { number: i.number, title: i.title, body: i.body ?? "", url: i.html_url, state: i.state, author: i.user?.login ?? "" };
    },
    async commentOnIssue(repo, num, body) {
      const r = await gh(`/repos/${repo}/issues/${num}/comments`, { method: "POST", body: JSON.stringify({ body }) });
      return { url: r.html_url };
    },
    async createReview(repo, num, r) {
      const res = await gh(`/repos/${repo}/pulls/${num}/reviews`, {
        method: "POST",
        body: JSON.stringify({ commit_id: r.commitId, body: r.body, event: "COMMENT", comments: r.comments }),   // COMMENT only
      });
      return { id: res.id, url: res.html_url };
    },
    async prActivity(repo, num, sinceIso) {
      const since = encodeURIComponent(sinceIso);
      const [comments, reviewComments, reviews] = await Promise.all([
        gh<any[]>(`/repos/${repo}/issues/${num}/comments?since=${since}&per_page=50`),
        gh<any[]>(`/repos/${repo}/pulls/${num}/comments?since=${since}&per_page=50`),
        gh<any[]>(`/repos/${repo}/pulls/${num}/reviews?per_page=50`),
      ]);
      const out: PrActivity[] = [
        ...comments.map((c) => ({ id: `c${c.id}`, kind: "comment" as const, author: c.user?.login, body: c.body ?? "", url: c.html_url, at: c.updated_at ?? c.created_at })),
        ...reviewComments.map((c) => ({ id: `r${c.id}`, kind: "review_comment" as const, author: c.user?.login, body: c.body ?? "", url: c.html_url, at: c.updated_at ?? c.created_at, path: c.path })),
        ...reviews.filter((r) => r.submitted_at && r.submitted_at > sinceIso && (r.body || r.state !== "COMMENTED"))
          .map((r) => ({ id: `v${r.id}`, kind: "review" as const, author: r.user?.login, body: r.body ?? "", url: r.html_url, at: r.submitted_at, state: r.state })),
      ];
      return out.sort((a, b) => a.at.localeCompare(b.at));
    },
    gitAuthHeader() {
      return "AUTHORIZATION: basic " + Buffer.from(`x-access-token:${token}`).toString("base64");
    },
  };
}

function matchBranch(pattern: string, branch: string): boolean {
  if (pattern.endsWith("*")) return branch.startsWith(pattern.slice(0, -1));
  return pattern === branch;
}

/**
 * A failing Actions job log, reduced to what a developer needs: the failing step, its command, the log around the first
 * error and the end of the step (where test runners print their summary). Timestamps and colour codes removed.
 */
export function describeFailure(log: string, steps: string[] = [], summary?: string): string {
  const lines = log.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").replace(/\x1b\[[0-9;]*m/g, ""));
  const errAt = lines.findIndex((l) => l.startsWith("##[error]"));
  const end = errAt < 0 ? lines.length : errAt;
  let command = "";
  for (let i = end - 1; i >= 0; i--) if (lines[i].startsWith("##[group]Run ")) { command = lines[i].slice("##[group]Run ".length); break; }
  const tail = lines.slice(Math.max(0, end - 60), end + 3).join("\n");
  return [
    steps.length ? `Failed step: ${steps.join(", ")}` : "",
    command ? `Command: ${command}` : "",
    log ? `End of the failing step:\n${tail}` : "",
    log && errAt > 120 ? `First error in the log:\n${failingSection(lines.slice(0, end).join("\n"), 20, 40)}` : "",
    summary ? `Check summary: ${summary}` : "",
  ].filter(Boolean).join("\n\n") || "No log available for this check – open its link.";
}

/** Keep only the part of a CI log around the first error – logs can be megabytes. */
export function failingSection(log: string, before = 40, after = 80): string {
  if (!log) return "";
  const lines = log.split(/\r?\n/);
  const idx = lines.findIndex((l) => /(##\[error\]|\bERROR\b|\bFAIL(ED)?\b|Error:|AssertionError|Traceback)/.test(l));
  const slice = idx < 0 ? lines.slice(-before - after) : lines.slice(Math.max(0, idx - before), idx + after);
  return truncate(slice.join("\n"), 12_000);
}

export async function testGitHub(token: string): Promise<ConnectionTest> {
  try {
    const res = await fetch(`${API}/user`, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "ai-workforce" } });
    if (!res.ok) return { ok: false, detail: `GitHub returned ${res.status}` };
    const u: any = await res.json();
    return { ok: true, account: u.login, scopes: (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean) };
  } catch (e: any) {
    return { ok: false, detail: e.message };
  }
}
