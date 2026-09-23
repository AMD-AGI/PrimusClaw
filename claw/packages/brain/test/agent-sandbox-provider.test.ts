// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxInstance } from "../src/sandbox/provider.js";

process.env.AGENT_SANDBOX_ROUTER_URL = "http://router.test";
const { AgentSandboxProvider } = await import("../src/sandbox/agent-sandbox-provider.js");
const provider = new AgentSandboxProvider();
const inst: SandboxInstance = {
  provider: "agent-sandbox", id: "session-1", sandboxName: "sandbox-1",
  namespace: "default", handsBaseUrl: "", userId: "user-1",
};

test("get separates absence, terminal and unknown provider outcomes", async (t) => {
  const unknown = { running: false, healthy: false, state: "unknown" };
  // A finished session is conclusive, and reports the address it last held.
  // The reason travels with it: a phase that says the workload failed is not
  // the same outcome as one whose EnvD exited cleanly, and collapsing both
  // into a generic terminal left the specific reasons unreachable.
  const terminalWith = (reason: string) => ({
    running: false, healthy: false, podIp: undefined, state: "terminal", reason,
  });
  const cases: Array<{ name: string; status: number; body: string; expected: unknown }> = [
    ...[404, 410].map((status) => ({
      name: `HTTP ${status}`, status, body: "",
      expected: { running: false, healthy: false, state: "absent" },
    })),
    ...[400, 401, 403, 429, 500, 502, 503].map((status) => ({
      name: `HTTP ${status}`, status, body: '{"status":"running"}', expected: unknown,
    })),
    ...["pending", ""].map((status) => ({
      name: `session status ${JSON.stringify(status)}`, status: 200,
      body: JSON.stringify({ status }), expected: unknown,
    })),
    ...([
      ["stopped", "sandbox_workload_terminal"],
      ["failed", "sandbox_container_failed"],
      ["completed", "sandbox_envd_exited"],
    ] as const).map(([status, reason]) => ({
      name: `session status ${JSON.stringify(status)}`, status: 200,
      body: JSON.stringify({ status }), expected: terminalWith(reason),
    })),
    {
      // What the Router reports wins: it comes from the container that failed,
      // while the phase only says that something did.
      name: "a reason the Router named", status: 200,
      body: JSON.stringify({ status: "failed", reason: "OOMKilled" }),
      expected: terminalWith("OOMKilled"),
    },
    ...["null", "{}", "[]", "invalid json"].map((body) => ({
      name: `body ${body}`, status: 200, body, expected: unknown,
    })),
  ];
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      t.mock.method(globalThis, "fetch", async () => new Response(c.body, { status: c.status }));
      assert.deepEqual(await provider.get(inst), c.expected);
    });
  }
});

test("get reports known running and preserves its health and address", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    status: "running", healthy: true, podIp: "192.0.2.1",
  }));
  assert.deepEqual(await provider.get(inst), {
    running: true, healthy: true, podIp: "192.0.2.1", state: "running",
  });
});

test("get returns unknown when transport or response decoding fails", async (t) => {
  for (const failure of ["transport", "body"] as const) {
    await t.test(failure, async (t) => {
      t.mock.method(globalThis, "fetch", async () => {
        if (failure === "transport") throw new Error("connection refused");
        const response = Response.json({ status: "running" });
        t.mock.method(response, "json", async () => { throw new Error("body interrupted"); });
        return response;
      });
      assert.deepEqual(await provider.get(inst), { running: false, healthy: false, state: "unknown" });
    });
  }
});
