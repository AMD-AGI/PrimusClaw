// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A cancelled run is not a provisioning failure.
 *
 * `ensureHands` throws for two unrelated reasons. One is that the sandbox could
 * not be built -- the control plane refused it, the image would not pull, Hands
 * never answered /health -- and that belongs on
 * `claw_sandbox_start_total{outcome="error"}`, because a user is sitting in
 * front of a session that cannot start. The other is that the run was cancelled
 * while ensureHands was still working: a lease lost to another replica, a user
 * interrupt, SIGTERM. Nothing refused anything there; the caller stopped wanting
 * a sandbox, and the abort signal cancels the probe mid-flight.
 *
 * Counting the second as an error is not a rounding issue. Lease handovers and
 * redeliveries cluster during a rolling update, so the false positives arrive in
 * a burst exactly when a deploy is in progress, and the panel reports a
 * provisioning outage caused by the deploy -- when what it is really watching is
 * the drain working as designed. This was observed on the first rollout after
 * the counter was wired up: one `outcome="error"` recorded for a session whose
 * log line above it read `run.lease_refused refusal="superseded"`, on a reuse
 * path that never attempted a creation at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/sandbox/ensure-hands.ts", import.meta.url)),
  "utf8",
);

/** The instrumented wrapper, from `export async function ensureHands` to its close. */
function wrapperSource(): string {
  const start = SRC.indexOf("export async function ensureHands(");
  assert.notEqual(start, -1, "could not find the exported ensureHands wrapper");
  const end = SRC.indexOf("\nfunction toHex(", start);
  assert.notEqual(end, -1, "could not find the end of the wrapper");
  return SRC.slice(start, end);
}

test("the sandbox-start error counter is not incremented on an aborted call", () => {
  const body = wrapperSource();

  const errorCall = body.indexOf('metrics.onSandboxStart("error"');
  assert.notEqual(errorCall, -1, "the wrapper no longer records a failed creation at all");

  // The guard has to be the thing that encloses the increment, not merely
  // present somewhere in the function: an abort check that does not gate the
  // call would pass a `includes` assertion while counting every cancellation.
  const guard = body.indexOf("options.signal?.aborted");
  assert.notEqual(guard, -1, "no abort guard around the error counter");
  assert.ok(
    guard < errorCall,
    "the abort guard must come before the increment it protects",
  );
  const between = body.slice(guard, errorCall);
  assert.match(
    between,
    /^options\.signal\?\.aborted\)\s*\{\s*$/,
    "the abort check should be what opens the block holding the increment, with "
      + `nothing else in between; found: ${JSON.stringify(between)}`,
  );
});

test("a successful call is only counted when a sandbox was actually created", () => {
  const body = wrapperSource();
  const okCall = body.indexOf('metrics.onSandboxStart("ok"');
  assert.notEqual(okCall, -1, "the wrapper no longer records a successful creation");

  const guard = body.indexOf("result.created");
  assert.notEqual(guard, -1, "no `created` guard around the success counter");
  assert.ok(
    guard < okCall,
    "reuse and the local-dev short-circuit return created:false and are not "
      + "creation attempts; counting them would put the reuse rate into a "
      + "histogram whose help text promises creation time",
  );
});
