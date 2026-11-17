import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paths, ensureDir } from "../core/paths.js";
import { sha256 } from "../core/util.js";
import { stripAttribution } from "../core/attribution.js";

export class GitError extends Error {}

export function git(cwd: string, args: string[], opts: { allowFail?: boolean; extraHeader?: string; env?: Record<string, string> } = {}): string {
  // Safety: never fall back to the process's current directory (that could be an unrelated repository).
  if (!cwd || !fs.existsSync(cwd)) throw new GitError(`git ${args[0]}: working directory missing (${cwd || "none"})`);
  const full = opts.extraHeader ? ["-c", `http.extraheader=${opts.extraHeader}`, ...args] : args;
  try {
    return execFileSync("git", full, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env: opts.env ? { ...process.env, ...opts.env } : undefined }).trim();
  } catch (e: any) {
    if (opts.allowFail) return "";
    const msg = String(e.stderr ?? e.message).replace(/AUTHORIZATION: basic \S+/gi, "AUTHORIZATION: ***");
    throw new GitError(`git ${args[0]} failed: ${msg.trim()}`);
  }
}

export function isGitRepo(dir: string): boolean {
  return fs.existsSync(dir) && git(dir, ["rev-parse", "--is-inside-work-tree"], { allowFail: true }) === "true";
}

export function hasRemote(repoDir: string, name = "origin"): boolean {
  return git(repoDir, ["remote"], { allowFail: true }).split(/\s+/).includes(name);
}

/** Latest commit of the base branch: origin/<base> after a fetch when a remote exists, else local <base>. */
export function resolveBase(repoDir: string, base: string): { ref: string; sha: string } {
  if (hasRemote(repoDir)) {
    git(repoDir, ["fetch", "--quiet", "origin", base], { allowFail: true });
    const sha = git(repoDir, ["rev-parse", `origin/${base}`], { allowFail: true });
    if (sha) return { ref: `origin/${base}`, sha };
  }
  const sha = git(repoDir, ["rev-parse", base], { allowFail: true });
  if (!sha) throw new GitError(`Base branch "${base}" not found`);
  return { ref: base, sha };
}

export function branchExists(repoDir: string, branch: string): boolean {
  return !!git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true });
}

/** Pick a branch name that does not exist yet – never overwrite branches we did not create. */
export function uniqueBranch(repoDir: string, wanted: string): string {
  if (!branchExists(repoDir, wanted)) return wanted;
  for (let i = 2; i < 100; i++) if (!branchExists(repoDir, `${wanted}-${i}`)) return `${wanted}-${i}`;
  throw new GitError("Could not find a free branch name");
}

/** Isolated workspace per task. The user's own working copy is never touched. */
export function createWorktree(repoDir: string, projectId: string, taskId: string, branch: string, baseRef: string, linkDirs: string[] = []): string {
  const wt = path.join(ensureDir(path.join(paths.worktrees(), projectId)), taskId);
  if (fs.existsSync(wt)) removeWorktree(repoDir, wt);
  git(repoDir, ["worktree", "add", "-b", branch, wt, baseRef]);
  // Reuse installed dependencies (e.g. node_modules) from the main clone through a link – no reinstall per task.
  for (const d of linkDirs) {
    const src = path.join(repoDir, d), dst = path.join(wt, d);
    if (fs.existsSync(src) && !fs.existsSync(dst)) { try { fs.symlinkSync(src, dst, "junction"); } catch { /* falls back to the install command */ } }
  }
  return wt;
}

/** Remove only the links we created (never the real folders they point to). */
function unlinkDependencyLinks(wt: string): void {
  for (const d of ["node_modules"]) {
    const p = path.join(wt, d);
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* not present */ }
  }
}

export function removeWorktree(repoDir: string, wt: string): void {
  unlinkDependencyLinks(wt);
  git(repoDir, ["worktree", "remove", "--force", wt], { allowFail: true });
  if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  git(repoDir, ["worktree", "prune"], { allowFail: true });
}

export function headSha(dir: string): string { return git(dir, ["rev-parse", "HEAD"]); }

/**
 * Commit everything except the local .ai-workforce/ folder, as the developer: the repository's / global git identity is used.
 * The message is sanitised (hard rule: no Claude / AI attribution) and no trailers are added.
 */
export function commitAll(wt: string, message: string, fallbackName = "Developer"): string | undefined {
  git(wt, ["add", "-A", "--", ".", ":(exclude).ai-workforce"]);
  if (!git(wt, ["diff", "--cached", "--name-only"])) return undefined;
  const clean = stripAttribution(message) || "update";
  const identity = git(wt, ["config", "user.email"], { allowFail: true })
    ? [] : ["-c", `user.name=${fallbackName}`, "-c", "user.email=developer@users.noreply.github.com"];
  git(wt, [...identity, "commit", "--quiet", "-m", clean]);   // the team's git hooks run as usual
  return headSha(wt);
}

export function diffAgainst(wt: string, baseSha: string): string {
  return git(wt, ["diff", `${baseSha}...HEAD`]);
}

export function changedFiles(wt: string, baseSha: string): string[] {
  return git(wt, ["diff", "--name-only", `${baseSha}...HEAD`]).split("\n").filter(Boolean);
}

export function diffHash(wt: string, baseSha: string): string { return sha256(diffAgainst(wt, baseSha)); }

export function diffStat(wt: string, baseSha: string): { files: number; added: number; removed: number } {
  const out = git(wt, ["diff", "--numstat", `${baseSha}...HEAD`]);
  let added = 0, removed = 0, files = 0;
  for (const l of out.split("\n").filter(Boolean)) {
    const [a, r] = l.split("\t");
    files++; added += +a || 0; removed += +r || 0;
  }
  return { files, added, removed };
}

/** Rebase the task branch on the latest base. Returns false (and aborts) on conflict. */
export function rebaseOnto(wt: string, baseRef: string): boolean {
  try { git(wt, ["rebase", "--quiet", baseRef]); return true; }
  catch { git(wt, ["rebase", "--abort"], { allowFail: true }); return false; }
}

/** The remote of a GitHub repository (tests point it at a local bare repository; "{repo}" picks one per repository). */
export function remoteUrl(repoFullName: string): string {
  return process.env.AIW_GIT_PUSH_URL?.replace("{repo}", repoFullName.replace("/", "_")) ?? `https://github.com/${repoFullName}.git`;
}

export function pushBranch(wt: string, repoFullName: string, branch: string, authHeader: string): void {
  git(wt, ["push", "--quiet", remoteUrl(repoFullName), `HEAD:refs/heads/${branch}`], { extraHeader: authHeader });
}

/** Fetch a pull request's head commit (also from forks) into the local clone, without touching any branch. */
export function fetchPrHead(repoDir: string, repoFullName: string, num: number, authHeader?: string): string {
  const ref = `refs/aiw/pr/${num}`;
  git(repoDir, ["fetch", "--quiet", "--force", remoteUrl(repoFullName), `+refs/pull/${num}/head:${ref}`], { extraHeader: authHeader });
  return git(repoDir, ["rev-parse", ref]);
}

/** A read-only look at one commit (e.g. a PR to review): a detached worktree, no branch is created. */
export function createDetachedWorktree(repoDir: string, projectId: string, id: string, sha: string, linkDirs: string[] = []): string {
  const wt = path.join(ensureDir(path.join(paths.worktrees(), projectId)), id);
  if (fs.existsSync(wt)) removeWorktree(repoDir, wt);
  git(repoDir, ["worktree", "add", "--detach", wt, sha]);
  for (const d of linkDirs) {
    const src = path.join(repoDir, d), dst = path.join(wt, d);
    if (fs.existsSync(src) && !fs.existsSync(dst)) { try { fs.symlinkSync(src, dst, "junction"); } catch { /* optional */ } }
  }
  return wt;
}

/**
 * Put files (e.g. PR screenshots) on their own branch of the remote WITHOUT touching any working copy or the task
 * branch: the commit is built from a temporary index. When the branch already exists the new commit builds on it,
 * so nothing is force-pushed. Returns the commit pushed.
 */
export function pushFilesToBranch(repoDir: string, repoFullName: string, branch: string, files: { path: string; local: string }[], message: string, authHeader: string, fallbackName = "Developer"): string {
  const url = remoteUrl(repoFullName);
  const remote = git(repoDir, ["ls-remote", url, `refs/heads/${branch}`], { extraHeader: authHeader, allowFail: true }).split(/\s+/)[0];
  let parent = "";
  if (remote) {
    git(repoDir, ["fetch", "--quiet", url, `refs/heads/${branch}`], { extraHeader: authHeader });
    parent = git(repoDir, ["rev-parse", "FETCH_HEAD"]);
  }
  const index = path.join(ensureDir(path.join(paths.worktrees(), ".index")), `idx-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (parent) git(repoDir, ["read-tree", parent], { env });
    else git(repoDir, ["read-tree", "--empty"], { env });
    for (const f of files) {
      const blob = git(repoDir, ["hash-object", "-w", f.local]);
      git(repoDir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${f.path.replace(/\\/g, "/")}`], { env });
    }
    const tree = git(repoDir, ["write-tree"], { env });
    const identity = git(repoDir, ["config", "user.email"], { allowFail: true })
      ? [] : ["-c", `user.name=${fallbackName}`, "-c", "user.email=developer@users.noreply.github.com"];
    const commit = git(repoDir, [...identity, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", stripAttribution(message) || "Add screenshots"]);
    git(repoDir, ["push", "--quiet", url, `${commit}:refs/heads/${branch}`], { extraHeader: authHeader });
    return commit;
  } finally {
    try { fs.rmSync(index, { force: true }); } catch { /* temp file */ }
  }
}

/** Async variant for long-running build/test commands inside the worktree. */
export function runCommand(cmd: string, cwd: string, timeoutMs = 15 * 60_000, env: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  if (!cwd || !fs.existsSync(cwd)) return Promise.resolve({ code: 1, output: `working directory missing (${cwd || "none"})` });
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    // Windows: the whole command goes to cmd.exe verbatim inside one pair of quotes (cmd /s removes exactly that pair),
    // so commands that start with a quoted path ("C:\…\python.exe" -m pytest) keep their own quotes.
    const win = process.platform === "win32";
    const args = win ? ["/d", "/s", "/c", `"${cmd}"`] : ["-c", cmd];
    execFile(shell, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: win, env: { ...process.env, CI: "1", ...env } },
      (err: any, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, output: `${stdout}\n${stderr}`.trim() }));
  });
}

export function freeDiskBytes(dir: string): number | undefined {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return undefined; }
}
