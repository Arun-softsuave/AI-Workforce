import fs from "node:fs";
import path from "node:path";
import { paths, ensureDir } from "./paths.js";
import { redactSecrets } from "./util.js";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = (process.env.AIW_LOG_LEVEL as Level) ?? "info";

let toConsole = process.env.AIW_LOG_CONSOLE === "1";
export function logToConsole(on: boolean) { toConsole = on; }

/** Structured JSON-lines logger. Secrets are redacted before writing. Rotates at ~5 MB. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < order[minLevel]) return;
  const line = redactSecrets(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
  try {
    const dir = ensureDir(paths.logs());
    const file = path.join(dir, "aiw-agentd.log");
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, path.join(dir, `aiw-agentd.${Date.now()}.log`));
    } catch { /* first write */ }
    fs.appendFileSync(file, line + "\n");
  } catch { /* never crash on logging */ }
  if (toConsole) (level === "error" ? console.error : console.log)(line);
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => log("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => log("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => log("error", m, f),
};
