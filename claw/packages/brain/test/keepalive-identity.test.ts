// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  registerSandbox,
  registeredSandboxCount,
  unregisterSandbox,
} from "../src/sandbox/keepalive.js";

test("DAG siblings have independent local keepalive registrations", () => {
  const sessionId = "shared-session";
  const a = { provider: "safe-workload" as const, workloadId: "wl-a" };
  const b = { provider: "safe-workload" as const, workloadId: "wl-b" };

  registerSandbox(sessionId, a);
  registerSandbox(sessionId, b);
  assert.equal(registeredSandboxCount(sessionId), 2);

  unregisterSandbox(sessionId, a);
  assert.equal(registeredSandboxCount(sessionId), 1);

  unregisterSandbox(sessionId);
  assert.equal(registeredSandboxCount(sessionId), 0);
});
