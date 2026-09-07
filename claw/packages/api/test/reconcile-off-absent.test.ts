// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reconciliation cases in a process that was never told about the switch.
 *
 * There is deliberately no environment module here: the setting defaults off,
 * so an untouched process is the deployment every replica is before the flip.
 * Importing ./reconcile-on-env.js here -- copied in alongside a mirrored case
 * from one of the ON suites -- would invert every case below without failing
 * one. reconcile-off-false.test.ts is the same cases with the value set.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, type Harness } from "./scenario-harness.js";
import { registerReconcileOffCases } from "./reconcile-off-cases.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

test("this process was never given the variable, which is the default the cases below run under", async () => {
  const { RUN_FAT_PREPARING_RECONCILE } = await import("../src/config.js");
  const { gateOwnershipEnforced } = await import("../src/tasks/chat-run.js");

  assert.equal(process.env.RUN_FAT_PREPARING_RECONCILE, undefined);
  assert.equal(RUN_FAT_PREPARING_RECONCILE, false);
  assert.equal(gateOwnershipEnforced(), false);
});

registerReconcileOffCases(() => h);
