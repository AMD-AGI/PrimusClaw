// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The same reconciliation cases in a process that set the switch to `"false"`.
 *
 * An operator who writes the value out is owed the behaviour of one who never
 * heard of it, and the parse is the only thing that separates the two: the
 * cases come from reconcile-off-cases.ts unchanged, and only the environment
 * this file establishes differs from reconcile-off-absent.test.ts.
 */

import "./reconcile-off-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, type Harness } from "./scenario-harness.js";
import { registerReconcileOffCases } from "./reconcile-off-cases.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

test("this process was given the variable explicitly, and it reads the same", async () => {
  const { RUN_FAT_PREPARING_RECONCILE } = await import("../src/config.js");
  const { gateOwnershipEnforced } = await import("../src/tasks/chat-run.js");

  assert.equal(process.env.RUN_FAT_PREPARING_RECONCILE, "false");
  assert.equal(RUN_FAT_PREPARING_RECONCILE, false);
  assert.equal(gateOwnershipEnforced(), false);
});

registerReconcileOffCases(() => h);
