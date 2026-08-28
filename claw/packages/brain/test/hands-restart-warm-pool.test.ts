// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Restarting in place skips resending the environment, which is right only
// while every pod is built for the request it serves.
//
// A pod claimed from the warm pool was created before anyone knew whose request
// it would take, so `overrides.environment` never reached its spec: the
// environment arrived through HANDS_ENV_FILE, and Hands reads that once and
// unlinks it. A Hands restarted in such a pod comes up with the base
// environment and none of user_env, session_env or the LLM keys -- and answers
// /health, so nothing downstream can tell. That is the failure the env file was
// added to remove, reintroduced by the repair path.
//
// AGENT_SANDBOX_WARM_POOL_SIZE is read at import, so this file sets it before
// loading the module and imports dynamically. Its own process, per the runner's
// file isolation.

import test from "node:test";
import assert from "node:assert/strict";

process.env.AGENT_SANDBOX_WARM_POOL_SIZE = "2";

const { restartHandsInSandbox, restartPreservesEnvironment } =
  await import("../src/sandbox/hands-restart.js");
const { bindContainerProbeEffects } = await import("../src/sandbox/container-probe.js");

const AGENT_ENTRY = {
  provider: "agent-sandbox" as const,
  sessionId: "agent-1",
  sandboxName: "box-1",
  namespace: "ns",
};

test("with a warm pool configured, an agent-sandbox restart cannot promise the environment", () => {
  assert.equal(restartPreservesEnvironment({
    provider: "agent-sandbox", id: "agent-1", sandboxName: "box-1",
    namespace: "ns", handsBaseUrl: "",
  }), false);
});

test("safe-workload has no pool, so its restart is unaffected", () => {
  assert.equal(restartPreservesEnvironment({
    provider: "safe-workload", id: "wl-1", sandboxName: "wl-1",
    namespace: "ns", handsBaseUrl: "",
  }), true);
});

test("a pooled agent-sandbox is refused before anything is killed", async () => {
  let execCalls = 0;
  const restore = bindContainerProbeEffects({
    readHandsEntry: async () => AGENT_ENTRY,
    exec: async () => { execCalls++; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  try {
    const r = await restartHandsInSandbox({
      sessionId: "sess-1",
      handsUrl: "http://sandbox:9100/mcp",
      token: "tok",
      entry: AGENT_ENTRY,
    });

    assert.equal(r.ok, false);
    assert.equal(r.detail, "env_not_reproducible",
      "the caller needs to see why, not just that it failed");
    // The flag, not the string, is what ensure-hands branches on to rebuild
    // instead of keeping a sandbox it can never repair.
    assert.equal(r.refused, true, "a refusal must be distinguishable from a failed repair");
    assert.equal(execCalls, 0,
      "SIGKILLing Hands and starting one without the user's credentials is the "
      + "outcome being prevented, so nothing may run in the container");
  } finally {
    restore();
  }
});
