/**
 * `aiw bench conductor` – how well the Teams understanding (fast rules + the Conductor model) picks the right action
 * for real messages. Each case sets up its situation (what waits for you, the ticket in focus, the last messages) in a
 * SCRATCH home (never your real data), routes the message WITHOUT doing anything (only read-only lookups run), and
 * compares the first action with the right one. Prints the pass rate, every miss, and the cost.
 *
 * Run as its own process (the scratch home must be set before the database opens):
 *   node dist/bench/conductorEval.js --home <dir> [--tier medium|large] [--effort low|medium|high] [--only id,id]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface EvalCase {
  id: string; text: string; expect?: string[]; all?: string[]; noAction?: boolean;
  setup?: { focus?: string; approval?: { ref: string; action: string }; question?: { ref: string; questions: { question: string; options: string[] }[] }; history?: [string, string][] };
}
export interface Call { name: string; ref?: string }
export interface CaseResult { id: string; text: string; via: "fast" | "conductor" | "special"; calls: Call[]; pass: boolean; why?: string; costUsd: number }

/** Fast-path intents → the same names the Conductor's tools have. */
const FAST: Record<string, string> = {
  start_ticket: "start", start_request: "start", approve: "decide:approve", reject: "decide:reject", answer: "decide:answer",
  cancel: "control:cancel", status: "status", resume: "control:resume", review_pr: "review", resolve_comments: "fix_pr:comments",
  fix_ci: "fix_pr:ci", fix_qa: "fix_pr:issues", qa_pr: "qa", send_report: "report", question: "lookup", unclear: "unclear",
};
const READS = new Set(["status", "find", "explain", "lookup", "reply", "unclear", "report"]);

/** A Conductor tool call as "tool[:action|mode|decision]" + its ticket ref. */
export function canonical(tool: string, args: Record<string, any> = {}): Call {
  const sub = tool === "control" ? args.action : tool === "decide" ? (args.decision ?? "approve") : tool === "fix_pr" ? (args.mode ?? "comments") : tool === "start" && args.role ? args.role : tool === "prefs" && args.key ? String(args.key) : undefined;
  const ref = typeof args.ref === "string" ? args.ref : Array.isArray(args.refs) && args.refs.length ? String(args.refs[0]) : undefined;
  return { name: sub ? `${tool}:${sub}` : tool, ref: ref ? normRef(ref) : undefined };
}
const normRef = (r: string) => r.trim().replace(/^([a-z]+)[\s-]*(\d+)/i, (_m, k, n) => `${String(k).toUpperCase()}-${n}`).replace(/@(.+)$/, (_m, x) => `@${String(x).toLowerCase()}`);

/** "control:resume KAN-52@nue-backend" matches a call; a ref without @ also matches the ticket's repo parts. */
export function matches(spec: string, c: Call): boolean {
  const [name, ref] = spec.trim().split(/\s+/);
  if (c.name !== name) return false;
  if (!ref) return true;
  if (!c.ref) return false;
  const want = normRef(ref), got = c.ref;
  return want.includes("@") ? got.toUpperCase() === want.toUpperCase() : got.toUpperCase().split("@")[0] === want.toUpperCase();
}

export function judge(k: EvalCase, calls: Call[]): { pass: boolean; why?: string } {
  const actions = calls.filter((c) => !READS.has(c.name));
  if (k.noAction) return actions.length ? { pass: false, why: `should only answer, but did ${actions.map(show).join(", ")}` } : { pass: true };
  // only reads (find → status): the right read anywhere in the turn counts
  const first = actions[0] ?? (k.expect?.length ? calls.find((c) => k.expect!.some((s) => matches(s, c))) : undefined) ?? calls[0];
  if (!first) return { pass: false, why: "did nothing" };
  if (k.expect?.length && !k.expect.some((s) => matches(s, first))) return { pass: false, why: `did ${show(first)}; expected ${k.expect.join(" or ")}` };
  for (const s of k.all ?? []) if (!calls.some((c) => matches(s, c))) return { pass: false, why: `missing ${s} (did ${calls.map(show).join(", ")})` };
  return { pass: true };
}
const show = (c: Call) => `${c.name}${c.ref ? ` ${c.ref}` : ""}`;

export function fixturePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "src", "test", "fixtures", "conductor-eval.json");
}

// ------------------------------------------------------------------ the run (scratch home only)

async function main(): Promise<void> {
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const home = arg("home");
  if (!home || !/aiw-eval/.test(home)) throw new Error("--home must be a scratch folder whose name contains aiw-eval");
  process.env.AIW_HOME = home;
  const realHome = arg("from");
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
  // the real settings (models, sign-in kind) and projects, copied – everything else starts empty
  for (const f of ["settings.yaml", "projects.yaml"]) if (realHome && fs.existsSync(path.join(realHome, "config", f))) fs.copyFileSync(path.join(realHome, "config", f), path.join(home, "config", f));
  const cfg = await import("../core/config.js");
  cfg.updateSettings((s: any) => {
    s.engine = { version: "v2" };
    s.conductor = { ...(s.conductor ?? {}), ...(arg("tier") ? { tier: arg("tier") } : {}), ...(arg("effort") ? { effort: arg("effort") } : {}) };
    s.notifications = { ...s.notifications, primary: "inbox", fallback: [] };
    if (process.argv.includes("--mock")) s.models = { ...s.models, provider: "mock" };
  });
  const { db } = await import("../core/db.js");
  const { createTask, getTask } = await import("../engine/tasks.js");
  const { requestApproval } = await import("../approvals/approvals.js");
  const { setFocus, logChat } = await import("../notify/chatLog.js");
  const { ruleIntent, pastedSecret } = await import("../intake/teamsIntent.js");
  const { pendingItems } = await import("../conductor/tools.js");
  const { ADAPT } = await import("../engine/adapt.js");
  const { planTurn } = await import("../conductor/conductor.js");
  const projects = cfg.loadProjects();
  const back = projects.find((p) => /back/i.test(p.id))?.id ?? projects[0]?.id ?? "nue-backend";
  const front = projects.find((p) => /front/i.test(p.id))?.id ?? projects[1]?.id ?? "nue-frontend";

  const seed = () => {
    for (const t of ["tasks", "approvals", "chat_log", "jobs", "events", "directives", "notifications"]) { try { db().exec(`DELETE FROM ${t}`); } catch { /* table may not exist */ } }
    try { db().exec("DELETE FROM meta WHERE key LIKE 'chat.%' OR key LIKE 'conductor.%' OR key = 'paused_until'"); } catch { /* ignore */ }
    const mk = (o: any) => createTask({ source: "jira", sourceId: `eval-${o.sourceRef}`, title: o.title ?? o.sourceRef, kind: "assigned", ...o });
    for (const [key, title, prB, prF] of [["KAN-52", "[FR-019] Relevant questions only", 131, 90], ["KAN-40", "[FR-012] Seller onboarding form", 134, 95]] as const) {
      const lead = mk({ projectId: back, sourceRef: key, title, state: "DONE", data: { ticket: { key, title }, targets: [back, front] } });
      db().prepare("UPDATE tasks SET playbook='dev-lead' WHERE id=?").run(lead.id);
      mk({ projectId: back, sourceRef: `${key}@${back}`, title, kind: "part", state: "PR_OPEN", data: { leadId: lead.id, ticket: { key, title }, pr: { number: prB, repo: "acme/backend" }, ...(key === "KAN-52" ? { conflict: { state: "open", num: prB, base: "dev", files: ["app/services/questions.py", "app/api/v1/questions.py"] } } : {}) } });
      mk({ projectId: front, sourceRef: `${key}@${front}`, title, kind: "part", state: "PR_OPEN", data: { leadId: lead.id, ticket: { key, title }, pr: { number: prF, repo: "acme/frontend" } } });
    }
    mk({ projectId: back, sourceRef: `FIX-131@${back}`, title: "Fixes for acme/backend#131", kind: "pr_fix", state: "PAUSED", data: { fix: { repo: "acme/backend", num: 131, mode: "ci" } } });
    mk({ projectId: back, sourceRef: "KAN-76", title: "[FR-030] Bulk price update", state: "AWAITING_START", data: { ticket: { key: "KAN-76", title: "[FR-030] Bulk price update" } } });
    mk({ projectId: front, sourceRef: "KAN-54", title: "[FR-021] Correct a fact", state: "AWAITING_START", data: { ticket: { key: "KAN-54", title: "[FR-021] Correct a fact" } } });
  };

  const fixture = JSON.parse(fs.readFileSync(arg("cases") ?? fixturePath(), "utf8"));
  const only = arg("only")?.split(",");
  const cases: EvalCase[] = fixture.cases.filter((c: EvalCase) => !only || only.includes(c.id));
  const results: CaseResult[] = [];
  for (const k of cases) {
    seed();
    const s = k.setup ?? {};
    const fix = (r: string) => r.replace("@nue-backend", `@${back}`).replace("@nue-frontend", `@${front}`);
    if (s.approval) { const t = getTask(fix(s.approval.ref))!; db().prepare("UPDATE tasks SET state='AWAITING_APPROVAL' WHERE id=?").run(t.id); requestApproval(t.id, s.approval.action, {}); }
    if (s.question) { const t = getTask(fix(s.question.ref))!; db().prepare("UPDATE tasks SET state='NEEDS_INFO', data=json_set(data,'$.questions',json(?)) WHERE id=?").run(JSON.stringify(s.question.questions), t.id); }
    for (const [dir, text] of s.history ?? []) logChat(dir === "in" ? "in" : "out", fix(text));
    if (s.focus) setFocus(fix(s.focus));
    const text = fix(k.text);
    let via: CaseResult["via"] = "fast", calls: Call[] = [], cost = 0;
    const adapt = ADAPT.exec(text);
    if (pastedSecret(text)) { via = "special"; calls = [{ name: "secret" }]; }
    else if (adapt) { via = "special"; calls = [{ name: "adapt", ref: normRef(adapt[1]) }]; }
    else {
      const rule: any = ruleIntent(text, pendingItems(), true);
      if (rule && "reply" in rule) calls = [{ name: "reply" }];
      else if (rule && "option" in rule) calls = [{ name: rule.option.n === 1 ? "decide:approve" : rule.option.n === 2 ? "decide:reject" : "control:cancel", ref: normRef(rule.option.ref) }];
      else if (rule && "intent" in rule) calls = [{ name: FAST[rule.intent.intent] ?? rule.intent.intent, ref: rule.intent.ref ? normRef(rule.intent.ref) : undefined }];
      else {
        via = "conductor";
        const r = await planTurn(text);
        cost = r.costUsd;
        calls = r.calls.map((c) => canonical(c.tool, c.args as any));
        if (!r.ok) calls = [{ name: "error" }];
        else if (!calls.length) calls = [{ name: "reply" }];
      }
    }
    const kk = { ...k, expect: k.expect?.map(fix), all: k.all?.map(fix) };
    const j = judge(kk, calls);
    results.push({ id: k.id, text: k.text, via, calls, pass: j.pass, why: j.why, costUsd: cost });
    process.stderr.write(`${j.pass ? "✔" : "✖"} ${k.id} ${via}: ${calls.map(show).join(", ")}${j.why ? ` — ${j.why}` : ""}\n`);
  }
  const passed = results.filter((r) => r.pass).length;
  const out = { at: new Date().toISOString(), tier: arg("tier") ?? "default", effort: arg("effort") ?? "default", passed, total: results.length,
    rate: results.length ? Math.round((passed / results.length) * 1000) / 10 : 0, costUsd: Math.round(results.reduce((n, r) => n + r.costUsd, 0) * 1000) / 1000,
    byPath: { fast: results.filter((r) => r.via !== "conductor").length, conductor: results.filter((r) => r.via === "conductor").length,
      conductorPassed: results.filter((r) => r.via === "conductor" && r.pass).length }, misses: results.filter((r) => !r.pass) };
  process.stdout.write(JSON.stringify(out, null, 1));
}

if (process.argv[1] && /conductorEval\.js$/.test(process.argv[1])) {
  main().then(() => process.exit(0)).catch((e) => { process.stderr.write(`eval failed: ${e?.stack ?? e}\n`); process.exit(1); });
}
