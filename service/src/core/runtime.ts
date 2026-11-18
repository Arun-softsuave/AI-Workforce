import fs from "node:fs";
import { paths, ensureBaseDirs } from "./paths.js";

/** runtime.json tells clients (CLI, MCP server, hooks) where the local service listens. */
export interface Runtime { pid: number; port: number; token: string; startedAt: string; version: string }

export function readRuntime(): Runtime | undefined {
  try { return JSON.parse(fs.readFileSync(paths.runtime(), "utf8")); } catch { return undefined; }
}

export function writeRuntime(r: Runtime): void {
  ensureBaseDirs();
  fs.writeFileSync(paths.runtime(), JSON.stringify(r, null, 2), { mode: 0o600 });
}

export function clearRuntime(): void {
  try { fs.rmSync(paths.runtime()); } catch { /* ignore */ }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}

/** Call the local service API. Returns undefined when the service is not running. */
export async function api<T = any>(method: string, p: string, body?: unknown, timeoutMs = 10_000): Promise<T | undefined> {
  const rt = readRuntime();
  if (!rt || !pidAlive(rt.pid)) return undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${rt.port}${p}`, {
      method, signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "X-AIW-Token": rt.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error ?? `service returned ${res.status}`);
    return data as T;
  } catch (e: any) {
    if (e.name === "AbortError" || /ECONNREFUSED|fetch failed/.test(e.message)) return undefined;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the service to run a scheduler pass now (after approvals, manual runs, …). Silent if not running. */
export async function kick(): Promise<void> {
  try { await api("POST", "/api/kick", {}, 3000); } catch { /* best effort */ }
}

export const VERSION = "1.0.7";
