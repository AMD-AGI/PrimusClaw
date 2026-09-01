// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How much a script step may capture.
 *
 * Captures travel to Backend inside the `agent_done` body, which has a size
 * limit. Unbounded, a step that captured a large `result.json` did not lose the
 * capture -- it failed the whole completion callback, so a run that had finished
 * its work was recorded as never having reported, and everything else it captured
 * went with it.
 *
 * Coverage:
 *   F1 a capture within the limit is untouched
 *   F2 an oversized one is cut, and says it was cut
 *   F3 many medium captures cannot do what one large one cannot
 *   F4 a dropped capture is dropped whole, not halved
 */
import test from "node:test";
import assert from "node:assert/strict";

import { capCapturesTotal, truncateCapture } from "../src/tasks/script-runner.js";

test("F1 a capture within the limit is returned unchanged", () => {
  const value = JSON.stringify({ ok: true });
  assert.equal(truncateCapture("result", value), value);
});

test("F2 an oversized capture is cut and says so", () => {
  // The marker matters: a consumer parsing a capture as JSON has to tell a
  // truncated document from a malformed one. Silently handing over the first
  // 256 KiB is how a caller concludes the producer is broken.
  const cut = truncateCapture("result", "x".repeat(400 * 1024));
  assert.ok(cut.length < 400 * 1024);
  assert.match(cut, /truncated at \d+ bytes/);
  assert.match(cut, /'result'/);
});

test("F2b the cut is measured in bytes, not characters", () => {
  // A multi-byte body would otherwise pass a character check and still be over.
  const cut = truncateCapture("result", "中".repeat(200 * 1024));
  assert.ok(Buffer.byteLength(cut, "utf8") < 400 * 1024);
});

test("F3 many medium captures are capped in total", () => {
  const captures: Record<string, string> = {};
  for (let i = 0; i < 10; i++) captures[`c${i}`] = "y".repeat(200 * 1024);
  const capped = capCapturesTotal(captures);
  const total = Object.values(capped).reduce((n, v) => n + Buffer.byteLength(v, "utf8"), 0);
  assert.ok(total <= 1024 * 1024, `total was ${total}`);
});

test("F4 a capture that has to go is dropped whole", () => {
  // Half a document is the answer that looks valid and is not: a caller reading
  // `captures.result` wants a document or an absence.
  const captures = { small: "ok", big: "z".repeat(2 * 1024 * 1024) };
  const capped = capCapturesTotal(captures);
  assert.equal(capped.small, "ok", "a capture that fits was disturbed");
  assert.match(capped.big, /dropped/);
  assert.ok(!capped.big.includes("zzzz"), "the dropped capture kept part of its body");
});

test("F5 captures that all fit are returned as they were", () => {
  const captures = { a: "1", b: "2" };
  assert.deepEqual(capCapturesTotal(captures), captures);
});
