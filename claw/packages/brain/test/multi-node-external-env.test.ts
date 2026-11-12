// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMultiNodeExternalEnv, buildNodeList, MN_NODE_LIST_ENV } from "../src/sandbox/params.js";
import type { MultiNodeContext, MultiNodeNodeList } from "../src/sandbox/multi-node/types.js";

const RAYJOB_CTX: MultiNodeContext = {
  backend: "rayjob",
  provider: "template",
  name: "msg1-rayjob",
  namespace: "test-workspace",
  nodeCount: 2,
  gpusPerNode: 8,
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
  gpusPerNode: 8,
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

const PD_CTX: MultiNodeContext = {
  backend: "sglangrouter",
  provider: "safe",
  name: "msg1",
  namespace: "test-workspace",
  nodeCount: 3,
  gpusPerNode: 8,
  serviceUrl: "http://msg1.test-workspace.svc.cluster.local:8000",
  prefillUrl: "http://msg1-prefill.test-workspace.svc.cluster.local:8010",
  decodeUrl: "http://msg1-decode.test-workspace.svc.cluster.local:8020",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYBODY\n-----END OPENSSH PRIVATE KEY-----\n",
  sshKeyPath: "/tmp/primus-claw-mn-ssh-key",
  sshPortBase: 25032,
  routerIps: ["10.0.0.1"],
  prefillIps: ["10.0.0.2"],
  decodeIps: ["10.0.0.3", "10.0.0.4"],
  pdLaunch: {
    model: "/models/DeepSeek-R1",
    kvTransferBackend: "mori",
    prefillTp: 8,
    decodeTp: 0,
    serverArgs: "--mem-fraction-static 0.8",
    prefillExtraArgs: "",
    decodeExtraArgs: "--max-running-requests 256",
  },
};

function nodeListOf(env: Record<string, string>): MultiNodeNodeList {
  return JSON.parse(env[MN_NODE_LIST_ENV]!) as MultiNodeNodeList;
}

test("sglangrouter and atomesh hand the cluster over as one node list", () => {
  for (const [backend, framework] of [["sglangrouter", "sglang"], ["atomesh", "atom"]] as const) {
    const env: Record<string, string> = { SAFE_API_URL: "https://safe.example" };
    applyMultiNodeExternalEnv(env, { ...PD_CTX, backend });
    assert.equal(env.SAFE_API_URL, undefined);
    assert.deepEqual(nodeListOf(env), {
      framework,
      model: "/models/DeepSeek-R1",
      service_url: PD_CTX.serviceUrl,
      prefill_url: PD_CTX.prefillUrl,
      decode_url: PD_CTX.decodeUrl,
      router: { host: "10.0.0.1" },
      prefill: [{ host: "10.0.0.2" }],
      decode: [{ host: "10.0.0.3" }, { host: "10.0.0.4" }],
      gpus_per_node: 8,
      launch_mode: "in_place",
      ssh: { port: 25032, user: "root", key_file: "/tmp/primus-claw-mn-ssh-key" },
      transfer_backend: "mori",
      topology: {
        prefill: { tp: 8, ep: null, dp_attention: null },
        decode: { tp: null, ep: null, dp_attention: null },
      },
      config: {
        prefill_args: "--mem-fraction-static 0.8",
        decode_args: "--mem-fraction-static 0.8 --max-running-requests 256",
        router_args: "",
      },
    });
    assert.ok(!env[MN_NODE_LIST_ENV]!.includes("SECRETKEYBODY"), "the key is passed by path only");
  }
});

test("sglangrouter and atomesh set no variable but the node list", () => {
  for (const legacyTopologyEnv of [true, false]) {
    const env: Record<string, string> = {};
    applyMultiNodeExternalEnv(env, PD_CTX, { legacyTopologyEnv });
    for (const name of [
      "TOPOLOGY_HANDOFF_FILE",
      "INFERENCE_OPTIMIZER_MN_BACKEND",
      "INFERENCE_OPTIMIZER_NODES",
      "HYPERLOOM_MN_EXT_SERVICE_URL",
      "HYPERLOOM_MN_EXT_PREFILL_URL",
      "HYPERLOOM_MN_EXT_DECODE_URL",
      "HYPERLOOM_MN_EXT_SSH_KEY",
      "HYPERLOOM_MN_EXT_SSH_PORT",
      "HYPERLOOM_MN_EXT_ROUTER_IPS",
      "HYPERLOOM_MN_EXT_PREFILL_IPS",
      "HYPERLOOM_MN_EXT_DECODE_IPS",
      "HYPERLOOM_MN_EXT_WORKER_IPS",
    ]) {
      assert.equal(env[name], undefined, name);
    }
  }
});

test("the node list leaves out what the prompt did not set", () => {
  const nodeList = buildNodeList({
    ...PD_CTX,
    sshPrivateKey: undefined,
    pdLaunch: { ...PD_CTX.pdLaunch!, prefillTp: 0, serverArgs: "", decodeExtraArgs: "", kvTransferBackend: "" },
  });
  assert.ok(nodeList);
  assert.equal(nodeList.ssh, undefined, "no ssh block without a written key file");
  const bare = buildNodeList({ ...PD_CTX, prefillUrl: undefined, decodeUrl: undefined });
  assert.equal(bare?.prefill_url, undefined);
  assert.equal(bare?.decode_url, undefined);
  assert.equal(nodeList.topology, undefined);
  assert.equal(nodeList.config, undefined);
  assert.equal(nodeList.transfer_backend, undefined);
});

test("no node list without router, prefill and decode hosts", () => {
  for (const missing of [{ routerIps: [] }, { prefillIps: [] }, { decodeIps: undefined }, { pdLaunch: undefined }]) {
    const env: Record<string, string> = {};
    applyMultiNodeExternalEnv(env, { ...PD_CTX, ...missing });
    assert.equal(env[MN_NODE_LIST_ENV], undefined, JSON.stringify(missing));
  }
  assert.equal(buildNodeList(INFERA_CTX), undefined, "infera is not a PD node list backend");
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
