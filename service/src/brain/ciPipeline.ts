import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/**
 * What the repository's CI runs on a pull request, read from .github/workflows (no AI, no tokens).
 * Used to fix a failing PR correctly: a lint or test failure is fixed by the plugin; a check that needs a person
 * (a re-recorded baseline, a paid evaluation, a secret, a deployment) is reported, never faked.
 */

export type CiKind = "lint" | "format" | "types" | "test" | "security" | "build" | "baseline" | "eval" | "deploy" | "other";
/** auto: the plugin may fix it · careful: fix only code, never the expectations · human: report what is needed. */
export type CiFixable = "auto" | "careful" | "human";

export interface CiJob {
  workflow: string;          // file name
  workflowName: string;
  job: string;               // job id
  name: string;              // what GitHub shows as the check name
  kinds: CiKind[];
  commands: string[];        // run: lines (first line of each, trimmed)
  actions: string[];         // uses: lines
  secrets: string[];         // secrets.* referenced (names only – never values)
  services: string[];        // e.g. postgres, redis
  onPullRequest: boolean;
  fixable: CiFixable;
  localCommand?: string;     // a command that reproduces it on this computer, when one exists
}

export interface CiPipeline { files: string[]; jobs: CiJob[]; detectedAt: string }

const KIND_RULES: { kind: CiKind; re: RegExp }[] = [
  { kind: "baseline", re: /\b(baselines?|golden|replay|cassettes?|snapshots?[- ](update|record))\b/i },
  { kind: "eval", re: /\b(eval(s|uation)?|llm[-_ ]?judge|benchmark)\b/i },
  { kind: "deploy", re: /\b(deploy|release|publish|terraform apply|helm upgrade|kubectl apply|vercel|netlify|aws\s+(s3|ecs|lambda))\b/i },
  { kind: "format", re: /\b(ruff format|black\b|prettier|isort|gofmt|format(:check)?\b)/i },
  { kind: "lint", re: /\b(ruff( check)?|flake8|pylint|eslint|lint\b|golangci|stylelint|biome)/i },
  { kind: "types", re: /\b(mypy|pyright|tsc\b|type-?check)/i },
  { kind: "security", re: /\b(gitleaks|trufflehog|trivy|bandit|pip-audit|safety check|npm audit|snyk|codeql|semgrep|dependency[- ]?(review|scan|check)|secret[- ]?scan|osv-scanner)/i },
  { kind: "test", re: /\b(pytest|unittest|jest|vitest|mocha|playwright test|cypress|go test|npm (run )?test|pnpm test|yarn test|coverage)\b/i },
  { kind: "build", re: /\b(build|docker build|compile|bundle)\b/i },
];

/** Secrets that only a person can provide or that cost money – a check that needs them can't be "fixed" by editing code. */
const PAID_OR_PRIVATE = /(ANTHROPIC|OPENAI|GEMINI|MISTRAL|COHERE|AWS|AZURE|GCP|GOOGLE|STRIPE|DEPLOY|PROD|VERCEL|NETLIFY|SUPABASE_SERVICE)/i;

export function kindsOf(text: string): CiKind[] {
  const out = KIND_RULES.filter((r) => r.re.test(text)).map((r) => r.kind);
  return out.length ? [...new Set(out)] : ["other"];
}

function asList(x: unknown): string[] {
  if (!x) return [];
  if (typeof x === "string") return [x];
  if (Array.isArray(x)) return x.map(String);
  if (typeof x === "object") return Object.keys(x as object);
  return [];
}

export function parseWorkflow(file: string, text: string): CiJob[] {
  let doc: any;
  try { doc = YAML.parse(text); } catch { return []; }
  if (!doc || typeof doc !== "object") return [];
  const on = doc.on ?? doc[true as any];          // YAML 1.1 parsers read `on:` as true
  const triggers = asList(on);
  const onPullRequest = triggers.some((t) => /pull_request/.test(t));
  const wfName = String(doc.name ?? path.basename(file));
  const jobs: CiJob[] = [];
  for (const [id, j] of Object.entries<any>(doc.jobs ?? {})) {
    if (!j || typeof j !== "object") continue;
    const steps: any[] = Array.isArray(j.steps) ? j.steps : [];
    const commands = steps.filter((s) => typeof s?.run === "string").map((s) => String(s.run).trim().split("\n")[0].trim()).filter(Boolean);
    const actions = steps.filter((s) => typeof s?.uses === "string").map((s) => String(s.uses));
    const stepNames = steps.map((s) => String(s?.name ?? "")).join(" ");
    const whole = YAML.stringify(j);
    const secrets = [...new Set([...whole.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).filter((s) => s !== "GITHUB_TOKEN"))];
    const services = Object.keys(j.services ?? {});
    const name = String(j.name ?? id).replace(/\$\{\{[^}]*\}\}/g, "").trim() || id;
    const kinds = kindsOf(`${name} ${id} ${stepNames} ${commands.join(" ")} ${actions.join(" ")}`);
    const usesPaid = secrets.some((s) => PAID_OR_PRIVATE.test(s));
    const fixable: CiFixable =
      kinds.some((k) => k === "baseline" || k === "eval" || k === "deploy") || (usesPaid && !kinds.some((k) => ["lint", "format", "types"].includes(k))) ? "human"
      : kinds.some((k) => k === "test" || k === "security" || k === "build") ? "careful"
      : kinds.some((k) => k === "lint" || k === "format" || k === "types") ? "auto" : "careful";
    // the first command that does the job's real work is the one to reproduce locally
    const local = fixable !== "human" ? commands.find((c) => kindsOf(c).some((k) => kinds.includes(k) && k !== "other") && !/\b(install|setup|apt-get|pip install|npm ci|uv sync)\b/i.test(c)) : undefined;
    jobs.push({ workflow: path.basename(file), workflowName: wfName, job: id, name, kinds, commands: commands.slice(0, 12), actions: actions.slice(0, 12), secrets, services, onPullRequest, fixable, localCommand: local });
  }
  return jobs;
}

export function detectCiPipeline(repo: string): CiPipeline | undefined {
  const dir = path.join(repo, ".github", "workflows");
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
  const jobs = files.flatMap((f) => { try { return parseWorkflow(f, fs.readFileSync(path.join(dir, f), "utf8")); } catch { return []; } });
  return { files, jobs, detectedAt: new Date().toISOString() };
}

/** The pipeline job a failing GitHub check belongs to ("Lint & Format" or "CI / lint (3.12)"). */
export function jobForCheck(ci: CiPipeline | undefined, checkName: string): CiJob | undefined {
  if (!ci) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const n = norm(checkName);
  return ci.jobs.find((j) => norm(j.name) === n || norm(j.job) === n || n.endsWith(norm(j.name)) || n.endsWith(norm(j.job)))
    ?? ci.jobs.find((j) => n.includes(norm(j.name)) || norm(j.name).includes(n));
}

export function ciSummaryLines(ci: CiPipeline | undefined): string[] {
  if (!ci || !ci.jobs.length) return ["CI: no GitHub Actions workflows found"];
  const label = { auto: "the plugin fixes it", careful: "fix the code, never weaken the check", human: "needs a person – reported, never faked" } as const;
  return ci.jobs.filter((j) => j.onPullRequest).map((j) =>
    `CI "${j.name}" (${j.kinds.join("/")}): ${label[j.fixable]}${j.localCommand ? ` · local: \`${j.localCommand}\`` : ""}${j.services.length ? ` · services: ${j.services.join(", ")}` : ""}${j.secrets.length ? ` · secrets: ${j.secrets.join(", ")}` : ""}`);
}
