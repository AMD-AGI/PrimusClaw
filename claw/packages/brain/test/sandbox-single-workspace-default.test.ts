// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The default: SANDBOX_CPU_NAMESPACE is not set, and a deployment behaves exactly as it
 * did before it existed -- one workspace for every sandbox whatever it asks for, one
 * Router for all of them.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.SANDBOX_NAMESPACE = "only-ws";
delete process.env.SANDBOX_CPU_NAMESPACE;
process.env.SANDBOX_ROUTER_URL = "http://r1.test,http://r2.test";
process.env.SANDBOX_HANDS_VIA_ROUTER = "true";

const { sandboxNamespaceForResources } = await import("../src/sandbox/workspace-select.js");
const { sandboxRouterBases, safeHandsBaseUrl } = await import("../src/sandbox/sandbox-router.js");

test("without a CPU workspace every sandbox goes to the one workspace, GPU or not", () => {
  for (const resources of [undefined, { cpu: "4" }, { gpu: "0" }, { gpu: "8" }, [{ gpu: "8" }]]) {
    assert.equal(sandboxNamespaceForResources(undefined, resources), "only-ws");
    assert.equal(sandboxNamespaceForResources("  ", resources), "only-ws");
    assert.equal(sandboxNamespaceForResources("ws-x", resources), "ws-x");
  }
});

test("every namespace uses the one list", () => {
  assert.deepEqual(sandboxRouterBases(), ["http://r1.test", "http://r2.test"]);
  assert.equal(
    safeHandsBaseUrl("only-ws", "wl-1", "9100"),
    "http://r1.test/v1/namespaces/only-ws/code-interpreters/wl-1/invocations/proxy/9100",
  );
});
