import fs from "node:fs";
import path from "node:path";
import { loadSettings, type Tier } from "../core/config.js";
import { getSecret } from "../core/secrets.js";
import { logger } from "../core/log.js";
import { wrapUntrusted, UNTRUSTED_NOTE, UNTRUSTED_RULE_TEXT } from "../policy/untrusted.js";
import { effortFor, maxTurnsFor, type Effort } from "./catalog.js";

/**
 * One specialist agent step. The Playbook Engine (code) decides WHAT runs; the runner only executes
 * one narrow job with the smallest context, a model tier, an explicit tool allowlist and a JSON schema.
 */
export interface AgentRequest {
  agent: string;                 // e.g. "triage", "planner", "implementer", "reviewer:security"
  tier: Tier;
  system: string;
  prompt: string;
  cwd?: string;                  // implementer/tester: the task worktree; others: none or read-only repo
  /** More folders the agent may read (the other repositories of a multi-repo product). Only for read-only agents. */
  additionalDirectories?: string[];
  tools?: string[];              // built-in tools made available (empty = pure reasoning, no tools)
  allow?: string[];              // auto-approved tool patterns, e.g. "Bash(npm test:*)"
  schema?: Record<string, unknown>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Give the agent the read-only lookup tools (Jira / GitHub PR / Figma / Notion) for the connected services. */
  lookup?: { repo?: string; codeRepos?: string[] };
  /** How hard the model thinks. Default: the agent's entry in the effort table (agents/catalog.ts). */
  effort?: Effort;
  /** Give the agent the compact run_tests / run_lint / git_diff_stat tools for its worktree (needs cwd). */
  compact?: import("./tools/compact.js").CompactProfile;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  data?: any;
  /** All input tokens: freshIn + cacheRead + cacheWrite (kept for budgets and older code). */
  tokensIn: number;
  tokensOut: number;
  /** Input tokens that were neither read from nor written to the prompt cache. */
  freshIn?: number;
  cacheRead?: number;
  cacheWrite?: number;
  effort?: string;
  costUsd: number;
  model: string;
  error?: string;
}

export interface Runner { run(req: AgentRequest): Promise<AgentResult> }

export function modelFor(tier: Tier): string {
  const m = loadSettings().models;
  return tier === "small" ? m.small : tier === "large" ? m.large : m.medium;
}

/**
 * External text (tickets, comments, docs, logs) is DATA, never instructions.
 * It is fenced and labelled so the model can tell it apart from the task it was given.
 */
export function untrusted(label: string, text: string): string {
  // code, diffs and logs keep every character (removing "hidden" HTML from a diff would hide real code from the reviewer)
  if (CODE_SOURCES.test(label)) {
    const clean = (text ?? "").replace(/<\/?untrusted[^>]*>/gi, "");
    return `(${UNTRUSTED_NOTE(label)})\n<untrusted source="${label}">\n${clean}\n</untrusted>`;
  }
  // prose from people (tickets, comments, designs, documents, messages): hidden text removed, order-like text flagged (§11a)
  return wrapUntrusted(label, text ?? "", Infinity);
}
/** Sources that are code or tool output, not prose: fenced as data but never rewritten. */
const CODE_SOURCES = /^(diff|test-output|ci-log|git-log|code|patch|log)\b/;

export const UNTRUSTED_RULE = UNTRUSTED_RULE_TEXT;

export interface CallOptions { effort?: Effort; maxBudgetUsd?: number; fallbackModel?: string; taskBudget?: { total: number }; maxTurns?: number }

/** What one agent call may spend and how hard it thinks (§9.1). Pure, so it can be tested. */
export function callOptions(req: AgentRequest, model: string, s = loadSettings()): CallOptions {
  const m = s.models;
  const cost = s.cost ?? { maxBudgetUsd: 25, taskBudget: false, taskBudgetTokens: { small: 60_000, medium: 300_000, large: 600_000 } };
  const next = m.fallback ?? (req.tier === "large" ? m.medium : req.tier === "medium" ? m.large : m.medium);
  return {
    effort: req.effort ?? effortFor(req.agent, undefined, cost.effort),
    maxBudgetUsd: req.maxBudgetUsd ?? cost.maxBudgetUsd,
    fallbackModel: next && next !== model ? next : undefined,
    taskBudget: cost.taskBudget ? { total: cost.taskBudgetTokens?.[req.tier] ?? 300_000 } : undefined,
    maxTurns: req.maxTurns ?? maxTurnsFor(req.agent),
  };
}

/** Split SDK usage into fresh input, cache reads and cache writes (tokensIn stays their sum). */
export function splitUsage(u: any): { tokensIn: number; tokensOut: number; freshIn: number; cacheRead: number; cacheWrite: number } {
  const freshIn = Number(u?.input_tokens ?? 0) || 0;
  const cacheRead = Number(u?.cache_read_input_tokens ?? 0) || 0;
  const cacheWrite = Number(u?.cache_creation_input_tokens ?? 0) || 0;
  return { tokensIn: freshIn + cacheRead + cacheWrite, tokensOut: Number(u?.output_tokens ?? 0) || 0, freshIn, cacheRead, cacheWrite };
}

// ---------------------------------------------------------------------------------------------

/** Production runner: Claude Agent SDK, headless, no persisted sessions, no user/project settings. */
export class ClaudeSdkRunner implements Runner {
  async run(req: AgentRequest): Promise<AgentResult> {
    const model = modelFor(req.tier);
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30 * 60_000);
    const env = agentEnv(loadSettings().models.provider);
    // long Bash output is cut by the CLI itself, so a noisy command can't flood the context (§9.1.2)
    if (!env.BASH_MAX_OUTPUT_LENGTH) env.BASH_MAX_OUTPUT_LENGTH = "20000";
    const opts = callOptions(req, model);
    try {
      // Read-only lookup tools (in-process MCP server) – only for connected services; nothing else is added.
      let mcpServers: Record<string, any> | undefined;
      let lookupNames: string[] = [];
      let lookupRule = "";
      if (req.lookup) {
        const L = await import("./lookup.js");
        lookupNames = L.lookupToolNames(req.lookup);
        if (lookupNames.length) {
          mcpServers = { [L.LOOKUP_SERVER]: await L.lookupServer(req.lookup) };
          lookupRule = `\n\n${L.LOOKUP_RULE}${lookupNames.some((n) => n.endsWith("__code_query")) ? `\n\n${L.CODE_GRAPH_RULE}` : ""}`;
        }
      }
      // compact test / lint / diff tools for the implementer: failures with file:line only, never the full log
      let compactNames: string[] = [];
      let compactRule = "";
      if (req.compact && req.cwd) {
        const C = await import("./tools/compact.js");
        mcpServers = { ...(mcpServers ?? {}), [C.COMPACT_SERVER]: await C.createCompactToolsServer(req.cwd, req.compact) };
        compactNames = C.compactToolNames();
        compactRule = `\n\n${C.COMPACT_RULE}`;
      }
      // a stable prompt prefix keeps the cache warm (§9.1.7): no times or ids in the system prompt, tools always in the same order
      const allowed = [...sorted(req.allow ?? req.tools ?? []), ...sorted(lookupNames), ...sorted(compactNames)];
      const q = query({
        prompt: req.prompt,
        options: {
          model,
          cwd: req.cwd,
          additionalDirectories: req.additionalDirectories?.length ? req.additionalDirectories : undefined,
          systemPrompt: `${req.system}\n\n${UNTRUSTED_RULE}${lookupRule}${compactRule}`,
          tools: sorted(req.tools ?? []),
          allowedTools: allowed,
          mcpServers,
          permissionMode: "dontAsk",
          maxTurns: opts.maxTurns ?? (req.tools?.length ? 40 : lookupNames.length ? 12 : 3),
          maxBudgetUsd: opts.maxBudgetUsd,
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
          ...(opts.taskBudget ? { taskBudget: opts.taskBudget } : {}),
          outputFormat: req.schema ? { type: "json_schema", schema: req.schema } : undefined,
          settingSources: [],
          persistSession: false,
          abortController: ctrl,
          env,
        } as any,
      });
      let result: any;
      for await (const m of q as AsyncIterable<any>) if (m.type === "result") result = m;
      if (!result) return fail(model, "Agent ended without a result");
      const base = { ...splitUsage(result.usage), costUsd: result.total_cost_usd ?? 0, model, effort: opts.effort };
      if (result.subtype !== "success" || result.is_error) return { ...base, ok: false, text: result.result ?? "", error: result.subtype };
      const data = result.structured_output ?? (req.schema ? parseJsonLoose(result.result) : undefined);
      return { ...base, ok: !req.schema || data !== undefined, text: result.result ?? "", data, error: req.schema && data === undefined ? "no structured output" : undefined };
    } catch (e: any) {
      logger.error("agent run failed", { agent: req.agent, error: e.message });
      return fail(model, e.message);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Environment for agent runs.
 *  - "claude": API key from the OS vault (or ANTHROPIC_API_KEY).
 *  - "claude-login": NO key is passed and any key in the environment is removed, so Claude Code uses the account
 *    the user is signed into (`claude` login). The plugin never reads or copies that login.
 */
export function agentEnv(provider: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (provider === "claude-login") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }
  const apiKey = getSecret("anthropic.apiKey") ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

export interface ChatTurn {
  prompt: string;
  system: string;
  cwd: string;
  additionalDirectories: string[];
  resume?: string;                       // Agent SDK session id from the previous turn
  mcpServers: Record<string, any>;
  allowedTools: string[];                // read-only tools only
  maxTurns: number;
  maxBudgetUsd: number;
}
export interface ChatReply { ok: boolean; text: string; sessionId?: string; tokens: number; costUsd: number; error?: string }

/**
 * A conversational turn (Teams chat assistant). Unlike playbook steps it keeps a session so follow-up questions work.
 * Built-in tools are limited to Read/Grep/Glob and permissionMode "dontAsk" denies everything not explicitly allowed.
 */
export async function runChatTurn(t: ChatTurn): Promise<ChatReply> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5 * 60_000);
  try {
    const q = query({
      prompt: t.prompt,
      options: {
        model: modelFor("medium"),
        cwd: t.cwd,
        additionalDirectories: t.additionalDirectories,
        systemPrompt: `${t.system}\n\n${UNTRUSTED_RULE}`,
        tools: ["Read", "Grep", "Glob"],
        allowedTools: t.allowedTools,
        permissionMode: "dontAsk",
        mcpServers: t.mcpServers,
        maxTurns: t.maxTurns,
        maxBudgetUsd: t.maxBudgetUsd,
        resume: t.resume,
        persistSession: true,
        settingSources: [],
        abortController: ctrl,
        env: agentEnv(loadSettings().models.provider),
      } as any,
    });
    let result: any, sessionId: string | undefined;
    for await (const m of q as AsyncIterable<any>) {
      if (m.session_id) sessionId = m.session_id;
      if (m.type === "result") result = m;
    }
    if (!result) return { ok: false, text: "", tokens: 0, costUsd: 0, error: "no result" };
    const u = splitUsage(result.usage);
    const tokens = u.tokensIn + u.tokensOut;
    return { ok: result.subtype === "success" && !result.is_error, text: result.result ?? "", sessionId, tokens, costUsd: result.total_cost_usd ?? 0, error: result.subtype !== "success" ? result.subtype : undefined };
  } catch (e: any) {
    return { ok: false, text: "", tokens: 0, costUsd: 0, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** One tiny real call to prove the chosen authentication works (used by `aiw model`). */
export async function testAgentAuth(): Promise<{ ok: boolean; detail: string }> {
  const r = await new ClaudeSdkRunner().run({ agent: "auth-test", tier: "small", system: "Reply with exactly: OK", prompt: "ping", maxTurns: 1 });
  return r.ok ? { ok: true, detail: `model ${r.model} answered` } : { ok: false, detail: r.error ?? "no answer" };
}

/** Unique and sorted, so the same tools always reach the model in the same order. */
const sorted = (xs: string[]) => [...new Set(xs)].sort();

function fail(model: string, error: string): AgentResult {
  return { ok: false, text: "", tokensIn: 0, tokensOut: 0, costUsd: 0, model, error };
}

export function parseJsonLoose(s: string): any {
  if (!s) return undefined;
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const body = m ? m[1] : s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1);
  try { return JSON.parse(body); } catch { return undefined; }
}

// ---------------------------------------------------------------------------------------------

/**
 * Deterministic offline runner used by tests, demos and `models.provider: mock`.
 * Produces plausible structured outputs so every playbook branch can be exercised without an API key.
 */
export class MockRunner implements Runner {
  calls: AgentRequest[] = [];
  constructor(private overrides: Record<string, (req: AgentRequest) => any> = {}) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const key = Object.keys(this.overrides).find((k) => req.agent === k || req.agent.startsWith(k + ":"));
    const data = key ? this.overrides[key](req) : this.defaults(req);
    const tokensIn = Math.ceil((req.system.length + req.prompt.length) / 4);
    return { ok: true, text: typeof data === "string" ? data : JSON.stringify(data), data, tokensIn, freshIn: tokensIn, cacheRead: 0, cacheWrite: 0, tokensOut: 300, costUsd: 0,
      model: `mock-${req.tier}`, effort: req.effort ?? effortFor(req.agent) };
  }

  private defaults(req: AgentRequest): any {
    const p = req.prompt;
    const ticket = /<untrusted source="ticket[^"]*">([\s\S]*?)<\/untrusted>/.exec(p)?.[1] ?? p;
    switch (req.agent.split(":")[0]) {
      case "triage": {
        const small = /\b(typo|rename|copy change|small|minor|bump)\b/i.test(ticket);
        const large = /\b(migration|redesign|new service|refactor all|architecture)\b/i.test(ticket);
        const clear = ticket.replace(/\s+/g, " ").trim().length >= 40 && !/\?\?|tbd/i.test(ticket);
        return { type: /bug|fix|error/i.test(ticket) ? "bug" : "feature", size: small ? "S" : large ? "L" : "M", clear,
          questions: clear ? [] : ["Could you describe the expected behaviour and acceptance criteria?"], summary: ticket.trim().split("\n")[0].slice(0, 120) };
      }
      case "analyst": return { requirements: [ticket.trim().split("\n")[0]], acceptanceCriteria: ["Behaviour matches the ticket description", "Existing tests keep passing"], openQuestions: [] };
      case "planner": return { summary: "Implement the requested change", steps: ["Locate relevant code", "Implement change", "Add tests"], files: [], tests: ["Unit test for the new behaviour"], risks: [] };
      case "plan-reviewer": case "reviewer": return { pass: true, issues: [] };
      case "implementer": {
        if (req.cwd) {
          const f = path.join(req.cwd, "AIW_CHANGE.md");
          fs.appendFileSync(f, `Change at ${new Date().toISOString()}\n`);
        }
        return { summary: "Applied the planned change (mock)", commitSubject: "apply the planned change", filesChanged: ["AIW_CHANGE.md"], testsAdded: [] };
      }
      case "reporter": return { title: "AI Workforce change", body: "## Summary\nMock implementation report.\n\n## Testing\nAll checks passed." };
      case "memory-keeper": return { facts: [], lessons: [] };
      case "intent": return { intent: "question", ref: "", text: "", project: "", delegated: false };
      // ----- multi-repository lead (offline): routes by repository names + ticket keywords, builds the producer first
      case "explorer": {
        const ids = (/Repository ids: (.+)/.exec(p)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        return { summary: "Relevant code found (mock)", repos: (ids.length ? ids : ["repo"]).map((repo) => ({
          repo, relevant: [{ file: "src/app.ts", line: 3, symbol: "app.post", why: "the endpoint this ticket touches", excerpt: "app.post('/payments/:id/refund', …)" }],
          existing: ["The endpoint exists"], missing: ["The new behaviour"], tests: [] })), facts: [], openPoints: [] };
      }
      case "lead": {
        const ids = (/Repository ids: (.+)/.exec(p)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        const fe = ids.find((id) => /front|web|ui|client/i.test(id)), be = ids.find((id) => /back|api|server|service/i.test(id));
        const wantsFe = /\b(ui|page|screen|button|form|frontend|front-end|component|display|show|render|chip|view)\b/i.test(ticket);
        const wantsBe = /\b(api|endpoint|database|backend|back-end|schema|server|migration|field|persist\w*|store)\b/i.test(ticket);
        const targets: string[] = [];
        if (be && (wantsBe || !wantsFe)) targets.push(be);
        if (fe && wantsFe) targets.push(fe);
        if (!targets.length && ids[0]) targets.push(ids[0]);
        return { summary: ticket.trim().split("\n")[0].slice(0, 160), requirements: [ticket.trim().split("\n")[0]], acceptanceCriteria: ["Behaviour matches the ticket description", "Existing tests keep passing"],
          existing: [], targets, targetsReason: "mock routing by repository names", order: "sequential", orderReason: "the side that produces the data goes first", decisions: [], questions: [] };
      }
      case "contract": {
        const t = (/Targets in build order: (.+)/.exec(p)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        return { summary: "Mock contract", items: [{ name: "GET /api/example", kind: "endpoint", producer: t[0] ?? "", consumer: t[1] ?? "", details: "returns { id: string, reason: string | null }" }], errors: ["404 when not found"], notes: [] };
      }
      case "lead-planner": {
        const t = (/Targets in build order: (.+)/.exec(p)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        return { summary: "Implement the requested change in every repository", parts: t.map((repo) => ({ repo, summary: `Change ${repo}`, steps: ["Locate relevant code", "Implement change", "Add tests"], files: [], tests: ["Unit test for the new behaviour"] })), risks: [] };
      }
      case "coordinator": return { decision: "answer", answer: "Follow the contract and keep the existing naming.", contractChange: "", userQuestions: [] };
      case "integration-reviewer": return { pass: true, summary: "The parts fit together (mock)", issues: [], criteria: [] };
      case "pr-reviewer": {
        // comment on the first added line of the first file in the PR (mock)
        const m = /### (\S+)\n```diff\n@@ -\d+(?:,\d+)? \+(\d+)/.exec(p);
        return { summary: "The change looks reasonable; one point to check (mock).", ticketCoverage: "Covers the ticket (mock)",
          verdict: "changes_needed", verdictReason: "One input is not validated (mock).", requirementsCheck: [{ requirement: "Behaviour matches the ticket", status: "met", where: "" }],
          comments: m ? [{ file: m[1], line: Number(m[2]), severity: "major", title: "Missing input check", body: "This value is used without checking it first. Please validate it before use.", suggestion: "" }] : [] };
      }
      case "screenshotter": return { pages: [], problems: ["mock runner: no browser"] };
      case "comment-resolver": {
        // fix every numbered item (mock)
        const ns = [...p.matchAll(/^\*\*(\d+)\.\*\* /gm)].map((m) => Number(m[1]));
        return { summary: "Addressed the review comments (mock).", items: ns.map((n) => ({ n, action: "fix", reason: "The reviewer is right.", instruction: `Address comment ${n}.`, reply: "Done – changed as suggested.", otherRepo: "", question: "", options: [] })) };
      }
      case "stack-profiler": return {};                       // keep the built-in rules (mock)
      case "qa-planner": return { risk: "medium", summary: "Check the changed behaviour (mock).", areas: ["changed code"], testFiles: [], browser: { needed: false, checks: [] }, gaps: [] };
      case "qa-tester": return { checks: [], problems: [] };
      case "qa-triager": return { verdict: "pass", summary: "Everything that ran passed (mock).", suites: [{ suite: "unit", passed: 1, failed: 0, skipped: 0, result: "pass" }], findings: [], gaps: [] };
      case "report-writer": return {
        summary: "The ticket was implemented and a draft PR was raised (mock).", asked: ticket.trim().split("\n")[0].slice(0, 200), outcome: "Implemented as planned.",
        changes: [], flow: { nodes: [{ id: "ui", label: "Page", layer: "ui", changed: true }, { id: "api", label: "API", layer: "api", changed: false }], edges: [{ from: "ui", to: "api", label: "request" }] }, followUps: [],
      };
      case "interviewer": {
        const request = /<untrusted source="request[^"]*">([\s\S]*?)<\/untrusted>/.exec(p)?.[1]?.trim() ?? "the requested change";
        const answered = /## Answers so far\n(?!none)/.test(p);
        const requirements = {
          title: request.split("\n")[0].slice(0, 80), goal: request, behaviour: [request], acceptanceCriteria: ["The requested behaviour works", "Existing tests keep passing"],
          edgeCases: [], outOfScope: [], repositories: [], assumptions: [],
        };
        return answered
          ? { done: true, questions: [], requirements }
          : { done: false, questions: [{ question: "Who will use this?", options: ["All buyers", "Admins only"] }], requirements };
      }
      case "image-describer": return { summary: "A screenshot of the app (mock).", errorText: "", kind: "screenshot" };
      case "onboarder": return {
        overview: "Project overview generated offline from the repository structure.",
        architecture: "See the code map for the most important files.", standards: "Follow existing conventions in the codebase.",
        glossary: "", facts: [],
      };
      default: return { summary: `Mock output for ${req.agent}`, items: [] };
    }
  }
}

let override: Runner | undefined;
export function setRunner(r: Runner | undefined): void { override = r; }

export function getRunner(): Runner {
  if (override) return override;
  return loadSettings().models.provider === "mock" ? new MockRunner() : new ClaudeSdkRunner();
}
