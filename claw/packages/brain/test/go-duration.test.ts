// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A duration the Workload Manager will not use is worse than one it rejects.
//
// The override is applied only when it parses AND comes out positive, and a
// value that fails either test is dropped without a word: the sandbox takes the
// default while the operator reads their own setting back from the Deployment
// and believes it took. So the check here has to be the same check, in the same
// units -- Go durations are whole nanoseconds, and the rounding is what makes
// `0.1ns` a zero rather than a very small number.

import test from "node:test";
import assert from "node:assert/strict";
import { goDurationNs } from "../src/config.js";

test("ordinary durations parse to their nanosecond value", () => {
  assert.equal(goDurationNs("1ns"), 1n);
  assert.equal(goDurationNs("90m"), 90n * 60_000_000_000n);
  assert.equal(goDurationNs("2h30m"), 2n * 3_600_000_000_000n + 30n * 60_000_000_000n);
});

test("zero is refused however it is spelled", () => {
  // Go takes both of these. It then makes them zero, and the Workload Manager
  // applies an override only when it is positive -- so they reach the sandbox as
  // nothing at all.
  assert.equal(goDurationNs("0s"), null);
  assert.equal(goDurationNs("0h0m0s"), null);
  assert.equal(goDurationNs("0.1ns"), null,
    "a tenth of a nanosecond truncates to zero, which is the whole problem");
  assert.equal(goDurationNs("0.6ns0.6ns"), null,
    "Go truncates each segment, so this is zero twice -- summing first and "
      + "rounding once would make it 1ns and send a value Go then drops");
});

test("something that is not a duration is refused", () => {
  assert.equal(goDurationNs("forever"), null);
  assert.equal(goDurationNs("15"), null, "Go wants a unit");
  assert.equal(goDurationNs("15 m"), null);
  assert.equal(goDurationNs(""), null);
});

test("a value too large for an int64 is refused rather than wrapped", () => {
  assert.equal(goDurationNs("1000000000h"), null,
    "Go fails to parse this; accepting it here would send a value that is "
      + "dropped on arrival");
  assert.equal(goDurationNs("9223372036854775808ns"), null,
    "one past int64 max, which a double rounds to exactly int64 max -- so a "
      + "range check done in floats let it through");
  assert.equal(goDurationNs("9223372036854775807ns"), 9223372036854775807n,
    "int64 max itself is a duration Go accepts");
  assert.notEqual(goDurationNs("2000h"), null, "83 days is long, not impossible");
});
