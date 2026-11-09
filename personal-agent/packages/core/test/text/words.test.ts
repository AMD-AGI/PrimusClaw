// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { decimalInt, isUpper, lstrip, pyFullmatch, rstripChars, splitOnce, stripChars } from "../../src/text/words.js";

test("splitOnce is str.split(None, 1)", () => {
  assert.deepEqual(splitOnce(""), []);
  assert.deepEqual(splitOnce(" 　 "), []);
  assert.deepEqual(splitOnce("  /agent  new codex /my repo "), ["/agent", "new codex /my repo "]);
  assert.deepEqual(splitOnce("/help"), ["/help"]);
  assert.deepEqual(splitOnce("/help \x1c"), ["/help"]);
});

test("strip with characters, and lstrip, as Python's", () => {
  assert.equal(stripChars("。。好了！", "。！"), "好了");
  assert.equal(rstripChars("😀😀a😀", "😀"), "😀😀a");
  assert.equal(lstrip("\x1c　 /x"), "/x");
});

test("a digit of any script is read as Python's int reads it", () => {
  assert.equal(decimalInt("１２"), 12);
  assert.equal(decimalInt("٣"), 3);
  assert.equal(decimalInt("𝟗"), 9);
  assert.ok(Number.isNaN(decimalInt("")) && Number.isNaN(decimalInt("1a")));
  assert.ok(isUpper("7KQ3") && !isUpper("1234") && !isUpper("Ab"));
});

test("pyFullmatch reads \\s and \\d as Python's re does, and matches the whole text only", () => {
  assert.ok(pyFullmatch(String.raw`a\sb`).test("a\x1cb"));
  assert.ok(!pyFullmatch(String.raw`a\sb`).test("a﻿b"));
  assert.ok(pyFullmatch(String.raw`x[\s-]*y`).test("x - \x1fy"));
  assert.ok(pyFullmatch(String.raw`\d+`).test("١٢"));
  assert.ok(!pyFullmatch("ab").test("abc"));
  assert.ok(pyFullmatch(String.raw`a\.b`, "i").test("A.B"));
});
