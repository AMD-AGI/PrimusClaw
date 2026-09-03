// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The deploy mode where one of the two settings has nowhere to go.
 *
 * safe-workload has a single lifetime concept. `timeout` runs whether or not
 * anyone is using the sandbox, and `ttlSecondsAfterFinished` is cleanup after
 * it ends -- neither is an idle deadline, so AGENT_SANDBOX_SESSION_TIMEOUT
 * cannot be mapped onto either without giving the same variable a different
 * meaning per deploy mode. It stays unwired, and the cost of that decision is
 * paid here: a setting that does nothing says so at startup.
 *
 * The ceiling does apply on this path, so it must NOT be reported -- a notice
 * that fires for both would train the reader to skip it.
 *
 * Sibling environments: config-sandbox-lifetime.test.ts,
 * config-sandbox-lifetime-refused.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.CLAW_DEPLOY_MODE = "safe";
process.env.AGENT_SANDBOX_SESSION_TIMEOUT = "90m";
process.env.AGENT_SANDBOX_MAX_SESSION_DURATION = "48h";

const {
  AGENT_SANDBOX_MAX_SESSION_SECONDS,
  envSettingProblems,
} = await import("../src/config.js");
const { workloadTimeoutSeconds } = await import("../src/sandbox/safe-workload-provider.js");

test("the idle knob is reported as doing nothing here", () => {
  const notice = envSettingProblems().find((p) =>
    p.includes("AGENT_SANDBOX_SESSION_TIMEOUT"));
  assert.ok(notice, `expected a notice, got: ${envSettingProblems().join(" | ")}`);
  // It is valid -- the point is that it is inert, not malformed. A message
  // saying it was rejected would send the reader to fix the syntax.
  assert.doesNotMatch(notice!, /not a positive Go duration/);
});

test("the ceiling is not itself reported, because it does apply here", () => {
  // Matched on the leading `NAME=`, not on a substring: the idle notice names
  // the ceiling on purpose, to point at the knob that does work in this mode.
  // A substring check would read that pointer as a second complaint.
  const problems = envSettingProblems();
  const about = problems.filter((p) => p.startsWith("AGENT_SANDBOX_MAX_SESSION_DURATION="));
  assert.deepEqual(about, [], `unexpected: ${about.join(" | ")}`);
  const total = problems.filter((p) => p.includes("AGENT_SANDBOX"));
  assert.equal(total.length, 1, `exactly one notice expected, got: ${total.join(" | ")}`);
});

test("and the ceiling reaches the workload the provider builds", () => {
  // End to end for this mode: env -> config -> seconds -> the field SaFE reads.
  assert.equal(AGENT_SANDBOX_MAX_SESSION_SECONDS, 48 * 3600);
  assert.equal(
    workloadTimeoutSeconds(undefined, AGENT_SANDBOX_MAX_SESSION_SECONDS),
    48 * 3600,
  );
  // And a caller asking for longer than the deployment allows gets the
  // deployment's answer -- the property that makes it a ceiling.
  assert.equal(
    workloadTimeoutSeconds(72 * 3600, AGENT_SANDBOX_MAX_SESSION_SECONDS),
    48 * 3600,
  );
});
