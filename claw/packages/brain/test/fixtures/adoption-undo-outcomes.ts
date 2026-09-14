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

/** Every outcome, and every `skipped` reason, since they do not all mean the same. */
const CASES = [
  { outcome: "parked" },
  { outcome: "gone" },
  { outcome: "skipped", reason: "not_ready" },
  { outcome: "skipped", reason: "other_sandbox" },
  { outcome: "skipped", reason: "unreadable" },
  { outcome: "superseded" },
  { outcome: "failed" },
] as const;

for (const result of CASES) {
  const outcome = result.outcome;
  bindSandboxReuseEffects({
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (async () => result) as never,
    destroyHands: (async () => {}) as never,
  });
  await registerReusedDagHandle(
    {} as never,
    {
      session_id: CLAW_SESSION,
      task_id: `t-${outcome}-${(result as { reason?: string }).reason ?? "x"}`,
      dag_root_task_id: `dag-${outcome}`,
    } as never,
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
