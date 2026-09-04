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
// ORACLE below is not a list of expectations someone reasoned out. Every row is
// the answer real `time.ParseDuration` gave, captured from a Go binary built
// against the toolchain in go.mod and pasted in verbatim, with Go's value
// mapped to null wherever it errors or returns something not positive -- the
// two cases this port refuses on purpose. An earlier version of this file said
// in a comment that 91 inputs had been cross-checked, which was true of a
// scratch program and not of anything committed: the file pinned 31 hand-written
// cases and the generated ones existed nowhere. A parity claim that nothing runs
// is the same silent drift it exists to catch, so the corpus lives here now.

import test from "node:test";
import assert from "node:assert/strict";
import { goDurationNs } from "../src/config.js";

const S = 1_000_000_000n;

/** Input, and what `time.ParseDuration` makes of it (null = errors, or <= 0). */
const ORACLE: ReadonlyArray<readonly [string, bigint | null]> = [
  ["+1s", 1000000000n],
  [".5s", 500000000n],
  ["1.s", 1000000000n],
  ["1us", 1000n],
  ["1\u00b5s", 1000n],
  ["1\u03bcs", 1000n],
  ["1ns", 1n],
  ["1ms", 1000000n],
  ["1m", 60000000000n],
  ["1h", 3600000000000n],
  ["1s", 1000000000n],
  ["90m", 5400000000000n],
  ["2h30m", 9000000000000n],
  ["1m0.5s", 60500000000n],
  ["2h30m45s", 9045000000000n],
  ["1h1m1s1ms1us1ns", 3661001001001n],
  ["15m", 900000000000n],
  ["24h", 86400000000000n],
  ["48h", 172800000000000n],
  ["36h30m", 131400000000000n],
  ["6h", 21600000000000n],
  ["0", null],
  ["0s", null],
  ["0h0m0s", null],
  ["-0s", null],
  ["+0s", null],
  ["0.1ns", null],
  ["0.6ns", null],
  ["0.6ns0.6ns", null],
  ["0.4ns", null],
  ["0.5ns", null],
  ["0ns", null],
  ["-1s", null],
  ["-1h", null],
  ["-9223372036854775808ns", null],
  ["-0.5s", null],
  ["forever", null],
  ["15", null],
  ["15 m", null],
  [" 1s", null],
  ["1 s", null],
  ["1S", null],
  ["1x", null],
  ["1H", null],
  ["1M", null],
  ["1d", null],
  ["1w", null],
  ["1y", null],
  [".s", null],
  ["-.s", null],
  [".", null],
  ["s", null],
  ["", null],
  ["00", null],
  ["1sm", null],
  ["1.2.3s", null],
  ["1..2s", null],
  ["--1s", null],
  ["++1s", null],
  ["+-1s", null],
  ["-+1s", null],
  ["0x1s", null],
  ["1e9ns", null],
  ["9223372036854775807ns", 9223372036854775807n],
  ["9223372036854775808ns", null],
  ["9223372036854775806ns", 9223372036854775806n],
  ["9223372036854775809ns", null],
  ["92233720368547758070ns", null],
  ["1000000h", 3600000000000000000n],
  ["2562047h", 9223369200000000000n],
  ["2562047h47m", 9223372020000000000n],
  ["2562047h47m16.854775807s", 9223372036854775807n],
  ["2562047h47m16.854775808s", null],
  ["2562048h", null],
  ["9223372036854775807h", null],
  ["9223372036854775807s", null],
  ["1000000000h", null],
  ["9223372036854775806ns1ns", 9223372036854775807n],
  ["9223372036854775807ns1ns", null],
  ["4611686018427387903ns4611686018427387904ns", 9223372036854775807n],
  ["4611686018427387904ns4611686018427387904ns", null],
  ["1ns9223372036854775807ns", null],
  ["1m9223372036854775807ns", null],
  ["0.9223372036854775808ns", null],
  ["0.9223372036854775808us", 922n],
  ["0.9223372036854775808ms", 922337n],
  ["0.9223372036854775808s", 922337203n],
  ["0.9223372036854775808m", 55340232221n],
  ["0.9223372036854775808h", 3320413933267n],
  ["0.92233720368547758080h", 3320413933267n],
  ["0.9223372036854775808999999h", 3320413933267n],
  ["0.9223372036854775807h", 3320413933267n],
  ["0.9223372036854775809h", 3320413933267n],
  ["1.9223372036854775808h", 6920413933267n],
  ["9223372036854775000ns0.9223372036854775808h", null],
  ["9223368515078286331ns0.9782712470769444004h", 9223372036854775807n],
  ["9223372036854775807ns0.9223372036854775808ns", 9223372036854775807n],
  ["0.0000000001s", null],
  ["0.9999999999s", 999999999n],
  ["1.0000000005s", 1000000000n],
  ["0.000000001s", 1n],
  ["0.0000000009s", null],
  ["1.5s", 1500000000n],
  ["500ms", 500000000n],
  ["1.000000001s", 1000000001n],
  ["0.1us", 100n],
  ["9223372036854775807us", null],
  ["9223372036854775us", 9223372036854775000n],
  ["9223372036854us", 9223372036854000n],
  ["9223372036ns", 9223372036n],
  ["153722867280912930m", null],
  ["153722867280912931m", null],
  ["2562047788015215h", null],
  ["2562047788015216h", null],

  // Terms that carry the uint64 total past 2^64, where Go's `d += v` wraps
  // instead of erroring. Captured from the same binary as everything above.
  ["9223372036854775808ns1ns", null],
  ["9223372036854775808ns9223372036854775808ns", null],
  ["9223372036854775808ns9223372036854775808ns1ns", 1n],
  ["9223372036854775808ns9223372036854775808ns9223372036854775807ns", 9223372036854775807n],
  ["9223372036854775808ns9223372036854775808ns9223372036854775808ns", null],
  ["1ns9223372036854775808ns9223372036854775808ns", null],
  ["9223372036854775808ns1ns9223372036854775808ns", null],
  ["9223372036854775807ns9223372036854775808ns1ns", null],
  ["9223372036854775808ns9223372036854775807ns1ns", null],
  ["9223372036854775808ns9223372036854775808ns1ns9223372036854775808ns9223372036854775808ns1ns", null],
  ["9223372036854775808ns9223372036854775808ns0.5s", 500000000n],
  ["-9223372036854775808ns9223372036854775808ns1ns", null],
  ["9223372036854775808ns9223372036854775808ns-1ns", null],
  ["9223372036854775806ns2ns", null],
  ["4611686018427387904ns4611686018427387904ns1ns", null],
  ["9223372036854775808ns9223372036854775808ns9223372036854775808ns9223372036854775808ns1ns", 1n],
  ["0.9223372036854775808h9223372036854775808ns9223372036854775808ns", null],
  ["9223372036854775808ns0.9223372036854775808h9223372036854775808ns", null],
  ["+9223372036854775808ns9223372036854775808ns.9999999999999999999s", 1000000000n],
  ["+9223372036854775808ns9223372036854775808ns0.9223372036854775808h", 3320413933267n],
  ["0ns9223372036854775808ns9223372036854775808ns4611686018427387902ns4611686018427387904ns", 9223372036854775806n],
  ["4611686018427387903ns4611686018427387905ns9223372036854775808ns1h", 3600000000000n],
  ["4611686018427387904ns0ns4611686018427387904ns9223372036854775808ns4611686018427387904ns", 4611686018427387904n],
  ["9223372036854775808ns9223372036854775808ns9223372036854775808ns9223372036854775808ns9223372036854775808ns9223372036854775808ns1ns", 1n],
];

test("every case agrees with what time.ParseDuration actually returned", () => {
  for (const [input, expected] of ORACLE) {
    assert.equal(goDurationNs(input), expected,
      `${JSON.stringify(input)} disagrees with the Go oracle`);
  }
});

test("the corpus is big enough to be worth the name", () => {
  // 91 is the number this file used to claim while pinning 31. The floor is
  // above it so the claim cannot quietly become false again by deletion.
  assert.ok(ORACLE.length >= 130, `only ${ORACLE.length} cases`);
});

// ── The wraparound a third review round put a name to ────────────────────────
//
// Go's running total is a uint64 and `d += v` is checked only afterwards, with
// `d > 1<<63`. A sum large enough to pass 2^64 therefore wraps under that
// question rather than failing it: two terms of exactly 1<<63 land on 0, and a
// third of 1ns makes the whole string 1ns. Accumulating in BigInt and rejecting
// on the way past looked like the more defensible reading, and it is -- but the
// Workload Manager is the one that decides, in uint64, and a value it accepts
// that this rejects is a lifetime refused at startup for being valid.
//
// This is the case an earlier 280,560-input random corpus could not reach,
// because nothing in it summed several terms across 2^64. Pinned here by hand.
test("the total wraps where Go's uint64 total wraps", () => {
  const P = "9223372036854775808ns"; // exactly 1<<63, which Go's leadingInt allows

  assert.equal(goDurationNs(P), null, "one of them is over int64 at the end");
  assert.equal(goDurationNs(P + "1ns"), null, "and so is one plus a little");
  assert.equal(goDurationNs(P + P), null, "two wrap to zero, which is not a lifetime");
  assert.equal(goDurationNs(P + P + "1ns"), 1n, "two wrap to zero, then 1ns is 1ns");
  assert.equal(goDurationNs(P + P + P + P + "1ns"), 1n, "four wrap twice, same answer");
  assert.equal(goDurationNs(P + P + "9223372036854775807ns"), 9223372036854775807n);
  assert.equal(goDurationNs(P + P + P), null, "three land back on 1<<63, over int64");

  // Order matters, because the check runs after every single add: the wrap only
  // survives when nothing in between has already been caught above 1<<63.
  assert.equal(goDurationNs("1ns" + P + P), null, "1ns first pushes the sum over");
  assert.equal(goDurationNs(P + "1ns" + P), null, "and so does 1ns in the middle");

  // A fraction after the wrap is measured from the wrapped total, not a bigger one.
  assert.equal(goDurationNs(P + P + "0.5s"), 500000000n);
  assert.equal(goDurationNs("-" + P + P + "1ns"), null, "negative is still refused");
});

// ── The boundary a cross-vendor review put a name to ─────────────────────────
//
// Go accumulates the fraction in a uint64 and stops it at `y > 1<<63`, one
// above int64's maximum. Stopping at INT64_MAX instead ends the accumulation a
// digit early on a fraction beginning exactly 9223372036854775808 -- Go keeps
// (1<<63, scale 1e19), the tighter bound keeps (922337203685477580, 1e18) --
// and the fractional term is then computed from a different pair.
//
// Both pairs happen to truncate to the same nanoseconds for all six units, so
// the tighter bound was not returning wrong answers; it was one float64
// rounding away from doing so, on a value nothing in the type system pins. The
// rows below are the real oracle's answers at that exact prefix.
test("the fraction accumulator stops where Go's uint64 one stops", () => {
  for (const [input, expected] of ORACLE) {
    if (!input.includes("9223372036854775808") || !input.includes(".")) continue;
    assert.equal(goDurationNs(input), expected,
      `${JSON.stringify(input)}: the fraction accumulator diverged from Go`);
  }
  // The review's own counterexample. It was offered as a value this port
  // accepts and Go refuses; Go accepts it too, at exactly int64 max, and the
  // case is kept because that is the tightest accept there is.
  assert.equal(goDurationNs("9223368515078286331ns0.9782712470769444004h"),
    9223372036854775807n, "int64 max reached through a fractional hour");
});

test("relaxing the internal bounds did not relax the result", () => {
  // Every guard inside now runs to 1<<63, as Go's do, which means the final
  // clamp is the only thing standing between int64 max and one past it.
  assert.equal(goDurationNs("9223372036854775807ns"), 9223372036854775807n);
  assert.equal(goDurationNs("9223372036854775808ns"), null);
  assert.equal(goDurationNs("9223372036854775806ns1ns"), 9223372036854775807n);
  assert.equal(goDurationNs("9223372036854775807ns1ns"), null);
  assert.equal(goDurationNs("9223372036854775807ns1.922337203685477580843ns"), null,
    "a fractional segment must not carry the total past int64 max either");
});

test("a fraction long enough to break float maths returns a value, not an exception", () => {
  // 309 digits made `scale` infinite, `f/scale` NaN, and `BigInt(NaN)` a
  // RangeError -- thrown at module load, from a config value, which is a crash
  // loop rather than a rejected setting. Go's leadingFraction stops scaling when
  // it stops accumulating, so it reads this as 1s.
  assert.equal(goDurationNs("." + "9".repeat(309) + "s"), S,
    "matches time.ParseDuration on the same input");
  assert.equal(goDurationNs("0." + "9".repeat(400) + "h"), 3600n * S,
    "and on this one");
  assert.doesNotThrow(() => goDurationNs("0." + "9".repeat(5000) + "h"));
});

test("zero and negative are refused, however they are spelled", () => {
  // Go takes all of these; the Workload Manager applies an override only when
  // it is positive, so they would reach the sandbox as nothing at all.
  for (const z of ["0", "0s", "0h0m0s", "-0s", "+0s", "0.1ns", "0.6ns0.6ns"]) {
    assert.equal(goDurationNs(z), null, `${JSON.stringify(z)} is not a lifetime`);
  }
  assert.equal(goDurationNs("-1s"), null, "negative is refused, not negated");
});
