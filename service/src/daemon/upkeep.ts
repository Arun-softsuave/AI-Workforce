import { getMeta, setMeta, audit } from "../core/db.js";
import { loadProjects, getProject } from "../core/config.js";
import { listTasks } from "../engine/tasks.js";
import { notify } from "../notify/router.js";
import { logger } from "../core/log.js";

/**
 * Daily and restart upkeep (Wave D):
 *  - A3: once a day each repository's conventions, rules card and CI map are re-learned; when what CI runs (or what the
 *    plugin may fix in it) changed, you get one line.
 *  - A7: after the service was off for a while (computer asleep, restart), ONE catch-up message: how long it was off,
 *    what was picked up again, what waits for you.
 */

const ciSig = (projectId: string): string => {
  const ci = getProject(projectId)?.conventions?.ci;
  return JSON.stringify((ci?.jobs ?? []).map((j) => [j.workflow, j.job, j.fixable, j.kinds]).sort());
};

/** A3: re-learn each repository at most once a day; tell you when its CI rules changed. */
export async function dailyRefresh(now = Date.now()): Promise<number> {
  const day = new Date(now).toISOString().slice(0, 10);
  if (getMeta("upkeep.refreshDay") === day) return 0;
  setMeta("upkeep.refreshDay", day);
  const { detectConventions } = await import("../brain/conventions.js");
  const { buildRulesCard } = await import("../brain/rulesCard.js");
  let n = 0;
  for (const p of loadProjects()) {
    if (!p.local?.path) continue;
    const before = ciSig(p.id);
    try {
      await detectConventions(p.id);
      await buildRulesCard(p.id).catch(() => undefined);
      n++;
    } catch (e: any) { logger.warn("daily convention refresh failed", { project: p.id, error: e?.message }); continue; }
    const after = ciSig(p.id);
    if (before !== "[]" && before !== after) {
      const jobs = (getProject(p.id)?.conventions?.ci?.jobs ?? []).map((j) => `${j.name} (${j.fixable === "auto" ? "I fix it" : j.fixable === "human" ? "needs a person" : "I fix it carefully"})`);
      await notify({ kind: "info", dedupeKey: `ci-rules:${p.id}:${day}`, title: `🔧 CI changed in ${p.id}`,
        body: `What CI runs on a PR is different now. I follow the new set:\n${jobs.slice(0, 6).map((x) => `- ${x}`).join("\n")}${jobs.length > 6 ? `\n… ${jobs.length - 6} more` : ""}` }).catch(() => {});
      audit("service", "ci.rules_changed", p.id, {});
    }
  }
  return n;
}

const ALIVE = "service.lastAlive";

/** Called every loop: the service is up now. */
export function heartbeat(now = Date.now()): void { try { setMeta(ALIVE, String(now)); } catch { /* best effort */ } }

/** The time the service was last seen alive before this start (read once at start, before the first heartbeat). */
export function lastAlive(): number { return Number(getMeta(ALIVE) ?? 0); }

/** A7: one message after being off for more than 20 minutes (never on a first start). */
export async function catchUp(offSince: number, recovered: number, now = Date.now()): Promise<boolean> {
  if (!offSince || now - offSince < 20 * 60_000) return false;
  const mins = Math.round((now - offSince) / 60_000);
  const off = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
  const waiting = listTasks({ states: ["AWAITING_APPROVAL", "NEEDS_INFO", "AWAITING_START"] }).filter((t) => t.kind !== "part");
  const running = listTasks({ states: ["QUEUED", "RUNNING", "PR_OPEN"] }).filter((t) => t.kind !== "part").length;
  const lines = [
    recovered ? `- ${recovered} piece${recovered === 1 ? "" : "s"} of work picked up again where ${recovered === 1 ? "it" : "they"} stopped` : "",
    `- Jira and GitHub checked for everything that happened meanwhile`,
    running ? `- ${running} ticket${running === 1 ? "" : "s"} in progress or with an open PR` : "",
    waiting.length ? `- Waiting for you: ${waiting.slice(0, 5).map((t) => t.source_ref ?? t.id).join(", ")}${waiting.length > 5 ? ` and ${waiting.length - 5} more` : ""}` : "- Nothing waits for you",
  ].filter(Boolean);
  await notify({ kind: "info", dedupeKey: `catch-up:${offSince}`, title: `👋 I'm back – I was off for ${off}`, body: lines.join("\n") }).catch(() => {});
  audit("service", "service.catch_up", undefined, { minutes: mins, recovered });
  return true;
}
