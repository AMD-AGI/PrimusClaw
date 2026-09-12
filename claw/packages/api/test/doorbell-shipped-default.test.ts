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
 * Until the API observes a capability floor at its own semantics version, the
 * production dispatch port still resolves to fat dispatch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

delete process.env.RUN_DOORBELL_DISPATCH;
const { RUN_DOORBELL_DISPATCH } = await import("../src/config.js");

test("doorbell dispatch ships on", () => {
  assert.equal(RUN_DOORBELL_DISPATCH, true);
});

test("the shipped default stays on the fat path until the fleet asserts version 1", async () => {
  const { doorbellGateOpen, doorbellLatch, setDoorbellLatch } =
    await import("../src/tasks/doorbell-gate.js");
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");

  assert.equal(doorbellLatch().state, "unknown");
  assert.equal(doorbellGateOpen(), false);
  assert.equal(sessionDispatchPorts.doorbellDispatch(), null);

  setDoorbellLatch({ state: "floor", version: DOORBELL_SEMANTICS_VERSION });
  const token = sessionDispatchPorts.doorbellDispatch();
  assert.notEqual(token, null);
  token?.release();
});

test("an explicit revocation still closes it", async () => {
  const { doorbellGateOpen, setDoorbellLatch, latchFromOperation } =
    await import("../src/tasks/doorbell-gate.js");
  setDoorbellLatch(latchFromOperation("DEL", null));
  assert.equal(doorbellGateOpen(), false);
});
