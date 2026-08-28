// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInferaWorkloadBody,
  buildRayJobWorkloadBody,
  inferaFrontendPort,
  inferaSshPortBase,
  serviceRolesFor,
  sshPortForPod,
} from "../src/sandbox/multi-node/safe-body.js";
import {
  discoverRolePods,
  gpuPodsReady,
  headPodIp,
  rayClusterName,
} from "../src/sandbox/multi-node/safe-pods.js";
import { deriveSessionKeypair } from "../src/sandbox/multi-node/ssh-key.js";

const COMMON = {
  workspace: "test-workspace",
  displayName: "msg1-ray",
  image: "registry.example.com/sglang:v1",
  nodes: 2,
  gpusPerNode: 8,
  cpusPerNode: 90,
  memGiPerNode: 1024,
  ephemeralGiPerNode: 200,
  sessionId: "sess-1",
  messageId: "msg1",
};

/** Decode a base64 entryPoint back to the shell command SaFE will run. */
function decodeEp(ep: string): string {
  return Buffer.from(ep, "base64").toString("utf-8");
}

test("buildRayJobWorkloadBody splits head/worker replicas and pins the head Service", () => {
  const body = buildRayJobWorkloadBody({ ...COMMON, nodes: 3 }) as Record<string, any>;

  assert.deepStrictEqual(body.groupVersionKind, { kind: "RayJob", version: "v1" });
  // head is always 1 replica; the remaining nodes form the worker role.
  assert.equal(body.resources[0].replica, 1);
  assert.equal(body.resources[1].replica, 2);
  assert.equal(body.resources[0].gpu, "8");
  assert.equal(body.resources[1].memory, "1024Gi");
  assert.deepStrictEqual(body.images, [
    "registry.example.com/sglang:v1",
    "registry.example.com/sglang:v1",
  ]);
  assert.deepStrictEqual(body.entryPoints, ["", ""]);
  // Only the head serves, so the Service selector must exclude the workers.
  assert.deepStrictEqual(body.service.extraSelectors, {
    "ray.io/node-type": "head",
  });
  assert.equal(body.service.port, 8888);
  // A SaFE retry would spawn a second cluster instead of restarting the server.
  assert.equal(body.maxRetry, 0);
  assert.equal(body.isTolerateAll, false);
  assert.equal(decodeEp(body.env.RAY_JOB_ENTRYPOINT), "tail -f /dev/null");
});

test("neither body claims the workspace-storage field", () => {
  // Absent, not false. SaFE reads it as a *bool and defaults an absent one to
  // true, which mounts the workspace's volumes into the cluster's pods -- the
  // shared filesystem a multi-node run reads its own profiles back from. Sending
  // the field could only ever turn that off, and sending `false` is exactly what
  // left a RayJob pod with no shared mount at all.
  for (const [name, body] of [
    ["rayjob", buildRayJobWorkloadBody(COMMON)],
    ["infera", buildInferaWorkloadBody({ ...INFERA_COMMON, pdMode: "aggregated" })],
  ] as const) {
    assert.ok(
      !("useWorkspaceStorage" in (body as Record<string, unknown>)),
      `${name} must not send useWorkspaceStorage`,
    );
  }
});

test("the head Service selects on KubeRay's own head label", () => {
  // Written out rather than read from the builder: the pair describes Ray, and
  // a change there has to break a test here rather than silently produce a
  // Service that selects every pod in the cluster.
  const body = buildRayJobWorkloadBody(COMMON) as Record<string, any>;
  assert.deepStrictEqual(body.service.extraSelectors, {
    "ray.io/node-type": "head",
  });
});

test("buildRayJobWorkloadBody keeps a single-node cluster's worker replica at 1", () => {
  // SaFE rejects replica 0, so nodes=1 still declares one worker slot.
  const body = buildRayJobWorkloadBody({ ...COMMON, nodes: 1 }) as Record<string, any>;
  assert.equal(body.resources[1].replica, 1);
});

test("workload bodies pin the id to the message so teardown never has to search", () => {
  assert.equal((buildRayJobWorkloadBody(COMMON) as Record<string, any>).workloadId, "msg1");
  const infera = buildInferaWorkloadBody({
    ...INFERA_COMMON,
    pdMode: "aggregated",
  }) as Record<string, any>;
  assert.equal(infera.workloadId, "msg1");
  // No message id: let SaFE generate one rather than send an empty string.
  const anon = buildRayJobWorkloadBody({ ...COMMON, messageId: undefined }) as Record<string, any>;
  assert.equal("workloadId" in anon, false);
});

test("workload bodies always carry a timeout so a leaked cluster still expires", () => {
  // Business timeout + the 3600s graceful-shutdown buffer, as the sandbox does.
  const timed = buildRayJobWorkloadBody({ ...COMMON, timeoutSec: 600 }) as Record<string, any>;
  assert.equal(timed.timeout, 4200);
  const inferaTimed = buildInferaWorkloadBody({
    ...INFERA_COMMON,
    pdMode: "aggregated",
    timeoutSec: 600,
  }) as Record<string, any>;
  assert.equal(inferaTimed.timeout, 4200);
  // Unpinned requests still get a bounded lifetime, never an unlimited one.
  assert.equal((buildRayJobWorkloadBody(COMMON) as Record<string, any>).timeout, 86400);
});

test("workload env carries the session key the idle sweeper queries on", () => {
  const body = buildRayJobWorkloadBody(COMMON) as Record<string, any>;
  // Same key sandbox/ensure-hands.ts sets on the sandbox, so one query reaches both.
  assert.equal(body.env.CLAW_SESSION_ID, "sess-1");
  assert.equal(body.env.PRIMUS_CLAW_MESSAGE_ID, "msg1");
  assert.equal(body.env.PRIMUS_CLAW_MN_BACKEND, "rayjob");
  // A user cannot shadow the discovery index and orphan their own cluster.
  const spoofed = buildRayJobWorkloadBody({
    ...COMMON,
    extraEnv: { CLAW_SESSION_ID: "spoofed", PRIMUS_CLAW_MN_BACKEND: "spoofed" },
  }) as Record<string, any>;
  assert.equal(spoofed.env.CLAW_SESSION_ID, "sess-1");
  assert.equal(spoofed.env.PRIMUS_CLAW_MN_BACKEND, "rayjob");
});

test("workload bodies carry the session/message labels cleanup relies on", () => {
  const body = buildRayJobWorkloadBody({
    ...COMMON,
    extraLabels: { team: "perf", "primus-claw/session-id": "spoofed" },
  }) as Record<string, any>;

  assert.equal(body.labels["primus-claw/session-id"], "sess-1");
  assert.equal(body.labels["primus-claw/message-id"], "msg1");
  assert.equal(body.labels["primus-claw/mn-backend"], "rayjob");
  assert.equal(body.labels.team, "perf");
});

test("a caller cannot hand itself one of Brain's own labels", () => {
  // The prefix is reserved unconditionally, so a caller can neither spoof the
  // correlation labels a session is found by nor suppress them.
  const body = buildRayJobWorkloadBody({
    ...COMMON,
    sessionId: undefined,
    messageId: undefined,
    extraLabels: {
      "primus-claw/session-id": "spoofed",
      "primus-claw/mn-backend": "spoofed",
      team: "perf",
    },
  }) as Record<string, any>;

  assert.equal(body.labels["primus-claw/session-id"], undefined);
  assert.equal(body.labels["primus-claw/mn-backend"], "rayjob");
  assert.equal(body.labels.team, "perf");
});

test("a caller cannot label every pod with the head role the Service selects on", () => {
  // The head-role key sits outside Brain's prefix, so it is dropped by name: a
  // caller label of that name would follow every pod and let the Service select
  // a worker.
  const HEAD_ROLE_LABEL = "ray.io/node-type";
  const body = buildRayJobWorkloadBody({
    ...COMMON,
    extraLabels: { [HEAD_ROLE_LABEL]: "head", team: "perf" },
  }) as Record<string, any>;

  assert.equal(body.labels[HEAD_ROLE_LABEL], undefined);
  assert.equal(body.labels.team, "perf");
  assert.deepStrictEqual(body.service.extraSelectors, {
    [HEAD_ROLE_LABEL]: "head",
  });
});

test("user extraEnv cannot override the reserved control-plane variables", () => {
  const body = buildRayJobWorkloadBody({
    ...COMMON,
    extraEnv: { MC_GID_INDEX: "3", RAY_JOB_ENTRYPOINT: "evil" },
  }) as Record<string, any>;

  assert.equal(body.env.MC_GID_INDEX, "3");
  assert.equal(decodeEp(body.env.RAY_JOB_ENTRYPOINT), "tail -f /dev/null");
});

const INFERA_COMMON = {
  ...COMMON,
  displayName: "msg1-infera",
  sshAuthorizedKey: "ssh-ed25519 AAAAC3Nz key",
  model: "/models/Qwen3-30B-A3B",
  framework: "sglang",
  kvTransferBackend: "mooncake",
};

test("buildInferaWorkloadBody deploys aggregated workers idle with a role-scoped SSH port", () => {
  const body = buildInferaWorkloadBody({
    ...INFERA_COMMON,
    pdMode: "aggregated",
  }) as Record<string, any>;

  assert.deepStrictEqual(body.groupVersionKind, { kind: "InferaDeployment", version: "v1" });
  assert.deepStrictEqual(body.inferaOptions.serviceRoles, ["frontend", "worker"]);
  // worker.replica IS the node count: one LWS group spanning both nodes.
  assert.deepStrictEqual(body.inferaOptions.multinodeRoles, ["worker"]);
  assert.equal(body.resources[1].replica, 2);
  assert.equal(body.resources[1].rdmaResource, "1");
  assert.equal(body.resources[0].gpu, undefined, "frontend is CPU-only");
  // Not a fixed 8000: the frontend rides hostNetwork, so the port is derived
  // per workload to keep two deployments on one node from colliding.
  const port = inferaFrontendPort(INFERA_COMMON.displayName);
  assert.ok(port >= 20000 && port < 30000, `derived port ${port} outside the window`);
  assert.equal(body.service.port, port);
  assert.equal(body.service.targetPort, port);
  assert.equal(body.env.MN_SSH_AUTHORIZED_KEY, "ssh-ed25519 AAAAC3Nz key");
  // Same reason as the frontend port: the GPU pods ride hostNetwork, so a fixed
  // sshd port would be fought over by two workloads sharing a node.
  const sshBase = inferaSshPortBase(INFERA_COMMON.displayName);
  assert.equal(body.env.MN_SSH_PORT, String(sshBase));

  assert.match(
    decodeEp(body.entryPoints[0]),
    new RegExp(`infera\\.server .*--port ${port} .*--router-tokenizer-path /models/Qwen3-30B-A3B`),
  );
  // The worker never starts an engine at deploy time; the optimizer SSHes in.
  assert.equal(
    decodeEp(body.entryPoints[1]),
    `export MN_SSH_PORT=$(( ${sshBase} + \${LWS_WORKER_INDEX:-0} )); exec /usr/local/bin/mn-idle.sh`,
  );
});

test("buildInferaWorkloadBody splits prefill/decode roles when PD-disaggregated", () => {
  const body = buildInferaWorkloadBody({
    ...INFERA_COMMON,
    pdMode: "disaggregated",
    pdPrefillNodes: 1,
    pdDecodeNodes: 1,
    pdPrefillTp: 8,
    pdDecodeTp: 8,
  }) as Record<string, any>;

  assert.deepStrictEqual(body.inferaOptions.serviceRoles, ["frontend", "prefill", "decode"]);
  // TP 8 fits one 8-GPU pod, so neither role spans nodes.
  assert.equal(body.inferaOptions.multinodeRoles, undefined);
  assert.equal(body.resources[1].replica, 1);
  assert.equal(body.resources[2].replica, 1);
  // Both roles still need RDMA: the KV transfer plane no-ops without a device.
  assert.equal(body.resources[1].rdmaResource, "1k");
  assert.equal(body.resources[2].rdmaResource, "1k");
  assert.equal(body.images.length, 3);
  // decode is strided so it can co-locate with prefill on one node.
  const decodeBase = inferaSshPortBase(INFERA_COMMON.displayName) + 10;
  assert.match(decodeEp(body.entryPoints[2]), new RegExp(`MN_SSH_PORT=\\$\\(\\( ${decodeBase} \\+`));
});

test("buildInferaWorkloadBody marks a role multinode when its TP exceeds one pod", () => {
  const body = buildInferaWorkloadBody({
    ...INFERA_COMMON,
    pdMode: "disaggregated",
    pdPrefillNodes: 2,
    pdDecodeNodes: 1,
    pdPrefillTp: 16,
    pdDecodeTp: 8,
  }) as Record<string, any>;
  assert.deepStrictEqual(body.inferaOptions.multinodeRoles, ["prefill"]);
});

test("buildInferaWorkloadBody rejects a missing model or authorized key", () => {
  assert.throws(
    () => buildInferaWorkloadBody({ ...INFERA_COMMON, model: "  ", pdMode: "aggregated" }),
    /model is required/,
  );
  assert.throws(
    () => buildInferaWorkloadBody({ ...INFERA_COMMON, sshAuthorizedKey: "", pdMode: "aggregated" }),
    /sshAuthorizedKey is required/,
  );
});

test("sshPortForPod matches the port the idle entryPoint computes in-pod", () => {
  const base = 20032;
  assert.equal(sshPortForPod("worker", 0, base), 20032);
  assert.equal(sshPortForPod("worker", 1, base), 20033);
  assert.equal(sshPortForPod("prefill", 0, base), 20032);
  assert.equal(sshPortForPod("decode", 0, base), 20042);
  assert.equal(sshPortForPod("decode", 2, base), 20044);
  assert.equal(sshPortForPod("worker", null, base), 20032, "unparseable ordinal falls back to the leader");
});

test("discoverRolePods maps PD pods by slot index and drops dead ones", () => {
  const workload = {
    pods: [
      { podId: "test-role0-abc", podIP: "192.0.2.1", phase: "Running" },
      { podId: "test-role1-def", podIP: "192.0.2.2", phase: "Running" },
      { podId: "test-role2-ghi", podIP: "192.0.2.3", phase: "Running" },
      // A crashed replica keeps its IP but has no sshd: SSHing to it fails the round.
      { podId: "test-role2-dead", podIP: "192.0.2.9", phase: "Failed" },
      { podId: "test-role1-nopod", podIP: "", phase: "Pending" },
    ],
  };
  const groups = discoverRolePods(workload, "disaggregated", 2222);

  assert.deepStrictEqual(groups.frontend.map((p) => p.podIp), ["192.0.2.1"]);
  assert.deepStrictEqual(groups.prefill.map((p) => p.podIp), ["192.0.2.2"]);
  assert.deepStrictEqual(groups.decode.map((p) => p.podIp), ["192.0.2.3"]);
  assert.equal(gpuPodsReady(groups, "disaggregated"), true);
});

test("discoverRolePods orders an LWS group leader-first", () => {
  const workload = {
    pods: [
      { podId: "test-role1-lws-2", podIP: "192.0.2.4", phase: "Running" },
      { podId: "test-role1-lws-0", podIP: "192.0.2.2", phase: "Running" },
      { podId: "test-role1-lws-1", podIP: "192.0.2.3", phase: "Running" },
    ],
  };
  const groups = discoverRolePods(workload, "aggregated", 2222);
  assert.deepStrictEqual(groups.worker.map((p) => p.podIp), ["192.0.2.2", "192.0.2.3", "192.0.2.4"]);
  assert.deepStrictEqual(groups.worker.map((p) => p.sshPort), [2222, 2223, 2224]);
});

test("gpuPodsReady waits for every role the topology needs", () => {
  const onlyPrefill = discoverRolePods(
    { pods: [{ podId: "test-role1-a", podIP: "192.0.2.2", phase: "Running" }] },
    "disaggregated",
    2222,
  );
  assert.equal(gpuPodsReady(onlyPrefill, "disaggregated"), false, "decode has no pod yet");
  assert.equal(gpuPodsReady(onlyPrefill, "aggregated"), false, "no worker pod either");
});

test("headPodIp picks the live Ray head pod, used as the control-plane fallback", () => {
  // Shape of a real workload detail: KubeRay names the head pod
  // `<rayClusterName>-head-<hash>`; the submitter and workers must not match.
  const detail = {
    pods: [
      { podId: "claw-1-ray-x-42svw", podIP: "172.16.0.20", phase: "Running" },
      { podId: "claw-1-ray-x-f6xw4-1-worker-rrpzg", podIP: "172.16.6.231", phase: "Running" },
      { podId: "claw-1-ray-x-f6xw4-head-x8lx8", podIP: "172.16.6.230", phase: "Running" },
    ],
  };
  assert.equal(headPodIp(detail), "172.16.6.230");

  // A dead head keeps its IP but serves nothing, so it must not be returned.
  assert.equal(
    headPodIp({ pods: [{ podId: "test-head-x", podIP: "192.0.2.1", phase: "Failed" }] }),
    undefined,
  );
  assert.equal(headPodIp({ pods: [] }), undefined);
  assert.equal(headPodIp({}), undefined);
});

test("rayClusterName recovers the cluster name from the head pod", () => {
  // Verbatim pod list from a live RayJob workload. The name carries a generated
  // suffix, so this is what spares us a RayJob CR read for the -head-svc host.
  const detail = {
    pods: [
      { podId: "claw-1785495315218-ray-cvvf2-g4ffm", phase: "Running" },
      { podId: "claw-1785495315218-ray-cvvf2-jspxc-1-worker-hxrlh", phase: "Running" },
      { podId: "claw-1785495315218-ray-cvvf2-jspxc-head-xdhsz", phase: "Running" },
    ],
  };
  assert.equal(rayClusterName(detail), "claw-1785495315218-ray-cvvf2-jspxc");
  // A dead head must not be trusted; its Service may already be gone.
  assert.equal(
    rayClusterName({ pods: [{ podId: "c-jspxc-head-x", phase: "Failed" }] }),
    undefined,
  );
  assert.equal(rayClusterName({ pods: [] }), undefined);
});

test("serviceRolesFor matches the positional roles the bodies declare", () => {
  assert.deepStrictEqual(serviceRolesFor("disaggregated"), ["frontend", "prefill", "decode"]);
  assert.deepStrictEqual(serviceRolesFor("aggregated"), ["frontend", "worker"]);
});

test("deriveSessionKeypair is deterministic per scope and isolated across scopes", () => {
  // Determinism is what lets a redelivered message adopt its running workload:
  // the pods' authorized_keys was baked from the original public key.
  const a = deriveSessionKeypair("secret", "sess-1:msg-1", "primus-claw-sess-1");
  const again = deriveSessionKeypair("secret", "sess-1:msg-1", "primus-claw-sess-1");
  const otherMessage = deriveSessionKeypair("secret", "sess-1:msg-2", "primus-claw-sess-1");
  const otherSecret = deriveSessionKeypair("secret2", "sess-1:msg-1", "primus-claw-sess-1");

  assert.equal(a.authorizedKey, again.authorizedKey);
  assert.equal(a.privateKeyPem, again.privateKeyPem);
  assert.notEqual(a.authorizedKey, otherMessage.authorizedKey);
  assert.notEqual(a.authorizedKey, otherSecret.authorizedKey);

  assert.match(a.authorizedKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[\w+/=]+ primus-claw-sess-1$/);
  assert.match(a.privateKeyPem, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
  assert.match(a.privateKeyPem, /-----END OPENSSH PRIVATE KEY-----\n$/);
});

test("deriveSessionKeypair refuses to run without a stable secret", () => {
  assert.throws(() => deriveSessionKeypair("", "sess-1:msg-1", "c"), /stable secret is required/);
});
