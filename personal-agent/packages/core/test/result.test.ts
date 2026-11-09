// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { err, errorName, InvariantError, mapResult, ok, unreachable, valueOr } from "../src/index.js";

test("ok and err carry their value and their failure", () => {
  assert.deepEqual(ok(3), { ok: true, value: 3 });
  assert.deepEqual(err({ kind: "nope" }), { ok: false, error: { kind: "nope" } });
});

test("valueOr gives the value, or the fallback for a failure", () => {
  assert.equal(valueOr(ok(1), 9), 1);
  assert.equal(valueOr(err({ kind: "x" }), 9), 9);
});

test("mapResult maps a value and passes a failure through unchanged", () => {
  assert.deepEqual(
    mapResult(ok(2), (v) => v * 10),
    ok(20),
  );
  const failure = err({ kind: "x" });
  assert.equal(
    mapResult(failure, () => 1),
    failure,
  );
});

test("errorName names the kind of error only, never its message", () => {
  assert.equal(errorName(new TypeError("secret text")), "TypeError");
  assert.equal(errorName(new InvariantError("x")), "InvariantError");
  class Custom extends Error {}
  const custom = new Custom("x");
  custom.name = "";
  assert.equal(errorName(custom), "Custom");
  assert.equal(errorName("a string"), "string");
  assert.equal(errorName(null), "null");
  assert.equal(errorName(undefined), "undefined");
});

test("unreachable throws an InvariantError naming the case", () => {
  assert.throws(
    () => unreachable("x" as never),
    (e: unknown) => e instanceof InvariantError && /"x"/.test(e.message),
  );
});
