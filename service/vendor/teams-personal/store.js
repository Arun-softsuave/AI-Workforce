// AI Workforce replacement for msteams-personal-mcp's src/store.js (same exports).
// The original encrypted the Microsoft refresh token with a key derived from hostname + username (obfuscation).
// Here: a random 256-bit key is kept in the OS credential vault (Windows Credential Manager / macOS Keychain /
// libsecret) and the token is AES-256-GCM encrypted in ~/.ai-workforce/teams-personal.enc.
// (Teams tokens are longer than a single Windows Credential Manager entry allows, so the token itself can't live there.)
// Tests set AIW_SECRETS=memory to keep everything in-process.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Entry } from '@napi-rs/keyring';

const SERVICE = process.env.AIW_KEYRING_SERVICE ?? 'ai-workforce';
const KEY_ACCOUNT = 'teamsPersonal.key';
const memory = { value: null };
const useMemory = () => process.env.AIW_SECRETS === 'memory';

export const CONFIG_DIR = process.env.AIW_HOME ?? path.join(os.homedir(), '.ai-workforce');
const STORE_FILE = path.join(CONFIG_DIR, 'teams-personal.enc');

function vaultKey(create) {
  const entry = new Entry(SERVICE, KEY_ACCOUNT);
  let k = null;
  try { k = entry.getPassword(); } catch { k = null; }
  if (!k && create) { k = crypto.randomBytes(32).toString('base64'); entry.setPassword(k); }
  return k ? Buffer.from(k, 'base64') : null;
}

export function readStore() {
  if (useMemory()) return memory.value ? JSON.parse(memory.value) : {};
  try {
    const key = vaultKey(false);
    if (!key) return {};
    const raw = fs.readFileSync(STORE_FILE);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    return {};
  }
}

export function writeStore(obj) {
  const json = JSON.stringify(obj);
  if (useMemory()) { memory.value = json; return; }
  const key = vaultKey(true);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
}

export function clearStore() {
  if (useMemory()) { memory.value = null; return; }
  try { fs.rmSync(STORE_FILE); } catch { /* not present */ }
  try { new Entry(SERVICE, KEY_ACCOUNT).deletePassword(); } catch { /* not present */ }
}
