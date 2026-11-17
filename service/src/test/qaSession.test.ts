import { makeRepo } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { saveSettings, DEFAULT_SETTINGS, upsertProject, normaliseProject, getProject } from "../core/config.js";
import { setSecret, getSecret } from "../core/secrets.js";
import { totp, jwtSecondsLeft, getSession, parseTokenInput, saveSession } from "../engine/qaSession.js";
import { redactSecrets } from "../notify/chatLog.js";

/**
 * Signing in for the live local app: saved session → renewed with the refresh token (no MFA) → demo login answering
 * MFA with the authenticator secret → otherwise a reason (the caller asks once in Teams and goes on "not tested").
 */
saveSettings({ ...structuredClone(DEFAULT_SETTINGS), models: { ...DEFAULT_SETTINGS.models, provider: "mock" } });
const jwt = (expInSeconds: number, tag = "a") => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: tag, exp: Math.floor(Date.now() / 1000) + expInSeconds })).toString("base64url")}.c2lnbmF0dXJlc2lnbmF0dXJl`;

// a backend like nue's: /auth/login → mfa_token, /auth/mfa/verify (TOTP) → session cookies, /auth/refresh → new pair
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const calls: string[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push(req.url!);
    const b = body ? JSON.parse(body) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/auth/login") return res.end(JSON.stringify({ data: { mfa_required: true, method: "totp", mfa_token: "mfa-123" } }));
    if (req.url === "/api/v1/auth/mfa/verify") {
      if (b.mfa_token !== "mfa-123" || b.code !== totp(SECRET)) { res.statusCode = 401; return res.end("{}"); }
      res.setHeader("Set-Cookie", [`nue_api_access_token=${jwt(3600, "mfa")}; HttpOnly`, "nue_api_refresh_token=refresh-1; HttpOnly"]);
      return res.end(JSON.stringify({ data: { access_token: jwt(3600, "mfa"), user: {} } }));
    }
    if (req.url === "/api/v1/auth/refresh") {
      if (b.refresh_token !== "refresh-1") { res.statusCode = 401; return res.end("{}"); }
      res.setHeader("Set-Cookie", ["nue_api_refresh_token=refresh-2; HttpOnly"]);
      return res.end(JSON.stringify({ data: { access_token: jwt(3600, "renewed") } }));
    }
    res.statusCode = 404; res.end("{}");
  });
});
const ready = new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port)));

const { repo: be } = makeRepo("be");
const { repo: fe } = makeRepo("fe");
upsertProject(normaliseProject({ id: "be", group: "g", local: { path: be }, roles: [], qa: { profile: { login: { emailVar: "E2E_EMAIL", passwordVar: "E2E_PASSWORD", path: "/auth/login", refreshPath: "/auth/refresh", mfaPath: "/auth/mfa/verify", mfaTokenField: "mfa_token", mfaCodeField: "code", accessCookie: "nue_api_access_token", refreshCookie: "nue_api_refresh_token" } } } }));
upsertProject(normaliseProject({ id: "fe", group: "g", local: { path: fe }, roles: [] }));

test.after(() => server.close());

test("authenticator codes (RFC 6238 test vector) and token helpers", () => {
  assert.equal(totp(SECRET, 59_000), "287082");
  assert.equal(totp(SECRET, 1111111109_000), "081804");
  assert.ok(jwtSecondsLeft(jwt(600))! > 590);
  assert.equal(jwtSecondsLeft("not-a-jwt"), undefined);
  assert.deepEqual(parseTokenInput(`${jwt(60, "x")} refresh-xyz-0123456789-abcdefgh`)?.refresh, "refresh-xyz-0123456789-abcdefgh");
  assert.equal(parseTokenInput(JSON.stringify({ data: { access_token: "a".repeat(30), refresh_token: "r".repeat(30) } }))?.refresh, "r".repeat(30));
});

test("no session and no demo account: a reason, nothing called", async () => {
  const api = `http://127.0.0.1:${await ready}/api/v1`;
  const r = await getSession(getProject("fe")!, getProject("be")!, api, undefined);
  assert.ok("reason" in r && /no saved session and no demo account/.test(r.reason));
  assert.equal(calls.length, 0);
});

test("demo login with MFA: the authenticator code is computed, the session saved and reused", async () => {
  const api = `http://127.0.0.1:${await ready}/api/v1`;
  const account = { email: "qa-demo@example.com", password: "pw" };
  const noTotp = await getSession(getProject("fe")!, getProject("be")!, api, account);
  assert.ok("reason" in noTotp && /authenticator secret/.test(noTotp.reason), "without the secret it says what is missing");
  setSecret("qa.fe.totp", SECRET);
  const s = await getSession(getProject("fe")!, getProject("be")!, api, account);
  assert.ok(!("reason" in s));
  if (!("reason" in s)) { assert.equal(s.via, "the demo account with its authenticator code"); assert.equal(s.refresh, "refresh-1"); }
  assert.match(getSecret("qa.fe.session")!, /refresh-1/, "saved in the vault");
  calls.length = 0;
  const again = await getSession(getProject("fe")!, getProject("be")!, api, account);
  assert.ok(!("reason" in again) && again.via === "the saved session");
  assert.equal(calls.length, 0, "a valid saved session is reused – no login, no MFA");
});

test("an expired session is renewed with the refresh token – no MFA", async () => {
  const api = `http://127.0.0.1:${await ready}/api/v1`;
  saveSession("fe", jwt(-60), "refresh-1");
  calls.length = 0;
  const s = await getSession(getProject("fe")!, getProject("be")!, api, undefined);
  assert.ok(!("reason" in s) && s.via === "the saved session, renewed");
  assert.deepEqual(calls, ["/api/v1/auth/refresh"]);
  assert.match(getSecret("qa.fe.session")!, /refresh-2/, "the new refresh token is kept");
});

test("tokens and keys are blanked in the chat history", () => {
  const t = redactSecrets(`qa token ${jwt(60)} refresh-abc`);
  assert.equal(t, "qa token [hidden]");
  assert.equal(redactSecrets("SET AWS_SECRET_ACCESS_KEY=abcdef123"), "SET AWS_SECRET_ACCESS_KEY=[hidden]");
  assert.match(redactSecrets(`here ${jwt(60)} done`), /here \[token hidden\] done/);
  assert.equal(redactSecrets("plan for KAN-42"), "plan for KAN-42");
});

test("long secrets (cloud session tokens) are split over several vault entries and joined back", async () => {
  const { deleteSecret } = await import("../core/secrets.js");
  const long = "x".repeat(2600) + "END";
  setSecret("qa.fe.env", long);
  assert.equal(getSecret("qa.fe.env"), long);
  setSecret("qa.fe.env", "short");
  assert.equal(getSecret("qa.fe.env"), "short", "old parts are removed when the value gets shorter");
  deleteSecret("qa.fe.env");
  assert.equal(getSecret("qa.fe.env"), undefined);
});
