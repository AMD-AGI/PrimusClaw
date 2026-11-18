// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { hasControl, pySplitlines } from "../../src/text/py-text.js";

const CASES = (
  JSON.parse(
    readFileSync(new URL("../../../../test-support/data/py-splitlines-cases.json", import.meta.url), "utf8"),
  ) as {
    cases: { input: string; lines: string[] }[];
  }
).cases;

test("py splitlines breaks where python's str.splitlines does, every case python itself produced", () => {
  assert.ok(CASES.length > 40);
  for (const c of CASES) assert.deepEqual(pySplitlines(c.input), c.lines, JSON.stringify(c.input));
});

test("py splitlines is no split on line feeds alone", () => {
  // (a differential: the breaks JavaScript's split("\n") misses, and the one it would add for a trailing break)
  const differ = CASES.filter((c) => JSON.stringify(c.input.split("\n")) !== JSON.stringify(c.lines));
  assert.ok(differ.length > 20, String(differ.length));
  for (const c of differ) assert.deepEqual(pySplitlines(c.input), c.lines, JSON.stringify(c.input));
});

test("has control finds a c0 control or del and nothing else", () => {
  for (const code of [0x00, 0x09, 0x0a, 0x1f, 0x7f])
    assert.equal(hasControl(`a${String.fromCharCode(code)}b`), true, String(code));
  for (const text of ["", "plain", "\u0080", "\u00a0", "\u2028", "😀"])
    assert.equal(hasControl(text), false, JSON.stringify(text));
});

test("py splitlines matches python on 5000 random strings of every break, plain characters and nothing", () => {
  // (test-support/python/py_splitlines_random.py made the corpus and ran python3's str.splitlines on it)
  const random = (
    JSON.parse(
      readFileSync(new URL("../../../../test-support/data/py-splitlines-random.json", import.meta.url), "utf8"),
    ) as {
      cases: { input: string; lines: string[] }[];
    }
  ).cases;
  assert.equal(random.length, 5000);
  const differ = random.filter((c) => JSON.stringify(pySplitlines(c.input)) !== JSON.stringify(c.lines));
  assert.deepEqual(differ.slice(0, 3), []);
  assert.equal(differ.length, 0);
});
