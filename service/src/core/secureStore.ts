import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Entry } from "@napi-rs/keyring";
import { paths, ensureDir } from "./paths.js";

/**
 * Encrypted JSON store for credentials that are too long for one OS-vault entry (OAuth tokens, Teams tokens):
 * a random AES-256 key lives in the OS credential vault; the data is AES-256-GCM encrypted in ~/.ai-workforce/<name>.enc.
 * The file alone is useless without the vault key. Tests (AIW_SECRETS=memory) keep everything in memory.
 */
const SERVICE = process.env.AIW_KEYRING_SERVICE ?? "ai-workforce";
const memory = new Map<string, string>();
const useMemory = () => process.env.AIW_SECRETS === "memory";
const file = (name: string) => path.join(paths.home(), `${name}.enc`);

function key(name: string, create: boolean): Buffer | undefined {
  const entry = new Entry(SERVICE, `${name}.key`);
  let k: string | null = null;
  try { k = entry.getPassword(); } catch { k = null; }
  if (!k && create) { k = crypto.randomBytes(32).toString("base64"); entry.setPassword(k); }
  return k ? Buffer.from(k, "base64") : undefined;
}

export function readSecure<T = any>(name: string): T | undefined {
  if (useMemory()) { const v = memory.get(name); return v ? JSON.parse(v) : undefined; }
  try {
    const k = key(name, false);
    if (!k) return undefined;
    const raw = fs.readFileSync(file(name));
    const d = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
  } catch { return undefined; }
}

export function writeSecure(name: string, value: unknown): void {
  const json = JSON.stringify(value);
  if (useMemory()) { memory.set(name, json); return; }
  const k = key(name, true)!;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([c.update(json, "utf8"), c.final()]);
  ensureDir(paths.home());
  fs.writeFileSync(file(name), Buffer.concat([iv, c.getAuthTag(), data]), { mode: 0o600 });
}

export function deleteSecure(name: string): void {
  if (useMemory()) { memory.delete(name); return; }
  try { fs.rmSync(file(name)); } catch { /* not present */ }
  try { new Entry(SERVICE, `${name}.key`).deletePassword(); } catch { /* not present */ }
}
