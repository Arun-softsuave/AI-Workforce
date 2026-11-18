import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../core/db.js";
import { saveSettings, upsertProject, normaliseProject, DEFAULT_SETTINGS, type Settings } from "../core/config.js";
import { clients } from "../connectors/registry.js";
import { createTask, getTask, type Task } from "../engine/tasks.js";
import "../engine/steps.js";
import { mergeMessages } from "../engine/steps/rebase.js";
import { refreshTask } from "../engine/engine.js";
import { requestApproval } from "../approvals/approvals.js";
import { ruleIntent, pastedSecret, handleChatMessage } from "../intake/teamsIntent.js";
import { runTool } from "../conductor/tools.js";
import { pollCi } from "../intake/intake.js";
import { routeEvents, type RouteDeps } from "../kernel/reactions.js";
import { getPlaybook, stepIndex } from "../engine/playbooks.js";

// 1.0.5: the bugs the 18 Nov audit confirmed – each one fails without its fix.

const S = (patch: (s: Settings) => void = () => {}): Settings => {
  const s: Settings = { ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" }, engine: { version: "v2" } } as Settings;
  patch(s); return s;
};
saveSettings(S());
upsertProject(normaliseProject({ id: "nue-backend", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "o/back", baseBranch: "dev" },
  local: { path: process.cwd() }, roles: ["fullstack-developer"] } as any));
upsertProject(normaliseProject({ id: "nue-frontend", jira: { site: "acme.atlassian.net", keys: ["KAN"] }, github: { repo: "o/front", baseBranch: "dev" },
  local: { path: process.cwd() }, roles: ["fullstack-developer", "devops-engineer"] } as any));

let n = 0;
const task = (o: Partial<Parameters<typeof createTask>[0]> & { state: string; data?: Record<string, any> }): Task => {
  const key = o.sourceRef ?? `KAN-${700 + ++n}`;
  return createTask({ projectId: "nue-backend", source: "jira", sourceId: `id-${key}-${n}`, sourceRef: key, title: key, kind: "assigned", ...o, state: o.state as any,
    data: { ticket: { key: key.split("@")[0], title: key }, ...(o.data ?? {}) } });
};
const commands = (itemId: string) => (db().prepare("SELECT payload FROM events WHERE type='user_command' AND item_id=?").all(itemId) as any[]).map((r) => JSON.parse(r.payload).command);

test("bug 2: the merge commit uses the team's commit convention, then a plain Conventional Commit – never git's default", () => {
  const conv = { conventions: { commitTemplate: "{type}({scope}): {summary} {key}" } } as any;
  const t = { source_ref: "KAN-52@nue-frontend", data: { ticket: { key: "KAN-52" } } };
  const m = mergeMessages(conv, t, "dev", "feat/KAN-52-x");
  assert.equal(m[0], "chore(core): merge dev into feat/KAN-52-x KAN-52");
  assert.equal(m[1], "chore: merge dev into feat/KAN-52-x");
  // a PR item has no ticket key: no "PR-90" in the message
  const pr = mergeMessages({ conventions: undefined } as any, { source_ref: "PR-90@nue-frontend", data: {} }, "dev", "b");
  assert.ok(pr.every((x) => !/PR-90/.test(x)), pr.join(" | "));
  assert.ok(pr.every((x) => !/^Merge /.test(x)));
});

test("bug 1: 'KAN-52@nue-backend' acts on that repository's PR only, not on every part", async () => {
  const lead = task({ state: "DONE", sourceRef: "KAN-552" });
  db().prepare("UPDATE tasks SET playbook='dev-lead' WHERE id=?").run(lead.id);
  const back = createTask({ projectId: "nue-backend", source: "jira", sourceId: "p-back", sourceRef: "KAN-552@nue-backend", title: "b", kind: "part", state: "PR_OPEN", data: { leadId: lead.id, pr: { number: 131, repo: "o/back" } } });
  const front = createTask({ projectId: "nue-frontend", source: "jira", sourceId: "p-front", sourceRef: "KAN-552@nue-frontend", title: "f", kind: "part", state: "PR_OPEN", data: { leadId: lead.id, pr: { number: 90, repo: "o/front" } } });
  const r = await runTool({ tool: "fix_pr", args: { ref: "KAN-552@nue-backend", mode: "rebase" } } as any, { who: "Sneha", original: "bring dev into KAN-552@nue-backend" } as any);
  assert.equal(r.ok, true, r.reply);
  assert.deepEqual(commands(back.id), ["rebase"]);
  assert.deepEqual(commands(front.id), [], "the frontend PR is left alone");
});

test("bug 9: 'rebase' for a ticket whose PR item is paused (not PR_OPEN) is done, never 'Which PR?'", async () => {
  const t = task({ state: "PAUSED", data: { pr: { number: 95, repo: "o/back" } } });
  const r = await runTool({ tool: "fix_pr", args: { ref: t.source_ref, mode: "rebase" } } as any, { who: "Sneha", original: `bring dev into ${t.source_ref}` } as any);
  assert.doesNotMatch(r.reply, /Which PR/);
  assert.deepEqual(commands(t.id), ["rebase"]);
});

test("bug 4: a stale PLAN approval goes back to its own step (never straight to publishing); a stale PR approval to prepublish", () => {
  const pb = getPlaybook("dev-feature");
  const planAt = stepIndex(pb, "plan_gate") >= 0 ? stepIndex(pb, "plan_gate") : 3;
  const a = task({ state: "STALE" });
  db().prepare("UPDATE tasks SET playbook='dev-feature', step_index=? WHERE id=?").run(planAt, a.id);
  requestApproval(a.id, "implement_plan", {});
  refreshTask(a.id);
  assert.equal(getTask(a.id)!.step_index, planAt, "the plan step asks again");
  assert.equal(getTask(a.id)!.state, "QUEUED");
  const b = task({ state: "STALE" });
  db().prepare("UPDATE tasks SET playbook='dev-feature', step_index=? WHERE id=?").run(planAt + 4, b.id);
  requestApproval(b.id, "create_pr", {});
  refreshTask(b.id);
  assert.equal(getTask(b.id)!.step_index, stepIndex(pb, "prepublish"));
});

test("bug 5: 'no, I meant KAN-47' while another ticket waits is a correction for the Conductor, not a reject of the waiting one", () => {
  const waiting = task({ state: "AWAITING_APPROVAL" });
  requestApproval(waiting.id, "implement_plan", {});
  const other = task({ state: "QUEUED" });
  const r = ruleIntent(`no, I meant ${other.source_ref}`);
  assert.equal(r, undefined, JSON.stringify(r));
  // a plain "no, use the existing validator" still goes to the waiting item
  const r2: any = ruleIntent("no, use the existing validator");
  assert.equal(r2?.intent?.intent, "reject");
  db().prepare("UPDATE tasks SET state='CANCELLED' WHERE id=?").run(waiting.id);
  db().prepare("UPDATE approvals SET state='expired' WHERE task_id=?").run(waiting.id);
});

test("bug 6: on engine v2 the old CI poller leaves the plugin's own PR branches to the kernel (no second DevOps task)", async () => {
  const asked: string[][] = [];
  const old = clients.github;
  clients.github = (() => ({ failedRuns: async (_r: string, _s: string, b?: string[]) => { asked.push(b ?? []); return []; } })) as any;
  try { await pollCi(); } finally { clients.github = old; }
  assert.deepEqual(asked, [["dev"]], "only the base branch of the DevOps project; nothing for aiw/*");
  saveSettings(S((s) => { (s as any).engine = { version: "v1" }; }));
  asked.length = 0;
  clients.github = (() => ({ failedRuns: async (_r: string, _s: string, b?: string[]) => { asked.push(b ?? []); return []; } })) as any;
  try { await pollCi(); } finally { clients.github = old; saveSettings(S()); }
  assert.deepEqual(asked, [["aiw/*"], ["dev", "aiw/*"]]);
});

test("bug 7: a pasted secret is never read, kept or acted on; the reply asks to revoke it and names the safe command", async () => {
  assert.equal(pastedSecret("here is the key ghp_abcdefghijklmnopqrstuvwxyz0123456789"), true);
  assert.equal(pastedSecret("STRIPE_SECRET_KEY=sk_live_51HxYzAbCdEf"), true);
  assert.equal(pastedSecret("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"), true);
  assert.equal(pastedSecret("review https://github.com/NueMarketplaceInc/nue-marketplace-backend/pull/131"), false);
  assert.equal(pastedSecret("resolve the conflicts on PR 131 yourself"), false);
  const reply = await handleChatMessage("KAN-701 the password is STRIPE_SECRET_KEY=sk_live_51HxYzAbCdEf", "Sneha");
  assert.match(reply, /revoke or rotate/);
  assert.match(reply, /aiw secret set NAME/);
  assert.doesNotMatch(reply, /sk_live/);
});

test("bug 10: a two-repo part the old engine ended at DONE is reopened when its PR is merged, so close-out runs", () => {
  const part = task({ state: "DONE", data: { pr: { number: 90, repo: "o/front" } } });
  const reopened: string[] = [];
  const ev = { id: "e-merge", type: "pr_merged", idem_key: "m1", item_id: part.id, project_id: "nue-backend", source_ref: null, payload: { ours: true }, handled_by: null, received_at: new Date().toISOString(), processed_at: null };
  const deps: RouteDeps = {
    pendingEvents: () => [ev as any], markHandled: () => {}, getItem: () => ({ ...getTask(part.id)!, level: "ticket", owner: "me" }) as any,
    enqueue: () => undefined, setItemState: () => {},
    reopenForOpenPr: (id: string) => { reopened.push(id); return { ...getTask(id)!, state: "PR_OPEN", level: "ticket", owner: "me" } as any; },
  } as any;
  routeEvents(S(), deps);
  assert.deepEqual(reopened, [part.id]);
});
