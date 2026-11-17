/**
 * One-time data migration when engine v2 first starts (idempotent; meta "kernel.migrated.v2" marks it done).
 *  1. a consistent copy of the database is written to <AIW_HOME>/aiw.db.bak-v2-migrate first;
 *  2. multi-repository parts (data.leadId) become children of their lead: parent_id, root_id, level "part";
 *  3. open FIX-n / QA-n / REVIEW-n tasks become light "pr" items (they keep their own row and state) with a job of the
 *     matching type, under the ticket item that raised the PR when there is one;
 *  4. every PR in meta fix.ciwatch gets a passive ci_watch job on its item (a light pr item when nothing here raised it);
 *  5. events v1 already acted on are marked "ignored", so the reactions never act on them again.
 * Steps 2 and the root_id fill are also run on every kernel pass (linkParts), for parts created later.
 */
import fs from "node:fs";
import { db, getMeta, setMeta, audit } from "../core/db.js";
import { paths } from "../core/paths.js";
import { nowIso, safeJson } from "../core/util.js";
import { logger } from "../core/log.js";
import { getRecipe } from "./recipes.js";
import { createJob } from "./mailbox.js";
import { ignoreBacklog } from "./events.js";
import { itemForPr, upsertCiWatchJob } from "./prs.js";
import type { JobType } from "./types.js";

export const MIGRATED_KEY = "kernel.migrated.v2";

/** Copy the database before the data migration (best effort; once). Returns the backup path. */
export function backupForKernel(): string | undefined {
  const file = paths.db();
  const bak = `${file}.bak-v2-migrate`;
  try {
    if (fs.existsSync(bak)) return bak;
    db().prepare("VACUUM INTO ?").run(bak);
    return bak;
  } catch (e: any) {
    logger.warn("database backup before the v2 migration failed", { error: e.message });
    return undefined;
  }
}

/** Parts (data.leadId) under their lead; every item without a root is its own root. Cheap and idempotent. */
export function linkParts(): number {
  const d = db();
  const r = d.prepare(`UPDATE tasks SET parent_id = json_extract(data,'$.leadId'), level = 'part',
      root_id = COALESCE((SELECT COALESCE(l.root_id, l.id) FROM tasks l WHERE l.id = json_extract(tasks.data,'$.leadId')), json_extract(data,'$.leadId'))
    WHERE parent_id IS NULL AND json_extract(data,'$.leadId') IS NOT NULL
      AND EXISTS (SELECT 1 FROM tasks l WHERE l.id = json_extract(tasks.data,'$.leadId'))`).run();
  d.prepare("UPDATE tasks SET root_id = id WHERE root_id IS NULL AND parent_id IS NULL").run();
  return Number(r.changes);
}

const PR_KINDS: Record<string, JobType> = { pr_fix: "comment_fix", pr_qa: "qa", pr_review: "review" };
/** Task states whose job is waiting on a person, an approval or the lead (not runnable until the task is QUEUED). */
const OPEN = ["TRIAGED", "QUEUED", "RUNNING", "PUBLISHING", "NEEDS_INFO", "AWAITING_START", "AWAITING_APPROVAL", "PAUSED", "REJECTED", "STALE", "FAILED_PUBLISH"];

/** PR work of a fix / QA / review task: repo and number. */
function prOf(data: Record<string, any>): { repo: string; num: number } | undefined {
  const x = data.fix ?? data.qa ?? data.review;
  return x?.repo && x?.num ? { repo: String(x.repo), num: Number(x.num) } : undefined;
}

export interface KernelMigration { parts: number; prItems: number; jobs: number; watches: number; events: number; backup?: string }

export const REPAIR_OPEN_PR_KEY = "kernel.repair.openPrEvents";

/**
 * One-time repair (1.0.1): before tickets finished by the old engine could be reopened for their open PR, events on
 * those PRs (a conflict, a failing check, a change request) were marked "ignored". Put the recent ones back in the
 * queue so routing looks at them again – it now reopens the ticket (DONE → PR_OPEN) and starts the right job.
 * Returns how many events were put back.
 */
export function repairIgnoredPrEvents(days = 14): number {
  if (getMeta(REPAIR_OPEN_PR_KEY)) return 0;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const r = db().prepare(`UPDATE events SET handled_by = NULL, processed_at = NULL
    WHERE handled_by = 'ignored' AND type IN ('pr_conflict','ci_failed','changes_requested') AND received_at >= ?
      AND item_id IN (SELECT id FROM tasks WHERE state = 'DONE' AND (json_extract(data,'$.pr') IS NOT NULL OR json_extract(data,'$.prs') IS NOT NULL))`).run(since);
  setMeta(REPAIR_OPEN_PR_KEY, nowIso());
  const n = Number(r.changes);
  if (n) { audit("service", "kernel.repaired_pr_events", undefined, { events: n }); logger.info("engine v2: ignored PR events queued again", { events: n }); }
  return n;
}

/** Run the v2 data migration once. Returns undefined when it already ran. */
export function migrateToKernel(): KernelMigration | undefined {
  if (getMeta(MIGRATED_KEY)) return undefined;
  const backup = backupForKernel();
  const d = db();
  const out: KernelMigration = { parts: 0, prItems: 0, jobs: 0, watches: 0, events: 0, backup };
  d.exec("BEGIN IMMEDIATE");
  try {
    out.parts = linkParts();

    // open fix / QA / review tasks: light pr items with their job
    const rows = d.prepare(`SELECT * FROM tasks WHERE kind IN ('pr_fix','pr_qa','pr_review') AND state IN (${OPEN.map(() => "?").join(",")})`).all(...OPEN) as any[];
    for (const r of rows) {
      const data = safeJson<Record<string, any>>(r.data, {});
      const pr = prOf(data);
      const parent = pr ? itemForPr(pr.repo, pr.num) : undefined;
      d.prepare("UPDATE tasks SET level='pr', parent_id=COALESCE(parent_id, ?), root_id=COALESCE(?, root_id, id), updated_at=? WHERE id=?")
        .run(parent?.id ?? null, parent ? (parent.root_id ?? parent.id) : null, nowIso(), r.id);
      out.prItems++;
      if (!r.playbook) continue;
      const has = d.prepare("SELECT 1 FROM jobs WHERE item_id=? AND state IN ('queued','running','waiting') AND type<>'ci_watch'").get(r.id);
      if (has) continue;
      let type: JobType = PR_KINDS[r.kind] ?? "build";
      try { type = getRecipe(r.playbook).job; } catch { /* unknown playbook: keep the kind's type */ }
      const j = createJob({ itemId: r.id, type, recipe: r.playbook, priority: r.priority ?? 3, data: { migrated: true } });
      const state = ["QUEUED", "RUNNING", "PUBLISHING"].includes(r.state) ? "queued" : "waiting";
      d.prepare("UPDATE jobs SET state=?, step_index=? WHERE id=?").run(state, r.step_index ?? 0, j.id);
      out.jobs++;
    }

    // CI watches: a passive ci_watch job on each PR's item
    let watches: any[] = [];
    try { watches = JSON.parse(getMeta("fix.ciwatch") ?? "[]"); } catch { watches = []; }
    for (const w of Array.isArray(watches) ? watches : []) {
      if (!w?.repo || !w?.num || !w?.projectId) continue;
      if (upsertCiWatchJob(w, { createLight: true })) out.watches++;
    }

    // events v1 already handled must not be routed again
    out.events = ignoreBacklog();
    setMeta(MIGRATED_KEY, nowIso());
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  audit("service", "kernel.migrated", undefined, out);
  logger.info("engine v2: data migrated", { ...out });
  return out;
}
