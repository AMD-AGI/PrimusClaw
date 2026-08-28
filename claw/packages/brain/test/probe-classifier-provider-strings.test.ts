// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The destroy licence is a string match, and both ends of it are untested.
 *
 * `exec_sandbox_gone` is the only verdict that lets a caller stop a workload,
 * and container-probe decides it by regex-matching the message the provider
 * threw. Both producers are bare template literals inside the providers, and
 * every other test hands the classifier a copy of those literals written out
 * by hand -- so a reword on the provider side would go unnoticed, and it fails
 * in both directions:
 *
 *   - a 404 for a container that really is gone stops classifying as `dead`,
 *     no rebuild is ever licensed, and the run dies with every turn failing;
 *   - a wording that starts matching a 502 turns the classifier into the
 *     rubber stamp for destroying live containers this module exists to
 *     prevent.
 *
 * These take the string from the real provider and give it to the real
 * classifier, so the two cannot drift apart while the suite stays green.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxInstance } from "../src/sandbox/provider.js";

// Set before the first dynamic import below: the agent-sandbox provider
// refuses to build a request at all without a router URL, and config reads the
// environment once, at module load. Static imports would run before this line.
process.env.AGENT_SANDBOX_ROUTER_URL ||= "http://router.test";

const ENTRY = {
  provider: "safe-workload",
  workloadId: "claw-sandbox-1",
  platformKey: "pk",
  namespace: "ns",
};

const AGENT_INST = {
  provider: "agent-sandbox", id: "sess-1", sandboxName: "box",
  namespace: "ns", handsBaseUrl: "", userId: "u",
} as unknown as SandboxInstance;

const SAFE_INST = {
  provider: "safe-workload", id: "wl-1", sandboxName: "wl-1",
  namespace: "ns", handsBaseUrl: "", platformKey: "pk",
} as unknown as SandboxInstance;

/** The error the real provider throws for an HTTP status, with fetch stubbed. */
async function execError(
  provider: { exec: (i: SandboxInstance, c: string, t: string) => Promise<unknown> },
  inst: SandboxInstance,
  status: number,
): Promise<Error> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("workload not found", { status })) as unknown as typeof fetch;
  let thrown: unknown;
  try {
    await provider.exec(inst, "true", "5s");
  } catch (e) {
    thrown = e;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(thrown instanceof Error, `the provider must throw on HTTP ${status}`);
  return thrown;
}

/** That same error, put through the real classifier. */
async function verdictFor(err: Error): Promise<unknown> {
  const cp = await import("../src/sandbox/container-probe.js");
  const restore = cp.bindContainerProbeEffects({
    readHandsEntry: async () => ENTRY,
    exec: async () => { throw err; },
  });
  try {
    return await cp.probeSandboxContainer("sess-1");
  } finally {
    restore();
  }
}

async function providers(): Promise<Array<[string, { exec: never }, SandboxInstance]>> {
  const { AgentSandboxProvider } = await import("../src/sandbox/agent-sandbox-provider.js");
  const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
  return [
    ["agent-sandbox", new AgentSandboxProvider() as never, AGENT_INST],
    ["safe-workload", new SafeWorkloadProvider() as never, SAFE_INST],
  ];
}

test("a real provider's 404 and 410 are what the classifier reads as a gone container", async () => {
  for (const [name, provider, inst] of await providers()) {
    for (const status of [404, 410]) {
      const err = await execError(provider, inst, status);
      assert.deepEqual(
        await verdictFor(err),
        { verdict: "dead", reason: "exec_sandbox_gone" },
        `${name} HTTP ${status} must license the rebuild; the provider said `
        + `"${err.message}", which the classifier did not recognise`,
      );
    }
  }
});

test("a real provider's 502 stays unknown, so nothing licenses a destroy", async () => {
  // The incident's own failure. A Router that cannot reach a healthy backend
  // answers 502, and reading that as evidence about the container is what
  // destroyed live workloads.
  for (const [name, provider, inst] of await providers()) {
    const err = await execError(provider, inst, 502);
    assert.deepEqual(
      await verdictFor(err),
      { verdict: "unknown", reason: "exec_unreachable" },
      `${name} HTTP 502 must never license a destroy; the provider said "${err.message}"`,
    );
  }
});
