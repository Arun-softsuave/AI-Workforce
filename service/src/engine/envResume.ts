import { getProject } from "../core/config.js";
import { logger } from "../core/log.js";
import { listTasks, mergeData, type Task } from "./tasks.js";
import { resumeTask } from "./engine.js";
import { checkEnvironment, type EnvResult } from "./envDoctor.js";
import { notify } from "../notify/router.js";

/**
 * Auto-resume for "Blocked: environment" (W2 12a). A task the environment check paused keeps
 * data.blocked = { reason: "environment", report }. Every few minutes the daemon checks those repositories again
 * (no cache); when the setup is fixed the task goes back in the queue with one short message.
 */
export function environmentBlocked(): Task[] {
  return listTasks({ states: ["PAUSED"] }).filter((t) => t.data?.blocked?.reason === "environment");
}

export async function resumeEnvironmentBlockedTasks(
  check: (repo: string, project: any) => Promise<EnvResult> = (repo, project) => checkEnvironment(repo, { project, force: true }),
): Promise<number> {
  const blocked = environmentBlocked();
  if (!blocked.length) return 0;
  const results = new Map<string, EnvResult>();          // one check per project, however many tasks wait on it
  let resumed = 0;
  for (const t of blocked) {
    const p = getProject(t.project_id);
    if (!p?.local?.path) continue;
    try {
      let env = results.get(p.id);
      if (!env) { env = await check(p.local.path, p); results.set(p.id, env); }
      if (!env.ok) continue;
      mergeData(t.id, { blocked: null });
      const r = resumeTask(t.id);
      if (r?.state !== "QUEUED") continue;
      resumed++;
      const ref = t.source_ref ?? t.id;
      await notify({ kind: "info", taskId: t.id, taskRef: t.source_ref ?? undefined, title: `${ref}: environment fixed, continuing.`, body: "", dedupeKey: `env-fixed:${t.id}:${t.data?.blocked?.at ?? ""}` });
    } catch (e: any) { logger.warn("environment re-check failed", { task: t.id, error: e.message }); }
  }
  return resumed;
}
