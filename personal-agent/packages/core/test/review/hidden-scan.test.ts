// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Readings of user and model text that the Python worker made one pass (its `_blank_hidden` and `_FILE_LINE`): here they were
 * already scans, and these guard that they stay linear. The results were also diffed against the Python worker on 30006
 * generated texts with no difference.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MARK_CLOSE, MARK_OPEN } from "../../src/review-text/pull-ref.js";
import { hasFileLine, hiddenSpans, replaceSpans } from "../../src/review-text/text/scan.js";

const blank = (text: string): string =>
  replaceSpans(text, hiddenSpans(text, MARK_OPEN, MARK_CLOSE), (m) => " ".repeat(m.length));

function cpuMs(run: () => void): number {
  const cpu = process.cpuUsage();
  run();
  const used = process.cpuUsage(cpu);
  return (used.user + used.system) / 1000;
}

test("tags, entities, links and mention markers are blanked in one pass", () => {
  // (as a regular expression, `<[^>]*>` read to the end of the text from each "<" with no ">" after it)
  const ms = cpuMs(() => {
    for (const unit of ["<", "http://x<", "<a>http://", "&#", "<b>&amp;⟦1⟧ "]) blank(unit.repeat(40_000)); // (the last: many spans)
  });
  assert.ok(ms < 250, `${String(ms)} ms of CPU`);
  assert.equal(
    blank("see <b>x</b> &amp; https://e.test/a ⟦1⟧ ok"),
    `see    x${" ".repeat(32)}ok`, // (the Python worker's answer)
  );
});

test("a file:line in a line is found in one pass", () => {
  // (as `[\w./-]+\.\w{1,8}:\d`, a search read a run of path characters to its end from each of them)
  const ms = cpuMs(() => {
    hasFileLine(`${"a.".repeat(40_000)}:1`);
    hasFileLine(".x:".repeat(40_000));
    hasFileLine("a".repeat(80_000));
  });
  assert.ok(ms < 250, `${String(ms)} ms of CPU`);
  assert.equal(hasFileLine("see src/app.py:12 for it"), true);
  assert.equal(hasFileLine("see app.toolongext:12"), false);
  assert.equal(hasFileLine(".py:12"), false); // (a path character before the dot)
});
