import { connectBot, say, sayFast, sayModel, script, item, stateOf, cloned, conductorCalls, sent } from "./teamsHarness.js";
import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../../core/db.js";
import { loadSettings, getProject } from "../../core/config.js";
import { getTask } from "../../engine/tasks.js";
import { logChat } from "../../notify/chatLog.js";
import { activeDirectives, effective } from "../../policy/directives.js";

/**
 * §12c situations handled in the Teams chat (wave 3): A9 A10 B5 B6 B17 B19 C10 J5 J6 J8 J10 J11 J13 M6.
 * Each message goes through the real poller; the Conductor's answer is scripted, the effects are real.
 */

test("setup", async () => { await connectBot(); });

test("J11: small talk and thanks get a short reply, no action and no model call", async () => {
  assert.match(await sayFast("thanks!"), /You're welcome/);
  assert.match(await sayFast("hi"), /^Hi 👋/);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM tasks").get() as any).n, 0, "nothing started");
});

test("B17: a ticket of a project that isn't set up says how to add it", async () => {
  assert.match(await sayFast("do OPS-12"), /OPS-12's project isn't set up\. Add it with `aiw project add`/);
  assert.equal(getTask("OPS-12"), undefined);
});

test("B5: someone else's ticket – asks first, never starts silently", async () => {
  assert.match(await sayFast("start KAN-60"), /KAN-60 is Priya's\. Take it over\?/);
  assert.match(await sayFast("no"), /nothing was done/);
  assert.equal(getTask("KAN-60"), undefined);
});

test("M6: a repository that isn't cloned – one question, cloned only after OK, then started", async () => {
  assert.match(await sayFast("start ADM-3"), /acme\/admin isn't on this computer\. Clone it/);
  assert.deepEqual(cloned, [], "nothing cloned before the OK");
  const r = await sayFast("yes");
  assert.deepEqual(cloned, ["https://github.com/acme/admin.git"]);
  assert.match(r, /On it – \*\*ADM-3\*\*/);
});

test("B6: a ticket in progress or with an open PR is never duplicated", async () => {
  item("KAN-45", "RUNNING");
  assert.match(await sayFast("plan for KAN-45"), /KAN-45 is already in progress/);
  item("KAN-98", "DONE", { pr: { url: "https://github.com/acme/shop/pull/98", number: 98, repo: "acme/shop" } });
  assert.match(await sayFast("plan for KAN-98"), /KAN-98 already has a PR/);
  assert.equal((db().prepare("SELECT COUNT(*) n FROM tasks WHERE source_ref IN ('KAN-45','KAN-98')").get() as any).n, 2);
});

test("B19: a priority sets the item's priority and says what it delays", async () => {
  const r = await sayModel("work on KAN-47 and KAN-48 today please – KAN-47 goes first, it's urgent for the release", { calls: [
    { tool: "start", args: { refs: ["KAN-47", "KAN-48"] } },
    { tool: "control", args: { action: "priority", ref: "KAN-47", priority: 1 } },
  ] });
  assert.match(r, /KAN-47 goes first\. It delays [^\n]*KAN-48/);
  assert.equal(getTask("KAN-47")!.priority, 1);
});

test("J5: a correction undoes the last start and starts the right ticket", async () => {
  assert.match(await sayFast("start KAN-63"), /On it – \*\*KAN-63\*\*/);
  const r = await sayModel("no, I meant KAN-64", { calls: [{ tool: "control", args: { action: "undo" } }, { tool: "start", args: { ref: "KAN-64" } }] });
  assert.match(r, /Undone – stopped KAN-63/);
  assert.equal(stateOf("KAN-63"), "CANCELLED");
  assert.equal(stateOf("KAN-64"), "DETECTED");
});

test("C10: a pasted secret is never taken; the vault command is given; the item keeps waiting", async () => {
  item("KAN-70", "NEEDS_INFO", { q: "Which STRIPE_WEBHOOK_SECRET should the webhook use?", options: ["The test one", "A new one"] });
  const secret = "whsec_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4";
  const r = await sayModel(secret, { calls: [{ tool: "decide", args: { decision: "answer", ref: "KAN-70", text: secret } }] });
  assert.match(r, /aiw secret set STRIPE_WEBHOOK_SECRET/);
  assert.equal(stateOf("KAN-70"), "NEEDS_INFO");
  assert.ok(!JSON.stringify(getTask("KAN-70")!.data).includes(secret), "the secret is not stored on the item");
});

test("J6: changing an instruction mid-way updates the running item's rule and is echoed once", async () => {
  item("KAN-61", "RUNNING");
  const a = await sayModel("no need to ask before the PR on KAN-61", { calls: [{ tool: "set_directive", args: { rule: "pr_approval", value: "skip", scope: "item", ref: "KAN-61" } }] });
  assert.match(a, /From now on for KAN-61: no PR approval\./);
  assert.equal(effective(getTask("KAN-61")!.id, "pr_approval").value, "skip");
  const b = await sayModel("actually ask me before the PR on KAN-61", { calls: [{ tool: "set_directive", args: { rule: "pr_approval", value: "ask", scope: "item", ref: "KAN-61" } }] });
  assert.match(b, /From now on for KAN-61: ask before the PR\./);
  assert.equal(effective(getTask("KAN-61")!.id, "pr_approval").value, "ask", "the newer rule replaces the older one");
  assert.equal(activeDirectives().filter((d) => d.rule === "pr_approval").length, 1);
});

test("A10: a preference change is stored and echoed once", async () => {
  const r = await sayModel("raise draft PRs from now on", { calls: [{ tool: "prefs", args: { key: "pr.draft", value: "true" } }] });
  assert.match(r, /^From now on: raise draft PRs\.$/);
  assert.equal(loadSettings().pr.draft, true);
});

test("A9: a teammate leaves – removed from the team and from the reviewer list", async () => {
  const r = await sayModel("Eric left the team", { calls: [{ tool: "prefs", args: { key: "team.remove", name: "Eric" } }] });
  assert.match(r, /Removed Eric/);
  assert.equal(loadSettings().team.members.some((m) => m.github === "eric-dev"), false);
  assert.deepEqual(getProject("shop")!.reviewers!.logins, ["sam-k"]);
});

test("J8: 'why did you …' is answered from the plan and history, without another model round", async () => {
  item("KAN-90", "AWAITING_APPROVAL", { plan: { summary: "Reuse the old validator because the new one rejects legacy refs" } });
  const n = conductorCalls.length;
  const r = await sayModel("why did you pick the old validator for KAN-90?", { calls: [{ tool: "explain", args: { ref: "KAN-90" } }] });
  assert.equal(conductorCalls.length - n, 1, "one model round");
  assert.match(r, /Reuse the old validator because the new one rejects legacy refs/);
});

test("J13: a follow-up on something days old – found in the history, then its status", async () => {
  item("KAN-47", "RUNNING");
  logChat("in", "please make the refund limit fix a priority", { taskRef: "KAN-47" });
  const msg = "what happened with that refund limit fix last week?";
  script(msg, (req) => req.prompt.includes("## Results of your read tools")
    ? { calls: [{ tool: "status", args: { ref: "KAN-47" } }], reply: "" }
    : { calls: [{ tool: "find", args: { query: "refund limit fix" } }], needResults: true });
  const n = conductorCalls.length;
  const r = await say(msg);
  assert.equal(conductorCalls.length - n, 2, "find, then status");
  assert.match(r, /KAN-47/);
});

test("J10: 'I'm back' gives one catch-up summary, no model call", async () => {
  const before = sent.length;
  const r = await sayFast("I'm back");
  assert.match(r, /^Welcome back 👋/);
  assert.equal(sent.length - before, 1, "one message");
});
