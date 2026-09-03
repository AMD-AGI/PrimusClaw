// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The refusing side of the floor's boundary.
 *
 * "Positive Go duration" was the whole of the validation, and it accepts "30s"
 * -- which is not a shorter leash, it is a broken one. The idle timeout is a
 * deadline something else keeps pushing back, and the thing that pushes it
 * back runs on a cadence this setting does not get to choose: the Router
 * refreshes activity every 5 minutes while a connection is open. Below the
 * floor, the sandbox is reclaimed while it is being used, before the signal
 * saying so was ever due -- and the operator sees a sandbox that died, not a
 * setting they got wrong.
 *
 * The value here is one nanosecond under the floor rather than something
 * plainly silly. A comparison is only wrong at its boundary: `<=` where `<` was
 * meant, or a floor constant off by any amount at all, still refuse "30s" --
 * and a whole second under would still miss a floor off by less than that,
 * which is why this is written to the nanosecond the floor is counted in. The accepting side of the same
 * boundary is config-sandbox-lifetime-at-floor.test.ts, and the two have to be
 * read together -- either alone is satisfied by a check that refuses
 * everything, or nothing.
 *
 * Sibling environments: config-sandbox-lifetime.test.ts (a value well clear of
 * the boundary), config-sandbox-lifetime-refused.test.ts (does not parse at
 * all), config-sandbox-lifetime-safe.test.ts (accepted but inert).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.CLAW_DEPLOY_MODE = "kubernetes";
// One nanosecond under the 11m floor: 659_999_999_999ns against a floor of
// 660_000_000_000ns. The floor is a nanosecond quantity, so a whole second
// under it is not the boundary -- it leaves a second of slack in which the
// constant could be wrong and every test still agree. This is the largest
// value that must still be refused.
process.env.AGENT_SANDBOX_SESSION_TIMEOUT = "10m59.999999999s";
// The ceiling has no floor of its own -- a short absolute lifetime is a short
// sandbox, not a raced one -- so it is set here to stay accepted, which is
// also what keeps this file honest about which knob the refusal came from.
process.env.AGENT_SANDBOX_MAX_SESSION_DURATION = "48h";

const {
  AGENT_SANDBOX_SESSION_TIMEOUT,
  AGENT_SANDBOX_MAX_SESSION_DURATION,
  envSettingProblems,
} = await import("../src/config.js");

test("a value one nanosecond under the floor resolves to unset, like any other refusal", () => {
  assert.equal(AGENT_SANDBOX_SESSION_TIMEOUT, "");
});

test("the ceiling is untouched by the idle knob's floor", () => {
  assert.equal(AGENT_SANDBOX_MAX_SESSION_DURATION, "48h");
});

test("and the refusal names the value, the floor, and why", () => {
  const problems = envSettingProblems();
  const timeout = problems.find((p) => p.startsWith("AGENT_SANDBOX_SESSION_TIMEOUT="));
  assert.ok(timeout, `no report for a value under the floor: ${problems.join(" | ")}`);
  // The value, so the reader knows which setting they are looking for.
  assert.match(timeout!, /10m59\.999999999s/);
  // The floor, so they know what to change it to. A message that only says
  // "too low" costs a trip through the source to find out too low for what.
  assert.match(timeout!, /\b11m\b/);
  // And the cadence it is a floor for, so the number is not folklore.
  assert.match(timeout!, /\b5m\b/);
  // The ceiling is fine, so nothing should be reported about it.
  assert.equal(problems.find((p) => p.startsWith("AGENT_SANDBOX_MAX_SESSION_DURATION=")), undefined);
});
