// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { check, parseLedger } from "../scripts/check-ported-tests.js";
import { statusOf, type TestName } from "../scripts/test-names-reporter.js";

const RAN: TestName[] = [
  { file: "packages/core/test/a.test.ts", name: "reads a link", status: "pass" },
  { file: "packages/core/test/a.test.ts", name: "suite > nested case", status: "pass" },
  { file: "packages/core/test/b.test.ts", name: "is skipped", status: "skip" },
  { file: "packages/core/test/b.test.ts", name: "fails", status: "fail" },
];

const GOOD = `# W1: store
python-baseline: 26d66d75de2f8100cbb62bcda0a25fdde1e8682c

teams/tests/test_store.py::test_link -> packages/core/test/a.test.ts::reads a link
teams/tests/test_store.py::test_nested -> MERGED packages/core/test/a.test.ts::suite > nested case
teams/tests/test_store.py::test_internal_thing -> INTERNAL
teams/tests/test_store.py::test_old -> DROPPED: the column no longer exists
`;

test("a well-formed ledger whose tests all passed is clean, and its destinations are counted", () => {
  const errors: string[] = [];
  const ledger = parseLedger("w1.txt", GOOD, errors);
  assert.deepEqual(errors, []);
  assert.equal(ledger.baseline, "26d66d75de2f8100cbb62bcda0a25fdde1e8682c");
  const report = check([ledger], RAN);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.counts, { "w1.txt": { ported: 1, merged: 1, internal: 1, dropped: 1 } });
});

test("a named test that did not run, was skipped or failed is an error", () => {
  const errors: string[] = [];
  const ledger = parseLedger(
    "w2.txt",
    `python-baseline: abcdef1
teams/tests/t.py::test_a -> packages/core/test/a.test.ts::not there
teams/tests/t.py::test_b -> packages/core/test/b.test.ts::is skipped
teams/tests/t.py::test_c -> MERGED packages/core/test/b.test.ts::fails
teams/tests/t.py::test_d -> packages/core/test/zz.test.ts::reads a link
`,
    errors,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(check([ledger], RAN).errors, [
    "w2.txt:2: packages/core/test/a.test.ts::not there did not run",
    "w2.txt:3: packages/core/test/b.test.ts::is skipped did not pass (skip)",
    "w2.txt:4: packages/core/test/b.test.ts::fails did not pass (fail)",
    "w2.txt:5: packages/core/test/zz.test.ts::reads a link did not run",
  ]);
});

test("malformed lines, a missing baseline and a Python id listed twice are errors", () => {
  const errors: string[] = [];
  parseLedger(
    "w3.txt",
    `teams/tests/t.py::test_a -> INTERNAL
teams/tests/t.py::test_b -> DROPPED:
teams/tests/t.py::test_c -> somewhere
not an entry at all
teams/tests/t.py::test_d -> packages/core/test/a.test.ts
`,
    errors,
  );
  assert.deepEqual(errors, [
    'w3.txt:1: the first line must be "python-baseline: <sha>"',
    'w3.txt:2: the first line must be "python-baseline: <sha>"',
    'w3.txt:3: the first line must be "python-baseline: <sha>"',
    'w3.txt:4: the first line must be "python-baseline: <sha>"',
    'w3.txt:5: the first line must be "python-baseline: <sha>"',
    "w3.txt: no python-baseline line",
  ]);
  const errors2: string[] = [];
  parseLedger(
    "w4.txt",
    `python-baseline: abcdef1
teams/tests/t.py::test_b -> DROPPED:
teams/tests/t.py::test_c -> somewhere
not an entry at all
teams/tests/t.py::test_d -> packages/core/test/a.test.ts
`,
    errors2,
  );
  assert.deepEqual(errors2, [
    "w4.txt:2: DROPPED needs a reason",
    'w4.txt:3: not a destination: "somewhere"',
    "w4.txt:4: not an entry",
    'w4.txt:5: not a destination: "packages/core/test/a.test.ts"',
  ]);
  const one = parseLedger("a.txt", "python-baseline: abcdef1\nteams/tests/t.py::test_x -> INTERNAL\n", []);
  const two = parseLedger("b.txt", "python-baseline: abcdef1\nteams/tests/t.py::test_x -> INTERNAL\n", []);
  assert.deepEqual(check([one, two], RAN).errors, ["b.txt:2: teams/tests/t.py::test_x is already listed at a.txt:2"]);
});

test("the reporter lists skipped and todo tests as such, whatever event ended them", () => {
  const base = { name: "x", nesting: 0, details: {} };
  assert.equal(statusOf("test:pass", base), "pass");
  assert.equal(statusOf("test:fail", base), "fail");
  assert.equal(statusOf("test:pass", { ...base, skip: true }), "skip");
  assert.equal(statusOf("test:pass", { ...base, skip: "reason" }), "skip");
  assert.equal(statusOf("test:pass", { ...base, todo: true }), "todo");
  assert.equal(statusOf("test:fail", { ...base, skip: false, todo: false }), "fail");
});
