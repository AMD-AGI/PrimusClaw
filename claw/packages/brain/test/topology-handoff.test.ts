// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTopologyHandoff, type TopologyHandoffV1 } from "@claw/protocol";
import {
  applyMultiNodeExternalEnv,
  buildTopologyHandoff,
  hasSshKeyFile,
  writeTopologyHandoff,
  TOPOLOGY_HANDOFF_DIR,
  TOPOLOGY_HANDOFF_PATH,
} from "../src/sandbox/params.js";
import { writeSandboxFiles } from "../src/sandbox/multi-node/sandbox-key.js";
import { WORKSPACE_EXCLUDES } from "../src/workspace/excludes.js";
import { USER_ENV_DENY_LIST } from "@claw/protocol";
import type { MultiNodeContext } from "../src/sandbox/multi-node/types.js";

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
const DOC = TOPOLOGY_HANDOFF_PATH;

function build(ctx: MultiNodeContext) {
  const env: Record<string, string> = { WORKSPACE_PATH: WS, SAFE_API_URL: "https://safe.example" };
  applyMultiNodeExternalEnv(env, ctx, { legacyTopologyEnv: true });
  const { handoff, files } = buildTopologyHandoff(ctx);
  const byPath = new Map(files.map((f) => [f.path, f]));
  return { env, handoff, files, byPath };
}

test("rayjob: every legacy variable equals its handoff field", () => {
  const { env, handoff } = build(RAYJOB);
  assert.equal(env.INFERENCE_OPTIMIZER_MN_BACKEND, handoff.backend, "backend");
  assert.equal(env.INFERENCE_OPTIMIZER_NODES, String(handoff.nodes), "nodes");
  assert.equal(env.HYPERLOOM_MN_EXT_SERVICE_URL, handoff.service_url, "service_url");
  assert.equal(env.HYPERLOOM_MN_EXT_HEAD_IP, handoff.ray?.head_ip, "ray.head_ip");
  assert.equal(handoff.gpus_per_node, 8, "gpus_per_node");
  assert.equal(handoff.infera, undefined);
  assert.equal(handoff.schema, "topology-handoff/v1");
  assert.equal(env.TOPOLOGY_HANDOFF_FILE, DOC);
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
  assert.equal(i.known_hosts_file, `${TOPOLOGY_HANDOFF_DIR}/known_hosts`, "infera.known_hosts_file");
  assert.equal(handoff.ray, undefined);
  assert.equal(env.HYPERLOOM_MN_EXT_HEAD_IP, undefined);
});

test("infera with empty role lists: file keeps empty arrays, legacy vars stay unset", () => {
  const { env, handoff } = build({ ...INFERA, prefillIps: [], decodeIps: [], workerIps: ["10.0.0.9"] });
  assert.deepEqual(handoff.infera?.prefill_ips, []);
  assert.equal(env.HYPERLOOM_MN_EXT_PREFILL_IPS, undefined);
  assert.equal(env.HYPERLOOM_MN_EXT_WORKER_IPS, "10.0.0.9");
});

test("atom and sglangrouter hand off the router service and no control-plane block", () => {
  for (const backend of ["atom", "sglangrouter"] as const) {
    const ctx: MultiNodeContext = {
      backend,
      provider: "safe",
      name: `msg1-${backend}`,
      namespace: "ws",
      nodeCount: 2,
      gpusPerNode: 8,
      serviceUrl: `http://msg1-${backend}.ws.svc.cluster.local:8000`,
    };
    const { env, handoff, files } = build(ctx);
    assert.equal(handoff.backend, backend);
    assert.equal(handoff.service_url, ctx.serviceUrl);
    assert.equal(handoff.ray, undefined);
    assert.equal(handoff.infera, undefined);
    assert.deepEqual(validateTopologyHandoff(handoff), []);
    assert.deepEqual(files.map((f) => f.path), [DOC]);
    assert.equal(env.HYPERLOOM_MN_EXT_SERVICE_URL, ctx.serviceUrl);
    assert.equal(env.HYPERLOOM_MN_EXT_SSH_KEY, undefined);
    assert.equal(env.HYPERLOOM_MN_EXT_PREFILL_IPS, undefined);
  }
});

test("handoff documents validate against the schema", () => {
  for (const ctx of [RAYJOB, INFERA]) {
    const { handoff, byPath } = build(ctx);
    assert.deepEqual(validateTopologyHandoff(handoff), []);
    const onDisk = JSON.parse(byPath.get(DOC)!.content) as TopologyHandoffV1;
    assert.deepEqual(onDisk, handoff);
  }
});

test("topology.json holds paths only, never a credential value", () => {
  for (const ctx of [RAYJOB, INFERA]) {
    const { files, byPath } = build(ctx);
    const doc = byPath.get(DOC)!;
    assert.equal(doc.mode, "644");
    for (const secret of ["SECRETKEYBODY", "BEGIN OPENSSH"]) {
      assert.ok(!doc.content.includes(secret), `topology.json must not contain ${secret}`);
    }
    // The handoff is written last, after the files it names.
    assert.equal(files[files.length - 1], doc);
    // Credential files are owner-only.
    for (const f of files) if (f !== doc && f.content) assert.equal(f.mode, "600", f.path);
  }
});

test("legacy variables follow LEGACY_TOPOLOGY_ENV; the file variable does not", () => {
  // Default (flag unset in the test environment): legacy variables are set.
  const def: Record<string, string> = { SAFE_API_URL: "x" };
  applyMultiNodeExternalEnv(def, INFERA);
  assert.equal(def.HYPERLOOM_MN_EXT_SERVICE_URL, INFERA.serviceUrl);
  assert.equal(def.INFERENCE_OPTIMIZER_NODES, "3");
  assert.equal(def.TOPOLOGY_HANDOFF_FILE, DOC);

  const off: Record<string, string> = { SAFE_API_URL: "x" };
  applyMultiNodeExternalEnv(off, INFERA, { legacyTopologyEnv: false });
  for (const k of Object.keys(off)) {
    assert.ok(!k.startsWith("HYPERLOOM_MN_EXT_"), `${k} must be absent`);
  }
  assert.equal(off.INFERENCE_OPTIMIZER_MN_BACKEND, undefined);
  assert.equal(off.INFERENCE_OPTIMIZER_NODES, undefined);
  assert.equal(off.TOPOLOGY_HANDOFF_FILE, DOC);
  assert.equal(off.SAFE_API_URL, undefined, "external mode is still forced");
});

test("the handoff directory is outside the workspace and outside anything the sync governs", () => {
  const { files } = build(INFERA);
  assert.equal(DOC, `${TOPOLOGY_HANDOFF_DIR}/topology.json`);
  for (const root of [WS, "/workspace", process.env.WORKSPACE_PATH ?? "/workspace"]) {
    assert.ok(!(TOPOLOGY_HANDOFF_DIR + "/").startsWith(root + "/"), `${TOPOLOGY_HANDOFF_DIR} under ${root}`);
  }
  // Every file Brain writes for the handoff is in that directory, so neither a
  // snapshot of the workspace nor a restore into it can reach them.
  for (const f of files) assert.equal(f.path.slice(0, f.path.lastIndexOf("/")), TOPOLOGY_HANDOFF_DIR, f.path);
  // And none of them is a path under a workspace-relative exclude that would
  // matter: the exclude list only ever describes workspace-relative names.
  assert.ok(![...WORKSPACE_EXCLUDES].some((e) => String(e).startsWith("/")), "excludes are workspace-relative");
});

test("TOPOLOGY_HANDOFF_FILE cannot be overridden from user env", () => {
  assert.ok(USER_ENV_DENY_LIST.has("TOPOLOGY_HANDOFF_FILE"));
});

test("ssh_key_file is emitted exactly when the key file is written", () => {
  for (const [name, ctx] of [
    ["path and key", INFERA],
    ["path, no key", { ...INFERA, sshPrivateKey: undefined }],
    ["key, no path", { ...INFERA, sshKeyPath: undefined }],
    ["neither", { ...INFERA, sshPrivateKey: undefined, sshKeyPath: undefined }],
  ] as const) {
    const { handoff } = buildTopologyHandoff(ctx);
    assert.equal(handoff.infera?.ssh_key_file !== undefined, hasSshKeyFile(ctx), name);
  }
  assert.equal(buildTopologyHandoff({ ...INFERA, sshPrivateKey: undefined }).handoff.infera?.ssh_key_file, undefined);
});

test("all handoff files are written by one exec, with no credential in it", async () => {
  const { files } = build(INFERA);
  const cmds: string[] = [];
  await writeSandboxFiles(async (c) => (cmds.push(c), { exitCode: 0, stdout: "", stderr: "" }), TOPOLOGY_HANDOFF_DIR, files);
  assert.equal(cmds.length, 1);
  assert.match(cmds[0], /mkdir -p '\/tmp\/claw-topology'/);
  assert.match(cmds[0], /chmod 700 '\/tmp\/claw-topology'/);
  assert.ok(!cmds[0].includes("SECRETKEYBODY"));
  assert.equal((cmds[0].match(/ mv /g) ?? []).length, files.length);
  await assert.rejects(
    writeSandboxFiles(async () => ({ exitCode: 1, stdout: "", stderr: "boom" }), TOPOLOGY_HANDOFF_DIR, files),
    /boom/,
  );
});

test("a handoff write failure is reported, not thrown, and drops TOPOLOGY_HANDOFF_FILE", async () => {
  const env: Record<string, string> = { WORKSPACE_PATH: WS };
  applyMultiNodeExternalEnv(env, INFERA);
  assert.equal(env.TOPOLOGY_HANDOFF_FILE, DOC);
  const bad = await writeTopologyHandoff(async () => ({ exitCode: 1, stdout: "", stderr: "disk full" }), INFERA, env);
  assert.equal(bad.written, false);
  assert.match((bad as { error: string }).error, /disk full/);
  assert.equal(env.TOPOLOGY_HANDOFF_FILE, undefined);
  assert.equal(env.HYPERLOOM_MN_EXT_SERVICE_URL, INFERA.serviceUrl, "legacy env intact");
  const thrown = await writeTopologyHandoff(async () => { throw new Error("exec down"); }, INFERA, env);
  assert.equal(thrown.written, false);

  const ok: Record<string, string> = {};
  applyMultiNodeExternalEnv(ok, INFERA);
  const good = await writeTopologyHandoff(async () => ({ exitCode: 0, stdout: "", stderr: "" }), INFERA, ok);
  assert.equal(good.written, true);
  assert.equal(ok.TOPOLOGY_HANDOFF_FILE, DOC);
});
