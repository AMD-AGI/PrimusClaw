// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The accepting side of the floor's boundary.
 *
 * Exactly the floor, which the check is written to allow: the comparison is
 * `<`, and the floor is the smallest value the timing actually works at, not
 * the largest one that fails. Getting this wrong is not hypothetical -- `<=`
 * reads as the safer of the two and would reject the one value the derivation
 * was built to make safe, leaving a documented minimum that cannot be
 * configured.
 *
 * The refusing side is config-sandbox-lifetime-too-short.test.ts, one
 * nanosecond below -- the floor is counted in nanoseconds, so that is where
 * the boundary is. Neither file means much alone: a check that refuses
 * everything passes that one, a check that refuses nothing passes this one,
 * and only the pair pins the boundary where the doc comment's arithmetic puts
 * it.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.CLAW_DEPLOY_MODE = "kubernetes";
// 2 x the Router's 5m refresh interval, plus the minute of slack the floor's
// derivation adds. The slack is not sized to a guarantee: the Router's write
// timeout is a real 2s, but agentd's `+ time.Second` is only what one
// reconcile asks for its own next pass, and an unrelated Sandbox event can
// bring one forward -- so the minute covers what cannot be relied on.
process.env.AGENT_SANDBOX_SESSION_TIMEOUT = "11m";

const { AGENT_SANDBOX_SESSION_TIMEOUT, envSettingProblems } = await import("../src/config.js");

test("exactly the floor is accepted, and reaches the backend unchanged", () => {
  assert.equal(AGENT_SANDBOX_SESSION_TIMEOUT, "11m");
});

test("and nothing is reported about it", () => {
  const problems = envSettingProblems().filter((p) => p.includes("AGENT_SANDBOX"));
  assert.deepEqual(problems, [], `the floor itself must not be a problem, got: ${problems.join(" | ")}`);
});
