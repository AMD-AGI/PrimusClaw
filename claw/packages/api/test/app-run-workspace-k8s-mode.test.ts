// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * kubernetes/BYOK mode has no SaFE and its callers hold an LLM-gateway key. The
 * workspace check says so (501) instead of asking SaFE and answering 403.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.CLAW_DEPLOY_MODE = "kubernetes";
delete process.env.CLAW_INSECURE_DEV_AUTH;

test("the workspace check is unsupported in kubernetes mode, not forbidden", async () => {
  const { safeWorkspaceAccess, WorkspaceCheckUnsupportedError } = await import("../src/tasks/app-run.js");
  await assert.rejects(safeWorkspaceAccess({ authorization: "Bearer sk-x" }, "ws-1"), WorkspaceCheckUnsupportedError);
});
