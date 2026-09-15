// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a process that was never told about the switch now does.
 *
 * There is deliberately no environment module here, and that used to mean the
 * off cases: the setting defaulted off, so an untouched process was the
 * deployment every replica is before the flip. The default is on, so an
 * untouched process is a deployment that has asserted the contract, and the
 * cases this file used to register moved to the one that sets the value --
 * reconcile-off-false.test.ts, which is now the only place the unasserted
 * behaviour is pinned and says so.
 *
 * What is left here is the default itself. It is a real production fact: every
 * deployment that renders no value for this variable reaps fat rows on the
 * fleet assertion alone, and a fleet rolling up from a release without the
 * durable holder has to set `false` for the duration or a reaper will close a
 * delivery that is about to execute.
 */

import test from "node:test";
import assert from "node:assert/strict";

test("a process that was never given the variable has the contract asserted", async () => {
  const { RUN_FAT_PREPARING_RECONCILE } = await import("../src/config.js");
  const { gateOwnershipEnforced } = await import("../src/tasks/chat-run.js");

  assert.equal(process.env.RUN_FAT_PREPARING_RECONCILE, undefined);
  assert.equal(
    RUN_FAT_PREPARING_RECONCILE, true,
    "the default is the deployment's answer for everyone who does not give one",
  );
  assert.equal(
    gateOwnershipEnforced(), true,
    "and the gate's ownership marker has readers again, not only writers",
  );
});
