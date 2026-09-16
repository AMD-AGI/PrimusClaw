// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The enabled half of health-bg-fields: what a gate reads on `/health` after
 * the enablement is exactly what the sandboxes created since were given.
 *
 * Its own file because both values are read at module load and the runner gives
 * each file its own process. The state that matters here is the one the rollout
 * moves the deployment into, where the ceiling also changes -- so a `/health`
 * reporting the pre-enablement number would pass the gate that exists to catch
 * exactly that.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.BG_SHELL_ENABLED = "true";
const { BG_SHELL_ENABLED, BASH_FOREGROUND_MAX_SEC } = await import("../src/config.js");
const { toolTimeoutCeilingSec } = await import("../src/tools/hands.js");
const { handsBaseEnv } = await import("../src/sandbox/bootstrap.js");

test("with the feature on, health and the sandbox are told the same two things", () => {
  const env = Object.fromEntries(
    handsBaseEnv("s-1", "9100", "tok").split(" ").filter((p) => p.includes("=")).map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );

  assert.equal(BG_SHELL_ENABLED, true);
  assert.equal(String(BG_SHELL_ENABLED), env.BG_SHELL_ENABLED);
  assert.equal(String(toolTimeoutCeilingSec("bash")), env.BASH_MAX_TIMEOUT_SEC);
});

test("the advertised ceiling moved with the flag, which is what the ceiling gate reads", () => {
  // The gate asserts a direction rather than a constant, so what is pinned here
  // is that there is one: a ceiling that did not move leaves the gate comparing
  // a number against itself.
  assert.equal(toolTimeoutCeilingSec("bash"), BASH_FOREGROUND_MAX_SEC,
    "with the flag on the setting is already under the transport clamp, so the "
      + "advertised ceiling is the setting itself");
  assert.ok(toolTimeoutCeilingSec("bash") < 3540,
    "3540 is the off-state ceiling; reporting it here would pass the ceiling gate "
      + "on a deployment whose sandboxes enforce something else");
});
