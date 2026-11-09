// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { whenOf } from "../../src/inbound-text/when.js";

const WHEN = "2026-11-03 08:36 UTC";

test("the time of a quote is read only when it is a time", () => {
  assert.equal(whenOf("1793695000000"), WHEN);
  assert.equal(whenOf("1793695000"), WHEN);
  assert.equal(whenOf("2026-11-03T10:36:40+02:00"), WHEN);
  assert.equal(whenOf("2026-11-03 08:36:40"), WHEN);
  for (const bad of ["", "soon", "99999999999999999999999", "-5", "12:30"]) assert.equal(whenOf(bad), "", bad);
});

// Expectations measured with CPython's `activity._when`.
const MEASURED: readonly (readonly [string, string])[] = [
  ["2026-11-03", "2026-11-03 00:00 UTC"],
  ["20261103", "1970-08-23 12:05 UTC"],
  ["2026-11-03T0836", WHEN],
  ["2026-11-03T08", "2026-11-03 08:00 UTC"],
  ["2026-11-03T08:36:40.123456Z", WHEN],
  ["2026-11-03T08:36:40,5", WHEN],
  ["2026-11-03x08:36", WHEN],
  ["2026-11-03T08:36:40-0130", "2026-11-03 10:06 UTC"],
  ["2026-11-03T08:36:40+01", "2026-11-03 07:36 UTC"],
  ["2026-11-03T08:36:40+01:00:30", "2026-11-03 07:36 UTC"],
  ["2026-11-03T08:36:40+0130", "2026-11-03 07:06 UTC"],
  ["2026-11-03T08:36:40+23:59", "2026-11-02 08:37 UTC"],
  ["2026-11-03T08:36:40+24:00", ""],
  ["2026-11-03T08:36:40Z+01", ""],
  ["2026-W45-2", "2026-11-03 00:00 UTC"],
  ["2026W452", "2026-11-03 00:00 UTC"],
  ["2026-W45", "2026-11-02 00:00 UTC"],
  ["2026-02-30", ""],
  ["2024-02-29", "2024-02-29 00:00 UTC"],
  ["0005-01-01", "0005-01-01 00:00 UTC"],
  ["253402300799999", "9999-12-31 23:59 UTC"],
  ["253402300800000", ""],
  ["2026-11-03T24:00", "2026-11-04 00:00 UTC"],
  ["2026-11-03T24:01", ""],
  ["2026-11-03T08:36:40.1234567", WHEN],
  ["2026-11-03T08:60", ""],
  ["2026-11-03T083640", WHEN],
  ["  1793695000000  ", WHEN],
  ["2026-1-03", ""],
  ["+2026-11-03", ""],
  ["0", "1970-01-01 00:00 UTC"],
];

test("iso dates and epoch numbers read as python reads them", () => {
  for (const [raw, expected] of MEASURED) assert.equal(whenOf(raw), expected, raw);
});

test("an iso week 53 exists only in a long year", () => {
  assert.equal(whenOf("2026-W53-1"), "2026-12-28 00:00 UTC");
  assert.equal(whenOf("2025-W53-1"), "");
  assert.equal(whenOf("2025-W00-1"), "");
});

test("an offset that moves a time out of the years one to 9999 is not a time and only the whole offset is checked", () => {
  assert.equal(whenOf("9999-12-31T23:59-01:00"), "");
  assert.equal(whenOf("0001-01-01T00:00+01:00"), "");
  assert.equal(whenOf("2026-11-03T08:36:40+01:60"), "2026-11-03 06:36 UTC");
});

test("a time written in any script's decimal digits reads as python's int() reads it", () => {
  // (expected values computed by the Python worker's _when)
  const cases: Array<[string, string]> = [
    ["1762152800", "2025-11-03 06:53 UTC"],
    ["1762152800123", "2025-11-03 06:53 UTC"],
    ["١٧٦٢١٥٢٨٠٠", "2025-11-03 06:53 UTC"],
    ["１７６２１５２８００", "2025-11-03 06:53 UTC"],
    ["１７６２１５２８００１２３", "2025-11-03 06:53 UTC"],
    ["¹⁷⁶²", ""],
    ["17621528001234567890123", ""],
    ["0", "1970-01-01 00:00 UTC"],
    ["99999999999999999999999999999999999", ""],
    ["2026-11-03T08:36:00+08:00", "2026-11-03 00:36 UTC"],
    ["２０２６-11-03", ""],
    ["20261103T0836Z", "2026-11-03 08:36 UTC"],
    ["2026-W45-2T10:00", "2026-11-03 10:00 UTC"],
    ["  1762152800 ", "2025-11-03 06:53 UTC"],
    ["1762152800.5", ""],
    ["", ""],
  ];
  for (const [raw, expected] of cases) assert.equal(whenOf(raw), expected, raw);
});
