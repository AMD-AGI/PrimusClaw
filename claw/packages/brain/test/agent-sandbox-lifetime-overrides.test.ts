// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What lifetimeOverrides() actually sends when a deployment sets the knobs.
 *
 * agent-sandbox-template.test.ts can only see the empty environment the runner
 * gives it, and config reads these variables once at module scope -- so the
 * configured case needs a process that owns its environment, which is this
 * file, and hence the dynamic import below.
 *
 * The expectation is a literal on purpose. Rebuilding it from the same
 * `AGENT_SANDBOX_* ? {...} : {}` the implementation is written as makes the
 * two agree by construction: it passes on an empty environment because both
 * sides collapse to `{}`, and it would keep passing against an implementation
 * that had stopped sending anything.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.CLAW_DEPLOY_MODE = "kubernetes";
process.env.AGENT_SANDBOX_SESSION_TIMEOUT = "90m";
process.env.AGENT_SANDBOX_MAX_SESSION_DURATION = "48h";

const { lifetimeOverrides } = await import("../src/sandbox/agent-sandbox-provider.js");

test("both configured values reach the create overrides, under their API names", () => {
  assert.deepEqual(lifetimeOverrides(), {
    sessionTimeout: "90m",
    maxSessionDuration: "48h",
  });
});

test("and nothing else rides along", () => {
  // The object is spread into the Workload Manager create request, so a key
  // that should not be there is a field set on the sandbox, not dead weight.
  assert.deepEqual(Object.keys(lifetimeOverrides()).sort(),
    ["maxSessionDuration", "sessionTimeout"]);
});
