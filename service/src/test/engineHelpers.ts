import { waitFor } from "./helpers.js";
import { engineVersion } from "../core/config.js";
import { db } from "../core/db.js";
import { getTask, type Task } from "../engine/tasks.js";

/**
 * Where a ticket's work ends once its PR is raised: DONE on engine v1; PR_OPEN on engine v2 (the kernel then looks
 * after the PR until it is merged or closed). Lets the end-to-end tests run on both engines with the same checks.
 */
export const prEndState = (): string => (engineVersion() === "v2" ? "PR_OPEN" : "DONE");

/**
 * Wait until the task reaches the PR end state (or one of `stops`) and, on v2, its build job has finished the rest of
 * the recipe (ticket report, memory) – so every later check sees the same finished work as on v1.
 * `poke` runs on each poll (e.g. tick()).
 */
export async function settleAfterPr(ref: string, stops: string[] = ["FAILED", "PAUSED", "FAILED_PUBLISH"], poke?: () => void, everyMs = 50): Promise<Task> {
  const end = prEndState();
  return waitFor(() => {
    poke?.();
    const t = getTask(ref);
    if (!t) return undefined;
    if (stops.includes(t.state)) return t;
    if (t.state !== end) return undefined;
    if (end === "PR_OPEN") {
      const busy = (db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE item_id=? AND state IN ('queued','running') AND type<>'ci_watch'").get(t.id) as any).n;
      if (busy) return undefined;
      return getTask(t.id);
    }
    return t;
  }, 60_000, everyMs);
}
