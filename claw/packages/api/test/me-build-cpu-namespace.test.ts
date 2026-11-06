// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `buildMe` in a deployment with a separate CPU workspace: the workspace sandboxes
 * start in is the CPU one, and SANDBOX_NAMESPACE (then the GPU workspace) is not
 * what the console is sent to. Its own file because both settings are read when the
 * config module is imported.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.SANDBOX_NAMESPACE = "gpu-ws";
process.env.SANDBOX_CPU_NAMESPACE = "cpu-ws";

const { buildMe } = await import("../src/routes/me.js");

const USER = { userId: "u-1", userName: "One", roles: ["default"] };
const ws = (workspaceId: string, extra: Record<string, unknown> = {}) => ({ workspaceId, workspaceName: workspaceId, scopes: ["Sandbox"], ...extra });
const list = (...items: unknown[]) => ({ totalCount: items.length, items });
const READY = list({ clusterId: "c", phase: "Ready" });
const NONE_MANAGED = { managedWorkspaces: [] };

test("the default sandbox workspace is the CPU one, though the GPU workspace is listed first", () => {
  const me = buildMe(USER, list(ws("gpu-ws", { gpuProduct: "MI355X" }), ws("cpu-ws")), READY, NONE_MANAGED);
  assert.deepEqual(me?.sandbox, {
    available: true, defaultWorkspaceId: "cpu-ws", cpu: { workspaceId: "cpu-ws", available: true },
  });
});

test("a caller without the CPU workspace gets the GPU workspace, then the first one, as before", () => {
  assert.deepEqual(
    buildMe(USER, list(ws("a"), ws("gpu-ws", { gpuProduct: "MI355X" })), READY, NONE_MANAGED)?.sandbox,
    { available: true, defaultWorkspaceId: "a", cpu: { workspaceId: "cpu-ws", available: false, reason: "no_access" } },
    "only the CPU workspace is preferred; the GPU one is not a second preference",
  );
});
