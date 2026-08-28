// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Can a cleanup path tell "this deployment has no GPU clusters" apart from
 * "tearing them down failed"?
 *
 * getMultiNodeProvider throws for a deployment without SaFE rather than
 * degrading, which is right for the provisioning paths. Session teardown is on
 * the other side of that: it has to reclaim whatever the session owns, and in
 * kubernetes mode that is a Sandbox CR the agent-sandbox provider already
 * handled, with no clusters at all. Calling the factory there marked every
 * session delete incomplete and queued a full budget of retries that failed
 * identically, so the teardown checks availability first.
 *
 * That check is only sound while it agrees with the factory, which is what this
 * pins: false here must mean the factory throws.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Read at module load, so the mode has to be set before the dynamic import.
process.env.CLAW_DEPLOY_MODE = "kubernetes";

const { getMultiNodeProvider, multiNodeAvailable } = await import(
  "../src/sandbox/multi-node/factory.js"
);

test("a deployment without SaFE reports no multi-node", () => {
  assert.equal(multiNodeAvailable(), false);
});

test("and the factory refuses to hand one out, which is why the check exists", () => {
  // The two must not drift: a caller that skips on `false` would otherwise start
  // calling a factory that no longer throws, or keep hitting a throw it thought
  // it had avoided.
  assert.throws(() => getMultiNodeProvider(), /CLAW_DEPLOY_MODE=safe/);
});

test("it throws synchronously, so a chained .catch cannot absorb it", () => {
  // Which rules out `getMultiNodeProvider().destroyForSession(...).catch(log)`:
  // the throw happens while evaluating the expression, before any promise exists,
  // so a rejection handler chained onto it never sees it. Both call sites sit
  // somewhere an escaping error does real damage — a `for await` subscription
  // loop, and a task's terminal path — so each needs either a prior availability
  // check or a real try/catch. If this ever becomes an async rejection instead,
  // those guards can be revisited.
  let escaped: unknown;
  try {
    getMultiNodeProvider();
  } catch (e) {
    escaped = e;
  }
  assert.ok(escaped instanceof Error, "thrown before a promise is returned");
});
