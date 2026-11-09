// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  clipLine,
  cpHead,
  cpRfind,
  fixedN,
  pyRstrip,
  cpLength,
  cpSlice,
  fixed1,
  isPyPrintable,
  PY_SPACE,
  pyCasefold,
  pyJsonDumps,
  pyLower,
  pyLstrip,
  pyStr,
  pySplit,
  pyStrip,
  squashSpaces,
} from "../../src/text/py-text.js";

test("white space is Python's: separators split, a byte-order mark does not", () => {
  assert.deepEqual(pySplit(" a\x1cb\x85c　d\n"), ["a", "b", "c", "d"]);
  assert.deepEqual(pySplit("a﻿b"), ["a﻿b"]);
  assert.equal(squashSpaces("two\nlines\tand   gaps"), "two lines and gaps");
  assert.equal(pyStrip("\x1f x \x85"), "x");
  assert.equal(pyStrip("﻿x"), "﻿x");
});

test("lengths and cuts count code points, not UTF-16 units", () => {
  assert.equal(cpLength("a😀b"), 3);
  assert.equal(cpSlice("a😀b", 0, 2), "a😀");
  assert.equal(cpHead("😀😀😀", 2), "😀😀");
  assert.equal(cpHead("short", 10), "short");
});

test("printable is Python's: controls, format and bidi characters are not, the space is", () => {
  assert.equal(isPyPrintable(" "), true);
  assert.equal(isPyPrintable("é"), true);
  assert.equal(isPyPrintable("\x00"), false);
  assert.equal(isPyPrintable("‮"), false);
  assert.equal(isPyPrintable(" "), false);
});

test("fixed decimals are Python's format: an exact tie rounds to even", () => {
  // Each pair is (value, digits) -> what Python 3 printed for f"{value:.{digits}f}".
  const cases: readonly (readonly [number, number, string])[] = [
    [12.5, 0, "12"],
    [13.5, 0, "14"],
    [0.5, 0, "0"],
    [1.5, 0, "2"],
    [2.5, 0, "2"],
    [-2.5, 0, "-2"],
    [0.25, 1, "0.2"],
    [0.75, 1, "0.8"],
    [-0.25, 1, "-0.2"],
    [-0.04, 1, "-0.0"],
    [-0, 1, "-0.0"],
    [2.675, 2, "2.67"],
    [1.005, 2, "1.00"],
    [0.125, 2, "0.12"],
    [1234.5678, 3, "1234.568"],
  ];
  for (const [value, digits, python] of cases)
    assert.equal(fixedN(value, digits), python, `${String(value)}:.${String(digits)}f`);
  assert.equal(fixedN(Number.NaN, 1), "nan");
  assert.equal(fixedN(Infinity, 1), "inf");
  assert.equal(fixedN(-Infinity, 1), "-inf");
});

test("strip with chars, negative slices, rfind and a clipped line are Python's", () => {
  assert.equal(pyStrip("**x**", "*"), "x");
  assert.equal(pyRstrip("a//", "/"), "a");
  assert.equal(pyStrip(" .a. ", " ."), "a");
  assert.equal(pyLstrip("xxa", "x"), "a");
  assert.equal(pyStrip("😀a😀", "😀"), "a");
  assert.equal(pyStrip("***", "*"), "");
  const t = "a😀b😀c";
  assert.equal(cpSlice(t, -2), "😀c");
  assert.equal(cpSlice(t, 1, -1), "😀b😀");
  assert.equal(cpSlice(t, -10, 2), "a😀");
  assert.equal(cpSlice(t, 3, 1), "");
  assert.equal(cpRfind(t, "😀"), 3);
  assert.equal(cpRfind(t, "x"), -1);
  assert.equal(cpRfind(t, ""), 5);
  assert.equal(clipLine("abc", 3), "abc");
  assert.equal(clipLine("ab cd", 4), "ab…");
  assert.equal(clipLine("😀😀😀", 2), "😀…");
});

test("one decimal rounds an exact tie to even, like Python's format", () => {
  assert.equal(fixed1(30), "30.0");
  assert.equal(fixed1(0.25), "0.2");
  assert.equal(fixed1(0.75), "0.8");
  assert.equal(fixed1(1.26), "1.3");
});

test("json dumps uses Python's separators and keeps non-ASCII", () => {
  assert.equal(
    pyJsonDumps({ a: 1, b: ["x", null, true], c: { d: "中文\n" } }),
    '{"a": 1, "b": ["x", null, true], "c": {"d": "中文\\n"}}',
  );
  assert.equal(pyJsonDumps(undefined), "null");
  assert.equal(pyJsonDumps(Number.NaN), "NaN");
  assert.equal(pyJsonDumps(-Infinity), "-Infinity");
  assert.equal(pyJsonDumps(Infinity), "Infinity");
  assert.equal(
    pyJsonDumps(() => 1),
    "null",
  );
});

test('lstrip and str(value or "") are Python\'s', () => {
  assert.equal(pyLstrip("\x1c a "), "a ");
  assert.equal(pyStr("x"), "x");
  assert.equal(pyStr(""), "");
  assert.equal(pyStr(undefined), "");
  assert.equal(pyStr(null), "");
  assert.equal(pyStr(false), "");
  assert.equal(pyStr(true), "True");
  assert.equal(pyStr(0), "");
  assert.equal(pyStr(Number.NaN), "");
  assert.equal(pyStr(12), "12");
  assert.equal(pyStr(0n), "");
  assert.equal(pyStr(7n), "7");
  assert.equal(pyStr({ a: 1 }), "");
});

test("json dumps with indent and sorted keys is json.dumps(indent=1, sort_keys=True)", () => {
  const value = { b: [1, { "\u{1f600}": null, "\uffff": true }], a: {}, c: [], d: undefined, é: "中" };
  assert.equal(
    pyJsonDumps(value, { indent: 1, sortKeys: true }),
    '{\n "a": {},\n "b": [\n  1,\n  {\n   "\uffff": true,\n   "\u{1f600}": null\n  }\n ],\n "c": [],\n "é": "中"\n}',
  );
  assert.equal(pyJsonDumps({ b: 1, a: 2 }, { sortKeys: true }), '{"a": 2, "b": 1}');
  assert.equal(pyJsonDumps({ ab: 1, a: 2 }, { sortKeys: true }), '{"a": 2, "ab": 1}');
});

test("the white space class is Python's str.isspace, x1c to x1f and x85 included", () => {
  const space = new RegExp(`^[${PY_SPACE}]+$`, "u");
  for (const ch of ["\x1c", "\x1d", "\x1e", "\x1f", "\x85", "\xa0", "\u2028", "\u3000", " ", "\t"]) {
    assert.ok(space.test(ch), JSON.stringify(ch));
    assert.equal(pyStrip(`${ch}a${ch}`), "a");
  }
  for (const ch of ["\ufeff", "\u200b", "a"]) assert.ok(!space.test(ch), JSON.stringify(ch));
});

test("lower and casefold are Python's", () => {
  // Python 3: each right-hand side is what str.lower() / str.casefold() returned.
  assert.equal(pyLower("ΑΣ Α"), "ας α");
  assert.equal(pyLower("ΌΣΟΣ"), "όσος");
  assert.equal(pyLower("İSTANBUL"), "i\u0307stanbul");
  assert.equal(pyCasefold("ΌΣΟΣ"), "όσοσ");
  assert.equal(pyCasefold("İSTANBUL"), "i\u0307stanbul");
  assert.equal(pyCasefold("ı"), "ı");
  assert.equal(pyCasefold("Straße ẞ ſ"), "strasse ss s");
  assert.equal(pyCasefold("ꭰᏸᎠ"), "ᎠᏰᎠ");
  assert.equal(pyCasefold("ABC"), "abc");
});
