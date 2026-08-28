// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMultiNodeExternalEnv } from "../src/sandbox/params.js";
import type { MultiNodeContext } from "../src/sandbox/multi-node/types.js";

const RAYJOB_CTX: MultiNodeContext = {
  backend: "rayjob",
  provider: "template",
  name: "msg1-rayjob",
  namespace: "test-workspace",
  nodeCount: 2,
  serviceUrl: "http://msg1-rayjob.test-workspace.svc.cluster.local:8888",
  headHost: "msg1-rayjob.test-workspace.svc.cluster.local",
  dashboardToken: "tok",
};

const INFERA_CTX: MultiNodeContext = {
  backend: "infera",
  provider: "safe",
  name: "msg1-infera",
  namespace: "test-workspace",
  nodeCount: 2,
  serviceUrl: "http://msg1-infera.test-workspace.svc.cluster.local:8000",
  sshKeyPath: "/tmp/primus-claw-mn-ssh-key",
  sshPortBase: 2222,
  prefillIps: ["10.0.0.2"],
  decodeIps: ["10.0.0.3"],
  workerIps: [],
};

test("rayjob env points Hyperloom at the head's dashboard/GCS control plane", () => {
  // ANTHROPIC_API_KEY rather than SAFE_API_KEY: the caller's key reaches a sandbox
  // under the agent-CLI names, and asserting on a variable the sandbox env no
  // longer carries would pin nothing.
  const env: Record<string, string> = {
    SAFE_API_URL: "https://safe.example",
    ANTHROPIC_API_KEY: "k",
  };
  applyMultiNodeExternalEnv(env, RAYJOB_CTX);

  // Clearing SAFE_API_URL is what forces external mode: left set, Hyperloom would
  // reach the workload API and create a second, duplicate cluster of its own.
  assert.equal(env.SAFE_API_URL, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "k", "other sandbox callers still need the key");
  assert.equal(env.INFERENCE_OPTIMIZER_MN_BACKEND, "rayjob");
  assert.equal(env.INFERENCE_OPTIMIZER_NODES, "2");
  assert.equal(env.HYPERLOOM_MN_EXT_SERVICE_URL, RAYJOB_CTX.serviceUrl);
  assert.equal(env.HYPERLOOM_MN_EXT_HEAD_IP, RAYJOB_CTX.headHost);
  assert.equal(env.HYPERLOOM_MN_EXT_RAY_DASHBOARD_TOKEN, "tok");
  // Neither is set from here. SaFE's dispatcher injects USER_DATA_PATH from the
  // workspace volume that declares enableUserDir, and would leave ours in place
  // if we set one -- so setting it could only redirect a root already correct.
  assert.equal(env.NFS_SHARED_ROOT, undefined);
  assert.equal(env.USER_DATA_PATH, undefined);

  // rayjob drives the head over REST/GCS and never SSHes into pods.
  assert.equal(env.HYPERLOOM_MN_EXT_SSH_KEY, undefined);
  assert.equal(env.HYPERLOOM_MN_EXT_PREFILL_IPS, undefined);
});

test("infera env exposes the SSH control plane and per-role pod IPs", () => {
  const env: Record<string, string> = { SAFE_API_URL: "https://safe.example" };
  applyMultiNodeExternalEnv(env, INFERA_CTX);

  assert.equal(env.INFERENCE_OPTIMIZER_MN_BACKEND, "infera");
  assert.equal(env.HYPERLOOM_MN_EXT_SERVICE_URL, INFERA_CTX.serviceUrl);
  assert.equal(env.HYPERLOOM_MN_EXT_SSH_KEY, "/tmp/primus-claw-mn-ssh-key");
  assert.equal(env.HYPERLOOM_MN_EXT_SSH_PORT, "2222");
  assert.equal(env.HYPERLOOM_MN_EXT_PREFILL_IPS, "10.0.0.2");
  assert.equal(env.HYPERLOOM_MN_EXT_DECODE_IPS, "10.0.0.3");
  // An empty role list must stay unset rather than become an empty string,
  // which Hyperloom would read as "external mode is misconfigured".
  assert.equal(env.HYPERLOOM_MN_EXT_WORKER_IPS, undefined);

  // infera has no Ray head: these would point the optimizer at nothing.
  assert.equal(env.HYPERLOOM_MN_EXT_HEAD_IP, undefined);
  assert.equal(env.HYPERLOOM_MN_EXT_RAY_DASHBOARD_TOKEN, undefined);
});

test("aggregated infera reports worker IPs instead of prefill/decode", () => {
  const env: Record<string, string> = {};
  applyMultiNodeExternalEnv(env, {
    ...INFERA_CTX,
    prefillIps: [],
    decodeIps: [],
    workerIps: ["10.0.0.4", "10.0.0.5"],
  });
  assert.equal(env.HYPERLOOM_MN_EXT_WORKER_IPS, "10.0.0.4,10.0.0.5");
  assert.equal(env.HYPERLOOM_MN_EXT_PREFILL_IPS, undefined);
});
