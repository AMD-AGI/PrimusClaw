// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  clipLine,
  decimalBigInt,
  decimalInt,
  isDigits,
  isPySpace,
  isUpper,
  splitOnce,
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
  pyRepr,
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
  assert.equal(pyStr(Number.NaN), "nan"); // NaN is truthy in Python
  assert.equal(pyStr(12), "12");
  assert.equal(pyStr(0n), "");
  assert.equal(pyStr(7n), "7");
  assert.equal(pyStr({ a: 1 }), "{'a': 1}"); // a container is its repr, as str() shows it
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

test("splitOnce is str.split(None, 1)", () => {
  assert.deepEqual(splitOnce(""), []);
  assert.deepEqual(splitOnce(" \u3000 "), []);
  assert.deepEqual(splitOnce("  /agent  new codex /my repo "), ["/agent", "new codex /my repo "]);
  assert.deepEqual(splitOnce("/help"), ["/help"]);
  assert.deepEqual(splitOnce("/help \x1c"), ["/help"]);
  assert.deepEqual(splitOnce("a\x1cb c"), ["a", "b c"]);
});

test("strip with characters, and lstrip, as Python's (the routing rules' cases)", () => {
  assert.equal(pyStrip("。。好了！", "。！"), "好了");
  assert.equal(pyRstrip("😀😀a😀", "😀"), "😀😀a");
  assert.equal(pyLstrip("\x1c\u3000 /x"), "/x");
});

test("a digit of any script is read as Python's int reads it", () => {
  assert.equal(decimalInt("１２"), 12);
  assert.equal(decimalInt("٣"), 3);
  assert.equal(decimalInt("𝟗"), 9);
  assert.equal(decimalInt("0"), 0);
  assert.equal(decimalInt("1909"), 1909);
  assert.ok(Number.isNaN(decimalInt("")) && Number.isNaN(decimalInt("1a")));
  assert.ok(isDigits("١٢") && !isDigits("") && !isDigits("²"));
  assert.ok(isUpper("7KQ3") && !isUpper("1234") && !isUpper("Ab") && !isUpper("ß"));
});

test("isPySpace agrees with the white-space class on every BMP code unit", () => {
  const space = new RegExp(`^[${PY_SPACE}]$`, "u");
  for (let c = 0; c < 0x10000; c += 1) {
    const ch = String.fromCharCode(c);
    if (isPySpace(ch) !== space.test(ch)) assert.fail(`U+${c.toString(16)}`);
  }
  assert.equal(isPySpace(""), false);
  assert.equal(isPySpace("  "), false);
  assert.equal(isPySpace("😀"), false);
});

/** The fastest of a few runs, in milliseconds (the minimum is the least disturbed by other work on the machine). */
function fastest(run: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return Math.max(best, 0.05);
}

test("stripping takes time linear in the text, also with long white space inside", () => {
  // A run of white space that something follows is what an end-anchored regular expression rescans from every start.
  const text = (n: number): string => `${" ".repeat(n)}x${" ".repeat(n)}y`;
  const small = text(20_000);
  const large = text(80_000);
  for (const strip of [pyStrip, pyRstrip, pyLstrip, (t: string) => pyStrip(t, " "), (t: string) => clipLine(t, 10)]) {
    const ratio = fastest(() => strip(large)) / fastest(() => strip(small));
    assert.ok(ratio < 12, `4x the text took ${ratio.toFixed(1)}x the time`); // linear ~4, quadratic ~16
  }
});

test("numbers are written as Python writes them, and the edges of clip, rfind and fixed decimals", () => {
  // Each right-hand side is what Python 3 printed.
  for (const [value, python] of [
    [1e-7, "1e-07"],
    [1.5e-7, "1.5e-07"],
    [0.001, "0.001"],
    [123.456, "123.456"],
    [1.5, "1.5"],
    [-2.25, "-2.25"],
    [12, "12"],
    [Number.NaN, "nan"],
    [Infinity, "inf"],
  ] as const) {
    assert.equal(pyStr(value), python, String(value));
  }
  assert.equal(pyJsonDumps([1e-7, 0.5, 1e300, -1.5e-10, 12]), "[1e-07, 0.5, 1e+300, -1.5e-10, 12]");
  assert.equal(fixedN(1e21, 2), "1000000000000000000000.00");
  assert.equal(fixedN(1e23, 0), "99999999999999991611392");
  assert.equal(fixedN(-1e22, 1), "-10000000000000000000000.0");
  assert.equal(clipLine("abc", 0), "ab\u2026");
  assert.equal(cpRfind("😀", "\ude00"), -1);
  assert.equal(cpRfind("a😀b", "b"), 2);
  assert.equal(cpRfind("x\ud83d\ude00", "\ud83d"), -1);
  assert.equal(cpRfind("\ud83dx", "\ud83d"), 0);
});

test("isupper, repr and str of containers, exact integers and fixed decimals of any size are Python's", () => {
  // Each right-hand side is what CPython 3 printed.
  for (const [text, python] of [
    ["ℂϒ", true],
    ["\u{1d400}", true], // MATHEMATICAL BOLD CAPITAL A
    ["Aĸ", false],
    ["Aª", false],
    ["AB1", true],
    ["ǅ", false],
    ["1", false],
  ] as const) {
    assert.equal(isUpper(text), python, text);
  }
  assert.equal(pyStr([1, "a'b", { k: null }]), "[1, \"a'b\", {'k': None}]");
  assert.equal(pyStr([]), "");
  assert.equal(pyStr({}), "");
  assert.equal(pyRepr("tab\there \\ 中 \u200b \ud800"), "'tab\\there \\\\ 中 \\u200b \\ud800'");
  assert.equal(pyRepr({ a: [true, false, 1.5] }), "{'a': [True, False, 1.5]}");
  assert.equal(decimalBigInt("9007199254740993"), 9007199254740993n);
  assert.equal(decimalBigInt("x"), undefined);
  assert.throws(() => decimalInt("9007199254740993"), RangeError);
  assert.equal(decimalInt("9007199254740991"), 9007199254740991);
  assert.equal(fixedN(1.25, 101), `1.25${"0".repeat(99)}`);
  assert.equal(pyJsonDumps("\ud800x"), '"\ud800x"'); // a lone surrogate is written raw, as Python's ensure_ascii=False does
});

test("negative zero and big integers are written as Python writes them", () => {
  // CPython 3: json.dumps(-0.0) and repr(-0.0) are -0.0; json.dumps(9007199254740993) is the integer.
  assert.equal(pyJsonDumps(-0), "-0.0");
  assert.equal(pyRepr(-0), "-0.0");
  assert.equal(pyStr(-0), ""); // -0.0 is falsy
  assert.equal(pyJsonDumps(9007199254740993n), "9007199254740993");
  assert.equal(pyJsonDumps({ n: 1, z: -0 }), '{"n": 1, "z": -0.0}');
});
