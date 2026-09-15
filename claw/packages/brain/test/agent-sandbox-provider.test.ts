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

test("get distinguishes explicit absence from every unknown provider outcome", async (t) => {
  const cases = [
    ...[404, 410].map((status) => ({ name: `HTTP ${status}`, status, body: "", state: "absent" })),
    ...[400, 401, 403, 429, 500, 502, 503].map((status) => ({
      name: `HTTP ${status}`, status, body: '{"status":"running"}', state: "unknown",
    })),
    ...["pending", "stopped", "failed", "completed", ""].map((status) => ({
      name: `session status ${JSON.stringify(status)}`, status: 200,
      body: JSON.stringify({ status }), state: "unknown",
    })),
    ...["null", "{}", "[]", "invalid json"].map((body) => ({
      name: `body ${body}`, status: 200, body, state: "unknown",
    })),
  ];
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      t.mock.method(globalThis, "fetch", async () => new Response(c.body, { status: c.status }));
      assert.deepEqual(await provider.get(inst), { running: false, healthy: false, state: c.state });
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
