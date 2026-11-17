import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { serviceRoot, paths } from "../core/paths.js";
import { readRuntime, pidAlive, clearRuntime, api } from "../core/runtime.js";
import { sleep } from "../core/util.js";

/**
 * Autostart without admin rights:
 *  Windows: a hidden launcher in the user's Startup folder · macOS: LaunchAgent · Linux: systemd --user.
 */
const mainJs = () => path.join(serviceRoot(), "dist", "daemon", "main.js");

function startupFile(): string {
  switch (process.platform) {
    case "win32": return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "AIWorkforce.vbs");
    case "darwin": return path.join(os.homedir(), "Library", "LaunchAgents", "com.aiworkforce.agentd.plist");
    default: return path.join(os.homedir(), ".config", "systemd", "user", "aiw-agentd.service");
  }
}

export function installAutostart(): string {
  const file = startupFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const node = process.execPath;
  const env = process.env.AIW_HOME ? { AIW_HOME: process.env.AIW_HOME } : {};
  if (process.platform === "win32") {
    const envLines = Object.entries(env).map(([k, v]) => `sh.Environment("Process")("${k}") = "${v}"`).join("\r\n");
    fs.writeFileSync(file, `' AI Workforce background service (installed by aiw)\r\nSet sh = CreateObject("WScript.Shell")\r\n${envLines}\r\nsh.Run """${node}"" ""${mainJs()}""", 0, False\r\n`);
  } else if (process.platform === "darwin") {
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.aiworkforce.agentd</string>
<key>ProgramArguments</key><array><string>${node}</string><string>${mainJs()}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
${Object.keys(env).length ? `<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict>` : ""}
<key>StandardErrorPath</key><string>${path.join(paths.logs(), "launchd.err")}</string></dict></plist>`);
  } else {
    fs.writeFileSync(file, `[Unit]\nDescription=AI Workforce local agent service\n\n[Service]\nExecStart=${node} ${mainJs()}\nRestart=on-failure\n${Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`).join("\n")}\n\n[Install]\nWantedBy=default.target\n`);
    try { execFileSync("systemctl", ["--user", "daemon-reload"]); execFileSync("systemctl", ["--user", "enable", "aiw-agentd"]); } catch { /* user can enable manually */ }
  }
  return file;
}

export function uninstallAutostart(): void {
  const file = startupFile();
  if (process.platform === "linux") { try { execFileSync("systemctl", ["--user", "disable", "aiw-agentd"]); } catch { /* ignore */ } }
  try { fs.rmSync(file); } catch { /* not installed */ }
}

export const autostartInstalled = () => fs.existsSync(startupFile());

export async function startService(): Promise<{ started: boolean; pid?: number; port?: number; message: string }> {
  const rt = readRuntime();
  if (rt && pidAlive(rt.pid)) return { started: false, pid: rt.pid, port: rt.port, message: `already running (pid ${rt.pid}, port ${rt.port})` };
  const child = spawn(process.execPath, [mainJs()], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const health = await api("GET", "/api/health").catch(() => undefined);
    if (health) { const r = readRuntime()!; return { started: true, pid: r.pid, port: r.port, message: `started (pid ${r.pid}, port ${r.port})` }; }
  }
  return { started: false, message: `service did not answer within 10 s – see ${path.join(paths.logs(), "aiw-agentd.log")}` };
}

export async function stopService(): Promise<string> {
  const rt = readRuntime();
  if (!rt || !pidAlive(rt.pid)) { clearRuntime(); return "not running"; }
  try { process.kill(rt.pid, "SIGTERM"); } catch { /* ignore */ }
  for (let i = 0; i < 20 && pidAlive(rt.pid); i++) await sleep(250);
  if (pidAlive(rt.pid)) {
    if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(rt.pid), "/F"], { stdio: "ignore" }); } catch { /* ignore */ } }
    else { try { process.kill(rt.pid, "SIGKILL"); } catch { /* ignore */ } }
  }
  clearRuntime();
  try { fs.rmSync(paths.lock()); } catch { /* ignore */ }
  return "stopped";
}
