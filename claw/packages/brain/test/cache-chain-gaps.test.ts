// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The anchor is geometry; only the rolling chain is evidence.
 *
 * `cacheChainGaps` exists because folding the two into one maximum sent the
 * first investigation of this bug after the wrong cause: past a certain
 * conversation length the field always read as "the chain broke", and it read
 * the same on the healthy turns as on the lost ones -- i.e. it was measuring
 * the conversation's length, not its health. These pin the two numbers apart,
 * and pin the one case where neither can be measured.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cacheChainGaps } from "../src/agent/agent-loop.js";

test("with only the anchor there is no chain, and so no gap to report", () => {
  // The regression. `blocks - anchor` is the distance from a marker that never
  // moves to the end of a prompt that keeps growing; publishing it as
  // rollingMaxGap is the same conflation one subtraction further along.
  assert.deepEqual(cacheChainGaps([0], 100), { anchorGap: undefined, rollingMaxGap: undefined });
  assert.deepEqual(cacheChainGaps([4], 4), { anchorGap: undefined, rollingMaxGap: undefined });
});

test("the anchor distance is reported under its own name, never as a rolling gap", () => {
  // One rolling marker: anchorGap is anchor->rolling, and the only rolling
  // distance there is runs from that marker to the end of the prompt.
  assert.deepEqual(cacheChainGaps([0, 30], 100), { anchorGap: 30, rollingMaxGap: 70 });
  // A large anchorGap does not inflate rollingMaxGap: this is the healthy-turn
  // shape that used to be reported as a broken chain.
  assert.deepEqual(cacheChainGaps([0, 57], 60), { anchorGap: 57, rollingMaxGap: 3 });
});

test("the rolling maximum spans marker-to-marker and the tail alike", () => {
  // Widest interior step wins.
  assert.deepEqual(cacheChainGaps([0, 10, 50, 55], 60), { anchorGap: 10, rollingMaxGap: 40 });
  // Tail wins: the chain's last marker is far behind the end of the prompt,
  // which is what one turn appending many blocks looks like.
  assert.deepEqual(cacheChainGaps([0, 10, 20, 30], 100), { anchorGap: 10, rollingMaxGap: 70 });
  // A perfectly even chain reports its stride, not the conversation's length.
  assert.deepEqual(cacheChainGaps([0, 40, 45, 50], 55), { anchorGap: 40, rollingMaxGap: 5 });
});

test("an unmeasurable prompt reports nothing rather than a zero-width gap", () => {
  // markerBlockOffsets is absent on providers that cannot report it, and
  // promptBlocks is absent on transports that do not count blocks. Neither is
  // a zero, and a zero here would read as a perfectly tight chain.
  const none = { anchorGap: undefined, rollingMaxGap: undefined };
  assert.deepEqual(cacheChainGaps(undefined, 100), none);
  assert.deepEqual(cacheChainGaps([0, 30], undefined), none);
  assert.deepEqual(cacheChainGaps(undefined, undefined), none);
  assert.deepEqual(cacheChainGaps([], 100), none);
});
