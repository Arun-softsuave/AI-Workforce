import { testHome } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, AIW_HOME: testHome };
const aiw = (...args: string[]) => execFileSync(process.execPath, [path.join(dist, "cli", "aiw.js"), ...args], { encoding: "utf8", env });

test("CLI works without the service and reports setup progress", () => {
  aiw("model", "--provider", "mock");
  aiw("profile", "--name", "Dev", "--roles", "backend-developer");
  const setup = JSON.parse(aiw("setup", "--json"));
  assert.deepEqual(setup.recommended.recommended, ["jira", "github"]);
  assert.equal(setup.steps.find((s: any) => s.step === "profile").status, "done");
  assert.match(aiw("statusline"), /^AIW: /);
});

test("background service starts, serves the API with a token, and refuses requests without it", async () => {
  const child = spawn(process.execPath, [path.join(dist, "daemon", "main.js")], { env, stdio: "ignore" });
  try {
    let rt: any;
    for (let i = 0; i < 60 && !rt; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { rt = JSON.parse(fs.readFileSync(path.join(testHome, "runtime.json"), "utf8")); } catch { /* not yet */ }
    }
    assert.ok(rt, "runtime.json written");
    const base = `http://127.0.0.1:${rt.port}`;
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    const ok = await fetch(`${base}/api/status`, { headers: { "X-AIW-Token": rt.token } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).provider, "mock");
    assert.equal((await fetch(`${base}/?t=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/?t=${rt.token}`)).status, 200);
    const status = JSON.parse(aiw("status", "--json"));
    assert.equal(status.service.pid, rt.pid);
    const second = execFileSync(process.execPath, [path.join(dist, "daemon", "main.js")], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(second, "", "a second instance exits immediately (single-instance lock)");
  } finally {
    child.kill();
  }
});
