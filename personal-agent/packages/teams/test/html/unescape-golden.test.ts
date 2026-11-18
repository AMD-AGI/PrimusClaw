// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Every HTML5 name, with and without what follows it, and the numeric edge cases, unescaped as Python's html.unescape does. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { unescape } from "../../src/html/entities.js";

const GOLDEN = JSON.parse(
  readFileSync(new URL("../../../../test-support/data/html_unescape_golden.json", import.meta.url), "utf8"),
) as Array<[string, string]>;

test("character references unescape exactly as python's html.unescape: every html5 name and the numeric edge cases", () => {
  assert.ok(GOLDEN.length > 2300);
  const wrong = GOLDEN.filter(([input, expected]) => unescape(input) !== expected).slice(0, 5);
  assert.deepEqual(wrong, []);
});
