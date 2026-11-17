import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Root of all local state. Override with AIW_HOME (used by tests). */
export function aiwHome(): string {
  return process.env.AIW_HOME ?? path.join(os.homedir(), ".ai-workforce");
}

export const paths = {
  home: () => aiwHome(),
  db: () => path.join(aiwHome(), "aiw.db"),
  configDir: () => path.join(aiwHome(), "config"),
  settings: () => path.join(aiwHome(), "config", "settings.yaml"),
  projects: () => path.join(aiwHome(), "config", "projects.yaml"),
  runtime: () => path.join(aiwHome(), "runtime.json"),
  lock: () => path.join(aiwHome(), "aiw-agentd.lock"),
  logs: () => path.join(aiwHome(), "logs"),
  worktrees: () => path.join(aiwHome(), "worktrees"),
  projectDir: (id: string) => path.join(aiwHome(), "projects", id),
  codeMap: (id: string) => path.join(aiwHome(), "projects", id, "code-map.json"),
  diaryDir: (id: string) => path.join(aiwHome(), "projects", id, "tasks"),
  globalPrefs: () => path.join(aiwHome(), "global", "me.md"),
  /** Shared Handbook lives inside the repository so the team reviews it via PRs. */
  knowledgeDir: (repoPath: string) => path.join(repoPath, ".ai-workforce", "knowledge"),
};

/** Directory that contains the installed service (…/service). */
export function serviceRoot(): string {
  // dist/core/paths.js -> service/
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function ensureBaseDirs(): void {
  for (const d of [paths.home(), paths.configDir(), paths.logs(), paths.worktrees(), path.dirname(paths.globalPrefs())]) ensureDir(d);
}
