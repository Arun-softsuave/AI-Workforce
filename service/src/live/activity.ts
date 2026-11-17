import { db } from "../core/db.js";
import { nowIso } from "../core/util.js";
import { publish } from "./bus.js";

/**
 * Plain-English activity lines for the dashboard (W19, module 5.25). Fixed rules only – no model call, no cost.
 *
 *   toolCallToLine("Bash", { command: "npm test" })            -> "Running npm test"
 *   toolCallToLine("Read", { file_path: "auth/middleware.py" }) -> "Reading auth/middleware.py"
 *   testProgressFromOutput("Tests: 17 failed, 41 passed, 58 total") -> { passed: 41, total: 58, line: "41 of 58 passed" }
 *
 * recordActivity() publishes every line on the live bus (throttled there) and stores the last line and progress in
 * the `activity` table at most every 5 s per task, so the dashboard shows it again after a restart.
 */

const MAX = 90;
const clip = (s: string, n = MAX) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** A file path as a person would say it: relative to the worktree when known, otherwise the last 3 parts. */
export function shortPath(p: string, root?: string): string {
  let s = str(p).replace(/\\/g, "/");
  if (root) {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (s.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return s.slice(r.length + 1);
  }
  s = s.replace(/^[A-Za-z]:/, "");
  const parts = s.split("/").filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join("/") : parts.join("/") || str(p);
}

/** Never show a secret that slipped into a command line. */
function hideSecrets(cmd: string): string {
  return cmd
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,})/g, "•••")
    .replace(/\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, "$1=•••")
    .replace(/(--?(token|password|secret|api-key)[= ])("[^"]*"|'[^']*'|\S+)/gi, "$1•••")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1•••@")
    .replace(/(Authorization:\s*(Bearer|Basic)\s+)\S+/gi, "$1•••");
}

/** The interesting part of a shell command: drops "cd x &&", env assignments and trailing pipes/redirects. */
function mainCommand(cmd: string): string {
  let c = hideSecrets(str(cmd)).trim();
  const chain = c.split(/\s*(?:&&|;|\|\|)\s*/).filter(Boolean);
  const pick = chain.find((x) => !/^(cd|pushd|set|export)\b/.test(x)) ?? chain[0] ?? c;
  c = pick.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
  c = c.split(/\s+\|\s+/)[0].replace(/\s+\d?>\s*\S+$/, "").replace(/\s+2>&1$/, "");
  return c.trim();
}

function bashLine(command: string): string {
  const c = mainCommand(command);
  if (!c) return "Running a command";
  const words = c.split(/\s+/);
  const [w0, w1] = words;
  if (w0 === "git") {
    const sub = w1 ?? "";
    const map: Record<string, string> = { status: "Checking which files changed", diff: "Looking at the changes", log: "Reading the change history",
      add: "Staging the changes", commit: "Saving a commit", fetch: "Fetching the latest code", pull: "Fetching the latest code",
      rebase: "Rebasing on the latest code", push: "Pushing the branch", checkout: "Switching branch", switch: "Switching branch",
      show: "Looking at a commit", blame: "Checking who changed a line", stash: "Putting changes aside" };
    return map[sub] ?? `Running ${clip(c, 60)}`;
  }
  if (/^(rg|grep|ag)$/.test(w0)) {
    const pat = words.slice(1).find((w) => !w.startsWith("-"));
    return pat ? `Searching for ${clip(pat.replace(/^['"]|['"]$/g, ""), 50)}` : "Searching the code";
  }
  if (/^(cat|head|tail|less|more|type)$/.test(w0) && words[1]) return `Reading ${shortPath(words[words.length - 1].replace(/^['"]|['"]$/g, ""))}`;
  if (/^(ls|dir|find|tree)$/.test(w0)) return "Looking through the files";
  if (/^(npm|pnpm|yarn)$/.test(w0) && /^(i|install|ci|add)$/.test(w1 ?? "")) return "Installing packages";
  if (/^pip3?$/.test(w0) && w1 === "install") return "Installing packages";
  return `Running ${clip(c, 70)}`;
}

/** Lookup tools (agents/lookup.ts) are offered as "mcp__lookup__<name>"; other MCP tools as "mcp__<server>__<name>". */
function lookupLine(name: string, input: Record<string, any>): string | undefined {
  switch (name) {
    case "jira_get_issue": return input.key ? `Reading Jira ticket ${clip(str(input.key), 30)}` : "Reading a Jira ticket";
    case "jira_search": return "Searching Jira";
    case "github_get_pr": {
      const m = /(\d+)\s*$/.exec(str(input.pr));
      return m ? `Reading pull request #${m[1]}` : "Reading a pull request";
    }
    case "figma_get_design": {
      const label = str(input.frame ?? input.name ?? input.nodeName);
      if (label) return `Reading Figma frame '${clip(label, 50)}'`;
      const node = /node-id=([\w%:-]+)/.exec(str(input.link ?? input.url));
      return node ? `Reading Figma frame ${decodeURIComponent(node[1]).replace("-", ":")}` : "Reading a Figma design";
    }
    case "notion_get_page": return "Reading a Notion page";
    case "code_query": return input.question ? `Searching the code map for "${clip(str(input.question), 50)}"` : "Searching the code map";
    case "code_explain": return input.symbol ? `Looking up ${clip(str(input.symbol), 50)} in the code map` : "Looking something up in the code map";
    case "code_affected": return input.symbol ? `Checking what a change to ${clip(str(input.symbol), 40)} affects` : "Checking what a change affects";
    default: return undefined;
  }
}

/** One tool call -> one short plain-English sentence. Never includes secret values. */
export function toolCallToLine(toolName: string, input: unknown = {}, opts: { root?: string } = {}): string {
  const i: Record<string, any> = input && typeof input === "object" ? input as any : {};
  const file = () => shortPath(str(i.file_path ?? i.path ?? i.notebook_path), opts.root);
  const name = str(toolName);
  switch (name) {
    case "Bash": case "PowerShell": return bashLine(str(i.command));
    case "Read": return i.file_path ? `Reading ${file()}` : "Reading a file";
    case "Grep": {
      const pat = clip(str(i.pattern), 50);
      const where = i.path ? ` in ${shortPath(str(i.path), opts.root)}` : i.glob ? ` in ${clip(str(i.glob), 30)}` : "";
      return pat ? `Searching for ${pat}${where}` : "Searching the code";
    }
    case "Glob": return i.pattern ? `Looking for files matching ${clip(str(i.pattern), 50)}` : "Looking for files";
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return (i.file_path || i.notebook_path) ? `Editing ${file()}` : "Editing a file";
    case "WebFetch": { try { return `Reading a web page on ${new URL(str(i.url)).hostname}`; } catch { return "Reading a web page"; } }
    case "WebSearch": return i.query ? `Searching the web for ${clip(str(i.query), 50)}` : "Searching the web";
    case "TodoWrite": return "Planning its next steps";
    case "Task": case "Agent": return i.description ? `Asking a helper: ${clip(str(i.description), 60)}` : "Asking a helper";
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) return lookupLine(mcp[2], i) ?? `Using ${mcp[2].replace(/[_-]+/g, " ")}`;
  return lookupLine(name, i) ?? `Using ${name.replace(/[_-]+/g, " ").trim() || "a tool"}`;
}

export interface TestProgress { passed: number; failed: number; total: number; line: string }

/**
 * Test-runner output -> "41 of 58 passed". Understands jest, vitest, pytest, mocha, the node test runner,
 * go test and cargo. Returns the LAST summary in the text (the most recent run), or undefined.
 */
export function testProgressFromOutput(output: string): TestProgress | undefined {
  const text = str(output).replace(/\x1b\[[0-9;]*m/g, "");
  let best: { at: number; passed: number; failed: number; total: number } | undefined;
  const take = (at: number, passed: number, failed: number, total?: number) => {
    const t = total ?? passed + failed;
    if (!t && !passed) return;
    if (!best || at >= best.at) best = { at, passed, failed, total: Math.max(t, passed + failed) };
  };
  const num = (re: RegExp, s: string) => { const m = re.exec(s); return m ? Number(m[1]) : 0; };
  let m: RegExpExecArray | null;

  // jest: "Tests:       2 failed, 41 passed, 58 total"
  const jest = /^\s*Tests:\s+([^\n]*?\d+ total)/gm;
  while ((m = jest.exec(text))) take(m.index, num(/(\d+) passed/, m[1]), num(/(\d+) failed/, m[1]), num(/(\d+) total/, m[1]));
  // vitest: "Tests  41 passed | 2 failed (58)" or "Tests  41 passed (41)"
  const vitest = /^\s*Tests\s+([^\n]*?)\((\d+)\)\s*$/gm;
  while ((m = vitest.exec(text))) take(m.index, num(/(\d+) passed/, m[1]), num(/(\d+) failed/, m[1]), Number(m[2]));
  // pytest: "==== 2 failed, 41 passed, 3 skipped in 4.20s ====" / "41 passed in 1.2s"
  const pytest = /^=*\s*((?:\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)(?:, )?)+) in [\d.]+s/gm;
  while ((m = pytest.exec(text))) {
    const failed = num(/(\d+) failed/, m[1]) + num(/(\d+) errors?/, m[1]);
    take(m.index, num(/(\d+) passed/, m[1]), failed);
  }
  // node --test: "# tests 58" "# pass 41" "# fail 2"
  const nodeT = /^#\s*tests\s+(\d+)\s*$/gm;
  while ((m = nodeT.exec(text))) {
    const rest = text.slice(m.index, m.index + 400);
    take(m.index, num(/^#\s*pass\s+(\d+)/m, rest), num(/^#\s*fail\s+(\d+)/m, rest), Number(m[1]));
  }
  // mocha: "41 passing (2s)" + "2 failing"
  const mocha = /^\s*(\d+) passing\b/gm;
  while ((m = mocha.exec(text))) {
    const rest = text.slice(m.index, m.index + 300);
    take(m.index, Number(m[1]), num(/^\s*(\d+) failing\b/m, rest));
  }
  // cargo: "test result: ok. 41 passed; 2 failed; 0 ignored"
  const cargo = /test result: \w+\. (\d+) passed; (\d+) failed/g;
  while ((m = cargo.exec(text))) take(m.index, Number(m[1]), Number(m[2]));
  // go test -v: count "--- PASS" / "--- FAIL" lines when nothing else matched
  if (!best) {
    const pass = (text.match(/^\s*--- PASS/gm) ?? []).length, fail = (text.match(/^\s*--- FAIL/gm) ?? []).length;
    if (pass + fail) take(text.length, pass, fail);
  }
  if (!best) return undefined;
  const { passed, failed, total } = best;
  return { passed, failed, total, line: `${passed} of ${total} passed` };
}

/** Progress in % from the recipe: finished steps ÷ steps in the recipe. Test progress replaces it while tests run. */
export function progressFrom(doneSteps: number, totalSteps: number, test?: TestProgress): number {
  if (test && test.total > 0) return Math.max(0, Math.min(100, Math.round((test.passed / test.total) * 100)));
  if (!totalSteps) return 0;
  return Math.max(0, Math.min(100, Math.round((doneSteps / totalSteps) * 100)));
}

/**
 * Lines from one Claude Agent SDK stream message (the runner's message loop): tool calls in an assistant message,
 * and a test summary in a tool result. Unknown shapes return nothing.
 */
export function activityFromSdkMessage(msg: any, opts: { root?: string } = {}): { lines: string[]; test?: TestProgress } {
  const lines: string[] = [];
  let test: TestProgress | undefined;
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return { lines };
  for (const b of content) {
    if (b?.type === "tool_use" && b.name) lines.push(toolCallToLine(b.name, b.input, opts));
    if (b?.type === "tool_result") {
      const out = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n") : "";
      test = testProgressFromOutput(out) ?? test;
    }
  }
  return { lines, test };
}

// ------------------------------------------------------------------ storage

export const ACTIVITY_WRITE_MS = 5000;
const lastWrite = new Map<string, number>();
let now: () => number = () => Date.now();
/** Tests only. */
export function _setActivityClock(fn?: () => number): void { now = fn ?? (() => Date.now()); lastWrite.clear(); }

export interface ActivityRow { task_id: string; agent: string | null; step: string | null; line: string | null; progress: number | null; tokens: number | null; started_at: string | null; at: string }

/**
 * Record what a job is doing now. Always publishes an `activity` event (the bus throttles it to one per 2 s per task);
 * writes the `activity` table at most every 5 s per task (always when `force`, e.g. at step start or end).
 * Returns true when the row was written.
 */
export function recordActivity(taskId: string, agent: string | null | undefined, step: string | null | undefined, line: string,
  progress?: number | null, tokens?: number | null, opts: { force?: boolean; ref?: string } = {}): boolean {
  const t = now();
  const at = new Date(t).toISOString();
  const pct = progress == null ? null : Math.max(0, Math.min(100, Math.round(progress)));
  publish("activity", { taskId, ref: opts.ref, agent: agent ?? null, step: step ?? null, line: clip(line, 140), progress: pct, tokens: tokens ?? null, at });
  const last = lastWrite.get(taskId);
  if (!opts.force && last !== undefined && t - last < ACTIVITY_WRITE_MS) return false;
  lastWrite.set(taskId, t);
  const prev = db().prepare("SELECT step, started_at FROM activity WHERE task_id=?").get(taskId) as { step: string | null; started_at: string | null } | undefined;
  const startedAt = prev && prev.step === (step ?? null) && prev.started_at ? prev.started_at : at;
  db().prepare(`INSERT INTO activity (task_id, agent, step, line, progress, tokens, started_at, at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET agent=excluded.agent, step=excluded.step, line=excluded.line,
      progress=coalesce(excluded.progress, activity.progress), tokens=coalesce(excluded.tokens, activity.tokens),
      started_at=excluded.started_at, at=excluded.at`)
    .run(taskId, agent ?? null, step ?? null, clip(line, 140), pct, tokens ?? null, startedAt, at);
  return true;
}

/** The job ended: remove its live line (the timeline keeps the history in `steps`). */
export function clearActivity(taskId: string): void {
  lastWrite.delete(taskId);
  db().prepare("DELETE FROM activity WHERE task_id=?").run(taskId);
  publish("activity", { taskId, ended: true, at: nowIso() }, { throttleMs: 0 });
}

export function getActivity(taskId: string): ActivityRow | undefined {
  return db().prepare("SELECT * FROM activity WHERE task_id=?").get(taskId) as ActivityRow | undefined;
}

export function listActivity(): ActivityRow[] {
  return db().prepare("SELECT * FROM activity ORDER BY at DESC").all() as unknown as ActivityRow[];
}
