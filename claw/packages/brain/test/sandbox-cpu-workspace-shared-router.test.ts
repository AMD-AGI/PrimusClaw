// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A CPU workspace on the same cluster as the GPU one: SANDBOX_CPU_NAMESPACE is set,
 * SANDBOX_CPU_ROUTER_URL is not, and the one Router serves both.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.SANDBOX_NAMESPACE = "gpu-ws";
process.env.SANDBOX_CPU_NAMESPACE = "cpu-ws";
process.env.SANDBOX_ROUTER_URL = "http://r1.test";
delete process.env.SANDBOX_CPU_ROUTER_URL;
process.env.SANDBOX_HANDS_VIA_ROUTER = "true";

const { sandboxRouterBasesFor, safeHandsBaseUrl } = await import("../src/sandbox/sandbox-router.js");
const { sandboxNamespaceForResources } = await import("../src/sandbox/workspace-select.js");

test("with no CPU Router, the CPU workspace is reached through SANDBOX_ROUTER_URL like every other", () => {
  assert.deepEqual(sandboxRouterBasesFor("cpu-ws"), ["http://r1.test"]);
  assert.deepEqual(sandboxRouterBasesFor("gpu-ws"), ["http://r1.test"]);
  assert.equal(
    safeHandsBaseUrl("cpu-ws", "wl-1", "9100"),
    "http://r1.test/v1/namespaces/cpu-ws/code-interpreters/wl-1/invocations/proxy/9100",
  );
});

test("the workspace rule does not depend on the Router setting", () => {
  assert.equal(sandboxNamespaceForResources(undefined, { gpu: "0" }), "cpu-ws");
  assert.equal(sandboxNamespaceForResources(undefined, { gpu: "8" }), "gpu-ws");
});
