// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Drives the adoption undo once per `markHandsIdle` outcome and lets the real
 * logger write to stdout, so the test can assert on what an operator would
 * actually see rather than on the shape of the source.
 */
import { bindSandboxReuseEffects, registerReusedDagHandle } from "../../src/sandbox/ensure-hands.js";
import { bindDagHandleKvForTest } from "../../src/sandbox/handles.js";

const CLAW_SESSION = "claw-sess-1";

bindDagHandleKvForTest({
  async get() { return null; },
  async create() { throw new Error("nats: no responders"); },
  async update() { throw new Error("nats: no responders"); },
  async put() { throw new Error("nats: no responders"); },
  async delete() {},
  async keys() { return (async function* () {})(); },
} as never);

for (const outcome of ["parked", "gone", "superseded", "failed"] as const) {
  bindSandboxReuseEffects({
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (async () => ({ outcome })) as never,
    destroyHands: (async () => {}) as never,
  });
  await registerReusedDagHandle(
    {} as never,
    { session_id: CLAW_SESSION, task_id: `t-${outcome}`, dag_root_task_id: `dag-${outcome}` } as never,
    { kind: "create", handle: "main" },
    {
      handsUrl: "http://hands", created: false, token: "tok",
      identity: {
        provider: "agent-sandbox", sessionId: "router-sess-9",
        sandboxName: "sb-1", namespace: "ns",
      },
    } as never,
  ).catch(() => { /* the registration failure is the point; the undo is what we watch */ });
}
