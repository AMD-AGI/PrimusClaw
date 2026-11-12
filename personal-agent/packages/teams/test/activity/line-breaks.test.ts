// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Teams' markdown runs lines a single "\n" separates together: a markdown-format message keeps each line of text on a
 * line of its own, and leaves blank lines, fenced code, lists and tables as they were written. Streamed, it only ever
 * grows, and what was streamed is the start of the final message.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { streamedLineBreaks, withLineBreaks } from "../../src/activity/line-breaks.js";

const GOLDEN: readonly (readonly [string, string, string])[] = [
  [
    "two URLs on two lines",
    "Opened:\nhttps://github.com/o/r/pull/804\nhttps://github.com/o/r/pull/805",
    "Opened:\n\nhttps://github.com/o/r/pull/804\n\nhttps://github.com/o/r/pull/805",
  ],
  ["a bilingual note", "已开始审阅。\nReview started.", "已开始审阅。\n\nReview started."],
  ["a list, then a sentence", "Steps:\n- build\n- test\nAll done.", "Steps:\n- build\n- test\n\nAll done."],
  ["a numbered list", "Then:\n1. merge\n2. release", "Then:\n1. merge\n2. release"],
  [
    "a fenced code block",
    "Run:\n```sh\nnpm ci\nnpm test\n```\nThen push.",
    "Run:\n```sh\nnpm ci\nnpm test\n```\nThen push.",
  ],
  ["a tilde fence left open", "~~~\na\nb", "~~~\na\nb"],
  [
    "a table",
    "Results:\n| job | state |\n| --- | --- |\n| lint | ok |\n| test | ok |",
    "Results:\n| job | state |\n| --- | --- |\n| lint | ok |\n| test | ok |",
  ],
  ["a line after a table", "| a |\n| - |\n| 1 |\nTotal: 1", "| a |\n| - |\n| 1 |\n\nTotal: 1"],
  ["a list item's indented line", "- first\n  continuation\n- second", "- first\n  continuation\n- second"],
  ["a sentence after a list item's indented line", "- a\n  more\nAfter.", "- a\n  more\n\nAfter."],
  [
    "a table without outer pipes",
    "Results:\nhost | state\n--- | :---:\nci | ok\ncd | ok\nDone.",
    "Results:\n\nhost | state\n--- | :---:\nci | ok\ncd | ok\n\nDone.",
  ],
  ["a pipe in a sentence", "a | b\nc", "a | b\n\nc"],
  ["paragraphs", "One.\n\nTwo.\n\n\nThree.", "One.\n\nTwo.\n\n\nThree."],
  ["a heading, a quote", "# Title\nbody\n> quoted", "# Title\n\nbody\n> quoted"],
  ["a bold label line", "**Status**\nall green", "**Status**\n\nall green"],
  ["one line", "just one line", "just one line"],
  ["a trailing newline", "a\nb\n", "a\n\nb\n"],
];

for (const [name, text, shown] of GOLDEN) {
  test(`line breaks: ${name}`, () => {
    assert.equal(withLineBreaks(text), shown);
    assert.equal(withLineBreaks(shown), shown); // (what already shows its lines stays as it is)
    assert.equal(streamedLineBreaks(text + "\n\n"), withLineBreaks(text + "\n\n"));
  });
}

test("a streamed text holds back only a last line that may still start a list, a fence or a heading", () => {
  assert.equal(streamedLineBreaks("Steps:\n-"), "Steps:");
  assert.equal(streamedLineBreaks("Steps:\n- "), "Steps:"); // (may still be a delimiter row, "- | -")
  assert.equal(streamedLineBreaks("Steps:\n- b"), "Steps:\n- b");
  assert.equal(streamedLineBreaks("Steps:\n-x"), "Steps:\n\n-x");
  assert.equal(streamedLineBreaks("Run:\n``"), "Run:");
  assert.equal(streamedLineBreaks("Run:\n```"), "Run:\n```");
  assert.equal(streamedLineBreaks("a\n12"), "a");
  assert.equal(streamedLineBreaks("a\n12."), "a");
  assert.equal(streamedLineBreaks("a\n12a"), "a\n\n12a");
  assert.equal(streamedLineBreaks("a\n "), "a");
  assert.equal(streamedLineBreaks("a\nh"), "a\n\nh");
  assert.equal(streamedLineBreaks("```\ncode\n-"), "```\ncode\n-"); // (code is never held)
  assert.equal(streamedLineBreaks("a\n\n-"), "a\n\n-"); // (after a blank line nothing changes)
  assert.equal(streamedLineBreaks("h | v\n--"), "h | v"); // (may still be a delimiter row)
  assert.equal(streamedLineBreaks("h | v\n--- | ---\nci"), "h | v\n--- | ---"); // (a row, until a pipe or its end)
  assert.equal(streamedLineBreaks("h | v\n--- | ---\nci |"), "h | v\n--- | ---\nci |");
});

/** Whether `shown` is `text` with only "\n" added, each right after a "\n" of `text`. */
function addsOnlyNewlines(text: string, shown: string): boolean {
  let j = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (shown[j] !== text[i]) return false;
    j += 1;
    if (text[i] === "\n") while (shown[j] === "\n" && text[i + 1] !== "\n") j += 1;
  }
  return j === shown.length;
}

function check(text: string): void {
  const shown = withLineBreaks(text);
  const streamed = streamedLineBreaks(text);
  assert.ok(shown.startsWith(streamed), JSON.stringify(text));
  assert.ok(streamed.startsWith(streamedLineBreaks(text.slice(0, -1))), JSON.stringify(text));
  assert.ok(addsOnlyNewlines(text, shown), JSON.stringify(text));
  assert.equal(withLineBreaks(shown), shown, JSON.stringify(text));
}

const ALPHABET = ["a", "-", " ", "1", ".", "`", "#", "|", ">", "\n", "*", "~"];

test("every text of a few characters: what is streamed only grows and starts the final message", () => {
  let texts = [""];
  for (let length = 1; length <= 5; length += 1) {
    texts = texts.flatMap((t) => ALPHABET.map((c) => t + c));
    texts.forEach(check);
  }
});

test("longer texts, streamed a character at a time, never take back what was streamed", () => {
  let seed = 7;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pieces = [
    ...ALPHABET,
    "```",
    "~~~",
    "- ",
    "1. ",
    "| x |",
    "# ",
    "https://x.test/1",
    "中文",
    "--- | ---",
    "a | b",
    ":",
    "  ",
  ];
  for (let round = 0; round < 3000; round += 1) {
    let text = "";
    const parts = 1 + next(24);
    for (let i = 0; i < parts; i += 1) text += pieces[next(pieces.length)] ?? "";
    for (let end = 1; end <= text.length; end += 1) check(text.slice(0, end));
  }
});
