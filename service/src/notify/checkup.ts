import { db, getMeta, setMeta } from "../core/db.js";
import { loadSettings } from "../core/config.js";
import { localHourMinute } from "../core/util.js";
import { listConnections } from "../connectors/registry.js";
import { listTasks, type Task } from "../engine/tasks.js";
import { latestApproval } from "../approvals/approvals.js";
import { taskNow } from "../api/ops.js";
import { notify } from "./router.js";

/**
 * Daily check-up (settings.workflow.checkupTime, default 10:00 local time): one message with everything that is
 * waiting for you, running, finished, failed or newly assigned, plus connection health. Built from local data only –
 * no AI, zero tokens. Sent once per day; if the computer was off at that time it is sent as soon as it is on again.
 */
export function localDate(d: Date, tz?: string): string {
  if (!tz) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const refOf = (t: Task) => t.source_ref ?? t.id;
const ago = (iso: string, now: Date) => {
  const h = Math.floor((now.getTime() - new Date(iso).getTime()) / 3_600_000);
  return h < 1 ? "under an hour" : h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
};

export function buildCheckup(now = new Date()): { title: string; body: string } {
  const notPart = (t: Task) => t.kind !== "part";       // a repository part is shown through its lead
  const waiting = listTasks({ states: ["AWAITING_APPROVAL", "NEEDS_INFO"] }).filter(notPart);
  const toStart = listTasks({ states: ["AWAITING_START"] }).filter(notPart);
  const running = listTasks({ states: ["QUEUED", "RUNNING", "PUBLISHING", "DETECTED", "TRIAGED", "WAITING_PARTS"] }).filter(notPart);
  const problems = listTasks({ states: ["FAILED", "PAUSED", "STALE", "FAILED_PUBLISH"] }).filter(notPart);
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const done = listTasks({ states: ["DONE"] }).filter((t) => notPart(t) && t.updated_at >= since);
  const fresh = listTasks({ states: ["DETECTED", "AWAITING_START", "QUEUED", "RUNNING"] }).filter((t) => t.source === "jira" && t.created_at >= since);

  const line = (t: Task) => `• ${refOf(t)} – ${t.title ?? ""}`.slice(0, 140);
  const sections: string[] = [];
  sections.push(waiting.length
    ? `⏳ Waiting for you (${waiting.length}):\n${waiting.map((t) => {
      const a = t.state === "AWAITING_APPROVAL" ? latestApproval(t.id) : undefined;
      const since2 = a?.requested_at ?? t.updated_at;
      return `${line(t)}\n   ${taskNow(t).waitingFor ?? taskNow(t).now} · for ${ago(since2, now)}`;
    }).join("\n")}`
    : "⏳ Nothing is waiting for your approval or answer.");
  if (toStart.length) sections.push(`🕓 Waiting to start (${toStart.length}) – say "start KAN-42" or "start all":\n${toStart.map(refOf).join(", ")}`);
  if (running.length) sections.push(`⚙️ In progress (${running.length}):\n${running.map((t) => `${line(t)}\n   ${taskNow(t).now}`).join("\n")}`);
  if (done.length) sections.push(`✅ Finished in the last 24 h (${done.length}):\n${done.map((t) => `${line(t)}${t.data.pr?.url ? `\n   ${t.data.pr.url}` : ""}`).join("\n")}`);
  if (problems.length) sections.push(`⚠️ Needs attention (${problems.length}):\n${problems.map((t) => `${line(t)}\n   ${taskNow(t).now}`.slice(0, 300)).join("\n")}`);
  if (fresh.length) sections.push(`🆕 Newly assigned (${fresh.length}):\n${fresh.map(line).join("\n")}`);

  const conns = listConnections();
  const broken = conns.filter((c) => c.status !== "connected");
  const failedMsgs = (db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE channel!='inbox' AND status IN ('failed','abandoned') AND created_at >= ?").get(since) as any).n as number;
  sections.push(broken.length
    ? `🔌 Connections: ${broken.map((c) => `${c.provider} ${c.status}`).join(", ")} – reconnect with \`aiw connect <name>\`.`
    : `🔌 Connections: ${conns.map((c) => c.provider).join(", ") || "none"} – all OK.`);
  if (failedMsgs) sections.push(`📭 ${failedMsgs} message(s) could not be delivered in the last 24 h.`);
  sections.push(waiting.length ? "Reply here to approve or answer – start with the ticket when several are waiting (e.g. \"KAN-42 1\")." : "Say \"plan for KAN-42\" or describe new work to start something.");
  return { title: `☀️ Daily check-up – ${localDate(now, loadSettings().profile.timezone)}`, body: sections.join("\n\n") };
}

/** Called from the service loop. Returns true when the check-up was sent now. */
export async function maybeSendCheckup(now = new Date()): Promise<boolean> {
  const s = loadSettings();
  const at = s.workflow.checkupTime;
  const m = /^(\d{1,2}):(\d{2})$/.exec(at ?? "");
  if (!m) return false;                                                  // "off"
  const [h, min] = localHourMinute(now, s.profile.timezone);
  if (h * 60 + min < +m[1] * 60 + +m[2]) return false;
  const today = localDate(now, s.profile.timezone);
  if (getMeta("checkup.date") === today) return false;
  setMeta("checkup.date", today);                                         // once per day, even if sending fails
  const { title, body } = buildCheckup(now);
  await notify({ kind: "checkup", title, body, dedupeKey: today });
  return true;
}
