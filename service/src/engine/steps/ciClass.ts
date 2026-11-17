/**
 * W9: what to do with one failing CI check, decided by code from the CI map (brain/ciPipeline.ts), the check's
 * conclusion and its log. No model calls.
 *
 *   base   – it also fails on the base branch: not this PR's fault → leave it, tell you
 *   human  – baseline, paid evaluation, deployment, secret → never faked, one short line of what is needed
 *   flaky  – runner / network problem → re-run the job once; red again → treated as real
 *   auto   – lint / format with a local fix command → run that command here (no AI), push
 *   agent  – tests, types, anything else → the fix agent (the normal fix flow)
 */
import type { CiCheck } from "../../connectors/github.js";
import { jobForCheck, type CiJob, type CiPipeline } from "../../brain/ciPipeline.js";

export type CiClass = "base" | "human" | "flaky" | "auto" | "agent";

export interface CiDecision {
  cls: CiClass;
  /** Short plain reason ("also fails on main", "runner problem"). */
  reason: string;
  /** auto: the local command that fixes it (e.g. "ruff check --fix ."). */
  fixCommand?: string;
  /** human: what a person must do ("re-record the baseline"). */
  needs?: string;
  job?: CiJob;
}

/** Signs in a log or a conclusion that the runner or the network failed, not the code. */
const RUNNER_PROBLEM = /(runner has received a shutdown signal|lost communication with the server|The operation was canceled|The job was not acquired|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|503 Service Unavailable|502 Bad Gateway|rate limit exceeded|No space left on device|Could not resolve host|TLS handshake timeout|exit code 137|Internal server error occurred|Unable to download artifact|failed to pull image|toomanyrequests)/i;
const RUNNER_CONCLUSIONS = new Set(["cancelled", "timed_out", "startup_failure", "stale"]);
/** A secret or credential the check needs is missing or wrong (a person must set it). */
const MISSING_SECRET = /(secret[^\n]{0,40}(not set|not found|missing|empty)|Bad credentials|401 Unauthorized|invalid api key|authentication failed for)/i;

export function looksFlaky(check: Pick<CiCheck, "conclusion">, log: string): boolean {
  return RUNNER_CONCLUSIONS.has(String(check.conclusion ?? "").toLowerCase()) || RUNNER_PROBLEM.test(log ?? "");
}

/**
 * The command that FIXES what a lint/format check command reports, or undefined when there is no safe one.
 * `scripts` = package.json scripts when known (to prefer "lint:fix" / "format").
 */
export function fixCommandFor(cmd: string | undefined, scripts: Record<string, string> = {}): string | undefined {
  if (!cmd) return undefined;
  const c = cmd.trim();
  const npm = /^(npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)(.*)$/.exec(c);
  if (npm) {
    const [, pm, script, rest] = npm;
    const run = (s: string) => `${pm} run ${s}${rest}`;
    if (/:check$/.test(script) && (scripts[script.replace(/:check$/, "")] !== undefined || !Object.keys(scripts).length)) return run(script.replace(/:check$/, ""));
    if (scripts[`${script}:fix`] !== undefined) return run(`${script}:fix`);
    if (/^format$/.test(script) && scripts["format:write"] !== undefined) return run("format:write");
    return undefined;
  }
  if (/\bruff\s+format\b/.test(c)) return c.replace(/\s--(check|diff)\b/g, "");
  if (/\bruff(\s+check)?\b/.test(c)) return /--fix\b/.test(c) ? c : c.replace(/\bruff(\s+check)?/, "ruff check --fix");
  if (/\bblack\b/.test(c)) return c.replace(/\s--(check|diff)\b/g, "");
  if (/\bisort\b/.test(c)) return c.replace(/\s--(check-only|check|diff|-c)\b/g, "");
  if (/\bprettier\b/.test(c)) return /\s(--check|-c|--list-different|-l)\b/.test(c) ? c.replace(/\s(--check|-c|--list-different|-l)\b/, " --write") : `${c} --write`;
  if (/\beslint\b/.test(c)) return /--fix\b/.test(c) ? c : `${c} --fix`;
  if (/\bstylelint\b/.test(c)) return /--fix\b/.test(c) ? c : `${c} --fix`;
  if (/\bbiome\s+(check|ci|lint|format)\b/.test(c)) return c.replace(/\bbiome\s+(check|ci|lint|format)\b/, "biome check --write");
  if (/\bgofmt\b/.test(c)) return c.replace(/\s-l\b/, " -w").replace(/\s-d\b/, " -w");
  return undefined;
}

/** What a person must do for a check the plugin must not fake. */
export function humanNeeds(job: CiJob | undefined, log = ""): string {
  const kinds = job?.kinds ?? [];
  if (kinds.includes("baseline")) return "the baseline must be re-recorded by a person (the expected output changed)";
  if (kinds.includes("eval")) return "a paid evaluation run must be started by a person";
  if (kinds.includes("deploy")) return "a deployment step – a person must check or run it";
  if (MISSING_SECRET.test(log)) return "a secret or credential is missing or wrong – a person must set it in the repository settings";
  if (job?.secrets.length) return `it needs ${job.secrets.join(", ")} – a person must check these secrets`;
  return "a person must look at it";
}

/**
 * Decide one failing check. `reruns` = how often this check was already re-run for this PR head (a re-run happens
 * once; red again → real).
 */
export function classifyCheck(o: { check: Pick<CiCheck, "name" | "conclusion">; log?: string; failsOnBase?: boolean; baseRef?: string;
  ci?: CiPipeline; reruns?: number; scripts?: Record<string, string> }): CiDecision {
  const log = o.log ?? "";
  const job = jobForCheck(o.ci, o.check.name);
  if (o.failsOnBase) return { cls: "base", reason: `also fails on ${o.baseRef ?? "the base branch"} – not caused by this PR`, job };
  if (job?.fixable === "human" || MISSING_SECRET.test(log)) return { cls: "human", reason: "needs a person", needs: humanNeeds(job, log), job };
  if (looksFlaky(o.check, log) && (o.reruns ?? 0) < 1) return { cls: "flaky", reason: "runner or network problem – re-running it once", job };
  const fix = job && job.fixable === "auto" && job.kinds.some((k) => k === "lint" || k === "format") ? fixCommandFor(job.localCommand, o.scripts) : undefined;
  if (fix) return { cls: "auto", reason: `${job!.kinds.filter((k) => k === "lint" || k === "format").join("/")} – fixed with \`${fix}\``, fixCommand: fix, job };
  return { cls: "agent", reason: job ? `${job.kinds.join("/")} – the code is fixed` : "fixed in the code", job };
}

/** The kind word for result messages ("lint", "tests", "types"). */
export function checkWord(d: Pick<CiDecision, "job">, name: string): string {
  const k = d.job?.kinds ?? [];
  if (k.includes("format")) return "format";
  if (k.includes("lint")) return "lint";
  if (k.includes("types")) return "types";
  if (k.includes("test")) return "tests";
  return name;
}
