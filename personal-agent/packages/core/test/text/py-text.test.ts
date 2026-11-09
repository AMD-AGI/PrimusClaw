// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  cpHead,
  cpLength,
  cpSlice,
  fixed1,
  isPyPrintable,
  pyJsonDumps,
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
