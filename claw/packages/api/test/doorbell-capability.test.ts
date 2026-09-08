// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The publisher gate: whether this pod may send a doorbell, and whether one it
 * already decided to send is still on its way.
 *
 * The deployment's intent and the fleet's readiness are two different facts and
 * neither substitutes for the other, so both are proved necessary here. The
 * barrier is proved at the interleaving a boolean gate gets wrong: a revocation
 * landing between the branch and the publish closes the gate on every pod while
 * a dispatch is still able to publish, and a rollback that read only the
 * boolean would take that as proof nothing more is coming.
 */

import "./doorbell-dispatch-on-env.js";

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

import {
  beginDoorbellDispatch, closeDoorbellLatch, doorbellGateOpen, doorbellInFlight, doorbellLatch,
  latchFromOperation, resetDoorbellGate, setDoorbellLatch,
} from "../src/tasks/doorbell-gate.js";

const SUPPORTED = DOORBELL_SEMANTICS_VERSION;

beforeEach(() => { resetDoorbellGate(); });

test("a pod that has never seen the floor dispatches fat", () => {
  assert.equal(doorbellLatch().state, "unknown");
  assert.equal(doorbellGateOpen(), false);
  assert.equal(beginDoorbellDispatch(), null);
});

test("each latch state maps to the gate value it is supposed to", () => {
  setDoorbellLatch({ state: "floor", version: SUPPORTED });
  assert.equal(doorbellGateOpen(), true, "a floor at this API's own version opens it");
  setDoorbellLatch({ state: "floor", version: SUPPORTED + 1 });
  assert.equal(doorbellGateOpen(), true, "a fleet ahead of this API can still take its doorbells");
  setDoorbellLatch({ state: "floor", version: SUPPORTED - 1 });
  assert.equal(doorbellGateOpen(), false, "a fleet below the floor cannot");
  setDoorbellLatch({ state: "revoked" });
  assert.equal(doorbellGateOpen(), false);
  setDoorbellLatch({ state: "invalid", value: "x" });
  assert.equal(doorbellGateOpen(), false);
  setDoorbellLatch({ state: "unknown", reason: "watch died" });
  assert.equal(doorbellGateOpen(), false);
});

test("a delete revokes, and only a write re-opens", () => {
  setDoorbellLatch(latchFromOperation("PUT", String(SUPPORTED)));
  assert.equal(doorbellGateOpen(), true);
  setDoorbellLatch(latchFromOperation("DEL", null));
  assert.equal(doorbellLatch().state, "revoked");
  assert.equal(doorbellGateOpen(), false, "revoked does not decay back to a floor on its own");
  setDoorbellLatch(latchFromOperation("PUT", String(SUPPORTED)));
  assert.equal(doorbellGateOpen(), true);
});

test("a watch that dies closes the gate rather than serving its last value", () => {
  // A floor whose feed is dead is an assertion nobody can revoke.
  setDoorbellLatch({ state: "floor", version: SUPPORTED });
  closeDoorbellLatch("iterator ended");
  assert.equal(doorbellLatch().state, "unknown");
  assert.equal(doorbellGateOpen(), false);
});

test("an unparseable value is invalid, which is not the same fact as absent", () => {
  for (const bad of ["", "  ", "one", "-1", "0", "1.5", "1e3", "01x"]) {
    setDoorbellLatch(latchFromOperation("PUT", bad));
    assert.equal(doorbellLatch().state, "invalid", `expected ${JSON.stringify(bad)} to be invalid`);
    assert.equal(doorbellGateOpen(), false);
  }
});

test("an observed floor stays open until another operation arrives", () => {
  setDoorbellLatch({ state: "floor", version: SUPPORTED });
  const before = doorbellLatch();
  assert.deepEqual(doorbellLatch(), before);
  assert.equal(doorbellGateOpen(), true);
});

test("a token is issued only while gate and barrier are both open", () => {
  setDoorbellLatch({ state: "floor", version: SUPPORTED });
  const token = beginDoorbellDispatch();
  assert.ok(token);
  assert.equal(doorbellInFlight(), 1);
  token!.release();
  assert.equal(doorbellInFlight(), 0);
});

test("a revocation mid-dispatch closes the gate while the in-flight count stays up", () => {
  // This is the ordering a bare boolean gets wrong: gate 0 and in_flight 1 is
  // NOT a satisfied rollback precondition, and asserting only the end state
  // would pass against a boolean gate.
  setDoorbellLatch({ state: "floor", version: SUPPORTED });
  const token = beginDoorbellDispatch();
  assert.ok(token);

  setDoorbellLatch({ state: "revoked" });
  assert.equal(doorbellGateOpen(), false);
  assert.equal(doorbellInFlight(), 1, "a dispatch past the branch is not aborted");
  assert.equal(beginDoorbellDispatch(), null, "and no further token is issued");

  token!.release();
  assert.equal(doorbellInFlight(), 0, "only now is the precondition satisfied");
});

test("releasing twice does not drive the count negative", () => {
  setDoorbellLatch({ state: "floor", version: SUPPORTED });
  const token = beginDoorbellDispatch();
  token!.release();
  token!.release();
  assert.equal(doorbellInFlight(), 0);
});

test("the barrier does not flicker open while the latch is closed", () => {
  setDoorbellLatch({ state: "floor", version: SUPPORTED });
  setDoorbellLatch({ state: "unknown", reason: "watch died" });
  assert.equal(beginDoorbellDispatch(), null);
  assert.equal(beginDoorbellDispatch(), null);
});
