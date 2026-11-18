// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { isoSeconds } from "../../src/feedback/iso-time.js";
import { secondsOf } from "../../src/feedback/scene.js";

// A text without an offset is local time in Python as here; the expected values were taken with TZ=UTC.
process.env["TZ"] = "UTC";

/** python3: datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp(), None where it raises ValueError. */
const PYTHON: readonly (readonly [string, number | undefined])[] = [
  ["2026", undefined],
  ["2026-01", undefined],
  ["Jan 1 2026", undefined],
  ["2026/01/01", undefined],
  ["Thu, 01 Jan 2026 00:00:00 GMT", undefined],
  [" 2026-01-01", undefined],
  ["2026-01-01 ", undefined],
  ["2026-02-30", undefined],
  ["2026-001", undefined],
  ["0000-01-01", undefined],
  ["2026-01-01", 1767225600.0],
  ["20260101", 1767225600.0],
  ["2026-01-01T00", 1767225600.0],
  ["2026-01-01T12:34", 1767270840.0],
  ["2026-01-01T123456", 1767270896.0],
  ["2026-01-01T12:34:56Z", 1767270896.0],
  ["2026-01-01t12:34:56+08:00", 1767242096.0],
  ["2026-01-01 12:34:56-0530", 1767290696.0],
  ["2026-01-01é12:34+08", 1767242040.0],
  ["2026-01-01😀12:34Z", 1767270840.0],
  ["2026-01-01T12:34:56.123456789Z", 1767270896.123456],
  ["2026-01-01T12:34:56,5Z", 1767270896.5],
  ["2026-01-01T12:34:56.Z", 1767270896.0],
  ["2026-01-01T12:34:56 Z", 1767270896.0],
  ["2026-01-01T12x+08:00", 1767240000.0],
  ["2026-01-01T123Z", 1767268800.0],
  ["2026-01-01T123", undefined],
  ["2026-01-01T12:34:56abc+08:00", undefined],
  ["2026-01-01T12:34:56é+08:00", undefined],
  ["2026-01-01T24:00", 1767312000.0],
  ["2026-12-31T24:00:00Z", 1798761600.0],
  ["2026-01-01T24:00:01", undefined],
  ["9999-12-31T24:00Z", undefined],
  ["2026-01-01T12:60", undefined],
  ["2026-01-01T12:34:60", undefined],
  ["2026-01-01T12:34:56+08:60", 1767238496.0],
  ["2026-01-01T12:34:56+24:00", undefined],
  ["2026-01-01T12:34:56+08:00:30.5", 1767242065.5],
  ["2026-01-01T12:34:56+080", undefined],
  ["2026-01-01T12:34:56+08:00x", undefined],
  ["2026-W01", 1766966400.0],
  ["2026-W01-1", 1766966400.0],
  ["2026W017", 1767484800.0],
  ["2026-W53", 1798416000.0],
  ["2020-W53-7", 1609632000.0],
  ["2026-W01-8", undefined],
  ["2026W01123", 1767049200.0],
  ["2026-W01-12", 1767009600.0],
  ["2026-01-01+08", 1767254400.0],
  ["0001-01-01T00:00", undefined],
  ["0001-01-01T00:00Z", -62135596800.0],
  ["0001-01-01T24:00", -62135510400.0],
  ["3024-02-29t23:59:59.999999-23:59:59.999999", 33266246399.999996],
  ["9999-12-31T23:59:59.999999+00:00", 253402300800.0],
  ["2026-11-09T23:22:05.123456+00:00", 1794266525.123456],
  ["2026-01-01T12:34:56:78Z", undefined],
  ["2026-01-01T12:34:56:7", undefined],
  ["2025-W53", undefined],
  ["2025-W53-1", undefined],
  ["2026W01-1", undefined],
  ["2026-W017", undefined],
  ["2026-01x01", undefined],
  ["2026-01-01T12.5Z", undefined],
  ["2026-01-01T12:34.5Z", undefined],
  ["2026-W01x1", undefined],
  ["2026-01x01T12:00Z", undefined],
];

test("an ISO time is read as Python's fromisoformat reads it", () => {
  for (const [text, seconds] of PYTHON) assert.equal(isoSeconds(text), seconds, text);
});

test("an event's time is epoch seconds or milliseconds, else such a text; nothing else", () => {
  assert.equal(secondsOf(1_700_000_000), 1_700_000_000);
  assert.equal(secondsOf(1_700_000_000_000), 1_700_000_000);
  assert.equal(secondsOf("2026"), undefined); // Date.parse takes it; Python does not
  assert.equal(secondsOf("2026-01-01T00:00:00.001100Z"), 1767225600.0011);
  assert.equal(secondsOf(""), undefined);
  assert.equal(secondsOf(true), undefined);
});

test("the reading is linear in the text's length", () => {
  const long = `2026-01-01T00:00:00.${"0".repeat(200_000)}x`;
  assert.equal(isoSeconds(long), undefined);
  assert.equal(isoSeconds(`2026-01-01T00:00:00.${"5".repeat(200_000)}+00:00`), 1767225600.555555);
});
