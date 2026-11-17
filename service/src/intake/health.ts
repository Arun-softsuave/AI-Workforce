/**
 * Connector health loop (W3; situations A6, A7, L4; IMPLEMENTATION-PLAN 5.18).
 *
 * Every 5 minutes one cheap call per connector, no model tokens:
 *   Jira `myself` · GitHub `user` (conditional request: a 304 is free and does not use the rate limit) ·
 *   Figma token `me` (token first; the desktop app only when settings say so) · Teams client `whoAmI` ·
 *   model access (Anthropic models list for an API key; nothing for the mock model).
 * Results go to `connector_health`. When a connector goes down:
 *   - kernel event `connector_down`;
 *   - items whose queued work needs it go BLOCKED (engine v2 only; v1 never enters BLOCKED) – the scheduler holds
 *     them through healthGate.isBlockedByConnector() on both engines; everything else keeps running;
 *   - one short reconnect message with the `aiw connect` command, repeated at most every 6 h while it stays down.
 * When it is back: `connector_up`, "✅ Jira reconnected" (only if we said it was down), BLOCKED items go back.
 * Rate limits (429, or 403 with no requests left) are "limited": work that needs it waits, no alert, no BLOCKED.
 * A network error counts as down only on the second check in a row (no alert for one dropped request).
 */
import { db, audit, getMeta, setMeta } from "../core/db.js";
import { nowIso, HttpError } from "../core/util.js";
import { logger } from "../core/log.js";
import { loadSettings, engineVersion } from "../core/config.js";
import { getSecret } from "../core/secrets.js";
import { registerTimer, runTimed } from "../core/timers.js";
import { publish } from "../live/bus.js";
import { emit } from "../kernel/events.js";
import { getTask, transition, mergeData, canTransition, type State } from "../engine/tasks.js";
import { notify } from "../notify/router.js";
import { clients, connectionMeta, onConnectionRecorded, preferredFigmaMode, type Provider } from "../connectors/registry.js";
import { figmaDesktopStatus } from "../connectors/figmaDesktop.js";
import { teamsPersonal } from "../connectors/teamsPersonal.js";
import { rowToJob } from "../kernel/mailbox.js";
import {
  HEALTH_PROVIDERS, PROVIDER_LABEL, needsOf, blockedByOf,
  type HealthProvider, type HealthRow, type HealthState, type BlockedBy,
} from "./healthGate.js";

export { isBlockedByConnector, blockingConnector, needsOf, unavailableConnectors, HEALTH_PROVIDERS, type HealthProvider } from "./healthGate.js";
export { preferredFigmaMode } from "../connectors/registry.js";

export const HEALTH_TIMER = "Connector health";
export const HEALTH_EVERY_MS = 5 * 60_000;
/** A reconnect message is repeated at most this often while a connector stays down. */
export const ALERT_REPEAT_MS = 6 * 3_600_000;
/** A new outage soon after the last message (a flapping connection) waits this long before another message. */
export const ALERT_NEW_OUTAGE_GAP_MS = 30 * 60_000;

// ------------------------------------------------------------------ probes

/** One check's result. "skip": the connector is not set up (nothing to check). */
export type ProbeResult =
  | { ok: true; account?: string; detail?: string }
  | { ok: false; kind: "auth" | "network" | "limited"; detail: string; retryAfterMs?: number }
  | "skip";
export type Probe = () => Promise<ProbeResult>;

const PROBE_TIMEOUT_MS = 15_000;
const GITHUB_API = () => process.env.AIW_GITHUB_API ?? "https://api.github.com";
const hasConnection = (p: Provider) => !!db().prepare("SELECT 1 FROM connections WHERE provider=?").get(p);

/** fetch with a short timeout and no retries (the next check is the retry). */
async function probeFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try { return await fetch(url, { headers, signal: ctrl.signal }); } finally { clearTimeout(timer); }
}

/** Map an HTTP status to a probe result (401 = sign-in expired; 429 or 403 with no requests left = rate limited). */
function fromStatus(label: string, res: Response): ProbeResult {
  if (res.ok || res.status === 304) return { ok: true };
  const ra = res.headers.get("retry-after");
  const reset = res.headers.get("x-ratelimit-reset");
  const remaining = res.headers.get("x-ratelimit-remaining");
  const retryAfterMs = ra && !isNaN(+ra) ? +ra * 1000 : reset && !isNaN(+reset) ? Math.max(0, +reset * 1000 - Date.now()) : undefined;
  if (res.status === 429 || (res.status === 403 && (remaining === "0" || !!ra))) return { ok: false, kind: "limited", detail: `${label} rate limit reached`, retryAfterMs };
  if (res.status === 401 || res.status === 403) return { ok: false, kind: "auth", detail: `${label} sign-in expired or was revoked` };
  return { ok: false, kind: "network", detail: `${label} answered ${res.status}` };
}

/** Map a thrown error (HttpError, network, MCP) to a probe result. */
export function classifyError(label: string, e: any): Exclude<ProbeResult, "skip" | { ok: true }> {
  const status = e instanceof HttpError ? e.status : typeof e?.status === "number" ? e.status : undefined;
  const msg = String(e?.message ?? e);
  if (status === 429) return { ok: false, kind: "limited", detail: `${label} rate limit reached`, retryAfterMs: e?.retryAfterMs };
  if (status === 401 || status === 403 || /\b(401|unauthori[sz]ed|invalid[_ ]token|token (has )?expired|sign[- ]?in|log ?in again|re-?authenticate)\b/i.test(msg))
    return { ok: false, kind: "auth", detail: `${label} sign-in expired or was revoked` };
  return { ok: false, kind: "network", detail: `Can't reach ${label}` };
}

export const defaultProbes: Record<HealthProvider, Probe> = {
  async jira() {
    if (!hasConnection("jira")) return "skip";
    const c = clients.jira();
    if (!c) return { ok: false, kind: "auth", detail: "No Jira sign-in saved" };
    try { const me = await c.myself(); return { ok: true, account: me.displayName }; } catch (e) { return classifyError("Jira", e); }
  },
  async github() {
    if (!hasConnection("github")) return "skip";
    const token = getSecret("github.token");
    if (!token) return { ok: false, kind: "auth", detail: "No GitHub sign-in saved" };
    const etag = getMeta("health.github.etag");
    try {
      const res = await probeFetch(`${GITHUB_API()}/user`, {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ai-workforce", ...(etag ? { "If-None-Match": etag } : {}),
      });
      const r = fromStatus("GitHub", res);
      if (res.status === 200) { const e = res.headers.get("etag"); if (e) setMeta("health.github.etag", e); }
      return r;
    } catch (e) { return classifyError("GitHub", e); }
  },
  async figma() {
    if (!hasConnection("figma")) return "skip";
    const token = getSecret("figma.token");
    const desktop = preferredFigmaMode() === "desktop" || (!token && connectionMeta("figma").auth === "figma-desktop");
    if (desktop) {
      const s = await figmaDesktopStatus().catch((e: any) => ({ ok: false, tools: [], detail: e?.message }));
      return s.ok ? { ok: true, account: "Figma desktop app" } : { ok: false, kind: "network", detail: "Figma desktop app is not running or its MCP server is off" };
    }
    if (!token) return { ok: false, kind: "auth", detail: "No Figma token saved" };
    try {
      const res = await probeFetch("https://api.figma.com/v1/me", { "X-Figma-Token": token });
      return fromStatus("Figma", res);
    } catch (e) { return classifyError("Figma", e); }
  },
  async teams() {
    if (!hasConnection("teams-personal")) return "skip";     // the webhook can't be checked without posting
    try {
      const tp = await teamsPersonal();
      if (!tp.hasSavedLogin()) return { ok: false, kind: "auth", detail: "Teams sign-in is missing" };
      const me = await tp.whoAmI();
      return { ok: true, account: me.mri };
    } catch (e) { return classifyError("Teams", e); }
  },
  async model() {
    const s = loadSettings();
    if (s.models.provider === "mock") return { ok: true, detail: "mock model" };
    if (s.models.provider === "claude-login") return { ok: true, detail: "Claude sign-in (checked when work runs)" };
    const key = getSecret("anthropic.apiKey") ?? process.env.ANTHROPIC_API_KEY;
    if (!key) return { ok: false, kind: "auth", detail: "No model API key saved" };
    try {
      const base = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
      const res = await probeFetch(`${base}/v1/models?limit=1`, { "x-api-key": key, "anthropic-version": "2023-06-01" });
      return fromStatus("The model API", res);
    } catch (e) { return classifyError("the model API", e); }
  },
};

let probes: Record<HealthProvider, Probe> = { ...defaultProbes };
/** Tests (and future adapters) replace probes here. */
export function setHealthProbes(p: Partial<Record<HealthProvider, Probe>>): void { probes = { ...probes, ...p }; }

// ------------------------------------------------------------------ state

const failStreak = new Map<HealthProvider, number>();
let checking = false;

export function healthRow(p: HealthProvider): HealthRow | undefined {
  return db().prepare("SELECT * FROM connector_health WHERE provider=?").get(p) as unknown as HealthRow | undefined;
}

/** Every row of connector_health (dashboard, `aiw status`). */
export function connectorHealth(): HealthRow[] {
  return db().prepare("SELECT * FROM connector_health ORDER BY provider").all() as unknown as HealthRow[];
}

function writeRow(p: HealthProvider, r: Partial<HealthRow> & { state: HealthState }): void {
  const prev = healthRow(p);
  const row: HealthRow = {
    provider: p, state: r.state,
    since: r.since ?? (prev && prev.state === r.state ? prev.since : nowIso()),
    last_ok: r.last_ok !== undefined ? r.last_ok : prev?.last_ok ?? null,
    last_alert: r.last_alert !== undefined ? r.last_alert : prev?.last_alert ?? null,
    detail: r.detail !== undefined ? r.detail : prev?.detail ?? null,
  };
  db().prepare(`INSERT INTO connector_health (provider, state, since, last_ok, last_alert, detail) VALUES (?,?,?,?,?,?)
    ON CONFLICT(provider) DO UPDATE SET state=excluded.state, since=excluded.since, last_ok=excluded.last_ok, last_alert=excluded.last_alert, detail=excluded.detail`)
    .run(row.provider, row.state, row.since, row.last_ok, row.last_alert, row.detail);
  if (!prev || prev.state !== row.state || prev.detail !== row.detail) {
    try { publish("connector", { provider: p, state: row.state, detail: row.detail, since: row.since }, { key: `health:${p}` }); } catch { /* live view only */ }
  }
}

/** The command that reconnects a connector. */
export function reconnectCommand(p: HealthProvider): string {
  if (p === "model") return "aiw model";
  if (p === "teams") return "aiw connect teams-personal";
  return `aiw connect ${p}`;
}

// ------------------------------------------------------------------ blocking and resuming items (engine v2)

/** States an item may be parked from (legal → BLOCKED transitions with nothing in flight). */
const PARKABLE: State[] = ["QUEUED", "RUNNING", "PR_OPEN", "PLANNING", "WAITING_CHILDREN"];

/**
 * Park items whose queued work needs `p` as BLOCKED (reason: connector). Items with a running job are left alone –
 * their current step finishes or fails on its own; the scheduler holds their next job. Returns the item ids parked.
 */
export function holdItemsFor(p: HealthProvider): string[] {
  if (engineVersion() !== "v2") return [];
  const rows = db().prepare(`SELECT j.* FROM jobs j JOIN tasks t ON t.id=j.item_id
    WHERE j.state='queued' AND j.type<>'ci_watch' AND t.state IN (${PARKABLE.map(() => "?").join(",")})
    AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.item_id=j.item_id AND r.state='running')
    ORDER BY j.created_at`).all(...PARKABLE) as any[];
  const parked: string[] = [];
  const label = PROVIDER_LABEL[p];
  for (const r of rows) {
    const job = rowToJob(r);
    if (parked.includes(job.item_id)) continue;
    const t = getTask(job.item_id);
    if (!t || !PARKABLE.includes(t.state) || !needsOf(t, job).has(p)) continue;
    try {
      const prev: BlockedBy | undefined = blockedByOf(t);
      transition(t.id, "BLOCKED", `connector ${p} down`, { error: `connector: ${label} disconnected` });
      mergeData(t.id, { blockedBy: { connectors: [...new Set([...(prev?.connectors ?? []), p])], prev: prev?.prev ?? t.state, at: nowIso() } });
      parked.push(t.id);
    } catch (e: any) { logger.warn("health: could not block item", { item: t.id, error: e.message }); }
  }
  // items already BLOCKED by another connector that also need this one: remember it, so they wait for both
  for (const r of db().prepare("SELECT id FROM tasks WHERE state='BLOCKED'").all() as any[]) {
    const t = getTask(r.id);
    const b = t && blockedByOf(t);
    if (!t || !b || b.connectors.includes(p)) continue;
    const q = db().prepare("SELECT * FROM jobs WHERE item_id=? AND state='queued' AND type<>'ci_watch' ORDER BY priority, created_at LIMIT 1").get(t.id);
    if (q && needsOf({ ...t, state: b.prev }, rowToJob(q)).has(p)) mergeData(t.id, { blockedBy: { ...b, connectors: [...b.connectors, p] } });
  }
  return parked;
}

/** Put items parked for `p` back where they were (when no other connector they wait for is still down). Returns the ids. */
export function releaseItemsFor(p: HealthProvider): string[] {
  const released: string[] = [];
  const stillDown = new Set((db().prepare("SELECT provider FROM connector_health WHERE state IN ('down','limited')").all() as any[]).map((r) => r.provider));
  for (const r of db().prepare("SELECT id FROM tasks WHERE state='BLOCKED'").all() as any[]) {
    const t = getTask(r.id);
    const b = t && blockedByOf(t);
    if (!t || !b || !b.connectors.includes(p)) continue;
    const left = b.connectors.filter((c) => c !== p && stillDown.has(c));
    if (left.length) { mergeData(t.id, { blockedBy: { ...b, connectors: left } }); continue; }
    // RUNNING can't be re-entered from BLOCKED: its job is queued again, so the item is QUEUED
    const back = (b.prev === "RUNNING" ? "QUEUED" : b.prev) as State;
    const to: State = canTransition(t, back) ? back : "QUEUED";
    try {
      transition(t.id, to, `connector ${p} back`, { error: null as any });
      mergeData(t.id, { blockedBy: null });
      released.push(t.id);
    } catch (e: any) { logger.warn("health: could not resume item", { item: t.id, error: e.message }); }
  }
  return released;
}

// ------------------------------------------------------------------ transitions

async function goDown(p: HealthProvider, detail: string, now: Date): Promise<void> {
  const prev = healthRow(p);
  const label = PROVIDER_LABEL[p];
  const isNew = prev?.state !== "down";
  const since = isNew ? now.toISOString() : prev!.since;
  writeRow(p, { state: "down", since, detail });
  if (isNew) {
    emit({ type: "connector_down", idemKey: `connector_down:${p}:${since}`, payload: { provider: p, detail } });
    audit("service", "connector.down", p, { detail });
    logger.warn("connector down", { provider: p, detail });
  }
  holdItemsFor(p);

  const lastAlert = prev?.last_alert ? new Date(prev.last_alert).getTime() : 0;
  const gap = isNew ? ALERT_NEW_OUTAGE_GAP_MS : ALERT_REPEAT_MS;
  if (lastAlert && now.getTime() - lastAlert < gap) return;
  writeRow(p, { state: "down", last_alert: now.toISOString() });
  try {
    await notify({
      kind: "connector_problem",
      title: `⚠️ ${label} disconnected – run \`${reconnectCommand(p)}\``,
      body: `${detail}. Work that needs ${label} waits; the rest keeps running. Or use Reconnect on the dashboard (\`aiw dashboard\`).`,
      dedupeKey: `${p}:${now.toISOString()}`,
      urgent: isNew,
    }, now);
  } catch (e: any) { logger.warn("health: reconnect message failed", { provider: p, error: e.message }); }
}

async function goUp(p: HealthProvider, r: { account?: string; detail?: string }, now: Date): Promise<void> {
  const prev = healthRow(p);
  const wasDown = prev?.state === "down";
  const wasHeld = wasDown || prev?.state === "limited";
  writeRow(p, { state: "up", last_ok: now.toISOString(), detail: r.account ?? r.detail ?? null, ...(wasHeld || !prev ? { since: now.toISOString() } : {}) });
  failStreak.delete(p);
  if (!wasHeld) return;
  releaseItemsFor(p);
  if (!wasDown) return;
  emit({ type: "connector_up", idemKey: `connector_up:${p}:${now.toISOString()}`, payload: { provider: p, downSince: prev!.since } });
  audit("service", "connector.up", p, { downSince: prev!.since });
  // say it is back only when we told the person it was down during this outage
  if (prev!.last_alert && prev!.last_alert >= prev!.since) {
    try {
      await notify({ kind: "info", title: `✅ ${PROVIDER_LABEL[p]} reconnected`, body: "Held work carries on.", dedupeKey: `up:${p}:${now.toISOString()}` }, now);
    } catch (e: any) { logger.warn("health: reconnected message failed", { provider: p, error: e.message }); }
  }
}

/** Apply one probe result for one connector. */
export async function applyResult(p: HealthProvider, r: ProbeResult, now = new Date()): Promise<HealthState | undefined> {
  if (r === "skip") {
    const prev = healthRow(p);
    if (prev && prev.state !== "off") { writeRow(p, { state: "off", detail: "not set up" }); releaseItemsFor(p); }
    failStreak.delete(p);
    return prev ? "off" : undefined;
  }
  if (r.ok) { await goUp(p, r, now); return "up"; }
  if (r.kind === "limited") {
    const until = r.retryAfterMs ? new Date(now.getTime() + r.retryAfterMs) : undefined;
    const prev = healthRow(p);
    if (prev?.state === "down") return "down";        // still down; a rate limit says nothing about the sign-in
    writeRow(p, { state: "limited", detail: until ? `${r.detail} – waiting until ${until.toISOString().slice(11, 16)} UTC` : r.detail });
    return "limited";
  }
  if (r.kind === "network") {
    const n = (failStreak.get(p) ?? 0) + 1;
    failStreak.set(p, n);
    const prev = healthRow(p);
    if (n < 2 && prev?.state !== "down") {
      writeRow(p, { state: prev?.state && prev.state !== "off" ? prev.state : "up", detail: `${r.detail} (once; checking again)` });
      return healthRow(p)!.state;
    }
  }
  await goDown(p, r.detail, now);
  return "down";
}

/** One health pass over every connector. Overlapping calls return at once. */
export async function checkHealth(now = new Date(), only?: HealthProvider[]): Promise<Record<string, HealthState | undefined>> {
  if (checking) return {};
  checking = true;
  const out: Record<string, HealthState | undefined> = {};
  try {
    for (const p of only ?? HEALTH_PROVIDERS) {
      let r: ProbeResult;
      try { r = await probes[p](); } catch (e) { r = classifyError(PROVIDER_LABEL[p], e); }
      try { out[p] = await applyResult(p, r, now); } catch (e: any) { logger.warn("health: check failed", { provider: p, error: e.message }); }
    }
    // keep parking new work that needs a connector that is still down
    for (const r of connectorHealth()) if (r.state === "down") holdItemsFor(r.provider as HealthProvider);
  } finally { checking = false; }
  return out;
}

/**
 * Called by code that saw a sign-in error mid-task (an API 401): marks the connector down at once instead of waiting
 * up to 5 minutes. Rate limits and network errors are left to the next check.
 */
export async function reportConnectorError(p: HealthProvider, e: unknown, now = new Date()): Promise<void> {
  const r = classifyError(PROVIDER_LABEL[p], e);
  if (r.kind === "auth") await applyResult(p, r, now);
}

/** Map a connections provider to the health provider it belongs to. */
export function healthProviderOf(p: Provider): HealthProvider | undefined {
  return p === "teams-personal" ? "teams" : (HEALTH_PROVIDERS as readonly string[]).includes(p) ? (p as HealthProvider) : undefined;
}

/**
 * Start the loop (daemon): registers the timer, runs a first check after `firstAfterMs`, then every 5 minutes, and
 * re-checks a connector as soon as it is reconnected. Returns a stop function.
 */
export function startHealthLoop(opts: { everyMs?: number; firstAfterMs?: number } = {}): () => void {
  const every = opts.everyMs ?? HEALTH_EVERY_MS;
  registerTimer(HEALTH_TIMER, every, "Jira, GitHub, Figma, Teams and model access sign-ins");
  const run = () => runTimed(HEALTH_TIMER, () => checkHealth()).catch((e) => logger.warn("health loop failed", { error: e?.message }));
  const first = setTimeout(run, opts.firstAfterMs ?? 20_000);
  const timer = setInterval(run, every);
  first.unref?.(); timer.unref?.();
  const off = onConnectionRecorded((p) => {
    const hp = healthProviderOf(p);
    if (hp) setTimeout(() => { checkHealth(new Date(), [hp]).catch(() => {}); }, 0);
  });
  return () => { clearTimeout(first); clearInterval(timer); off(); };
}

/** Tests only. */
export function _resetHealth(): void { probes = { ...defaultProbes }; failStreak.clear(); checking = false; }
