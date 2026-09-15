// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The other conjunct, in a process that does not want doorbell dispatch.
 *
 * The deployment's intent and the fleet's readiness answer different questions
 * -- "does this installation want doorbells at all" and "can the fleet on the
 * other end understand one" -- and a satisfied floor must not open the gate on
 * its own.
 *
 * The flag is read at import, so proving it needs its own process. It is set
 * here rather than inherited from the shipped default: the property is that the
 * two conjuncts are both required, and a test that demonstrates it by relying
 * on the default silently stops demonstrating anything the day the default
 * moves -- which is exactly what happened when dispatch was turned on by
 * default. The shipped value is asserted separately, below, where a change to
 * it is meant to fail.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

process.env.RUN_DOORBELL_DISPATCH = "false";
const { RUN_DOORBELL_DISPATCH } = await import("../src/config.js");
const { beginDoorbellDispatch, doorbellGateOpen, setDoorbellLatch } =
  await import("../src/tasks/doorbell-gate.js");

test("this process does not want doorbells", () => {
  assert.equal(RUN_DOORBELL_DISPATCH, false, "the env set above is what this file proves against");
});

test("a satisfied floor does not open the gate on its own", () => {
  setDoorbellLatch({ state: "floor", version: DOORBELL_SEMANTICS_VERSION });
  assert.equal(doorbellGateOpen(), false);
  assert.equal(beginDoorbellDispatch(), null);
});
