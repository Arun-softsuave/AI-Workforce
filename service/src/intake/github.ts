/**
 * GitHub producers (engine v2, IMPLEMENTATION-PLAN §5 5.19, W9/W10/W13/W14): poll the configured repositories with
 * conditional GETs (ETag / 304, connectors/github.ts conditionalGet) and turn what changed into kernel events with
 * stable idem keys. Code only: no model calls, nothing is written to GitHub.
 *
 * Events (the kernel's reactions table decides what each one starts):
 *   ci_failed / ci_passed       every check of the head commit finished (our PRs), with the check names
 *   comment_added / review_comment / changes_requested / pr_approved   other people on our PRs
 *   review_requested            someone asked me to review (a light "pr" item owned by the author is made for it)
 *   teammate_pr_opened          EVERY new PR by someone else in a configured repo (K1 on their side)
 *   new_commits                 someone else pushed to our PR branch, or the author pushed to a PR I reviewed
 *   pr_conflict                 our PR is not mergeable (dirty)
 *   pr_merged / pr_closed       a tracked PR ended
 *   mention                     someone @mentioned me on a PR or issue (K7)
 *
 * Comment and PR text is outside text (§11a): it is sanitised, cut short and kept as data in the payload
 * (payload.untrusted = true, payload.flags when it looks like an attempt to give orders). It never decides anything here.
 */
import { db, getMeta, setMeta } from "../core/db.js";
import { loadProjects, loadSettings, engineVersion, type ProjectConfig, type Settings } from "../core/config.js";
import { sha256 } from "../core/util.js";
import { logger } from "../core/log.js";
import { runTimed } from "../core/timers.js";
import { clients } from "../connectors/registry.js";
import type { GitHubClient } from "../connectors/github.js";
import { emit } from "../kernel/events.js";
import { itemForPr, itemForPrOrLight } from "../kernel/prs.js";
import { toItem } from "../kernel/items.js";
import { pushedByPlugin } from "../git/git.js";
import type { Item } from "../kernel/types.js";
import { sanitize, detectInjection } from "../policy/untrusted.js";

export const GITHUB_TIMER = "GitHub events";
/** Mentions use the search API (30 calls a minute): look at most this often. */
export const MENTION_EVERY_MS = 5 * 60_000;
const TEXT_MAX = 2000;
const SNAPSHOT_MAX = 300;

export interface GitHubPollDeps {
  gh?: GitHubClient;
  /** My GitHub login (default: settings.team.me.github, then meta github.login, then GET /user). */
  me?: string;
  settings?: Settings;
  projects?: ProjectConfig[];
  now?: () => Date;
  /** Force the mention search this run (tests). */
  mentions?: boolean;
}

export interface GitHubPollResult {
  repos: number;
  /** New events by type (deduped repeats are not counted). */
  emitted: Record<string, number>;
  /** Conditional GETs answered 304 (no change, no rate limit used). */
  notModified: number;
  errors: string[];
}

/** One PR as remembered between polls (meta gh.prs:<repo>). */
interface Snap { head: string; state: string; merged: boolean; rr: string[]; author: string; branch: string; upd: string }

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const isBot = (u: any) => !u?.login || u.type === "Bot" || /\[bot\]$/i.test(String(u.login));
/** Jira project keys of the configured projects (set by pollGitHub), so "branch-9" is not taken for a ticket key. */
let knownKeys = new Set<string>();

/** Jira keys in PR titles and branch names: a configured project key in any case, else only an upper-case KEY-123. */
export function jiraKeys(...texts: (string | undefined | null)[]): string[] {
  const out = new Set<string>();
  for (const m of texts.filter(Boolean).join(" ").matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]+)-(\d+)(?![0-9])/g)) {
    const prefix = m[1].toUpperCase();
    if (knownKeys.size ? knownKeys.has(prefix) : m[1] === prefix) out.add(`${prefix}-${m[2]}`);
  }
  return [...out];
}

/** Outside text as data: hidden parts removed, cut short, flagged when it reads like orders. */
export function asData(text: string | null | undefined): { text: string; untrusted: true; flags?: string[] } {
  const clean = sanitize(String(text ?? "")).slice(0, TEXT_MAX);
  const inj = detectInjection(clean);
  return { text: clean, untrusted: true, ...(inj.suspicious ? { flags: inj.flags } : {}) };
}

/** Does the text @mention this login? */
export function mentionsLogin(text: string | null | undefined, login: string): boolean {
  if (!text || !login) return false;
  const esc = login.replace(/[^A-Za-z0-9-]/g, "");
  return new RegExp(`(^|[^A-Za-z0-9_-])@${esc}(?![A-Za-z0-9_-])`, "i").test(text);
}

/** The item behind a PR: by number (kernel/prs.ts itemForPr), else by its branch in one of the repo's projects. */
export function itemForPrOrBranch(repo: string, num: number, branch: string | undefined, projectIds: string[]): Item | undefined {
  const byNum = itemForPr(repo, num);
  if (byNum || !branch || !projectIds.length) return byNum;
  const r = db().prepare(`SELECT * FROM tasks WHERE branch=? AND project_id IN (${projectIds.map(() => "?").join(",")})
    AND state NOT IN ('CANCELLED') AND kind NOT IN ('pr_fix','pr_qa','pr_review') ORDER BY created_at DESC LIMIT 1`).get(branch, ...projectIds);
  return r ? toItem(r) : undefined;
}

/** Did I review this PR (a pr_review task)? Then the author's new commits are worth a re-review offer. */
function iReviewed(repo: string, num: number): boolean {
  return !!db().prepare(`SELECT 1 FROM tasks WHERE kind='pr_review' AND state <> 'CANCELLED'
    AND lower(json_extract(data,'$.review.repo'))=lower(?) AND json_extract(data,'$.review.num')=? LIMIT 1`).get(repo, num);
}

async function whoAmI(gh: GitHubClient, deps: GitHubPollDeps, s: Settings): Promise<string | undefined> {
  if (deps.me) return deps.me;
  const known = s.team?.me?.github || getMeta("github.login");
  if (known) return known;
  try { const u = await gh.user(); setMeta("github.login", u.login); return u.login; } catch { return undefined; }
}

/** Repositories to watch: each configured project's github.repo (not paused), with the projects that use it. */
export function watchedRepos(projects: ProjectConfig[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of projects) {
    const repo = p.github?.repo;
    if (!repo || p.status === "paused") continue;
    const k = [...out.keys()].find((r) => same(r, repo)) ?? repo;
    out.set(k, [...(out.get(k) ?? []), p.id]);
  }
  return out;
}

/**
 * One poll of every watched repository. Errors in one repository don't stop the others.
 * The first poll of a repository only records what is there (no "teammate PR opened" for old PRs).
 */
export async function pollGitHub(deps: GitHubPollDeps = {}): Promise<GitHubPollResult> {
  const res: GitHubPollResult = { repos: 0, emitted: {}, notModified: 0, errors: [] };
  const gh = deps.gh ?? clients.github();
  if (!gh?.getCached) return res;
  const s = deps.settings ?? loadSettings();
  const now = deps.now ?? (() => new Date());
  const me = await whoAmI(gh, deps, s);
  if (!me) { res.errors.push("GitHub login unknown"); return res; }
  const projects = deps.projects ?? loadProjects();
  knownKeys = new Set(projects.flatMap((p) => p.jira?.keys ?? []).map((k) => k.toUpperCase()));
  const repos = watchedRepos(projects);
  const p = new Producer(gh, me, now, res);
  for (const [repo, projectIds] of repos) {
    res.repos++;
    try { await p.repo(repo, projectIds); }
    catch (e: any) { res.errors.push(`${repo}: ${e.message}`); logger.warn("GitHub poll failed", { repo, error: e.message }); }
  }
  const last = getMeta("gh.mentions.checked");
  if (repos.size && (deps.mentions || !last || now().getTime() - new Date(last).getTime() >= MENTION_EVERY_MS)) {
    try { await p.mentions([...repos.keys()], repos); setMeta("gh.mentions.checked", now().toISOString()); }
    catch (e: any) { res.errors.push(`mentions: ${e.message}`); logger.warn("GitHub mention search failed", { error: e.message }); }
  }
  return res;
}

/** pollGitHub as the "GitHub events" timer run. Skipped on engine v1 (nothing routes the events there). */
export async function runGitHubProducers(deps: GitHubPollDeps = {}): Promise<GitHubPollResult | undefined> {
  if (engineVersion(deps.settings ?? loadSettings()) !== "v2") return undefined;
  return runTimed(GITHUB_TIMER, () => pollGitHub(deps));
}

class Producer {
  constructor(private gh: GitHubClient, private me: string, private now: () => Date, private res: GitHubPollResult) {}

  private async get<T = any>(path: string): Promise<{ data: T; changed: boolean }> {
    const r = await this.gh.getCached!<T>(path);
    if (!r.changed) this.res.notModified++;
    return r;
  }

  private emit(type: string, idemKey: string, payload: Record<string, any>, at: { itemId?: string; projectId?: string }): void {
    const e = emit({ type, idemKey, itemId: at.itemId, projectId: at.itemId ? undefined : at.projectId, payload });
    if (e) this.res.emitted[type] = (this.res.emitted[type] ?? 0) + 1;
  }

  /** Our work: an item owned by me (raised or adopted here). A teammate's light pr item has owner = their login. */
  private isMine(item: Item | undefined, _author?: string): boolean {
    return !!item && item.owner === "me";
  }

  async repo(repo: string, projectIds: string[]): Promise<void> {
    const sinceKey = `gh.since:${repo.toLowerCase()}`;
    let since = getMeta(sinceKey);
    const firstPoll = !since;
    if (!since) { since = this.now().toISOString(); setMeta(sinceKey, since); }
    const snapKey = `gh.prs:${repo.toLowerCase()}`;
    const snaps: Record<string, Snap> = JSON.parse(getMeta(snapKey) ?? "{}");

    const list = await this.get<any[]>(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=50`);
    const prs = Array.isArray(list.data) ? list.data : [];
    if (list.changed) {
      for (const pr of prs) await this.diffPr(repo, projectIds, pr, snaps[String(pr.number)], firstPoll, since);
      for (const pr of prs) {
        snaps[String(pr.number)] = {
          head: pr.head?.sha ?? "", state: pr.state, merged: !!pr.merged_at, author: pr.user?.login ?? "", branch: pr.head?.ref ?? "",
          rr: (pr.requested_reviewers ?? []).map((u: any) => String(u.login)), upd: pr.updated_at ?? "",
        };
      }
      const keep = Object.entries(snaps).sort((a, b) => String(b[1].upd).localeCompare(String(a[1].upd))).slice(0, SNAPSHOT_MAX);
      setMeta(snapKey, JSON.stringify(Object.fromEntries(keep)));
    }

    // our open PRs: CI, conflicts, comments and reviews (each a conditional GET – 304 when nothing changed)
    for (const pr of prs.filter((x) => x.state === "open")) {
      const author = pr.user?.login ?? "";
      const item = itemForPrOrBranch(repo, pr.number, pr.head?.ref, projectIds);
      if (!this.isMine(item, author)) continue;
      await this.ci(repo, pr, item!);
      await this.conflict(repo, pr, item!);
      await this.talk(repo, pr, item!, since);
    }
  }

  /** What changed on one PR since the last list: opened, review request, new commits, merged / closed. */
  private async diffPr(repo: string, projectIds: string[], pr: any, prev: Snap | undefined, firstPoll: boolean, since: string): Promise<void> {
    const num = Number(pr.number), author = pr.user?.login ?? "", head = pr.head?.sha ?? "", branch = pr.head?.ref ?? "";
    const projectId = projectIds[0];
    const base = { repo, num, title: asData(pr.title).text, url: pr.html_url, author, branch, base: pr.base?.ref, keys: jiraKeys(pr.title, branch) };
    const mine = same(author, this.me);
    let item = itemForPrOrBranch(repo, num, branch, projectIds);

    // every teammate PR, once (K1 / W10)
    if (!prev && !firstPoll && pr.state === "open" && !mine && !isBot(pr.user) && String(pr.created_at ?? "") >= since)
      this.emit("teammate_pr_opened", `gh:teammate_pr_opened:${repo.toLowerCase()}#${num}`, { ...base, draft: !!pr.draft }, { projectId });

    // a review asked of me (H2)
    const rr: string[] = (pr.requested_reviewers ?? []).map((u: any) => String(u.login));
    if (pr.state === "open" && !mine && rr.some((l) => same(l, this.me)) && !(prev?.rr ?? []).some((l) => same(l, this.me))) {
      item ??= itemForPrOrLight(projectId, repo, num, author || "teammate");
      this.emit("review_requested", `gh:review_requested:${repo.toLowerCase()}#${num}:${head}`, { ...base, sha: head, ours: false }, { itemId: item.id, projectId });
    }

    // new commits on the branch (G13 on our PR; re-review offer on a PR I reviewed)
    if (prev && prev.head && head && prev.head !== head && pr.state === "open") {
      const ours = this.isMine(item, author);
      if (ours || (!mine && (item || iReviewed(repo, num)))) {
        const commits = await this.newCommits(repo, num, prev.head);
        const others = commits.filter((c) => !same(c.author, this.me));
        // the plugin's own pushes are not news; a push the plugin did not make (you, by hand – same login – or a
        // teammate) is: local work is moved on top of it, never over it (I2 / G13)
        const yours = ours && !others.length && !pushedByPlugin(head);
        if (!ours || others.length || yours) {
          const by = yours ? "you" : (ours ? others : commits)[0]?.author ?? (ours ? "" : author);
          this.emit("new_commits", `gh:new_commits:${repo.toLowerCase()}#${num}:${head}`, {
            ...base, from: prev.head, to: head, count: commits.length, authors: [...new Set(commits.map((c) => c.author))], by,
            ...(ours ? {} : { ours: false }),
          }, { itemId: item?.id, projectId });
        }
      }
    }

    // merged or closed (G17 / G18): only PRs we track
    if (pr.state === "closed" && item && prev?.state !== "closed") {
      const merged = !!pr.merged_at;
      // a PR can be closed, reopened and closed again: the close time keeps each close its own event
      this.emit(merged ? "pr_merged" : "pr_closed", `gh:${merged ? "pr_merged" : "pr_closed"}:${repo.toLowerCase()}#${num}${merged ? "" : `:${pr.closed_at ?? ""}`}`,
        { ...base, sha: head, at: pr.merged_at ?? pr.closed_at ?? null, mergedBy: pr.merged_by?.login }, { itemId: item.id, projectId });
    }
    // reopened (G18 "reopen"): looked after again (the reaction moves CLOSED → PR_OPEN)
    if (pr.state === "open" && item && prev?.state === "closed" && !prev?.merged) {
      this.emit("pr_reopened", `gh:pr_reopened:${repo.toLowerCase()}#${num}:${pr.updated_at ?? head}`, { ...base, sha: head }, { itemId: item.id, projectId });
    }
  }

  private async newCommits(repo: string, num: number, fromSha: string): Promise<{ sha: string; author: string }[]> {
    const r = await this.get<any[]>(`/repos/${repo}/pulls/${num}/commits?per_page=100`);
    const all = (Array.isArray(r.data) ? r.data : []).map((c: any) => ({ sha: String(c.sha), author: String(c.author?.login ?? c.commit?.author?.name ?? "") }));
    const at = all.findIndex((c) => c.sha === fromSha);
    return at >= 0 ? all.slice(at + 1) : all;            // force-pushed: the old head is gone, so all of them
  }

  /** CI of the head commit (G1–G8): one event when every check has finished. */
  private async ci(repo: string, pr: any, item: Item): Promise<void> {
    const sha = pr.head?.sha;
    if (!sha) return;
    const [runs, status] = await Promise.all([
      this.get<any>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
      this.get<any>(`/repos/${repo}/commits/${sha}/status`).catch(() => ({ data: { statuses: [] }, changed: false })),
    ]);
    const latest = new Map<string, any>();
    for (const c of runs.data?.check_runs ?? []) { const p = latest.get(c.name); if (!p || String(c.started_at ?? "") > String(p.started_at ?? "")) latest.set(c.name, c); }
    type C = { id: string; name: string; state: "pending" | "passed" | "failed"; conclusion: string; url: string; jobId?: number };
    const checks: C[] = [];
    for (const c of latest.values()) {
      const conclusion = c.status === "completed" ? String(c.conclusion ?? "") : String(c.status ?? "queued");
      const state = c.status !== "completed" ? "pending" : ["success", "skipped", "neutral"].includes(conclusion) ? "passed" : "failed";
      const job = /\/job\/(\d+)/.exec(c.details_url ?? c.html_url ?? "")?.[1];
      checks.push({ id: `run:${c.id}`, name: c.name, state, conclusion, url: c.html_url ?? c.details_url ?? "", jobId: job ? Number(job) : undefined });
    }
    for (const st of status.data?.statuses ?? []) {
      if (checks.some((x) => x.name === st.context)) continue;
      checks.push({ id: `status:${st.context}:${st.id ?? st.updated_at ?? ""}`, name: st.context, state: st.state === "pending" ? "pending" : st.state === "success" ? "passed" : "failed", conclusion: st.state, url: st.target_url ?? "" });
    }
    if (!checks.length || checks.some((c) => c.state === "pending")) return;
    const failed = checks.filter((c) => c.state === "failed");
    const payload = {
      repo, num: pr.number, sha, branch: pr.head?.ref, url: pr.html_url, ours: true,
      checks: checks.map((c) => c.name).sort(), failed: failed.map(({ name, conclusion, url, jobId, id }) => ({ name, conclusion, url, jobId, id })),
    };
    if (failed.length) {
      // a re-run makes new run ids, so a second failure on the same commit is a new event
      const ids = sha256(failed.map((c) => c.id).sort().join(",")).slice(0, 12);
      this.emit("ci_failed", `gh:ci_failed:${repo.toLowerCase()}#${pr.number}:${sha}:${ids}`, payload, { itemId: item.id });
    } else {
      this.emit("ci_passed", `gh:ci_passed:${repo.toLowerCase()}#${pr.number}:${sha}`, payload, { itemId: item.id });
    }
  }

  /** G14: the PR conflicts with its base. GitHub works mergeability out lazily: null now, an answer on a later poll. */
  private async conflict(repo: string, pr: any, item: Item): Promise<void> {
    const r = await this.get<any>(`/repos/${repo}/pulls/${pr.number}`);
    const p = r.data ?? {};
    // the conflict is gone (you fixed it, or a merge was pushed): one "no conflicts now" line, and "is it resolved?" knows
    if (p.state === "open" && p.mergeable === true && item.data?.conflict?.state === "open") {
      this.emit("pr_conflict_cleared", `gh:pr_conflict_cleared:${repo.toLowerCase()}#${pr.number}:${p.head?.sha ?? ""}`, {
        repo, num: pr.number, url: pr.html_url, branch: p.head?.ref, base: p.base?.ref, sha: p.head?.sha, ours: true,
      }, { itemId: item.id });
      try { (await import("../engine/tasks.js")).mergeData(item.id, { conflict: { ...item.data.conflict, state: "resolved", at: new Date().toISOString() } }); } catch { /* item gone */ }
      return;
    }
    if (p.state !== "open" || !(p.mergeable === false || p.mergeable_state === "dirty")) return;
    this.emit("pr_conflict", `gh:pr_conflict:${repo.toLowerCase()}#${pr.number}:${p.head?.sha ?? ""}:${p.base?.sha ?? ""}`, {
      repo, num: pr.number, url: pr.html_url, branch: p.head?.ref, base: p.base?.ref, baseSha: p.base?.sha, sha: p.head?.sha, state: p.mergeable_state ?? "dirty", ours: true,
    }, { itemId: item.id });
  }

  /** W10: other people's comments and reviews on our PR. */
  private async talk(repo: string, pr: any, item: Item, repoSince: string): Promise<void> {
    const num = pr.number;
    const curKey = `gh.talk:${repo.toLowerCase()}#${num}`;
    const since = getMeta(curKey) ?? (String(item.data?.prOpenedAt ?? "") > repoSince ? String(item.data.prOpenedAt) : repoSince);
    let latest = since;
    const seen = (at: string) => { if (at > latest) latest = at; };
    const fromOther = (u: any) => !isBot(u) && !same(u?.login, this.me);
    const base = { repo, num, url: pr.html_url, branch: pr.head?.ref };

    const [reviews, lineComments, comments] = await Promise.all([
      this.get<any[]>(`/repos/${repo}/pulls/${num}/reviews?per_page=100`),
      this.get<any[]>(`/repos/${repo}/pulls/${num}/comments?since=${encodeURIComponent(since)}&per_page=100`),
      this.get<any[]>(`/repos/${repo}/issues/${num}/comments?since=${encodeURIComponent(since)}&per_page=100`),
    ]);
    for (const r of Array.isArray(reviews.data) ? reviews.data : []) {
      const at = String(r.submitted_at ?? "");
      if (!at || at <= since || !fromOther(r.user)) continue;
      seen(at);
      const type = r.state === "APPROVED" ? "pr_approved" : r.state === "CHANGES_REQUESTED" ? "changes_requested" : r.state === "COMMENTED" && (r.body ?? "").trim() ? "comment_added" : "";
      if (!type) continue;
      this.emit(type, `gh:${type}:${repo.toLowerCase()}#${num}:v${r.id}`, { ...base, id: `v${r.id}`, kind: "review", author: r.user.login, at, sha: r.commit_id, commentUrl: r.html_url, ...asData(r.body) }, { itemId: item.id });
    }
    for (const c of Array.isArray(lineComments.data) ? lineComments.data : []) {
      const at = String(c.updated_at ?? c.created_at ?? "");
      if (!at || at <= since || !fromOther(c.user)) continue;
      seen(at);
      this.emit("review_comment", `gh:review_comment:${repo.toLowerCase()}#${num}:r${c.id}`, {
        ...base, id: `r${c.id}`, commentId: c.id, kind: "review_comment", author: c.user.login, at, path: c.path, line: c.line ?? c.original_line ?? null,
        inReplyTo: c.in_reply_to_id ?? null, commentUrl: c.html_url, ...asData(c.body),
      }, { itemId: item.id });
    }
    for (const c of Array.isArray(comments.data) ? comments.data : []) {
      const at = String(c.updated_at ?? c.created_at ?? "");
      if (!at || at <= since || !fromOther(c.user)) continue;
      seen(at);
      this.emit("comment_added", `gh:comment_added:${repo.toLowerCase()}#${num}:c${c.id}`, { ...base, id: `c${c.id}`, kind: "comment", author: c.user.login, at, commentUrl: c.html_url, ...asData(c.body) }, { itemId: item.id });
    }
    if (latest !== since || !getMeta(curKey)) setMeta(curKey, latest);
  }

  /** K7: @mentions of me on PRs and issues in the watched repos (our own PRs' comments are reported as comments already). */
  async mentions(repos: string[], projects: Map<string, string[]>): Promise<void> {
    const curKey = "gh.mentions.since";
    const since = getMeta(curKey);
    if (!since) { setMeta(curKey, this.now().toISOString()); return; }     // first run: from now on
    const q = `mentions:${this.me} updated:>=${since.slice(0, 10)} ${repos.map((r) => `repo:${r}`).join(" ")}`;
    const r = await this.get<any>(`/search/issues?per_page=50&sort=updated&order=desc&q=${encodeURIComponent(q)}`);
    let latest = since;
    for (const it of r.data?.items ?? []) {
      if (String(it.updated_at ?? "") <= since) continue;
      const repo = String(it.repository_url ?? "").split("/repos/")[1] ?? "";
      const projectIds = projects.get([...projects.keys()].find((k) => same(k, repo)) ?? "") ?? [];
      const isPr = !!it.pull_request;
      const item = isPr ? itemForPr(repo, it.number) : undefined;
      if (item && this.isMine(item, it.user?.login ?? "")) continue;
      const base = { repo, num: it.number, isPr, title: asData(it.title).text, url: it.html_url, keys: jiraKeys(it.title) };
      const at = { itemId: item?.id, projectId: projectIds[0] };
      if (String(it.created_at ?? "") > since && !isBot(it.user) && !same(it.user?.login, this.me) && mentionsLogin(it.body, this.me))
        this.emit("mention", `gh:mention:${repo.toLowerCase()}#${it.number}:body`, { ...base, author: it.user.login, commentUrl: it.html_url, ...asData(it.body) }, at);
      const lists = [this.get<any[]>(`/repos/${repo}/issues/${it.number}/comments?since=${encodeURIComponent(since)}&per_page=100`)];
      if (isPr) lists.push(this.get<any[]>(`/repos/${repo}/pulls/${it.number}/comments?since=${encodeURIComponent(since)}&per_page=100`));
      const got = await Promise.all(lists);
      got.forEach((g, i) => {
        for (const c of Array.isArray(g.data) ? g.data : []) {
          const cAt = String(c.updated_at ?? c.created_at ?? "");
          if (cAt <= since || isBot(c.user) || same(c.user?.login, this.me) || !mentionsLogin(c.body, this.me)) continue;
          const id = `${i ? "r" : "c"}${c.id}`;
          this.emit("mention", `gh:mention:${repo.toLowerCase()}#${it.number}:${id}`, { ...base, id, author: c.user.login, path: c.path, commentUrl: c.html_url, ...asData(c.body) }, at);
        }
      });
      if (String(it.updated_at) > latest) latest = String(it.updated_at);
    }
    if (latest !== since) setMeta(curKey, latest);
  }
}

