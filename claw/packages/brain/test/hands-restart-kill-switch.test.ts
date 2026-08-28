// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Does SANDBOX_HANDS_RESTART_ENABLED=false actually disable anything?
//
// It was read at one of the three call sites. task-runner's recovery honoured
// it; ensure-hands' reuse repair and its DAG `use` repair did not, so turning
// the flag off left two thirds of the feature running. A rollback lever that
// rolls back part of a change is worse than none: the operator reaching for it
// during an incident believes the code is off.
//
// The flag is read at import, so this file sets it before loading the module
// under test and therefore has to import dynamically. Its own process, per the
// runner's file isolation, so the env change reaches nothing else.

import test from "node:test";
import assert from "node:assert/strict";

process.env.SANDBOX_HANDS_RESTART_ENABLED = "false";

const { restartHandsInSandbox } = await import("../src/sandbox/hands-restart.js");
const { bindContainerProbeEffects } = await import("../src/sandbox/container-probe.js");

test("the kill switch stops a restart before it reaches the container", async () => {
  let execCalls = 0;
  const restore = bindContainerProbeEffects({
    readHandsEntry: async () => ({ provider: "safe-workload", workloadId: "wl-1" }),
    exec: async () => { execCalls++; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  try {
    const result = await restartHandsInSandbox({
      sessionId: "s-1",
      handsUrl: "http://sandbox:9100",
      token: "tok",
      entry: { provider: "safe-workload", workloadId: "wl-1" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.detail, "restart_disabled",
      "the caller has to be able to tell 'switched off' from 'tried and failed'");
    assert.equal(execCalls, 0,
      "nothing may run in the container: SIGKILLing Hands is the thing being disabled");
  } finally {
    restore();
  }
});

test("the kill-switch refusal is marked `refused`, which is what makes the caller rebuild", async () => {
  // The flag, not the string, is what ensure-hands branches on. Every test of
  // the rebuild fallback drives it from a stub, so nothing pinned that the real
  // restart sets it -- drop the flag here and the caller silently goes back to
  // keeping a sandbox it can never repair.
  const r = await restartHandsInSandbox({
    sessionId: "s-1",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    entry: { provider: "safe-workload", workloadId: "wl-1" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.detail, "restart_disabled");
  assert.equal(r.refused, true, "a refusal must be distinguishable from a failed repair");
});
