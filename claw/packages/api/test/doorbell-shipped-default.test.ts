// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an installation that names no value gets.
 *
 * Its own file because it needs a process with the variable unset, and its own
 * test because the shipped default is a decision rather than a detail: turning
 * it off again is a rollout-visible change and should have to edit an assertion
 * that says so.
 *
 * On, and safe to ship on, because the flag is only one of the two conjuncts.
 * An API whose fleet has asserted no capability floor -- or one below the
 * semantics version this binary implements -- resolves to fat dispatch on its
 * own, so a mixed fleet is guarded by the floor rather than by this value.
 */

import test from "node:test";
import assert from "node:assert/strict";

delete process.env.RUN_DOORBELL_DISPATCH;
const { RUN_DOORBELL_DISPATCH } = await import("../src/config.js");

test("doorbell dispatch ships on", () => {
  assert.equal(RUN_DOORBELL_DISPATCH, true);
});

test("a fleet that has asserted nothing is a version-1 fleet, not an unknown one", async () => {
  // The floor's whole job is to stop a v2 doorbell reaching a fleet that only
  // speaks v1. It cannot do that job at v1, where there is nothing older to
  // protect -- and every other reader already reads absence as 1
  // (`doorbellSemanticsOf`, and COALESCE(...,1) in both claim filters). Starting
  // at `unknown` therefore turned every existing doorbell installation off on
  // upgrade and asked for an operator step to restore what it already had.
  const { doorbellGateOpen, doorbellLatch, beginDoorbellDispatch, DOORBELL_SEMANTICS_BASELINE } =
    await import("../src/tasks/doorbell-gate.js");
  assert.deepEqual(doorbellLatch(), { state: "floor", version: DOORBELL_SEMANTICS_BASELINE });
  assert.equal(doorbellGateOpen(), true, "no assertion, and the gate is open at the baseline");
  // The one that decides dispatch. `doorbellGateOpen` does not read the barrier,
  // so asserting only that passed while a barrier seeded `false` sent every turn
  // down the fat path on a live cluster: an empty floor bucket delivers no watch
  // event, and nothing else moves the barrier.
  const token = beginDoorbellDispatch();
  assert.notEqual(token, null, "a token, or the caller publishes fat whatever the latch says");
  token?.release();
});

test("an explicit revocation still closes it", async () => {
  const { doorbellGateOpen, setDoorbellLatch, latchFromOperation } =
    await import("../src/tasks/doorbell-gate.js");
  setDoorbellLatch(latchFromOperation("DEL", null));
  assert.equal(doorbellGateOpen(), false, "a delete is an operator saying no, and outranks the baseline");
});
