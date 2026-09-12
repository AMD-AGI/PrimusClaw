// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The kill-switch, in a process that has it off.
 *
 * `RUN_DOORBELL_DISPATCH` is read at import, so proving both values needs two
 * processes; node's test runner gives one per file, and this is the off half.
 * The on half is doorbell-semantics.test.ts.
 */

import { claimNextEnabled } from "../src/delivery/claim-next-loop.js";
import "./doorbell-kill-switch-env.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { RUN_DOORBELL_DISPATCH } from "../src/config.js";
import { handleTask } from "../src/tasks/dispatch.js";
import { bindDelivery, doorbellPayload, fakeDelivery, recordClaims } from "./doorbell-wire.js";

test("the switch is off in this process, so the cases below mean what they say", () => {
  assert.equal(RUN_DOORBELL_DISPATCH, false);
});

test("a killed pod acks the doorbell and never attempts the claim", async () => {
  // Acking is what leaves the row queued for a sibling that is not killed.
  // Naking would be a poison loop with max_retries_exceeded at the end of it,
  // which reports the wrong cause for a fleet-wide switch.
  const claims = recordClaims();
  const { msg, verdicts } = fakeDelivery(doorbellPayload());
  try {
    await handleTask(msg);
  } finally {
    claims.restore();
  }
  assert.deepEqual(verdicts, ["ack"]);
  assert.deepEqual(claims.urls, []);
});

test("a killed pod still executes a fat execute request", async () => {
  // The switch is scoped to doorbell execution. A pod that stopped taking fat
  // work would be a drain, which is a different control with a different
  // rollout meaning.
  const { events } = bindDelivery();
  const claims = recordClaims();
  const { msg } = fakeDelivery({
    session_id: "sess-wire", message_id: "claw-wire", prompt: "hi", user_id: "u1",
  });
  try {
    await handleTask(msg);
  } finally {
    claims.restore();
  }
  assert.deepEqual(claims.urls, [], "the fat path claims nothing");
  assert.ok(
    events.length > 0,
    "a declined delivery emits nothing, so an executed fat one must emit something",
  );
});

test("the switch closes the claim-next route as well, not only the doorbell wire", () => {
  // A pod that acks and walks away from a doorbell, then claims the same row
  // through the polling loop seconds later, is a rollback that appears to have
  // no effect: the switch has to gate both routes or it is not a switch. And
  // a pod with no API base cannot claim at all -- every cycle would fail at
  // the POST -- so both inputs have to hold, not either.
  //
  // This used to read `src/index.ts` as text and check the spelling of the
  // expression, because the entrypoint runs `main()` on import. The decision
  // now lives in the module that owns the loop, so the four combinations are
  // asserted rather than the characters that compute them.
  assert.equal(claimNextEnabled("http://api", true), true, "both halves present");
  assert.equal(claimNextEnabled("http://api", false), false, "the kill-switch closes it");
  assert.equal(claimNextEnabled(undefined, true), false, "nothing to claim against");
  assert.equal(claimNextEnabled(undefined, false), false);
  assert.equal(claimNextEnabled("", true), false, "an empty base is no base");
});
