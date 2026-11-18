import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../core/db.js";
import { saveSettings, upsertProject, normaliseProject, getProject, DEFAULT_SETTINGS, type Settings } from "../core/config.js";
import { setSenders } from "../notify/router.js";
import { createTask, getTask, type Task } from "../engine/tasks.js";
import "../engine/steps.js";
import { makeAgentCaller, type StepCtx } from "../engine/steps.js";
import { FIX_STEPS } from "../engine/prFix.js";
import { requestApproval } from "../approvals/approvals.js";
import { ruleIntent, handleChatMessage } from "../intake/teamsIntent.js";
import { pendingItems } from "../conductor/tools.js";
import { redactSecrets } from "../notify/chatLog.js";
import { planNotes } from "../messenger/messenger.js";
import { resumeTask } from "../engine/engine.js";
import { checkBudget } from "../engine/budget.js";
import { createJob } from "../kernel/mailbox.js";

// 1.1.1: what the final audit of 1.1.0 found – each one fails without its fix.

const S = (patch: (s: Settings) => void = () => {}): Settings => {
  const s = { ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" }, engine: { version: "v2" }, notifications: { ...DEFAULT_SETTINGS.notifications, primary: "desktop", fallback: [], quietHours: "off" } } as Settings;
  patch(s); return s;
};
saveSettings(S());
const sent: { title: string; body: string }[] = [];
setSenders({ desktop: { send: async (n: any) => { sent.push({ title: n.title, body: n.body }); return undefined; } } } as any);
upsertProject(normaliseProject({ id: "shop", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "acme/shop", baseBranch: "main" }, local: { path: process.cwd() }, roles: ["backend-developer"] } as any));
let n = 0;
const item = (state: string, data: Record<string, any> = {}): Task => {
  const ref = `KAN-${500 + ++n}`;
  return createTask({ projectId: "shop", source: "jira", sourceId: `f111-${ref}`, sourceRef: ref, title: ref, kind: "assigned", state: state as any, data: { ticket: { key: ref, title: ref }, ...data } });
};

test("an approval made beside an open PR (push the fixes, conflict resolution) is answered by '1' / 'yes' in Teams", () => {
  const t = item("PR_OPEN", { pr: { number: 131, repo: "acme/shop" } });
  const ap = requestApproval(t.id, "push_fixes", {});
  assert.ok(pendingItems().approvals.some((x) => x.approval.id === ap.id), "listed as waiting for you");
  const r: any = ruleIntent("1");
  assert.equal(r?.option?.ref ?? r?.intent?.ref, t.source_ref);
  db().prepare("UPDATE approvals SET state='expired' WHERE id=?").run(ap.id);
});

test("a pasted GitHub, Slack, AWS or sk- key never stays in the chat history (and so never reaches a prompt)", () => {
  for (const s of ["ghp_abcdefghijklmnopqrstuvwxyz0123", "xoxb-1234567890-abcdefghij", "AKIAABCDEFGHIJKLMNOP", "sk-ant-abcdefghijklmnop1234", "github_pat_11ABCDEFG0123456789_abcdefghij"]) {
    const out = redactSecrets(`here it is: ${s} thanks`);
    assert.doesNotMatch(out, new RegExp(s.slice(0, 12)), out);
    assert.match(out, /\[key hidden\]/);
  }
  assert.equal(redactSecrets("resolve the conflicts on PR 131 yourself"), "resolve the conflicts on PR 131 yourself");
});

test("short Teams messages keep all they say: priority and rules go to the Conductor; 'fix these' uses the review findings; a bare 'fix PR N' fixes everything", () => {
  assert.equal(ruleIntent("start KAN-47 first, it's urgent"), undefined);
  assert.equal(ruleIntent("do KAN-45, only backend"), undefined);
  assert.equal((ruleIntent("start KAN-45") as any)?.intent?.intent, "start_ticket");
  assert.equal((ruleIntent("fix these on PR 140") as any)?.intent?.intent, "resolve_comments");
  assert.equal((ruleIntent("fix PR 150") as any)?.intent?.intent, "resolve_comments");
  assert.equal((ruleIntent("fix the CI on PR 134") as any)?.intent?.intent, "fix_ci");
});

test("plan notes (outside work, migration, no design) stay in the Teams message when it shows the design document's summary", () => {
  const body = "Add a limit\n\n**⚠️ Risks**\n- Database migration – I never run it on a shared database; check it before it runs there.\n\n**🧩 Outside these repositories (for a person)**\n- Set REFUND_LIMIT in production\n\n🎨 No design was given for this – I follow the existing screens' patterns.";
  const notes = planNotes(body);
  assert.equal(notes.length, 3);
  assert.match(notes.join("\n"), /Outside these repositories[\s\S]*REFUND_LIMIT[\s\S]*Database migration[\s\S]*No design was given/);
  assert.deepEqual(planNotes("Just a plan"), []);
});

test("D6: work paused because the code changed after your approval is refreshed on resume (not paused again)", () => {
  const t = item("PAUSED");
  db().prepare("UPDATE tasks SET playbook='dev-feature', step_index=20, error=? WHERE id=?").run("STALE: commit changed (aaaaaaa -> bbbbbbb)", t.id);
  requestApproval(t.id, "create_pr", {});
  const r = resumeTask(t.source_ref!)!;
  assert.equal(r.state, "QUEUED");
  assert.notEqual(r.step_index, 20, "back to the checks before the PR, which ask again");
});

test("E12: with the default settings (no budget stops) the 80% warning still comes – and the work never stops", () => {
  const t = item("RUNNING");
  const limit = getProject("shop")!.budget.perTaskTokens.M;
  db().prepare("UPDATE tasks SET size='M', tokens_used=? WHERE id=?").run(Math.ceil(limit * 0.85), t.id);
  const b = checkBudget(getProject("shop")!, getTask(t.id)!);
  assert.deepEqual([b.ok, b.warn], [true, true]);
});

test("'skip rule R9' / 'issues AUDIT-…' are answered in Teams (they were offered but never handled)", async () => {
  assert.match(await handleChatMessage("skip rule R9", "Sneha"), /no rule idea R9 waiting/);
  assert.match(await handleChatMessage("issues AUDIT-KAN-999", "Sneha"), /can't find the review AUDIT-KAN-999/);
});

test("the CI fix round limit holds on v2: after 3 pushed rounds since CI was last green, a 4th red result is handed to you", async () => {
  const t = item("PR_OPEN", { pr: { number: 77, repo: "acme/shop" } });
  for (let i = 0; i < 3; i++) {
    const j = createJob({ itemId: t.id, type: "ci_fix", recipe: "ci_fix", priority: 1, data: { ctx: { fixPublished: { pushed: `sha${i}` } } } } as any);
    db().prepare("UPDATE jobs SET state='done' WHERE id=?").run(j.id);
  }
  const now = createJob({ itemId: t.id, type: "ci_fix", recipe: "ci_fix", priority: 1, data: { events: [{ id: "e", type: "ci_failed", payload: { repo: "acme/shop", num: 77 } }] } } as any);
  db().prepare("UPDATE jobs SET state='running' WHERE id=?").run(now.id);
  const ctx = { task: { ...getTask(t.id)!, data: { ...getTask(t.id)!.data, fix: { repo: "acme/shop", num: 77, mode: "ci", ciRound: 1 } } }, project: getProject("shop")!, settings: S(), params: {}, usage: { tokensIn: 0, tokensOut: 0, cost: 0, agents: [] },
    save: (p: any) => { ctx.task = { ...ctx.task, data: { ...ctx.task.data, ...p } }; return ctx.task; } } as any as StepCtx;
  ctx.agent = makeAgentCaller(() => ctx);
  const before = sent.length;
  const r: any = await FIX_STEPS.fix_prepare(ctx);
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.match(r.note, /round limit \(3\)/);
  assert.ok(sent.slice(before).some((m) => /CI still red on PR #77/.test(m.title)));
});
