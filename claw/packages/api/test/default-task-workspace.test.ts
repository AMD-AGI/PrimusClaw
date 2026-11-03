// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a dispatched task is stamped with when its session names no workspace: Brain
 * obeys a task's `workspace_id` over its own default, so with a CPU workspace the
 * API must stamp nothing and let Brain choose per sandbox.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultTaskWorkspaceId } from "../src/tasks/default-workspace.js";

test("one workspace: the task is stamped with SANDBOX_NAMESPACE, as before", () => {
  assert.equal(defaultTaskWorkspaceId({ SANDBOX_NAMESPACE: "ws-1" }), "ws-1");
  assert.equal(defaultTaskWorkspaceId({ SANDBOX_NAMESPACE: " ws-1 " }), "ws-1");
  assert.equal(defaultTaskWorkspaceId({ SANDBOX_NAMESPACE: "ws-1", SANDBOX_CPU_NAMESPACE: "" }), "ws-1");
  assert.equal(defaultTaskWorkspaceId({ SANDBOX_NAMESPACE: "ws-1", SANDBOX_CPU_NAMESPACE: "  " }), "ws-1");
});

test("nothing configured: nothing is stamped", () => {
  assert.equal(defaultTaskWorkspaceId({}), "");
  assert.equal(defaultTaskWorkspaceId({ SANDBOX_NAMESPACE: "" }), "");
});

test("a CPU workspace: nothing is stamped, so Brain picks per sandbox", () => {
  assert.equal(defaultTaskWorkspaceId({ SANDBOX_NAMESPACE: "gpu-ws", SANDBOX_CPU_NAMESPACE: "cpu-ws" }), "");
  assert.equal(defaultTaskWorkspaceId({ SANDBOX_CPU_NAMESPACE: "cpu-ws" }), "");
});

test("the dispatcher stamps its tasks through it, not from the environment directly", () => {
  const src = readFileSync(new URL("../src/tasks/dispatcher.ts", import.meta.url), "utf8");
  assert.match(src, /workspace_id: sessionWorkspaceId \|\| defaultTaskWorkspaceId\(\)/);
  assert.doesNotMatch(src, /process\.env\.SANDBOX_NAMESPACE/);
});
