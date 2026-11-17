import { Entry } from "@napi-rs/keyring";

/**
 * Credentials live ONLY in the OS credential vault
 * (Windows Credential Manager / macOS Keychain / libsecret) – never in files, logs or the database.
 * Tests can set AIW_SECRETS=memory to use an in-process store.
 */
const SERVICE = process.env.AIW_KEYRING_SERVICE ?? "ai-workforce";
const memory = new Map<string, string>();
const useMemory = () => process.env.AIW_SECRETS === "memory";

export type SecretName =
  | "anthropic.apiKey" | "jira.token" | "github.token" | "slack.botToken" | "slack.appToken"
  | "teams.webhookUrl" | "notion.token" | "figma.token" | "api.sessionToken"
  | `qa.${string}`;                        // the QA demo account per product (qa.<project>.email / .password)

/**
 * The Windows credential vault holds at most 2560 bytes (1280 UTF-16 characters) per entry; cloud session tokens and
 * signed-in sessions can be longer. Long values are split over numbered entries ("name#1", "name#2", …) and the main
 * entry only records how many parts there are.
 */
const PART = 1000;
const CHUNKED = /^aiw-chunked:(\d+)$/;

const rawGet = (name: string): string | undefined => {
  if (useMemory()) return memory.get(name);
  try { return new Entry(SERVICE, name).getPassword() ?? undefined; } catch { return undefined; }
};
const rawSet = (name: string, value: string) => { if (useMemory()) memory.set(name, value); else new Entry(SERVICE, name).setPassword(value); };
const rawDel = (name: string) => { if (useMemory()) memory.delete(name); else { try { new Entry(SERVICE, name).deletePassword(); } catch { /* not present */ } } };

export function setSecret(name: SecretName, value: string): void {
  if (!value) throw new Error(`Empty value for ${name}`);
  deleteSecret(name);                                        // old parts of a longer value must not linger
  if (value.length <= PART) { rawSet(name, value); return; }
  const parts = value.match(new RegExp(`[\\s\\S]{1,${PART}}`, "g"))!;
  parts.forEach((p, i) => rawSet(`${name}#${i + 1}`, p));
  rawSet(name, `aiw-chunked:${parts.length}`);
}

export function getSecret(name: SecretName): string | undefined {
  const v = rawGet(name);
  const m = v ? CHUNKED.exec(v) : null;
  if (!m) return v;
  const parts: string[] = [];
  for (let i = 1; i <= Number(m[1]); i++) { const p = rawGet(`${name}#${i}`); if (p === undefined) return undefined; parts.push(p); }
  return parts.join("");
}

export function deleteSecret(name: SecretName): void {
  const v = rawGet(name);
  const m = v ? CHUNKED.exec(v) : null;
  if (m) for (let i = 1; i <= Number(m[1]); i++) rawDel(`${name}#${i}`);
  rawDel(name);
}

export const ALL_SECRETS: SecretName[] = [
  "anthropic.apiKey", "jira.token", "github.token", "slack.botToken", "slack.appToken",
  "teams.webhookUrl", "notion.token", "figma.token", "api.sessionToken",
];
