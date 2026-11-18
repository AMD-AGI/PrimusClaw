// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a message asks for a review (`asksForReview`, Python `github_connect._asks_for_review`): read in one pass, and as the
 * Python worker reads it. The expectations are the Python worker's answers to the same texts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { asksForReview } from "../../src/review/connect/review-ask.js";

test("a long line of review words is read in one pass", () => {
  // (as a regular expression per "review" this grew with the square of the line: ~1.8 s of CPU for "review-" x 8000; the
  // question check stops at 2000 characters before it, so this is the function on its own)
  const cpu = process.cpuUsage();
  assert.equal(asksForReview("review-".repeat(8000)), false);
  const used = process.cpuUsage(cpu);
  assert.ok((used.user + used.system) / 1000 < 250, `${String((used.user + used.system) / 1000)} ms of CPU`);
});

test("it answers as the python worker does", () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["review o/r#1", true],
    [`review${" ".repeat(40)}o/r#1`, true],
    [`review${" ".repeat(41)}o/r#1`, false],
    [`review${"😀".repeat(39)} o/r#1`, true], // (40 characters, as Python counts them)
    [`review${"😀".repeat(40)} o/r#1`, false],
    ["review\no/r#1", false],
    ["reviewer o/r#1", false],
    ["review \u212a\u017f/r#1", true], // (the Kelvin sign and long s are name characters under re.I)
    ["REV\u0130EW merge", true],
    ["review HTTP\u017f://x", true],
    ["帮忙看一下审", true],
    ["review-".repeat(300), false],
  ];
  for (const [text, asks] of cases) assert.equal(asksForReview(text), asks, JSON.stringify(text));
});
