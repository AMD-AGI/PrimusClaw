// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two ways a configured number used to be wrong without anyone noticing.
 *
 * Both are pinned here rather than at the call sites because the call sites are
 * config files evaluated at import time, where a wrong value has already been
 * frozen into a constant by the time a test could look at it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { readIntSetting, PG_INT4_MAX } from "../src/env-settings.js";

test("an absent setting is not a problem", () => {
  // The distinction the callers depend on: nothing to report, use the default.
  assert.equal(readIntSetting(undefined), null);
  assert.equal(readIntSetting(""), null);
  assert.equal(readIntSetting("   "), null);
});

test("a value is read whole, not up to the first thing it does not understand", () => {
  // parseInt read `6e4` as 6, which turned a one-minute sweeper into a 6 ms
  // busy loop against the database, and `60s` into 60 ms the same way.
  assert.deepEqual(readIntSetting("6e4"), { value: 60_000 });
  assert.deepEqual(readIntSetting("60000"), { value: 60_000 });
  assert.deepEqual(readIntSetting("  60000  "), { value: 60_000 });
  assert.ok("problem" in readIntSetting("60s")!, "a unit suffix is a typo, not a number");
  assert.ok("problem" in readIntSetting("6 0")!);
  assert.ok("problem" in readIntSetting("abc")!);
});

test("a value too wide for the query it ends up in is refused", () => {
  // 3000000000 seconds passed every sanity check its callers made and then
  // overflowed `$1::int` on every sweeper tick. Because the reaper reading it
  // runs third, the four behind it were skipped on every pass -- the visible
  // symptom was elsewhere entirely.
  assert.ok("problem" in readIntSetting("3000000000")!);
  assert.deepEqual(readIntSetting(String(PG_INT4_MAX)), { value: PG_INT4_MAX });
  assert.ok("problem" in readIntSetting(String(PG_INT4_MAX + 1))!);
});

test("bounds are the caller's to narrow, and default to permissive", () => {
  // Several settings use zero or a negative value to mean "off", so the parser
  // cannot assume positivity; the ones that need it ask.
  assert.deepEqual(readIntSetting("0"), { value: 0 });
  assert.deepEqual(readIntSetting("-1"), { value: -1 });
  assert.ok("problem" in readIntSetting("0", { min: 1 })!);
  assert.deepEqual(readIntSetting("5", { min: 1, max: 10 }), { value: 5 });
  assert.ok("problem" in readIntSetting("11", { min: 1, max: 10 })!);
});

test("the reason says what was wrong with it", () => {
  // It reaches an operator through a startup log line and is the only thing
  // telling them their setting is not the one in effect.
  const tooBig = readIntSetting("99", { max: 10 });
  assert.match((tooBig as { problem: string }).problem, /outside the usable range -?\d+\.\.10/);
  const notANumber = readIntSetting("ten");
  assert.match((notANumber as { problem: string }).problem, /not a number/);
});

test("a fraction is truncated, the way every parser this replaces did", () => {
  assert.deepEqual(readIntSetting("1.9"), { value: 1 });
  assert.deepEqual(readIntSetting("-1.9"), { value: -1 });
});

/**
 * The two defaults above are wrong for a setting whose values are an
 * enumeration rather than a quantity. `CHECKPOINT_WRITE_VERSION` is the one in
 * this repo: 3 and 4 are two different on-disk formats, so `3.5` truncating to
 * 3 and a blank falling back to 3 both hand back a legal-looking neighbour of
 * what was asked for -- and 3 is the weaker format, written while the values
 * file reads as though sealing had been requested. Opt-in, so no existing
 * caller's meaning changes.
 */
test("wholeNumbersOnly refuses a fraction instead of truncating toward a legal value", () => {
  assert.deepEqual(readIntSetting("3.5", { min: 3, max: 4, wholeNumbersOnly: true }), {
    problem: "is not a whole number",
  });
  assert.deepEqual(readIntSetting("2.9", { min: 3, max: 4, wholeNumbersOnly: true }), {
    problem: "is not a whole number",
  });
  // The shape it is refusing is the fraction, not the number: whole values,
  // however written, still read as themselves.
  assert.deepEqual(readIntSetting("4", { min: 3, max: 4, wholeNumbersOnly: true }), { value: 4 });
  assert.deepEqual(readIntSetting(" 3 ", { min: 3, max: 4, wholeNumbersOnly: true }), { value: 3 });
  assert.deepEqual(readIntSetting("4.0", { min: 3, max: 4, wholeNumbersOnly: true }), { value: 4 });
  // And range is still range: it must not be reported as a fraction.
  assert.deepEqual(readIntSetting("5", { min: 3, max: 4, wholeNumbersOnly: true }), {
    problem: "is outside the usable range 3..4",
  });
});

test("blankIsRefused tells a key that rendered empty from a key nobody set", () => {
  assert.deepEqual(readIntSetting("", { blankIsRefused: true }), { problem: "is blank" });
  assert.deepEqual(readIntSetting("   ", { blankIsRefused: true }), { problem: "is blank" });
  // Unset stays absent under any options. There is no configured value to
  // refuse, and refusing it would make every unset setting fatal.
  assert.equal(readIntSetting(undefined, { blankIsRefused: true }), null);
  assert.equal(readIntSetting(null, { blankIsRefused: true }), null);
  // Off by default, or every `.env.example` key left empty becomes a refusal.
  assert.equal(readIntSetting(""), null);
});
