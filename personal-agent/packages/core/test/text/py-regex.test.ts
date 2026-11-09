// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { pyFullmatch } from "../../src/text/py-regex.js";

/**
 * (pattern, flags, text, what Python 3's re.fullmatch said). `\\p{Lu}` was checked in Python with the class of the
 * capitals in the text, since Python's re has no \\p.
 */
const CASES: readonly (readonly [string, string, string, boolean])[] = [
  ["a\\sb", "", "a\u001cb", true],
  ["a\\sb", "", "a\ufeffb", false],
  ["a\\sb", "", "a\u0085b", true],
  ["x[\\s-]*y", "", "x - \u001fy", true],
  ["\\d+", "", "\u0661\u0662", true],
  ["\\d+", "", "\uff11\uff12", true],
  ["ab", "", "abc", false],
  ["a\\.b", "i", "A.B", true],
  ["\\S+", "", "a\u001cb", false],
  ["\\S+", "", "a\ufeffb", true],
  ["\\D+", "", "ab", true],
  ["\\D+", "", "a\u0661", false],
  ["\\w+", "", "h\u00e9llo_\u4e2d\u6587\u0661", true],
  ["\\w+", "", "a-b", false],
  ["\\W", "", "-", true],
  ["\\W", "", "\u00e9", false],
  ["a\\b.*", "", "a b", true],
  ["a\\b.*", "", "a\u00e9", false],
  ["\\b\u00e9\\b", "", "\u00e9", true],
  ["a\\B.*", "", "a\u00e9", true],
  ["link", "i", "L\u0130NK", true],
  ["link", "i", "l\u0131nk", true],
  ["[a-z]+", "i", "\u0131\u0130", true],
  ["[^a-z]", "i", "\u0131", false],
  ["[^a-z]", "i", "-", true],
  ["(?<id>i+)", "i", "\u0131I", true],
  ["\\p{Lu}+", "", "AB\u0130", true],
  ["\\x41\\u0042", "", "AB", true],
  ["(\\d{1,2}):(\\d{2})\\s*-\\s*(\\d{1,2}):(\\d{2})", "", "9:00 - 18:30", true],
  ["(\\d{1,4})\\s*([mhd])", "i", "30 M", true],
  ["[\\d:]+", "", "\u0661:\u0662", true],
  ["[\\w]+", "", "\u00e9_1", true],
];

test("pyFullmatch reads \\s and \\d as Python's re does, and matches the whole text only", () => {
  for (const [pattern, flags, text, python] of CASES) {
    assert.equal(pyFullmatch(pattern, flags).test(text), python, `${pattern} /${flags} ${JSON.stringify(text)}`);
  }
});

test("pyFullmatch keeps groups and refuses a negated class escape inside a class", () => {
  assert.deepEqual(
    pyFullmatch(String.raw`(\d{1,2}):(\d{2})`)
      .exec("９:05")
      ?.slice(1),
    ["９", "05"],
  );
  assert.equal(pyFullmatch(String.raw`(?<id>i+)`, "i").exec("ıI")?.groups?.["id"], "ıI");
  assert.throws(() => pyFullmatch(String.raw`[\S]`), /no JavaScript form/);
  assert.equal(pyFullmatch("[]a]").test("]"), true);
  assert.equal(pyFullmatch("[^]a]").test("b"), true);
  assert.equal(pyFullmatch("a", "u").flags, "u");
});
