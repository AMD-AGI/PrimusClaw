// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// This has to be Go's parser, not something that resembles it.
//
// Both directions of "close enough" fail without a symptom. Too permissive and
// the Workload Manager drops the override in silence, while the operator reads
// their setting back from the Deployment and believes it took. Too strict and a
// legal value is refused -- Go takes `+1s`, `.5s`, `1.s` and three spellings of
// microseconds, and a hand-rolled check rejected all of them.
//
// The cases below were cross-checked against `time.ParseDuration` itself: 91
// inputs, including 60 generated ones, agree exactly.

import test from "node:test";
import assert from "node:assert/strict";
import { goDurationNs } from "../src/config.js";

const S = 1_000_000_000n;

test("the forms Go accepts and a hand-rolled check did not", () => {
  assert.equal(goDurationNs("+1s"), S, "a leading plus is legal");
  assert.equal(goDurationNs(".5s"), S / 2n, "the integer part is optional");
  assert.equal(goDurationNs("1.s"), S, "so is the fraction after the point");
  assert.equal(goDurationNs("1us"), 1_000n);
  assert.equal(goDurationNs("1µs"), 1_000n, "MICRO SIGN");
  assert.equal(goDurationNs("1μs"), 1_000n, "GREEK SMALL LETTER MU");
});

test("ordinary durations parse to their nanosecond value", () => {
  assert.equal(goDurationNs("1ns"), 1n);
  assert.equal(goDurationNs("90m"), 90n * 60n * S);
  assert.equal(goDurationNs("2h30m"), 2n * 3600n * S + 30n * 60n * S);
  assert.equal(goDurationNs("1m0.5s"), 60n * S + S / 2n);
});

test("zero is refused however it is spelled", () => {
  // Go takes all of these and makes them zero; the Workload Manager applies an
  // override only when it is positive, so they would reach the sandbox as
  // nothing at all.
  assert.equal(goDurationNs("0"), null);
  assert.equal(goDurationNs("0s"), null);
  assert.equal(goDurationNs("0h0m0s"), null);
  assert.equal(goDurationNs("0.1ns"), null,
    "a tenth of a nanosecond truncates to zero, which is the whole problem");
  assert.equal(goDurationNs("0.6ns0.6ns"), null,
    "Go truncates each segment, so this is zero twice -- summing first and "
      + "rounding once would make it 1ns and send a value Go then drops");
});

test("negative is refused, not negated", () => {
  assert.equal(goDurationNs("-1s"), null, "not a lifetime");
});

test("something that is not a duration is refused", () => {
  for (const bad of ["forever", "15", "15 m", " 1s", "1 s", "1S", "1x", ".s", ""]) {
    assert.equal(goDurationNs(bad), null, `${JSON.stringify(bad)} should be refused`);
  }
});

test("a value too large for an int64 is refused rather than wrapped", () => {
  assert.equal(goDurationNs("9223372036854775807ns"), 9223372036854775807n,
    "int64 max itself is a duration Go accepts");
  assert.equal(goDurationNs("9223372036854775808ns"), null,
    "one past it, which a double rounds back to int64 max -- so a range check "
      + "done in floats let it through");
  assert.equal(goDurationNs("1000000000h"), null);
  assert.equal(goDurationNs("9223372036854775807h"), null, "overflows on the multiply");
});

test("a fraction long enough to break float maths returns a value, not an exception", () => {
  // 309 digits made `scale` infinite, `f/scale` NaN, and `BigInt(NaN)` a
  // RangeError -- thrown at module load, from a config value, which is a crash
  // loop rather than a rejected setting. Go's leadingFraction stops scaling when
  // it stops accumulating, so it reads this as 1s.
  const long = "0." + "9".repeat(309) + "s";
  assert.equal(goDurationNs(long), S, "matches time.ParseDuration on the same input");
  assert.doesNotThrow(() => goDurationNs("0." + "9".repeat(5000) + "h"));
});
