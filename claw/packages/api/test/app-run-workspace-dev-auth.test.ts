// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Under the dev auth bypass there is no credential to forward and everyone is an
 * admin, so the SaFE workspace check is skipped rather than answered "forbidden".
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.APP_ENV = "dev";
process.env.CLAW_INSECURE_DEV_AUTH = "1";
process.env.CLAW_DEPLOY_MODE = "safe";

test("the workspace check is skipped under the dev bypass", async () => {
  const { safeWorkspaceAccess } = await import("../src/tasks/app-run.js");
  assert.equal(await safeWorkspaceAccess({}, "ws-1"), "ok");
});
