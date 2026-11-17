import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import * as G from "../../git/git.js";
import { expandCheck } from "../../brain/conventions.js";
import type { TestProfile } from "../../engine/testProfile.js";

/**
 * Small tool outputs (IMPLEMENTATION-PLAN §9.1.2, module 5.8a): test, lint, CI and diff results reduced to counts,
 * the failures (name, file:line, first 3 message lines) and a short text – never the full log.
 * The parsers are pure; runTests / runLint / gitDiffStat run real commands; createCompactToolsServer offers them to an
 * agent as MCP tools (run_tests, run_lint, git_diff_stat).
 */

export interface CompactFailure { name: string; file?: string; line?: number; message: string }
export interface Compact {
  tool: string;
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  /** lint / type checkers only */
  warnings?: number;
  failures: CompactFailure[];
  /** At most TEXT_MAX characters. */
  text: string;
}
export type Parser = (raw: string) => Compact;

export const TEXT_MAX = 1500;
const MSG_LINE_MAX = 200;

// ------------------------------------------------------------------ helpers

/** Remove colour codes, carriage returns and a BOM. */
export const clean = (raw: string) => String(raw ?? "").replace(/^﻿/, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r(?=\n)/g, "").replace(/\r/g, "\n");

/** First n non-empty lines, trimmed and capped. */
function firstLines(lines: string[], n = 3): string {
  return lines.map((l) => l.trim()).filter(Boolean).slice(0, n).map((l) => (l.length > MSG_LINE_MAX ? `${l.slice(0, MSG_LINE_MAX)}…` : l)).join("\n");
}

const fileUrlToPath = (p: string) => p.replace(/^file:\/\/\/?(?=[A-Za-z]:)/, "").replace(/^file:\/\//, "");

/** Counts "3 passed, 1 failed" / "3 passed | 1 failed" into a map. */
function counts(line: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of line.matchAll(/(\d+)\s+([a-z]+)/gi)) out[m[2].toLowerCase()] = (out[m[2].toLowerCase()] ?? 0) + Number(m[1]);
  return out;
}

function dedupe(fs_: CompactFailure[]): CompactFailure[] {
  const seen = new Set<string>();
  return fs_.filter((f) => { const k = `${f.name}|${f.file ?? ""}|${f.line ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** The short text an agent sees: one header line, then each failure with its place and first message lines. */
export function compactText(c: Omit<Compact, "text">, extra = ""): string {
  const lint = c.warnings !== undefined;
  const head = lint
    ? `${c.tool}: ${c.failed} error${c.failed === 1 ? "" : "s"}, ${c.warnings} warning${c.warnings === 1 ? "" : "s"}${c.ok ? " – OK" : ""}`
    : `${c.tool}: ${c.failed} failed, ${c.passed} passed, ${c.skipped} skipped${c.ok ? " – OK" : ""}`;
  const parts = [head + (extra ? `\n${extra}` : "")];
  let used = parts[0].length;
  let shown = 0;
  for (const f of c.failures) {
    const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
    const block = `- ${f.name}${loc}${f.message ? `\n  ${f.message.split("\n").join("\n  ")}` : ""}`;
    if (used + block.length + 1 > TEXT_MAX - 40) break;
    parts.push(block); used += block.length + 1; shown++;
  }
  if (shown < c.failures.length) parts.push(`…and ${c.failures.length - shown} more`);
  return parts.join("\n").slice(0, TEXT_MAX);
}

function finish(c: Omit<Compact, "text">, extra = ""): Compact {
  const failures = dedupe(c.failures);
  const out = { ...c, failures };
  return { ...out, text: compactText(out, extra) };
}

// ------------------------------------------------------------------ pytest

export const parsePytest: Parser = (raw) => {
  const text = clean(raw);
  const lines = text.split("\n");
  // summary: "=== 2 failed, 10 passed, 1 skipped in 0.52s ===" or (-q) "2 failed, 10 passed in 0.12s"
  let c: Record<string, number> = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\d+\s+(passed|failed|errors?|skipped|xfailed|xpassed|deselected)\b/.test(lines[i]) && /\bin\s+[\d.]+s\b/.test(lines[i])) { c = counts(lines[i]); break; }
  }
  if (!Object.keys(c).length && /no tests ran/.test(text)) c = {};
  // sections "____ test_name ____" hold the traceback of each failure
  const sections = new Map<string, string[]>();
  let cur: string[] | undefined;
  for (const l of lines) {
    const h = /^_{3,} (.+?) _{3,}$/.exec(l);
    if (h) { cur = []; sections.set(h[1].replace(/^ERROR (at \w+ of|collecting) /, ""), cur); continue; }
    if (/^={3,}/.test(l)) cur = undefined;
    else cur?.push(l);
  }
  const fromSection = (body: string[] | undefined, fileHint?: string) => {
    if (!body) return {};
    let file: string | undefined, line: number | undefined;
    for (const l of body) {
      const m = /^(\S.*?\.py):(\d+):(?:\s|$)/.exec(l);
      if (m && (!fileHint || m[1].replace(/\\/g, "/").endsWith(fileHint.replace(/\\/g, "/")) || !file)) { file = m[1]; line = Number(m[2]); }
    }
    const e = body.filter((l) => /^E\s+/.test(l)).map((l) => l.replace(/^E\s+/, ""));
    return { file, line, message: e.length ? firstLines(e) : undefined };
  };
  const failures: CompactFailure[] = [];
  for (const l of lines) {
    const m = /^(FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.*))?$/.exec(l);
    if (!m) continue;
    const nodeid = m[2];
    const file = nodeid.split("::")[0];
    const short = nodeid.split("::").slice(1).join(".") || file;
    const sec = fromSection(sections.get(short) ?? sections.get(short.split(".").pop()!) ?? sections.get(file), file);
    failures.push({ name: nodeid, file: sec.file ?? file, line: sec.line, message: sec.message ?? firstLines([m[3] ?? ""]) });
  }
  if (!failures.length) {
    for (const [name, body] of sections) {
      const sec = fromSection(body);
      failures.push({ name, file: sec.file, line: sec.line, message: sec.message ?? "" });
    }
  }
  const failed = (c.failed ?? 0) + (c.error ?? 0) + (c.errors ?? 0) || failures.length;
  return finish({ tool: "pytest", ok: failed === 0, passed: (c.passed ?? 0) + (c.xpassed ?? 0), failed, skipped: (c.skipped ?? 0) + (c.xfailed ?? 0), failures });
};

// ------------------------------------------------------------------ jest

const JS_LOC = /\(?((?:[A-Za-z]:)?[^\s():'"]*?\.[cm]?[jt]sx?):(\d+):(\d+)\)?/;
const notDeps = (l: string) => !/node_modules|node:internal|\(internal\//.test(l);

export const parseJest: Parser = (raw) => {
  const lines = clean(raw).split("\n");
  const sum = lines.find((l) => /^Tests:\s+/.test(l)) ?? "";
  const c = counts(sum);
  const failures: CompactFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*● (.+)$/.exec(lines[i]);
    if (!h) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^\s*● /.test(lines[j]) || /^(PASS|FAIL)\s/.test(lines[j]) || /^(Test Suites|Tests|Summary of all failing tests):?/.test(lines[j])) break;
      body.push(lines[j]);
    }
    const stackAt = body.findIndex((l) => /^\s+at\s/.test(l));
    const msgLines = (stackAt < 0 ? body : body.slice(0, stackAt)).filter((l) => !/^\s*\d+\s*\|/.test(l) && !/^\s*>\s*\d+\s*\|/.test(l) && !/^\s*\|\s*\^/.test(l));
    const locLine = body.find((l) => /^\s+at\s/.test(l) && notDeps(l) && JS_LOC.test(l)) ?? body.find((l) => JS_LOC.test(l) && notDeps(l));
    const loc = locLine ? JS_LOC.exec(locLine) : null;
    failures.push({ name: h[1].trim(), file: loc ? fileUrlToPath(loc[1]) : undefined, line: loc ? Number(loc[2]) : undefined, message: firstLines(msgLines) });
    i = j - 1;
  }
  const failed = c.failed ?? failures.length;
  return finish({ tool: "jest", ok: failed === 0 && !/^Test Suites:.*\d+ failed/m.test(lines.join("\n")), passed: c.passed ?? 0, failed, skipped: (c.skipped ?? 0) + (c.todo ?? 0), failures });
};

// ------------------------------------------------------------------ vitest

export const parseVitest: Parser = (raw) => {
  const lines = clean(raw).split("\n");
  const sum = lines.find((l) => /^\s*Tests\s+\d+/.test(l)) ?? "";
  const c = counts(sum.replace(/\(\d+\)\s*$/, ""));
  const failures: CompactFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*FAIL\s+(\S+?)\s+>\s+(.+?)\s*$/.exec(lines[i]);
    if (!h) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^\s*FAIL\s+\S/.test(lines[j]) || /^\s*⎯{3,}/.test(lines[j]) || /^\s*(Test Files|Tests)\s+\d/.test(lines[j])) break;
      body.push(lines[j]);
    }
    const locLine = body.find((l) => /❯\s/.test(l) && JS_LOC.test(l) && notDeps(l)) ?? body.find((l) => JS_LOC.test(l) && notDeps(l));
    const loc = locLine ? JS_LOC.exec(locLine) : null;
    const msg = body.filter((l) => !/^\s*❯/.test(l) && !/^\s*\d+\s*\|/.test(l) && !/^\s*\|\s*\^/.test(l) && !/^\s*at\s/.test(l));
    failures.push({ name: h[2], file: loc ? fileUrlToPath(loc[1]) : h[1], line: loc ? Number(loc[2]) : undefined, message: firstLines(msg) });
    i = j - 1;
  }
  if (!failures.length) {
    for (const l of lines) { const m = /^\s*[×✗]\s+(.+?)(?:\s+\d+m?s)?\s*$/.exec(l); if (m) failures.push({ name: m[1], message: "" }); }
  }
  const failed = c.failed ?? failures.length;
  return finish({ tool: "vitest", ok: failed === 0 && !/Test Files\s+\d+ failed/.test(lines.join("\n")), passed: c.passed ?? 0, failed, skipped: (c.skipped ?? 0) + (c.todo ?? 0), failures });
};

// ------------------------------------------------------------------ node --test (spec and tap)

function nodeLoc(s: string): { file?: string; line?: number } {
  const m = /((?:file:\/\/\/?)?(?:[A-Za-z]:)?[^\s'"()]+?):(\d+):(\d+)/.exec(s);
  return m ? { file: fileUrlToPath(m[1]), line: Number(m[2]) } : {};
}

export const parseNodeSpec: Parser = (raw) => {
  const lines = clean(raw).split("\n");
  const stat = (k: string) => { const l = lines.find((x) => new RegExp(`^ℹ ${k} \\d+`).test(x)); return l ? Number(/\d+/.exec(l)![0]) : 0; };
  const failures: CompactFailure[] = [];
  const start = lines.findIndex((l) => /^✖ failing tests:/.test(l));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const at = /^test at (.+)$/.exec(lines[i]);
      if (!at) continue;
      const name = /^\s*✖ (.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(lines[i + 1] ?? "")?.[1] ?? "test";
      const body: string[] = [];
      let j = i + 2;
      for (; j < lines.length && !/^test at /.test(lines[j]) && !/^ℹ /.test(lines[j]); j++) body.push(lines[j]);
      const msg = body.filter((l) => !/^\s+at\s/.test(l) && !/^\s*(generatedMessage|code|actual|expected|operator|diff):/.test(l) && !/^\s*[{}]\s*$/.test(l));
      failures.push({ name, ...nodeLoc(at[1]), message: firstLines(msg) });
      i = j - 1;
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*✖ (.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(lines[i]);
      if (!m) continue;
      const body = lines.slice(i + 1, i + 12);
      const stack = body.find((l) => /^\s+at\s/.test(l) && notDeps(l));
      failures.push({ name: m[1], ...(stack ? nodeLoc(stack) : {}), message: firstLines(body.filter((l) => /\S/.test(l) && !/^\s+at\s/.test(l) && !/^\s*[✖✔﹣]/.test(l))) });
    }
  }
  const failed = stat("fail") + stat("cancelled");
  return finish({ tool: "node --test", ok: failed === 0, passed: stat("pass"), failed, skipped: stat("skipped") + stat("todo"), failures: failed ? failures : [] });
};

export const parseNodeTap: Parser = (raw) => {
  const lines = clean(raw).split("\n");
  const stat = (k: string) => { const l = lines.find((x) => new RegExp(`^# ${k} \\d+`).test(x)); return l ? Number(/\d+/.exec(l)![0]) : 0; };
  const failures: CompactFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const yaml: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (new RegExp(`^\\s{0,${indent}}(not )?ok \\d+`).test(l) || /^#\s/.test(l)) break;
      yaml.push(l);
    }
    const y = yaml.join("\n");
    if (/failureType:\s*'subtestsFailed'/.test(y)) continue;
    const loc = /location:\s*'([^']+)'/.exec(y)?.[1] ?? /location:\s*"([^"]+)"/.exec(y)?.[1] ?? "";
    let msg = "";
    const ei = yaml.findIndex((l) => /^\s*error:/.test(l));
    if (ei >= 0) {
      const first = yaml[ei].replace(/^\s*error:\s*/, "");
      if (/^[|>][-+]?\s*$/.test(first)) {
        const ind = (/^(\s*)/.exec(yaml[ei])![1].length);
        const block: string[] = [];
        for (let k = ei + 1; k < yaml.length && (/^\s*$/.test(yaml[k]) || /^(\s*)/.exec(yaml[k])![1].length > ind); k++) block.push(yaml[k]);
        msg = firstLines(block);
      } else msg = firstLines([first.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1")]);
    }
    failures.push({ name: m[2], ...nodeLoc(loc), message: msg });
  }
  const failed = stat("fail") + stat("cancelled");
  return finish({ tool: "node --test", ok: failed === 0 && !failures.length, passed: stat("pass"), failed: failed || failures.length, skipped: stat("skipped") + stat("todo"), failures });
};

// ------------------------------------------------------------------ eslint (stylish)

export const parseEslint: Parser = (raw) => {
  const lines = clean(raw).split("\n");
  let file = "";
  let errors = 0, warnings = 0;
  const failures: CompactFailure[] = [];
  for (const l of lines) {
    const p = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/.exec(l);
    if (p) {
      if (p[3] === "error") { errors++; failures.push({ name: p[5] ?? "error", file, line: Number(p[1]), message: p[4] }); }
      else warnings++;
      continue;
    }
    if (/^\S/.test(l) && !/^[✖×]/.test(l) && !/^\d+ (error|problem)/.test(l)) file = l.trim();
  }
  const sum = /[✖×] (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(lines.join("\n"));
  if (sum) { errors = Number(sum[2]); warnings = Number(sum[3]); }
  return finish({ tool: "eslint", ok: errors === 0, passed: 0, failed: errors, skipped: 0, warnings, failures });
};

// ------------------------------------------------------------------ ruff

export const parseRuff: Parser = (raw) => {
  const lines = clean(raw).split("\n");
  const failures: CompactFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const concise = /^(.+?):(\d+):(\d+): ([A-Z]+\d+) (?:\[\*\] )?(.+)$/.exec(lines[i]);
    if (concise) { failures.push({ name: concise[4], file: concise[1], line: Number(concise[2]), message: concise[5] }); continue; }
    const full = /^([A-Z]+\d+) (?:\[\*\] )?(.+)$/.exec(lines[i]);
    if (full) {
      const at = lines.slice(i + 1, i + 4).map((l) => /^\s*-->\s+(.+?):(\d+):(\d+)/.exec(l)).find(Boolean);
      if (at) failures.push({ name: full[1], file: at[1], line: Number(at[2]), message: full[2] });
    }
  }
  const found = /Found (\d+) errors?/.exec(lines.join("\n"));
  const failed = found ? Number(found[1]) : failures.length;
  return finish({ tool: "ruff", ok: failed === 0, passed: 0, failed, skipped: 0, warnings: 0, failures });
};

// ------------------------------------------------------------------ tsc

export const parseTsc: Parser = (raw) => {
  const lines = clean(raw).split("\n");
  const failures: CompactFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(lines[i]) ?? /^(.+?):(\d+):(\d+) - error (TS\d+): (.+)$/.exec(lines[i]);
    if (!m) continue;
    const more: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !/^\s*\d+\s/.test(lines[j]) && more.length < 2; j++) more.push(lines[j]);
    failures.push({ name: m[4], file: m[1], line: Number(m[2]), message: firstLines([m[5], ...more]) });
  }
  const found = /Found (\d+) errors?/.exec(lines.join("\n"));
  const failed = found ? Number(found[1]) : failures.length;
  return finish({ tool: "tsc", ok: failed === 0, passed: 0, failed, skipped: 0, warnings: 0, failures });
};

// ------------------------------------------------------------------ detect

const ERROR_LINE = /(##\[error\]|\berror\b[:\s]|Error:|\bFAIL(ED)?\b|AssertionError|Traceback|not ok \d)/i;

/** Output that no parser recognises: the exit code decides, plus the first error line and the end of the output. */
export function parseGeneric(raw: string, code?: number): Compact {
  const text = clean(raw).trim();
  const lines = text.split("\n");
  const err = lines.find((l) => ERROR_LINE.test(l));
  const ok = code === undefined ? !err : code === 0;
  const tail = text.slice(-900);
  const extra = ok ? "" : [err ? `First error: ${err.trim().slice(0, 300)}` : "", `End of the output:\n${tail}`].filter(Boolean).join("\n");
  const c = { tool: "command", ok, passed: 0, failed: ok ? 0 : 1, skipped: 0, failures: [] as CompactFailure[] };
  return { ...c, text: `${ok ? "command: OK" : `command: failed${code !== undefined ? ` (exit code ${code})` : ""}`}${extra ? `\n${extra}` : ""}`.slice(0, TEXT_MAX) };
}

/** Pick the parser for this output, or undefined when none recognises it. */
export function detect(raw: string): { name: string; parse: Parser } | undefined {
  const t = clean(raw);
  if (/^ℹ (tests|pass|fail) \d+/m.test(t)) return { name: "node-spec", parse: parseNodeSpec };
  if (/^TAP version \d+/m.test(t) || (/^# (pass|fail) \d+/m.test(t) && /^\s*(not )?ok \d+/m.test(t))) return { name: "node-tap", parse: parseNodeTap };
  if (/^\s*Test Files\s+\d+/m.test(t) || /^\s*Tests\s+\d+ (failed|passed)/m.test(t)) return { name: "vitest", parse: parseVitest };
  if (/^Tests:\s+.*\d+ total/m.test(t) || /^Test Suites:/m.test(t)) return { name: "jest", parse: parseJest };
  if (/^=+ .*test session starts/m.test(t) || /^(FAILED|ERROR) \S+::/m.test(t) || /\d+ (passed|failed)(, \d+ \w+)* in [\d.]+s\b/.test(t)) return { name: "pytest", parse: parsePytest };
  if (/^(.+?)\(\d+,\d+\): error TS\d+:/m.test(t) || /^.+?:\d+:\d+ - error TS\d+:/m.test(t)) return { name: "tsc", parse: parseTsc };
  if (/^\s+\d+:\d+\s+(error|warning)\s+/m.test(t)) return { name: "eslint", parse: parseEslint };
  if (/^.+?:\d+:\d+: [A-Z]+\d+ /m.test(t) || (/^[A-Z]+\d+ /m.test(t) && /^\s*-->\s+\S/m.test(t)) || /^All checks passed!/m.test(t)) return { name: "ruff", parse: parseRuff };
  return undefined;
}

/** Compact any output: the detected parser, else the generic one. The exit code wins over a parser that saw no failures. */
export function compact(raw: string, code?: number): Compact {
  const d = detect(raw);
  if (!d) return parseGeneric(raw, code);
  const c = d.parse(raw);
  if (code !== undefined && code !== 0 && c.ok) {
    const g = parseGeneric(raw, code);
    return { ...c, ok: false, text: `${c.text.split("\n")[0].replace(/ – OK$/, "")} – but the command failed (exit code ${code})\n${g.text.split("\n").slice(1).join("\n")}`.slice(0, TEXT_MAX) };
  }
  return c;
}

// ------------------------------------------------------------------ running commands

export interface RunOpts { timeoutMs?: number; maxBytes?: number; env?: Record<string, string> }
export interface RawRun { code: number; output: string; timedOut: boolean; truncated: boolean; ms: number }

/**
 * Run a shell command with a time limit and an output cap: when the output is larger than maxBytes, its start and its
 * end are kept (runners print their summary at the end). The whole process tree is stopped on timeout.
 */
/** The command's environment: no colours, CI mode, and never the test-runner state of this process. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export function execCapped(cmd: string, cwd: string, opts: RunOpts = {}): Promise<RawRun> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000, maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  const t0 = Date.now();
  if (!cwd || !fs.existsSync(cwd)) return Promise.resolve({ code: 1, output: `working directory missing (${cwd || "none"})`, timedOut: false, truncated: false, ms: 0 });
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const shell = win ? "cmd.exe" : "/bin/sh";
    const args = win ? ["/d", "/s", "/c", `"${cmd}"`] : ["-c", cmd];
    const half = Math.max(1024, Math.floor(maxBytes / 2));
    let head = "", tail = "", dropped = 0, timedOut = false, done = false;
    const add = (s: string) => {
      if (head.length < half) { const room = half - head.length; head += s.slice(0, room); s = s.slice(room); }
      if (!s) return;
      tail += s;
      if (tail.length > half * 2) { dropped += tail.length - half; tail = tail.slice(-half); }
    };
    let child: ChildProcess;
    try {
      child = spawn(shell, args, { cwd, windowsHide: true, windowsVerbatimArguments: win, detached: !win, env: childEnv(opts.env) });
    } catch (e: any) {
      resolve({ code: 1, output: `could not start the command: ${e.message}`, timedOut: false, truncated: false, ms: 0 });
      return;
    }
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", add); child.stderr?.on("data", add);
    const kill = () => {
      try {
        if (win) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else process.kill(-child.pid!, "SIGKILL");
      } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const end = (code: number) => {
      if (done) return; done = true;
      clearTimeout(timer);
      const output = dropped ? `${head}\n…[${dropped} characters of output left out]…\n${tail}` : head + tail;
      resolve({ code: timedOut ? 124 : code, output, timedOut, truncated: dropped > 0, ms: Date.now() - t0 });
    };
    child.on("error", (e) => { add(`\n${e.message}`); end(1); });
    child.on("close", (code) => end(typeof code === "number" ? code : 1));
  });
}

export type CompactRun = Compact & { code: number; timedOut: boolean; ms: number };

/** Paths in the text are shown relative to the working directory. */
function relativise(c: Compact, cwd: string): Compact {
  const roots = [cwd, cwd.replace(/\\/g, "/"), cwd.replace(/\//g, "\\")].map((r) => r.replace(/[\\/]+$/, "")).filter((r, i, a) => r && a.indexOf(r) === i);
  const rel = (s: string) => roots.reduce((acc, r) => acc.split(`${r}\\`).join("").split(`${r}/`).join(""), s);
  return { ...c, text: rel(c.text), failures: c.failures.map((f) => ({ ...f, file: f.file ? rel(f.file) : f.file })) };
}

async function runCompact(kind: string, cwd: string, cmd: string, opts: RunOpts): Promise<CompactRun> {
  const r = await execCapped(cmd, cwd, opts);
  let c = relativise(compact(r.output, r.code), cwd);
  if (r.timedOut) c = { ...c, ok: false, text: `${kind} stopped: no result after ${Math.round((opts.timeoutMs ?? 600_000) / 1000)} s.\n${c.text}`.slice(0, TEXT_MAX) };
  return { ...c, code: r.code, timedOut: r.timedOut, ms: r.ms };
}

/** Run a test command and return only the compact result. */
export function runTests(cwd: string, cmd: string, opts: RunOpts = {}): Promise<CompactRun> {
  return runCompact("Tests", cwd, cmd, { timeoutMs: 15 * 60_000, ...opts });
}

/** Run a lint / format / type-check command and return only the compact result. */
export function runLint(cwd: string, cmd: string, opts: RunOpts = {}): Promise<CompactRun> {
  return runCompact("Check", cwd, cmd, { timeoutMs: 5 * 60_000, ...opts });
}

// ------------------------------------------------------------------ CI log

export interface CiExcerpt { step?: string; error?: string; file?: string; line?: number; summary?: Compact; text: string }

/**
 * A CI job log (GitHub Actions, or plain "$ command" logs) reduced to the failing step, its first error and file:line,
 * plus the compact test / lint result when the step's output is one a parser recognises.
 */
export function ciLog(rawLog: string): CiExcerpt {
  const lines = clean(rawLog).split("\n").map((l) => l.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, ""));
  if (!lines.join("").trim()) return { text: "No log available for this check." };
  const markers: { at: number; name: string }[] = [];
  lines.forEach((l, i) => {
    const m = /^##\[group\]Run (.+)$/.exec(l) ?? /^\$ (.+)$/.exec(l);
    if (m) markers.push({ at: i, name: m[1].trim() });
  });
  const real = (l: string) => !/^##\[error\]Process completed with exit code/.test(l);
  let errAt = lines.findIndex((l) => /^##\[error\]/.test(l) && real(l));
  if (errAt < 0) errAt = lines.findIndex((l) => /^##\[error\]/.test(l));
  if (errAt < 0) errAt = lines.findIndex((l) => ERROR_LINE.test(l) && !/^##\[group\]/.test(l));
  const marker = [...markers].reverse().find((m) => errAt < 0 || m.at <= errAt) ?? markers[markers.length - 1];
  const from = marker ? marker.at + 1 : 0;
  const next = markers.find((m) => m.at >= from);
  const to = next ? next.at : lines.length;
  let body = lines.slice(from, to).map((l) => (/^##\[error\]Process completed/.test(l) ? l : l.replace(/^##\[(error|warning)\]/, "")));
  const eg = body.findIndex((l) => /^##\[endgroup\]/.test(l));
  if (eg >= 0 && eg < 40) body = body.slice(eg + 1);       // the step's command and env block
  const stepText = body.join("\n");
  const d = detect(stepText);
  const summary = d ? d.parse(stepText) : undefined;
  const firstErr = body.find((l) => ERROR_LINE.test(l) && real(l)) ?? (errAt >= 0 ? lines[errAt] : undefined);
  const error = firstErr?.replace(/^##\[error\]/, "").trim().slice(0, 300);
  const sf = summary?.failures.find((f) => f.file);
  let file = sf?.file, line = sf?.line;
  if (!file) {
    const startAt = Math.max(0, firstErr ? body.indexOf(firstErr) : 0);
    for (const l of body.slice(startAt)) {
      const m = /((?:[A-Za-z]:)?[\w./\\-]+\.[A-Za-z]{1,5})(?::|\()(\d+)/.exec(l);
      if (m && !/node_modules|site-packages/.test(m[1])) { file = m[1]; line = Number(m[2]); break; }
    }
  }
  const step = marker?.name.split("\n")[0].slice(0, 200);
  const text = [
    step ? `Failing step: ${step}` : "",
    error ? `First error: ${error}` : "",
    file ? `At: ${file}${line ? `:${line}` : ""}` : "",
    summary ? summary.text : "",
  ].filter(Boolean).join("\n").slice(0, TEXT_MAX) || "The log shows no error line – open the check's link.";
  return { step, error, file, line, summary, text };
}

// ------------------------------------------------------------------ git diff stat

export interface DiffStat { files: { path: string; added: number; removed: number; binary?: boolean; untracked?: boolean }[]; added: number; removed: number; text: string }

/** Files changed since `base` (committed, staged, unstaged and new files) with +/- line counts. */
export function gitDiffStat(cwd: string, base = "HEAD"): DiffStat {
  const from = base === "HEAD" ? "HEAD" : (G.git(cwd, ["merge-base", base, "HEAD"], { allowFail: true }) || base);
  const files: DiffStat["files"] = [];
  for (const l of G.git(cwd, ["diff", "--numstat", from], { allowFail: true }).split("\n").filter(Boolean)) {
    const [a, r, ...p] = l.split("\t");
    const binary = a === "-" && r === "-";
    files.push({ path: p.join("\t"), added: +a || 0, removed: +r || 0, ...(binary ? { binary } : {}) });
  }
  for (const p of G.git(cwd, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }).split("\n").filter(Boolean)) {
    let added = 0;
    try { const st = fs.statSync(path.join(cwd, p)); if (st.size < 2_000_000) { const s = fs.readFileSync(path.join(cwd, p), "utf8"); added = s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0; } } catch { /* unreadable */ }
    files.push({ path: p, added, removed: 0, untracked: true });
  }
  const added = files.reduce((s, f) => s + f.added, 0), removed = files.reduce((s, f) => s + f.removed, 0);
  const head = files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed, +${added} -${removed}` : "No changes.";
  const rows: string[] = [];
  let used = head.length;
  for (const f of files) {
    const row = `${f.binary ? "binary" : `+${f.added} -${f.removed}`} ${f.path}${f.untracked ? " (new, not added yet)" : ""}`;
    if (used + row.length + 1 > TEXT_MAX - 30) { rows.push(`…and ${files.length - rows.length} more`); break; }
    rows.push(row); used += row.length + 1;
  }
  return { files, added, removed, text: [head, ...rows].join("\n").slice(0, TEXT_MAX) };
}

// ------------------------------------------------------------------ MCP server for agents

export const COMPACT_SERVER = "aiw_compact";
export const COMPACT_TOOLS = ["run_tests", "run_lint", "git_diff_stat"] as const;
export const compactToolNames = () => COMPACT_TOOLS.map((n) => `mcp__${COMPACT_SERVER}__${n}`);
export const COMPACT_RULE =
  "Use run_tests, run_lint and git_diff_stat instead of running test, lint or diff commands in the shell: they return only the counts, " +
  "each failure with file:line and its first message lines. Pass `files` to run only the tests or checks for the files you changed.";

/** What the tools may run: the project's own commands (from its test profile and conventions), never one the agent writes. */
export interface CompactProfile {
  /** {python} is filled in with the project's working Python. */
  testCommand?: string;
  testFiles?: TestProfile["testFiles"];
  /** The team's checks (conventions.checks); {py} / {js} / {all} are filled with the changed files. */
  lintCommands?: string[];
  /** Base for git_diff_stat and for "changed files" (default HEAD). */
  base?: string;
  /** Extra environment for the test command (e.g. a temporary database). */
  env?: Record<string, string>;
  timeoutMs?: number;
}

const SAFE_FILE = /^(?!.*\.\.)[\w@+.\-/\\:]+$/;
/** Relative paths (pytest node ids like tests/a.py::test_x allowed); no options, no absolute paths, no "..", no shell characters. */
const safeFiles = (files?: string[]) => (files ?? []).filter((f) => typeof f === "string" && SAFE_FILE.test(f) && !/^[-\\/]/.test(f) && !/^[A-Za-z]:/.test(f)).slice(0, 50);

async function fillPython(cmd: string, cwd: string): Promise<string | undefined> {
  if (!cmd.includes("{python}")) return cmd;
  const { findPython } = await import("../../engine/localStack.js");
  const py = findPython(cwd);
  return py ? cmd.split("{python}").join(`"${py}"`) : undefined;
}

/** Run one compact tool the way an agent would (also used by tests). Never throws: problems become short text. */
export async function runCompactTool(name: string, args: { files?: string[] } | undefined, cwd: string, profile: CompactProfile): Promise<{ text: string; isError: boolean }> {
  try {
    const files = safeFiles(args?.files);
    const rejected = (args?.files ?? []).length - files.length;
    const note = rejected ? `\n(${rejected} file name${rejected > 1 ? "s were" : " was"} left out: only relative paths inside the repository are allowed)` : "";
    if (name === "git_diff_stat") return { text: gitDiffStat(cwd, profile.base).text, isError: false };
    if (name === "run_tests") {
      if (!profile.testCommand) return { text: "No test command is set up for this project.", isError: true };
      const cmd = await fillPython(profile.testCommand, cwd);
      if (!cmd) return { text: "The tests cannot run here: no working Python was found for this project.", isError: true };
      const mode = profile.testFiles ?? "append";
      const full = !files.length || mode === "none" ? cmd : `${cmd} ${mode === "after-dashdash" ? "-- " : ""}${files.join(" ")}`;
      const r = await runTests(cwd, full, { env: profile.env, ...(profile.timeoutMs ? { timeoutMs: profile.timeoutMs } : {}) });
      return { text: r.text + note, isError: false };
    }
    if (name === "run_lint") {
      const checks = profile.lintCommands ?? [];
      if (!checks.length) return { text: "No lint or format checks are set up for this project.", isError: false };
      const changed = files.length ? files : gitDiffStat(cwd, profile.base).files.filter((f) => fs.existsSync(path.join(cwd, f.path))).map((f) => f.path);
      const out: string[] = [];
      let ran = 0;
      for (const raw of checks) {
        const cmd = expandCheck(raw, changed);
        if (!cmd) continue;
        ran++;
        const r = await runLint(cwd, cmd, profile.timeoutMs ? { timeoutMs: profile.timeoutMs } : {});
        out.push(r.ok ? `${raw}: OK` : `${raw}:\n${r.text}`);
      }
      if (!ran) return { text: "No check applies to the changed files.", isError: false };
      return { text: (out.join("\n\n") + note).slice(0, TEXT_MAX * 2), isError: false };
    }
    return { text: `${name} is not a compact tool.`, isError: true };
  } catch (e: any) {
    return { text: `${name} failed: ${String(e?.message ?? e).slice(0, 300)}`, isError: true };
  }
}

/** In-process MCP server (Claude Agent SDK) with run_tests, run_lint and git_diff_stat for one agent run in `cwd`. */
export async function createCompactToolsServer(cwd: string, profile: CompactProfile): Promise<any> {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const filesArg = { files: z.array(z.string()).optional().describe("Relative paths of the files to run for (optional; default: the whole suite / the changed files)") };
  const wrap = (name: string) => async (args: any) => {
    const r = await runCompactTool(name, args, cwd, profile);
    return { content: [{ type: "text" as const, text: r.text }], isError: r.isError };
  };
  return createSdkMcpServer({
    name: COMPACT_SERVER, version: "1.0.0",
    tools: [
      tool("run_tests", "Run the project's tests (optionally only some test files). Returns counts and each failure with file:line and its first message lines.", filesArg, wrap("run_tests")),
      tool("run_lint", "Run the project's lint / format / type checks on the changed files (or the given files). Returns only the errors with file:line.", filesArg, wrap("run_lint")),
      tool("git_diff_stat", "List the files changed so far with +/- line counts.", {}, wrap("git_diff_stat"), { annotations: { readOnlyHint: true } }),
    ],
  });
}
