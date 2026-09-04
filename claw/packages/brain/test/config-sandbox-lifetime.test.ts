// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the lifetime knobs resolve to when a deployment actually sets them.
 *
 * safe-workload-lifetime.test.ts covers the arithmetic, but it imports config
 * under whatever environment the runner happens to have -- which is an empty
 * one -- so every assertion there about a *configured* value sits behind an
 * `if` that does not run. A regression that made a good value resolve to null
 * would pass that file. Config reads each variable once at module scope, so
 * the only way to test a set value is a process that owns its environment:
 * hence this file, and hence the dynamic import below.
 *
 * The sibling environments are next door, for the same reason they are in the
 * NATS_REPLICAS trio: a value config refuses is
 * config-sandbox-lifetime-refused.test.ts, and the deploy mode where one of
 * these settings does nothing is config-sandbox-lifetime-safe.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

// Deliberately kubernetes: this is the mode where both settings mean
// something, so nothing here is confounded by the safe-mode notice.
process.env.CLAW_DEPLOY_MODE = "kubernetes";
process.env.AGENT_SANDBOX_SESSION_TIMEOUT = "90m";
process.env.AGENT_SANDBOX_MAX_SESSION_DURATION = "48h";

const {
  AGENT_SANDBOX_SESSION_TIMEOUT,
  AGENT_SANDBOX_MAX_SESSION_DURATION,
  AGENT_SANDBOX_MAX_SESSION_SECONDS,
  envSettingProblems,
} = await import("../src/config.js");

test("a configured Go duration survives to both forms", () => {
  assert.equal(AGENT_SANDBOX_SESSION_TIMEOUT, "90m");
  assert.equal(AGENT_SANDBOX_MAX_SESSION_DURATION, "48h");
  // The branch safe-workload-lifetime.test.ts can never reach: a set value has
  // to arrive as a number, because null is what every provider reads as "not
  // configured" and falls back from.
  assert.equal(AGENT_SANDBOX_MAX_SESSION_SECONDS, 48 * 3600);
});

test("a value that parses is not also reported as a problem", () => {
  const problems = envSettingProblems().filter((p) => p.includes("AGENT_SANDBOX"));
  assert.deepEqual(problems, [], `nothing to report, got: ${problems.join(" | ")}`);
});
