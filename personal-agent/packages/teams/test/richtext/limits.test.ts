// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Size and time limits: pathological input converts fast, an enormous answer is refused, the worst-case part of an
 * answer still fits a Teams message, and markup too large for one is refused so the caller sends the markdown.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_INPUT_CHARS,
  MAX_OUTPUT_BYTES,
  markdownActivity,
  richTextActivity,
  RichTextError,
  toTeamsHtml,
} from "../../src/richtext/index.js";

/** The longest part of an answer the renderer sends in one message (render's MAX_ANSWER_CHARS in the Python worker). */
const MAX_ANSWER_CHARS = 3000;

const PATHOLOGICAL: readonly (readonly [string, string])[] = [
  ["many unclosed stars", "*a ".repeat(1500)],
  ["many unclosed underscores", "_a ".repeat(1500)],
  ["many open brackets", "[".repeat(3000)],
  ["many link starts", "[a](".repeat(700)],
  ["many backticks", "`a".repeat(1500)],
  ["every line opens a code span", "`a\nb\n".repeat(1000)],
  [
    "unmatched runs of growing length",
    Array.from({ length: 900 }, (_, k) => "`".repeat((k % 7) + 1) + " x\n").join(""),
  ],
  ["star soup", "*_~+".repeat(700)],
  ["long bold run", "**" + "a".repeat(5000) + "**"],
  ["deep nesting", "**_~~".repeat(40) + "x" + "~~_**".repeat(40)],
  ["many short links", "[a](https://a.example) ".repeat(400)],
  ["many lines", "- x\n".repeat(2000)],
  ["many table rows", "|a|b|\n|-|-|\n" + "|1|2|\n".repeat(1500)],
];

for (const [name, markdown] of PATHOLOGICAL) {
  test(`pathological input is fast: ${name}`, () => {
    const started = performance.now();
    try {
      toTeamsHtml(markdown);
    } catch (err) {
      if (!(err instanceof RichTextError)) throw err; // too long to convert is an allowed answer; being slow is not
    }
    assert.ok(performance.now() - started < 2000, name);
  });
}

test("an enormous answer is refused so the caller falls back", () => {
  assert.throws(() => toTeamsHtml("x".repeat(MAX_INPUT_CHARS + 1)), RichTextError);
});

test("the worst case part still fits in a teams message", () => {
  for (const char of ["&", "<", ">"]) {
    assert.ok(Buffer.byteLength(toTeamsHtml(char.repeat(MAX_ANSWER_CHARS))) < MAX_OUTPUT_BYTES);
  }
  assert.ok(Buffer.byteLength(toTeamsHtml("- ✅ **a**\n".repeat(270))) < MAX_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(toTeamsHtml("**ab**\n".repeat(420))) < MAX_OUTPUT_BYTES); // the heaviest markup per character
});

test("markup that would not fit a teams message is refused so the caller falls back", () => {
  const heavy = "**ab**\n".repeat(1000); // 7000 characters of markdown, far more as markup
  assert.throws(() => toTeamsHtml(heavy), RichTextError);
  assert.deepEqual(richTextActivity(heavy), markdownActivity(heavy));
});

test("the input limit counts code points, as Python's len does", () => {
  // 10001 emoji are 20002 UTF-16 units but 10001 characters: under the input limit, refused only as too much markup.
  assert.throws(() => toTeamsHtml("😀".repeat(10_001)), { message: "converted answer too long" });
  assert.throws(() => toTeamsHtml("x".repeat(MAX_INPUT_CHARS + 1)), { message: "answer too long to convert" });
  assert.equal(toTeamsHtml("😀".repeat(5000)), "😀".repeat(5000));
});

test("a lone surrogate is refused, as Python's utf-8 encoding refuses it", () => {
  assert.throws(() => toTeamsHtml("a \ud800 b"), RichTextError);
});
