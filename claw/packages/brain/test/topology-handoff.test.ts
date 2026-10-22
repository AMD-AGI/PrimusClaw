// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTopologyHandoff, type TopologyHandoffV1 } from "@claw/protocol";
import { applyMultiNodeExternalEnv, buildTopologyHandoff } from "../src/sandbox/params.js";
import type { MultiNodeContext } from "../src/sandbox/multi-node/types.js";

const DASH_TOKEN = "dash-token-SECRET-1f3a";
const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYBODY\n-----END OPENSSH PRIVATE KEY-----\n";

const RAYJOB: MultiNodeContext = {
  backend: "rayjob",
  provider: "safe",
  name: "msg1-rayjob",
  namespace: "ws",
  nodeCount: 2,
  gpusPerNode: 8,
  serviceUrl: "http://msg1-rayjob.ws.svc.cluster.local:8888",
  headHost: "msg1-rayjob.ws.svc.cluster.local",
  dashboardToken: DASH_TOKEN,
};

const INFERA: MultiNodeContext = {
  backend: "infera",
  provider: "safe",
  name: "msg1-infera",
  namespace: "ws",
  nodeCount: 3,
  gpusPerNode: 4,
  serviceUrl: "http://msg1-infera.ws.svc.cluster.local:8000",
  sshPrivateKey: PEM,
  sshKeyPath: "/tmp/primus-claw-mn-ssh-key",
  sshPortBase: 2222,
  prefillIps: ["10.0.0.2", "10.0.0.6"],
  decodeIps: ["10.0.0.3"],
  workerIps: ["10.0.0.4"],
};

const WS = "/workspace";

function build(ctx: MultiNodeContext) {
  const env: Record<string, string> = { WORKSPACE_PATH: WS, SAFE_API_URL: "https://safe.example" };
  applyMultiNodeExternalEnv(env, ctx, { legacyTopologyEnv: true });
  const { handoff, files } = buildTopologyHandoff(ctx, WS);
  const byPath = new Map(files.map((f) => [f.path, f]));
  return { env, handoff, files, byPath };
}

test("rayjob: every legacy variable equals its handoff field", () => {
  const { env, handoff, byPath } = build(RAYJOB);
  assert.equal(env.INFERENCE_OPTIMIZER_MN_BACKEND, handoff.backend, "backend");
  assert.equal(env.INFERENCE_OPTIMIZER_NODES, String(handoff.nodes), "nodes");
  assert.equal(env.HYPERLOOM_MN_EXT_SERVICE_URL, handoff.service_url, "service_url");
  assert.equal(env.HYPERLOOM_MN_EXT_HEAD_IP, handoff.ray?.head_ip, "ray.head_ip");
  const tokenFile = handoff.ray?.dashboard_token_file;
  assert.ok(tokenFile, "ray.dashboard_token_file");
  assert.equal(env.HYPERLOOM_MN_EXT_RAY_DASHBOARD_TOKEN, byPath.get(tokenFile)?.content, "ray token via file");
  assert.equal(handoff.gpus_per_node, 8, "gpus_per_node");
  assert.equal(handoff.infera, undefined);
  assert.equal(handoff.schema, "claw.topology-handoff/v1");
  assert.equal(env.CLAW_TOPOLOGY_FILE, `${WS}/.claw/topology.json`);
});

test("infera: every legacy variable equals its handoff field", () => {
  const { env, handoff } = build(INFERA);
  const i = handoff.infera;
  assert.ok(i);
  assert.equal(env.INFERENCE_OPTIMIZER_MN_BACKEND, handoff.backend, "backend");
  assert.equal(env.INFERENCE_OPTIMIZER_NODES, String(handoff.nodes), "nodes");
  assert.equal(env.HYPERLOOM_MN_EXT_SERVICE_URL, handoff.service_url, "service_url");
  assert.equal(env.HYPERLOOM_MN_EXT_SSH_KEY, i.ssh_key_file, "infera.ssh_key_file");
  assert.equal(env.HYPERLOOM_MN_EXT_SSH_PORT, String(i.ssh_port_base), "infera.ssh_port_base");
  assert.equal(env.HYPERLOOM_MN_EXT_PREFILL_IPS, i.prefill_ips.join(","), "infera.prefill_ips");
  assert.equal(env.HYPERLOOM_MN_EXT_DECODE_IPS, i.decode_ips.join(","), "infera.decode_ips");
  assert.equal(env.HYPERLOOM_MN_EXT_WORKER_IPS, i.worker_ips.join(","), "infera.worker_ips");
  assert.equal(handoff.gpus_per_node, 4, "gpus_per_node");
  assert.equal(i.known_hosts_file, `${WS}/.claw/ssh/known_hosts`, "infera.known_hosts_file");
  assert.equal(handoff.ray, undefined);
  assert.equal(env.HYPERLOOM_MN_EXT_HEAD_IP, undefined);
});

test("infera with empty role lists: file keeps empty arrays, legacy vars stay unset", () => {
  const { env, handoff } = build({ ...INFERA, prefillIps: [], decodeIps: [], workerIps: ["10.0.0.9"] });
  assert.deepEqual(handoff.infera?.prefill_ips, []);
  assert.equal(env.HYPERLOOM_MN_EXT_PREFILL_IPS, undefined);
  assert.equal(env.HYPERLOOM_MN_EXT_WORKER_IPS, "10.0.0.9");
});

test("handoff documents validate against the schema", () => {
  for (const ctx of [RAYJOB, INFERA]) {
    const { handoff, byPath } = build(ctx);
    assert.deepEqual(validateTopologyHandoff(handoff), []);
    const onDisk = JSON.parse(byPath.get(`${WS}/.claw/topology.json`)!.content) as TopologyHandoffV1;
    assert.deepEqual(onDisk, handoff);
  }
});

test("topology.json holds paths only, never a credential value", () => {
  for (const ctx of [RAYJOB, INFERA]) {
    const { files, byPath } = build(ctx);
    const doc = byPath.get(`${WS}/.claw/topology.json`)!;
    assert.equal(doc.mode, "644");
    for (const secret of [DASH_TOKEN, "SECRETKEYBODY", "BEGIN OPENSSH"]) {
      assert.ok(!doc.content.includes(secret), `topology.json must not contain ${secret}`);
    }
    // The handoff is written last, after the files it names.
    assert.equal(files[files.length - 1], doc);
    // Credential files are owner-only.
    for (const f of files) if (f !== doc && f.content) assert.equal(f.mode, "600", f.path);
  }
  // The token reaches the sandbox as its own file.
  const { byPath } = build(RAYJOB);
  assert.equal(byPath.get(`${WS}/.claw/ray-token`)?.content, DASH_TOKEN);
});

test("legacy variables follow LEGACY_TOPOLOGY_ENV; the file variable does not", () => {
  // Default (flag unset in the test environment): legacy variables are set.
  const def: Record<string, string> = { SAFE_API_URL: "x" };
  applyMultiNodeExternalEnv(def, INFERA);
  assert.equal(def.HYPERLOOM_MN_EXT_SERVICE_URL, INFERA.serviceUrl);
  assert.equal(def.INFERENCE_OPTIMIZER_NODES, "3");
  assert.equal(def.CLAW_TOPOLOGY_FILE, "/workspace/.claw/topology.json");

  const off: Record<string, string> = { SAFE_API_URL: "x" };
  applyMultiNodeExternalEnv(off, INFERA, { legacyTopologyEnv: false });
  for (const k of Object.keys(off)) {
    assert.ok(!k.startsWith("HYPERLOOM_MN_EXT_"), `${k} must be absent`);
  }
  assert.equal(off.INFERENCE_OPTIMIZER_MN_BACKEND, undefined);
  assert.equal(off.INFERENCE_OPTIMIZER_NODES, undefined);
  assert.equal(off.CLAW_TOPOLOGY_FILE, "/workspace/.claw/topology.json");
  assert.equal(off.SAFE_API_URL, undefined, "external mode is still forced");
});
