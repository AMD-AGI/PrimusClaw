// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The other conjunct, in a process that does not want doorbell dispatch.
 *
 * The deployment's intent and the fleet's readiness answer different questions
 * -- "does this installation want doorbells at all" and "can the fleet on the
 * other end understand one" -- and a satisfied floor must not open the gate on
 * its own. The flag is read at import, so proving it needs its own process.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

import { RUN_DOORBELL_DISPATCH } from "../src/config.js";
import {
  beginDoorbellDispatch, doorbellGateOpen, setDoorbellLatch,
} from "../src/tasks/doorbell-gate.js";

test("the deployment does not want doorbells in this process", () => {
  assert.equal(RUN_DOORBELL_DISPATCH, false, "the shipped default, and what this file proves against");
});

test("a satisfied floor does not open the gate on its own", () => {
  setDoorbellLatch({ state: "floor", version: DOORBELL_SEMANTICS_VERSION });
  assert.equal(doorbellGateOpen(), false);
  assert.equal(beginDoorbellDispatch(), null);
});
