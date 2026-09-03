// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a value that is not a Go duration does.
 *
 * The failure this guards against is silence. Both variables are passed
 * through to a backend that parses them itself, and a backend that cannot
 * parse one does not fail the create -- it ignores the field and applies its
 * own default, which is indistinguishable from the operator never having set
 * anything. So the refusal has to happen here, out loud, and resolve to the
 * same empty string an unset variable does, so no provider invents a third
 * behaviour for "configured but bad".
 *
 * Sibling environments: config-sandbox-lifetime.test.ts (accepted),
 * config-sandbox-lifetime-safe.test.ts (accepted but inert).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.CLAW_DEPLOY_MODE = "kubernetes";
// "24" is the interesting one: a bare number is what someone writes when they
// think the unit is hours, and Go rejects it for having no unit at all.
process.env.AGENT_SANDBOX_SESSION_TIMEOUT = "24";
process.env.AGENT_SANDBOX_MAX_SESSION_DURATION = "forever";

const {
  AGENT_SANDBOX_SESSION_TIMEOUT,
  AGENT_SANDBOX_MAX_SESSION_DURATION,
  AGENT_SANDBOX_MAX_SESSION_SECONDS,
  envSettingProblems,
} = await import("../src/config.js");

test("a refused value resolves to unset, not to the raw string", () => {
  assert.equal(AGENT_SANDBOX_SESSION_TIMEOUT, "");
  assert.equal(AGENT_SANDBOX_MAX_SESSION_DURATION, "");
  assert.equal(AGENT_SANDBOX_MAX_SESSION_SECONDS, null);
});

test("and it is reported, naming the variable and the value", () => {
  const problems = envSettingProblems();
  const timeout = problems.find((p) => p.startsWith("AGENT_SANDBOX_SESSION_TIMEOUT="));
  const duration = problems.find((p) => p.startsWith("AGENT_SANDBOX_MAX_SESSION_DURATION="));
  assert.ok(timeout, `no report for the idle knob: ${problems.join(" | ")}`);
  assert.ok(duration, `no report for the ceiling: ${problems.join(" | ")}`);
  // The value has to be in the message. "not a positive Go duration" without
  // it sends the reader looking through a ConfigMap for which one it was.
  assert.match(timeout!, /24/);
  assert.match(duration!, /forever/);
});
