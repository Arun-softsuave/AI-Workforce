import crypto from "node:crypto";
import type { ProjectConfig } from "../core/config.js";
import { getSecret, setSecret } from "../core/secrets.js";
import { logger } from "../core/log.js";
import { profileOf } from "./testProfile.js";

/**
 * A signed-in session for QA's live checks and the PR screenshots – any project, driven by its test profile:
 *   1. the saved session, while its access token is still valid
 *   2. renewed with the saved refresh token (no MFA needed)
 *   3. the demo account's login, answering MFA with the saved authenticator secret (TOTP) when the app asks
 *   4. nothing → the caller asks once in Teams and otherwise marks the work "not tested in the live local app"
 * Every new session is saved in the OS credential vault and reused until it expires. Values are never logged.
 */

export interface Session { access: string; refresh?: string; via: string }
interface Saved { access: string; refresh?: string; savedAt: string }

const key = (projectId: string) => `qa.${projectId}.session` as const;

/** Seconds until a JWT expires (undefined when it is not a JWT or has no exp). */
export function jwtSecondsLeft(token: string): number | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try { const exp = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")).exp; return typeof exp === "number" ? exp - Date.now() / 1000 : undefined; } catch { return undefined; }
}

/** RFC 6238 one-time code (SHA-1, 30 s, 6 digits) from a base32 authenticator secret. */
export function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secretBase32.replace(/[\s=-]/g, "").toUpperCase();
  let bits = "";
  for (const c of clean) { const v = alphabet.indexOf(c); if (v < 0) throw new Error("not a base32 secret"); bits += v.toString(2).padStart(5, "0"); }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = crypto.createHmac("sha1", bytes).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

export function saveSession(projectId: string, access: string, refresh?: string): void {
  setSecret(key(projectId), JSON.stringify({ access, refresh, savedAt: new Date().toISOString() } satisfies Saved));
}
function savedSession(projectId: string): Saved | undefined {
  try { const s = JSON.parse(getSecret(key(projectId)) ?? "null"); return s?.access ? s : undefined; } catch { return undefined; }
}

/** "access" or "access refresh" or JSON {access_token, refresh_token} → the pair. */
export function parseTokenInput(text: string): { access: string; refresh?: string } | undefined {
  const t = text.trim();
  try { const j = JSON.parse(t); const p = findTokens(j, []); if (p.access) return { access: p.access, refresh: p.refresh }; } catch { /* not JSON */ }
  const parts = t.split(/\s+/).filter((x) => x.length > 20);
  return parts[0] ? { access: parts[0], refresh: parts[1] } : undefined;
}

/** Tokens in a JSON body (any depth) or Set-Cookie headers. */
function findTokens(body: any, cookies: string[], names: { access?: string; refresh?: string } = {}): { access?: string; refresh?: string; mfa?: string } {
  const out: { access?: string; refresh?: string; mfa?: string } = {};
  const walk = (o: any) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") {
        if (!out.access && /^(access_?token|accessToken|token|jwt)$/i.test(k)) out.access = v;
        else if (!out.refresh && /^(refresh_?token|refreshToken)$/i.test(k)) out.refresh = v;
        else if (!out.mfa && /mfa.*token|challenge.*token|session$/i.test(k)) out.mfa = v;
      } else walk(v);
    }
  };
  walk(body);
  for (const c of cookies) {
    const m = /^([^=]+)=([^;]+)/.exec(c);
    if (!m) continue;
    if (!out.access && (m[1] === names.access || /access/i.test(m[1]))) out.access = m[2];
    if (!out.refresh && (m[1] === names.refresh || /refresh/i.test(m[1]))) out.refresh = m[2];
  }
  return out;
}

async function post(url: string, body: unknown): Promise<{ status: number; json: any; cookies: string[] }> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  let json: any = undefined;
  try { json = await r.json(); } catch { /* not JSON */ }
  const cookies = typeof (r.headers as any).getSetCookie === "function" ? (r.headers as any).getSetCookie() : (r.headers.get("set-cookie") ?? "").split(/,(?=\s*\w+=)/);
  return { status: r.status, json, cookies };
}

/**
 * A usable session against `api` (the running backend's API base URL). `frontend` holds the saved session / account;
 * `backend` is the repository whose profile describes the auth endpoints.
 */
export async function getSession(frontend: ProjectConfig, backend: ProjectConfig, api: string, account?: { email: string; password: string }): Promise<Session | { reason: string }> {
  const auth = profileOf(backend).login;
  const names = { access: auth.accessCookie || undefined, refresh: auth.refreshCookie || undefined };
  const reasons: string[] = [];
  // 1) the saved session
  const saved = savedSession(frontend.id);
  if (saved) {
    const left = jwtSecondsLeft(saved.access);
    if (left === undefined || left > 300) return { access: saved.access, refresh: saved.refresh, via: "the saved session" };
    // 2) renew it (no MFA)
    if (saved.refresh && auth.refreshPath) {
      try {
        const r = await post(`${api}${auth.refreshPath}`, { refresh_token: saved.refresh });
        const t = findTokens(r.json, r.cookies, names);
        if (r.status < 300 && t.access) { saveSession(frontend.id, t.access, t.refresh ?? saved.refresh); return { access: t.access, refresh: t.refresh ?? saved.refresh, via: "the saved session, renewed" }; }
        reasons.push(`renewing the saved session failed (HTTP ${r.status})`);
      } catch (e: any) { reasons.push(`renewing the saved session failed (${e.message})`); }
    } else reasons.push("the saved session has expired");
  }
  // 3) the demo account (+ authenticator code when the app asks for MFA)
  if (account && auth.path) {
    try {
      const r = await post(`${api}${auth.path}`, { email: account.email, password: account.password });
      const t = findTokens(r.json, r.cookies, names);
      if (r.status < 300 && t.access) { saveSession(frontend.id, t.access, t.refresh); return { access: t.access, refresh: t.refresh, via: "the demo account" }; }
      if (r.status < 300 && t.mfa) {
        const secret = getSecret(`qa.${frontend.id}.totp`);
        if (!secret) reasons.push("the demo account needs an authenticator code (save its authenticator secret with `aiw qa account <project> <email> --totp`)");
        else if (!auth.mfaPath) reasons.push("the app asks for MFA but the profile has no MFA path (set qa.profile.login.mfaPath)");
        else {
          const v = await post(`${api}${auth.mfaPath}`, { [auth.mfaTokenField || "mfa_token"]: t.mfa, [auth.mfaCodeField || "code"]: totp(secret) });
          const s = findTokens(v.json, v.cookies, names);
          if (v.status < 300 && s.access) { saveSession(frontend.id, s.access, s.refresh); return { access: s.access, refresh: s.refresh, via: "the demo account with its authenticator code" }; }
          reasons.push(`the authenticator code was not accepted (HTTP ${v.status})`);
        }
      } else if (r.status >= 300) reasons.push(`the demo login failed (HTTP ${r.status}${r.json?.error?.code ? ` ${r.json.error.code}` : r.json?.detail ? ` ${String(r.json.detail).slice(0, 80)}` : ""})`);
    } catch (e: any) { reasons.push(`the demo login failed (${e.message})`); }
  } else if (!saved) reasons.push("no saved session and no demo account");
  logger.info("qa session not available", { project: frontend.id, reasons });
  return { reason: reasons.join("; ") };
}
