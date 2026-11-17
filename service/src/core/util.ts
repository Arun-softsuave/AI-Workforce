import crypto from "node:crypto";

export const nowIso = (): string => new Date().toISOString();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sha256 = (s: string | Buffer): string => crypto.createHash("sha256").update(s).digest("hex");
export const newId = (prefix: string): string => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
export const randomToken = (): string => crypto.randomBytes(24).toString("base64url");

export function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

export function slugify(s: string, max = 40): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "task";
}

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Parse "HH:MM-HH:MM" (may wrap midnight) and test if a Date's local time is inside. */
export function inTimeWindow(window: string | undefined, d: Date, tz?: string): boolean {
  if (!window) return false;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!m) return false;
  const [hh, mm] = localHourMinute(d, tz);
  const cur = hh * 60 + mm;
  const a = +m[1] * 60 + +m[2];
  const b = +m[3] * 60 + +m[4];
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

export function localHourMinute(d: Date, tz?: string): [number, number] {
  if (!tz) return [d.getHours(), d.getMinutes()];
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return [get("hour") % 24, get("minute")];
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfterMs?: number) { super(message); }
}

/** fetch with timeout, JSON handling and retry with back-off on 429/5xx/network errors. */
export async function httpJson<T = any>(url: string, init: RequestInit & { retries?: number; timeoutMs?: number } = {}): Promise<T> {
  const retries = init.retries ?? 3;
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (res.ok) {
        try { return (text ? JSON.parse(text) : {}) as T; }
        catch { throw new HttpError(res.status, `${redactUrl(url)} returned a web page instead of API data – check the site address (use only the domain, e.g. yourcompany.atlassian.net)`); }
      }
      const ra = res.headers.get("retry-after");
      const retryAfterMs = ra ? (isNaN(+ra) ? 5000 : +ra * 1000) : undefined;
      const err = new HttpError(res.status, `${init.method ?? "GET"} ${redactUrl(url)} -> ${res.status}: ${truncate(text, 300)}`, retryAfterMs);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        attempt++;
        await sleep(retryAfterMs ?? backoff(attempt));
        continue;
      }
      throw err;
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      if (attempt < retries) { attempt++; await sleep(backoff(attempt)); continue; }
      throw new Error(`Network error calling ${redactUrl(url)}: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const backoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);

function redactUrl(u: string): string {
  return u.replace(/([?&](token|key|sig)=)[^&]+/gi, "$1***");
}

/** Remove anything that looks like a credential before it is logged or sent in a notification. */
export function redactSecrets(s: string): string {
  return s
    .replace(/(xox[abpr]-[A-Za-z0-9-]{10,})/g, "xox*-***")
    .replace(/(gh[pousr]_[A-Za-z0-9]{20,})/g, "gh*_***")
    .replace(/(sk-ant-[A-Za-z0-9_-]{10,})/g, "sk-ant-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/g, "$1***")
    .replace(/(Basic\s+)[A-Za-z0-9+/=]{12,}/g, "$1***");
}
