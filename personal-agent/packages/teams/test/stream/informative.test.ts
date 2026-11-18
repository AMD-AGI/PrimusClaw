// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { informativeText } from "../../src/stream/informative.js";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

test("the informative text is cut to teams limits keeping the newest", () => {
  // (reverse proof: cut from the end instead of the start, or count characters only: 2-byte characters overflow 1 KB)
  const text = informativeText(["old ".repeat(200), "x".repeat(500), "最新的一步：读取文件"]);
  assert.ok(Array.from(text).length <= 1000 && bytes(text) <= 1024);
  assert.ok(text.startsWith("…") && text.endsWith("最新的一步：读取文件"));
  const wide = informativeText(["字".repeat(900)]);
  assert.ok(bytes(wide) <= 1024 && wide.endsWith("字"));
  assert.equal(informativeText(["a\n b", "", "c"]), "a b · c");
});

test("a cut never starts with a mark that belongs to the letter before it", () => {
  const text = informativeText(["é".repeat(600)]);
  assert.ok(bytes(text) <= 1024);
  assert.notEqual(Array.from(text)[1], "́");
  assert.ok(text.startsWith("…e"));
});
