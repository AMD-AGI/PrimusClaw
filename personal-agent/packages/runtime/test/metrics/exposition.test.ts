// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatNumber, pyFloatRepr, round3 } from "../../src/index.js";

// Each row: the value, Python's repr(v), Python's metric number, repr(round(v, 3)) (printed by Python 3.14).
const PYTHON: ReadonlyArray<readonly [number, string, string, string]> = [
  [0.5, "0.5", "0.5", "0.5"],
  [1.0, "1.0", "1", "1.0"],
  [2.375, "2.375", "2.375", "2.375"],
  [1e-5, "1e-05", "1e-05", "0.0"],
  [0.0001, "0.0001", "0.0001", "0.0"],
  [123.456, "123.456", "123.456", "123.456"],
  [1e16, "1e+16", "10000000000000000", "1e+16"],
  [1.5e16, "1.5e+16", "15000000000000000", "1.5e+16"],
  [0.0625, "0.0625", "0.0625", "0.062"],
  [-0.5, "-0.5", "-0.5", "-0.5"],
  [1e-7, "1e-07", "1e-07", "0.0"],
];

describe("Python number formatting", () => {
  it("writes floats, metric numbers and rounded sums as Python does", () => {
    for (const [value, repr, metric, rounded] of PYTHON) {
      assert.equal(pyFloatRepr(value), repr, String(value));
      assert.equal(formatNumber(value), metric, String(value));
      assert.equal(pyFloatRepr(round3(value)), rounded, String(value));
    }
    assert.equal(pyFloatRepr(Number.NaN), "nan");
    assert.equal(pyFloatRepr(Infinity), "inf");
    assert.equal(pyFloatRepr(-Infinity), "-inf");
  });
});
