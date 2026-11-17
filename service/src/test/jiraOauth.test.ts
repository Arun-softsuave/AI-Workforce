import "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { registerJiraMcpFactory, createJiraClient, type JiraClient } from "../connectors/jira.js";
import { recordJiraOAuth, clients } from "../connectors/registry.js";
import { setSecret, getSecret } from "../core/secrets.js";

test("Jira uses the browser sign-in (Atlassian MCP) once connected that way, and drops the old API token", async () => {
  setSecret("jira.token", "old-api-token");
  const calls: string[] = [];
  registerJiraMcpFactory((site, cloudId) => ({
    site, myself: async () => { calls.push(`myself@${cloudId}`); return { accountId: "a1", displayName: "Sneha S" }; },
    search: async () => [], getIssue: async () => undefined, addComment: async () => {},
  } as JiraClient));
  recordJiraOAuth("nuemarketplaceinc.atlassian.net", "cloud-123", "Sneha S (a1)", "sneha@example.com");
  assert.equal(getSecret("jira.token"), undefined, "unused API token removed");
  const j = createJiraClient()!;
  assert.equal((await j.myself()).displayName, "Sneha S");
  assert.deepEqual(calls, ["myself@cloud-123"]);
  assert.ok(clients.jira(), "the regular Jira entry point returns the sign-in based client");
});
