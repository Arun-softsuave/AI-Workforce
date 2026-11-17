import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRepo, sh } from "./helpers.js";
import {
  parsePytest, parseJest, parseVitest, parseNodeSpec, parseNodeTap, parseEslint, parseRuff, parseTsc,
  detect, compact, runTests, runLint, ciLog, gitDiffStat, runCompactTool, createCompactToolsServer, execCapped, TEXT_MAX, compactToolNames,
} from "../agents/tools/compact.js";

const PYTEST = `============================= test session starts ==============================
platform linux -- Python 3.12.1, pytest-8.0.0
collected 13 items

tests/test_refund.py ..F.s                                               [ 38%]
tests/test_pay.py .......F                                               [100%]

=================================== FAILURES ===================================
_______________________________ test_refund_zero _______________________________

    def test_refund_zero():
>       assert refund(0) == "rejected"
E       AssertionError: assert 'ok' == 'rejected'
E         - rejected
E         + ok
E         extra line

tests/test_refund.py:14: AssertionError
_____________________________ TestPay.test_limit _______________________________

self = <tests.test_pay.TestPay object at 0x7f>

    def test_limit(self):
>       pay(10**9)
E       ValueError: amount too large

app/pay.py:22: ValueError
=========================== short test summary info ============================
FAILED tests/test_refund.py::test_refund_zero - AssertionError: assert 'ok' == 'rejected'
FAILED tests/test_pay.py::TestPay::test_limit - ValueError: amount too large
=================== 2 failed, 10 passed, 1 skipped in 0.52s ====================
`;

const JEST = `PASS src/a.test.js
FAIL src/refund.test.js
  ● refund › rejects zero

    expect(received).toBe(expected) // Object.is equality

    Expected: "rejected"
    Received: "ok"

      10 |   it('rejects zero', () => {
    > 11 |     expect(refund(0)).toBe('rejected');
         |                       ^

      at Object.<anonymous> (src/refund.test.js:11:23)
      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 1 skipped, 5 passed, 7 total
Snapshots:   0 total
Time:        1.2 s
`;

const VITEST = ` ✓ src/a.test.ts (3 tests) 4ms
 ❯ src/refund.test.ts (2 tests | 1 failed) 6ms
   × refund > rejects zero 3ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/refund.test.ts > refund > rejects zero
AssertionError: expected 'ok' to be 'rejected' // Object.is equality

- Expected
+ Received

 ❯ src/refund.test.ts:5:23
      3| describe('refund', () => {
      4|   it('rejects zero', () => {
      5|     expect(refund(0)).toBe('rejected');
       |                       ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 4 passed (5)
   Start at  10:00:00
   Duration  300ms
`;

const NODE_SPEC = `✔ adds (0.5ms)
✖ refund rejects zero (1.2ms)
ℹ tests 3
ℹ suites 0
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 50.1

✖ failing tests:

test at file:///D:/repo/test/refund.test.js:5:1
✖ refund rejects zero (1.2ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  'ok' !== 'rejected'

      at TestContext.<anonymous> (file:///D:/repo/test/refund.test.js:6:10)
  {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
  }
`;

const NODE_TAP = `TAP version 13
# Subtest: adds
ok 1 - adds
  ---
  duration_ms: 0.5
  ...
# Subtest: refund rejects zero
not ok 2 - refund rejects zero
  ---
  duration_ms: 1.2
  location: '/repo/test/refund.test.js:5:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    'ok' !== 'rejected'
  code: 'ERR_ASSERTION'
  stack: |-
    TestContext.<anonymous> (/repo/test/refund.test.js:6:10)
  ...
1..2
# tests 2
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
`;

const ESLINT = `
/repo/src/refund.js
   3:7   error    'unused' is assigned a value but never used  no-unused-vars
  10:1   warning  Unexpected console statement                no-console

/repo/src/pay.js
  1:10  error  'x' is not defined  no-undef

✖ 3 problems (2 errors, 1 warning)
`;

const RUFF_CONCISE = `app/pay.py:3:8: F401 [*] \`os\` imported but unused
app/refund.py:12:1: E711 Comparison to \`None\` should be \`cond is None\`
Found 2 errors.
[*] 1 fixable with the \`--fix\` option.
`;

const RUFF_FULL = `F401 [*] \`os\` imported but unused
 --> app/pay.py:3:8
  |
3 | import os
  |        ^^
  |
help: Remove unused import: \`os\`

Found 1 error.
`;

const TSC = `src/pay.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/refund.ts:10:5 - error TS2304: Cannot find name 'refnd'.

10     refnd(id);
       ~~~~~

Found 2 errors in 2 files.
`;

test("pytest: counts, failures with file:line and first 3 message lines", () => {
  const c = parsePytest(PYTEST);
  assert.equal(c.tool, "pytest");
  assert.deepEqual([c.ok, c.passed, c.failed, c.skipped], [false, 10, 2, 1]);
  assert.equal(c.failures[0].name, "tests/test_refund.py::test_refund_zero");
  assert.equal(c.failures[0].file, "tests/test_refund.py");
  assert.equal(c.failures[0].line, 14);
  assert.equal(c.failures[0].message.split("\n").length, 3);
  assert.match(c.failures[0].message, /AssertionError/);
  assert.equal(c.failures[1].file, "app/pay.py");
  assert.equal(c.failures[1].line, 22);
  assert.match(c.text, /2 failed, 10 passed, 1 skipped/);
  assert.ok(c.text.length <= TEXT_MAX);
  assert.equal(detect(PYTEST)?.name, "pytest");
  const ok = parsePytest("....\n4 passed in 0.10s\n");
  assert.deepEqual([ok.ok, ok.passed, ok.failed], [true, 4, 0]);
});

test("jest: counts and failure location outside node_modules", () => {
  const c = parseJest(JEST);
  assert.deepEqual([c.ok, c.passed, c.failed, c.skipped], [false, 5, 1, 1]);
  assert.equal(c.failures[0].name, "refund › rejects zero");
  assert.equal(c.failures[0].file, "src/refund.test.js");
  assert.equal(c.failures[0].line, 11);
  assert.match(c.failures[0].message, /toBe/);
  assert.ok(!/node_modules/.test(c.text));
  assert.equal(detect(JEST)?.name, "jest");
});

test("vitest: counts and failure location", () => {
  const c = parseVitest(VITEST);
  assert.deepEqual([c.ok, c.passed, c.failed], [false, 4, 1]);
  assert.equal(c.failures.length, 1);
  assert.equal(c.failures[0].name, "refund > rejects zero");
  assert.equal(c.failures[0].file, "src/refund.test.ts");
  assert.equal(c.failures[0].line, 5);
  assert.match(c.failures[0].message, /expected 'ok' to be 'rejected'/);
  assert.equal(detect(VITEST)?.name, "vitest");
});

test("node --test spec and tap", () => {
  const s = parseNodeSpec(NODE_SPEC);
  assert.deepEqual([s.ok, s.passed, s.failed], [false, 2, 1]);
  assert.equal(s.failures[0].name, "refund rejects zero");
  assert.equal(s.failures[0].file, "D:/repo/test/refund.test.js");
  assert.equal(s.failures[0].line, 5);
  assert.match(s.failures[0].message, /strictly equal/);
  assert.equal(detect(NODE_SPEC)?.name, "node-spec");

  const t = parseNodeTap(NODE_TAP);
  assert.deepEqual([t.ok, t.passed, t.failed], [false, 1, 1]);
  assert.equal(t.failures[0].name, "refund rejects zero");
  assert.equal(t.failures[0].file, "/repo/test/refund.test.js");
  assert.equal(t.failures[0].line, 5);
  assert.match(t.failures[0].message, /strictly equal[\s\S]*'ok' !== 'rejected'/);
  assert.equal(detect(NODE_TAP)?.name, "node-tap");
});

test("eslint stylish: errors as failures, warnings counted", () => {
  const c = parseEslint(ESLINT);
  assert.deepEqual([c.ok, c.failed, c.warnings], [false, 2, 1]);
  assert.deepEqual(c.failures.map((f) => [f.name, f.file, f.line]), [["no-unused-vars", "/repo/src/refund.js", 3], ["no-undef", "/repo/src/pay.js", 1]]);
  assert.match(c.text, /2 errors, 1 warning/);
  assert.equal(detect(ESLINT)?.name, "eslint");
});

test("ruff concise and full formats", () => {
  const a = parseRuff(RUFF_CONCISE);
  assert.deepEqual([a.ok, a.failed], [false, 2]);
  assert.deepEqual([a.failures[0].name, a.failures[0].file, a.failures[0].line], ["F401", "app/pay.py", 3]);
  assert.equal(detect(RUFF_CONCISE)?.name, "ruff");
  const b = parseRuff(RUFF_FULL);
  assert.deepEqual([b.failed, b.failures[0].file, b.failures[0].line], [1, "app/pay.py", 3]);
  assert.equal(detect(RUFF_FULL)?.name, "ruff");
  assert.equal(parseRuff("All checks passed!\n").ok, true);
});

test("tsc: both output styles", () => {
  const c = parseTsc(TSC);
  assert.deepEqual([c.ok, c.failed], [false, 2]);
  assert.deepEqual(c.failures.map((f) => [f.name, f.file, f.line]), [["TS2322", "src/pay.ts", 3], ["TS2304", "src/refund.ts", 10]]);
  assert.equal(detect(TSC)?.name, "tsc");
});

test("text stays under the limit with many failures; unknown output uses the exit code", () => {
  const many = Array.from({ length: 200 }, (_, i) => `FAILED tests/test_x.py::test_${i} - AssertionError: ${"x".repeat(80)}`).join("\n") + "\n200 failed in 1.00s\n";
  const c = parsePytest(many);
  assert.equal(c.failed, 200);
  assert.ok(c.text.length <= TEXT_MAX);
  assert.match(c.text, /…and \d+ more/);
  const g = compact("something broke\nError: disk full\nbye", 2);
  assert.equal(g.ok, false);
  assert.match(g.text, /exit code 2/);
  assert.match(g.text, /First error: Error: disk full/);
  assert.equal(compact("all good", 0).ok, true);
  // a parser that saw no failures but the command failed
  const p = compact("....\n4 passed in 0.10s\nINTERNALERROR coverage below minimum", 1);
  assert.equal(p.ok, false);
});

test("ciLog: failing step, first error and file:line", () => {
  const log = [
    "2026-11-17T10:00:00.0000000Z ##[group]Run actions/checkout@v4",
    "2026-11-17T10:00:01.0000000Z ##[endgroup]",
    "2026-11-17T10:00:02.0000000Z ##[group]Run npm run lint",
    "2026-11-17T10:00:02.1000000Z ##[endgroup]",
    "2026-11-17T10:00:03.0000000Z all fine",
    "2026-11-17T10:00:04.0000000Z ##[group]Run python -m pytest -q",
    "2026-11-17T10:00:04.1000000Z python -m pytest -q",
    "2026-11-17T10:00:04.2000000Z shell: /usr/bin/bash -e {0}",
    "2026-11-17T10:00:04.3000000Z ##[endgroup]",
    ...PYTEST.split("\n").map((l) => `2026-11-17T10:00:05.0000000Z ${l}`),
    "2026-11-17T10:00:06.0000000Z ##[error]Process completed with exit code 1.",
  ].join("\n");
  const x = ciLog(log);
  assert.equal(x.step, "python -m pytest -q");
  assert.equal(x.file, "tests/test_refund.py");
  assert.equal(x.line, 14);
  assert.equal(x.summary?.failed, 2);
  assert.match(x.text, /Failing step: python -m pytest -q/);
  assert.ok(x.text.length <= TEXT_MAX);
  const y = ciLog("##[group]Run tsc --noEmit\n##[endgroup]\n##[error]src/pay.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n##[error]Process completed with exit code 2.");
  assert.equal(y.step, "tsc --noEmit");
  assert.match(y.error ?? "", /TS2322/);
  assert.equal(y.file, "src/pay.ts");
  assert.equal(ciLog("").text, "No log available for this check.");
});

test("runTests / runLint run a real command and compact its output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiw-compact-"));
  fs.writeFileSync(path.join(dir, "t.test.mjs"), [
    "import { test } from 'node:test';", "import assert from 'node:assert/strict';",
    "test('adds', () => assert.equal(1 + 1, 2));", "test('breaks', () => assert.equal(1, 2));",
  ].join("\n"));
  const r = await runTests(dir, `"${process.execPath}" --test --test-reporter=spec t.test.mjs`);
  assert.equal(r.ok, false);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.failures[0].name, "breaks");
  assert.match(r.failures[0].file ?? "", /t\.test\.mjs$/);
  assert.ok(!r.text.includes(dir), "paths are relative to the working directory");
  const ok = await runLint(dir, `"${process.execPath}" -e "console.log('clean')"`);
  assert.equal(ok.ok, true);
  // time limit and output cap
  const slow = await runTests(dir, `"${process.execPath}" -e "setTimeout(()=>{}, 20000)"`, { timeoutMs: 500 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.ok, false);
  const big = await execCapped(`"${process.execPath}" -e "process.stdout.write('a'.repeat(300000)+'END')"`, dir, { maxBytes: 20_000 });
  assert.equal(big.truncated, true);
  assert.ok(big.output.length < 30_000);
  assert.ok(big.output.endsWith("END"));
});

test("gitDiffStat and the compact tools", async () => {
  const { repo } = makeRepo("compact-repo");
  const base = sh(repo, "rev-parse", "HEAD");
  fs.appendFileSync(path.join(repo, "src", "app.ts"), "export const a = 1;\nexport const b = 2;\n");
  sh(repo, "commit", "-qam", "change");
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "x\ny\n");
  const d = gitDiffStat(repo, base);
  assert.equal(d.files.length, 2);
  assert.equal(d.added, 4);
  assert.match(d.text, /2 files changed, \+4 -0/);
  assert.match(d.text, /src\/new\.ts \(new, not added yet\)/);

  const profile = { testCommand: `"${process.execPath}" -e "console.log('1 passed in 0.01s')"`, base, lintCommands: [`"${process.execPath}" -e "process.exit(0)" {js}`, "never-runs {py}"] };
  const t = await runCompactTool("run_tests", { files: ["../etc/passwd", "--evil", "src/app.ts"] }, repo, profile);
  assert.equal(t.isError, false);
  assert.match(t.text, /pytest: 0 failed, 1 passed/);
  assert.match(t.text, /2 file names were left out/);
  const l = await runCompactTool("run_lint", {}, repo, profile);
  assert.match(l.text, /: OK/);
  assert.ok(!/never-runs/.test(l.text));
  assert.match((await runCompactTool("git_diff_stat", {}, repo, profile)).text, /2 files changed/);
  assert.equal((await runCompactTool("run_tests", {}, repo, {})).isError, true);
  assert.match((await runCompactTool("run_lint", {}, repo, {})).text, /No lint/);

  const server = await createCompactToolsServer(repo, profile);
  assert.equal(server.type, "sdk");
  assert.equal(server.name, "aiw_compact");
  assert.deepEqual(compactToolNames(), ["mcp__aiw_compact__run_tests", "mcp__aiw_compact__run_lint", "mcp__aiw_compact__git_diff_stat"]);
});
