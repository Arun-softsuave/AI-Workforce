import { db } from "../core/db.js";
import { listConnections } from "../connectors/registry.js";
import { mergeOrder } from "../kernel/items.js";

/**
 * Morning digest (W17, L6): at most 10 lines – done / in progress / waiting on you / blocked / merge next /
 * connections. Built from local data only (no model call). The long check-up stays behind "details digest".
 */
const DONE = ["DONE", "MERGED", "PR_OPEN"];
const RUNNING = ["DETECTED", "TRIAGED", "QUEUED", "RUNNING", "PUBLISHING", "WAITING_PARTS", "PLANNING", "WAITING_CHILDREN"];
const WAITING = ["AWAITING_APPROVAL", "NEEDS_INFO", "AWAITING_START"];
const BLOCKED = ["BLOCKED", "FAILED", "PAUSED", "STALE", "FAILED_PUBLISH"];

interface Row { id: string; source_ref: string | null; state: string; updated_at: string; level: string | null; owner: string | null; kind: string }

function rows(states: string[]): Row[] {
  // repository parts show through their lead; containers (epic/sprint/batch) show through their children; teammates' items are theirs
  return db().prepare(`SELECT id, source_ref, state, updated_at, level, owner, kind FROM tasks WHERE state IN (${states.map(() => "?").join(",")})
    AND kind != 'part' AND COALESCE(level,'ticket') NOT IN ('epic','sprint','batch') AND COALESCE(owner,'me')='me'
    ORDER BY priority ASC, created_at ASC LIMIT 200`).all(...states) as unknown as Row[];
}

const refs = (rs: Row[], max = 5) => {
  const names = rs.map((r) => r.source_ref ?? r.id);
  return names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max} more` : names.join(", ");
};

export function buildDigest(now = new Date()): { lines: string[]; body: string } {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const done = rows(DONE).filter((r) => r.updated_at >= since);
  const running = rows(RUNNING);
  const waiting = rows(WAITING);
  const blocked = rows(BLOCKED);
  const open = rows(["PR_OPEN"]);
  let mergeNext = "";
  if (open.length) {
    const r = mergeOrder(open.map((o) => o.id));
    const byId = new Map(open.map((o) => [o.id, o]));
    const first = r.order.map((id) => byId.get(id)!).filter(Boolean);
    mergeNext = first.length ? refs(first, 3) : "";
    if (r.cycle) mergeNext += `${mergeNext ? " · " : ""}a dependency loop needs you`;
  }
  const conns = listConnections();
  const broken = conns.filter((c) => c.status !== "connected");
  const lines = [
    `✅ Done: ${done.length ? `${done.length} – ${refs(done)}` : "none in the last 24 h"}`,
    `⚙️ In progress: ${running.length ? `${running.length} – ${refs(running)}` : "none"}`,
    `⏳ Waiting on you: ${waiting.length ? `${waiting.length} – ${refs(waiting)}` : "nothing"}`,
    `⚠️ Blocked: ${blocked.length ? `${blocked.length} – ${refs(blocked)}` : "nothing"}`,
    `🔀 Merge next: ${mergeNext || "no open PRs"}`,
    `🔌 Connections: ${broken.length ? `${broken.map((c) => `${c.provider} ${c.status}`).join(", ")} – reconnect with \`aiw connect <name>\`` : `${conns.map((c) => c.provider).join(", ") || "none"} – all OK`}`,
    `Reply "details digest" for the full check-up.`,
  ];
  return { lines, body: lines.slice(0, 10).join("\n") };
}
