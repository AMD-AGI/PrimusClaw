// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What `/health` says about a sandbox that booted with the feature on.
 *
 * This payload is how a rollout gate reads a *running* sandbox's configuration:
 * the tool list is identical in both switch states, so it is not a capability
 * signal, and nothing outside the sandbox can answer the question otherwise.
 * The flag-off half is in internal-shells-routes-flag-off.
 *
 * Its own file because the flag is read at module load and the runner gives
 * each file its own process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
if (!process.argv.includes("--self-check")) process.argv.push("--self-check");

const { app } = await import("../src/index.js");
const { MAX_TIMEOUT_SEC } = await import("../src/tools/shell/bash.js");

const { isolatingSandbox } = await import("./support/sandbox-isolation.js");
isolatingSandbox();

test("/health reports the feature on, and the tightened ceiling", async () => {
  const health = (await app.inject({ method: "GET", url: "/health" })).json();

  assert.equal(health.bgShellEnabled, true);
  assert.equal(health.bashMaxTimeoutSec, MAX_TIMEOUT_SEC,
    "the advertised ceiling must be the one this process enforces");
  assert.equal(typeof health.bgShellRecords, "boolean",
    "how Brain addresses this process depends on it being stated, not inferred");
});
