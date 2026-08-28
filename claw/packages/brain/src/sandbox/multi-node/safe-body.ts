// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Builders for SaFE CreateWorkloadRequest bodies of a session-scoped
 * multi-node cluster. Derived from Hyperloom's multi-node workload
 * specification.
 *
 * Non-overridable decisions (both backends):
 *   - `isSupervised/isTolerateAll = false` (tolerateAll would let benchmarks
 *     land on tainted nodes).
 *   - `maxRetry = 0`: a SaFE retry would spawn a duplicate cluster; the
 *     optimizer restarts the server in-cluster instead.
 *   - `entryPoints` are base64 per the SaFE contract.
 * Kept import-free (no k8s client, no config) so tests and other callers can
 * load deterministic builders without inheriting process environment.
 */

import type { MultiNodeBackend } from "./types.js";

/** RayJob head serves the inference server here; matches the Claw template. */
export const RAYJOB_SERVER_PORT = 8888;
/**
 * Window the Infera frontend's HTTP port is drawn from.
 *
 * The port cannot be a fixed 8000. SaFE puts the frontend on hostNetwork
 * whenever any worker requests RDMA (see the InferaDeployment branch of
 * `IsEnabledHostNetwork`), so `--port` binds a NODE port -- and two Infera
 * deployments landing on one node then fight over it. That is not theoretical:
 * a frontend crash-looped with `[Errno 98] address already in use` against
 * another team's `infera.server` on the same host.
 *
 * 20000-29999 sits above the registered range and below both Kubernetes'
 * default NodePort range (30000-32767) and Linux's ephemeral range (32768+),
 * so it collides with neither. The band is split in half with the sshd windows
 * below, so a frontend port can never land on one of its own pods' sshd ports.
 */
const INFERA_FRONTEND_PORT_BASE = 20000;
const INFERA_FRONTEND_PORT_SPAN = 5000;

/**
 * FNV-1a, hand-rolled rather than taken from a runtime hash, which is not
 * guaranteed stable across processes or versions. Port derivation must be
 * reproducible: a redelivered message re-derives the ports of the cluster it
 * adopts instead of talking to the wrong ones.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Derive the frontend port from the workload name.
 *
 * Deterministic so the value is identical in the entryPoint, the Service and the
 * URL handed to the sandbox.
 */
export function inferaFrontendPort(workloadName: string): number {
  return INFERA_FRONTEND_PORT_BASE + (fnv1a(workloadName) % INFERA_FRONTEND_PORT_SPAN);
}

/** Port stride between co-located Infera roles (prefill 0, decode +10). */
export const INFERA_SSH_PORT_ROLE_STRIDE = 10;

/**
 * Window each workload's sshd ports are drawn from, for the same reason the
 * frontend port is derived: RDMA forces the GPU pods onto hostNetwork, so
 * `MN_SSH_PORT` binds a NODE port. A fixed base (this was 2222) is therefore
 * guaranteed to clash once two workloads share a node -- and the clash is
 * silent and confusing, because the pod holding host:2222 answers with ITS
 * host key while the pod one expects to reach looks perfectly healthy from
 * `kubectl exec`, so the failure surfaces as "the key matches but SSH is
 * refused".
 *
 * Takes the upper half of the same collision-free band the frontend draws from,
 * quantised into windows so a workload owns every port a role can compute:
 * prefill takes base+0..9, decode base+10..19 (see
 * INFERA_SSH_PORT_ROLE_STRIDE), leaving 12 spare. That caps a role at 10 nodes,
 * which the stride already implied. Disjoint from the frontend half by
 * construction rather than by hashing, so no frontend port can ever sit on an
 * sshd port -- not even its own workload's.
 */
const INFERA_SSH_PORT_BAND_BASE = INFERA_FRONTEND_PORT_BASE + INFERA_FRONTEND_PORT_SPAN;
const INFERA_SSH_PORT_BAND_SPAN = 5000;
const INFERA_SSH_PORT_WINDOW = 32;
const INFERA_SSH_PORT_WINDOW_COUNT = Math.floor(INFERA_SSH_PORT_BAND_SPAN / INFERA_SSH_PORT_WINDOW);

/**
 * Derive a workload's sshd port base from its name.
 *
 * Two different workloads can still draw the same window (156 exist), but at
 * ~1/156 instead of the certainty a fixed base gave.
 */
export function inferaSshPortBase(workloadName: string): number {
  const slot = fnv1a(`ssh:${workloadName}`) % INFERA_SSH_PORT_WINDOW_COUNT;
  return INFERA_SSH_PORT_BAND_BASE + slot * INFERA_SSH_PORT_WINDOW;
}

/** Prefix of every label Brain manages; callers can never set one. */
const BRAIN_LABEL_PREFIX = "primus-claw/";

/**
 * Label and value identifying the head pod of a RayJob, which the Service below
 * pins through `extraSelectors` so only the head is ever selected.
 *
 * KubeRay's own label, not the platform's. SaFE's RayJob template adds a second
 * head label of its own, and the operator stamps this one; both are on the pod.
 * This is the one to select on because it comes from the operator rather than
 * from a chart template a release could edit, and because it carries no
 * deployment-specific name -- SaFE's own template relies on it too, to keep the
 * job submitter on the head's node.
 *
 * Constants rather than settings: they describe Ray and the SaFE release Brain
 * submits to, so there is no value a deployment could know that these do not.
 */
const HEAD_ROLE_LABEL = "ray.io/node-type";
const HEAD_ROLE_VALUE = "head";

/**
 * Scheduling priority every multi-node workload is created with.
 *
 * Zero is SaFE's own default for the field, so this states what would happen
 * anyway. It stays explicit because the Service and resource layout below are
 * written for one priority, and a cluster created at another would compete with
 * the platform's own workloads on terms nothing here accounts for.
 */
const WORKLOAD_PRIORITY = 0;

/** Session correlation label Brain queries on to find its own workloads. */
export const SESSION_LABEL = `${BRAIN_LABEL_PREFIX}session-id`;

/** Submitter-only, signal-interruptable driver for RayJob.spec.entrypoint. */
const SUBMITTER_BLOCK_ENTRYPOINT = "tail -f /dev/null";

/** Idle GPU-pod script shipped in the SaFE images: starts sshd, then blocks. */
const INFERA_IDLE_SCRIPT = "/usr/local/bin/mn-idle.sh";

/**
 * Correlation env, mirroring the labels below.
 *
 * This is the discovery index: SaFE's list endpoint filters on `envKey` /
 * `envValue` (exact jsonb match) and echoes `env` back, but it neither filters
 * nor returns the workload labels, so the labels alone cannot find a session's
 * clusters through the API (see sandbox/multi-node/safe-provider.ts findSessionWorkloads).
 *
 * `CLAW_SESSION_ID` is deliberately the same key sandbox/ensure-hands.ts already sets on
 * the Hands sandbox, so one session-scoped query reaches the sandbox and every
 * GPU cluster -- matching what the `primus-claw/session-id` label selector used
 * to cover.
 */
export const SESSION_ENV = "CLAW_SESSION_ID";
export const MESSAGE_ENV = "PRIMUS_CLAW_MESSAGE_ID";
export const BACKEND_ENV = "PRIMUS_CLAW_MN_BACKEND";

/** Owned by the builders below, so user `extraEnv` may not set them. */
const RESERVED_ENV = new Set([
  "RAY_JOB_ENTRYPOINT",
  "MN_SSH_AUTHORIZED_KEY",
  "MN_SSH_PORT",
  SESSION_ENV,
  MESSAGE_ENV,
  BACKEND_ENV,
]);

function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

function sanitizeEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extraEnv ?? {})) {
    if (RESERVED_ENV.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Drops caller labels that Brain manages. Keys the body itself depends on are
 * passed in as `reservedKeys`, which is how the head-role label is protected
 * without being a prefix.
 */
function sanitizeLabels(
  extraLabels?: Record<string, string>,
  reservedKeys?: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extraLabels ?? {})) {
    if (reservedKeys?.includes(k)) continue;
    if (k.startsWith(BRAIN_LABEL_PREFIX)) continue;
    out[k] = v;
  }
  return out;
}

/** SSH port offset for a GPU role; decode is strided so it can co-locate. */
export function sshRolePortOffset(role: string): number {
  return role.toLowerCase() === "decode" ? INFERA_SSH_PORT_ROLE_STRIDE : 0;
}

/**
 * sshd port a pod listens on: base + role offset + LWS ordinal. `base` is
 * required so no caller can silently fall back to a shared fixed port.
 */
export function sshPortForPod(role: string, lwsIndex: number | null, base: number): number {
  return base + sshRolePortOffset(role) + (typeof lwsIndex === "number" ? lwsIndex : 0);
}

/**
 * Idle entryPoint for a GPU role. `MN_SSH_PORT` is derived in-pod from
 * `LWS_WORKER_INDEX` so every pod of a multi-node group gets a distinct port
 * while sharing one role base.
 */
function idleWorkerEntrypoint(role: string, base: number): string {
  const roleBase = base + sshRolePortOffset(role);
  return `export MN_SSH_PORT=$(( ${roleBase} + \${LWS_WORKER_INDEX:-0} )); exec ${INFERA_IDLE_SCRIPT}`;
}

/** Fields shared by both workload bodies. */
interface CommonWorkloadParams {
  workspace: string;
  displayName: string;
  image: string;
  nodes: number;
  gpusPerNode: number;
  cpusPerNode: number;
  memGiPerNode: number;
  ephemeralGiPerNode: number;
  sessionId?: string;
  /** Correlates the workload with the message that provisioned it. */
  messageId?: string;
  description?: string;
  ownerId?: string;
  /**
   * Business timeout in seconds; SaFE stops the cluster once it elapses.
   *
   * The backstop against a leaked cluster: Brain releases the cluster when its
   * task ends, but a Brain that dies mid-task never runs that teardown, and
   * nothing else would ever reclaim the GPUs. Mirrors what the Hands sandbox
   * already does, graceful-shutdown buffer included.
   */
  timeoutSec?: number;
  /** Total lifetime used when timeoutSec is omitted; includes any shutdown buffer. */
  defaultTimeoutSec?: number;
  extraEnv?: Record<string, string>;
  extraLabels?: Record<string, string>;
}

/**
 * Grace period SaFE gets to stop a cluster after its business timeout, matching
 * sandbox/safe-workload-provider.ts so the sandbox and its GPU cluster expire alike.
 */
const SHUTDOWN_BUFFER_SECONDS = 3600;

/**
 * Business timeout plus the shutdown buffer. A request that pins no timeout
 * falls back to the configured default, which the sandbox shares.
 */
function workloadTimeout(timeoutSec?: number, defaultTimeoutSec = 24 * 60 * 60): number {
  return timeoutSec !== undefined
    ? timeoutSec + SHUTDOWN_BUFFER_SECONDS
    : defaultTimeoutSec;
}

/**
 * Constant, non-overridable part of every multi-node CreateWorkloadRequest.
 *
 * `useWorkspaceStorage` is deliberately absent. SaFE reads that field as a
 * *bool and treats an absent one as true, mounting the workspace's declared
 * volumes into the cluster's pods -- which is what a multi-node run needs,
 * since the shared root travels to the pods as a path in NFS_SHARED_ROOT and
 * nothing here asks for the mount that makes the path exist. Sending the field
 * at all could only ever turn that off.
 */
function baseBody(kind: string): Record<string, unknown> {
  return {
    groupVersionKind: { kind, version: "v1" },
    priority: WORKLOAD_PRIORITY,
    isSupervised: false,
    isTolerateAll: false,
    privileged: false,
    forceHostNetwork: false,
    preheat: false,
    maxRetry: 0,
    dependencies: [],
  };
}

/**
 * Add the session/message correlation env to a sanitised env map, in place.
 *
 * @param env Sanitised env map (reserved keys already stripped).
 * @param backend Engine topology, so a sweep can tell the two apart.
 */
function applyCorrelationEnv(
  env: Record<string, string>,
  backend: MultiNodeBackend,
  sessionId?: string,
  messageId?: string,
): void {
  if (sessionId) env[SESSION_ENV] = sessionId;
  if (messageId) env[MESSAGE_ENV] = messageId;
  env[BACKEND_ENV] = backend;
}

/**
 * Pin the workload id to the message id, in place.
 *
 * SaFE derives an id from `displayName` with a random suffix unless one is
 * given, which would force every later lookup to search for it. Pinning it makes
 * the cluster directly addressable (`DELETE /api/v1/workloads/{messageId}`), so
 * teardown never has to scan. Safe because a message provisions at most one
 * cluster, and re-creating an existing id is exactly the redelivery case the
 * caller already adopts.
 *
 * @param body Workload create body, mutated in place.
 * @param messageId Message that provisioned the cluster; skipped when absent.
 */
function applyWorkloadId(body: Record<string, unknown>, messageId?: string): void {
  const id = (messageId ?? "").trim();
  if (id) body.workloadId = id;
}

/** Session/message correlation labels Brain needs for discovery and cleanup. */
function correlationLabels(
  extraLabels: Record<string, string> | undefined,
  backend: MultiNodeBackend,
  sessionId?: string,
  messageId?: string,
  reservedKeys?: readonly string[],
): Record<string, string> {
  const labels = sanitizeLabels(extraLabels, reservedKeys);
  if (sessionId) labels[SESSION_LABEL] = sessionId;
  if (messageId) labels["primus-claw/message-id"] = messageId;
  labels["primus-claw/mn-backend"] = backend;
  return labels;
}

function assertCommon(p: CommonWorkloadParams): void {
  if (p.nodes < 1) throw new Error(`nodes must be >= 1, got ${p.nodes}`);
  if (p.gpusPerNode < 1) throw new Error(`gpusPerNode must be >= 1, got ${p.gpusPerNode}`);
  if (!p.workspace) throw new Error("workspace is required");
  if (!p.displayName) throw new Error("displayName is required");
  if (!p.image) throw new Error("image is required");
}

/**
 * SaFE CreateWorkloadRequest for a multi-node RayJob: head (replica 1) plus one
 * worker role scaled to `nodes - 1`. The Service pins the head role, since only
 * the head serves.
 */
export function buildRayJobWorkloadBody(p: CommonWorkloadParams): Record<string, unknown> {
  assertCommon(p);
  const perNode = {
    cpu: String(p.cpusPerNode),
    memory: `${p.memGiPerNode}Gi`,
    gpu: String(p.gpusPerNode),
    ephemeralStorage: `${p.ephemeralGiPerNode}Gi`,
  };
  // SaFE requires replica >= 1 even for a single-node "cluster".
  const workerReplica = Math.max(1, p.nodes - 1);

  const env = sanitizeEnv(p.extraEnv);
  env.RAY_JOB_ENTRYPOINT = b64(SUBMITTER_BLOCK_ENTRYPOINT);
  applyCorrelationEnv(env, "rayjob", p.sessionId, p.messageId);

  const body: Record<string, unknown> = {
    ...baseBody("RayJob"),
    timeout: workloadTimeout(p.timeoutSec, p.defaultTimeoutSec),
    displayName: p.displayName,
    workspaceId: p.workspace,
    resources: [
      { replica: 1, ...perNode },
      { replica: workerReplica, ...perNode },
    ],
    images: [p.image, p.image],
    // Optional per-role install payloads; the long-run driver is RAY_JOB_ENTRYPOINT.
    entryPoints: ["", ""],
    env,
    // The head-role key is reserved: a caller label of the same name would
    // follow every pod and let the Service below select a worker.
    labels: correlationLabels(
      p.extraLabels,
      "rayjob",
      p.sessionId,
      p.messageId,
      [HEAD_ROLE_LABEL],
    ),
    service: {
      protocol: "TCP",
      port: RAYJOB_SERVER_PORT,
      targetPort: RAYJOB_SERVER_PORT,
      serviceType: "ClusterIP",
      extraSelectors: { [HEAD_ROLE_LABEL]: HEAD_ROLE_VALUE },
    },
  };
  applyWorkloadId(body, p.messageId);
  if (p.description) body.description = p.description;
  if (p.ownerId) body.ownerId = p.ownerId;
  return body;
}

export interface InferaWorkloadParams extends CommonWorkloadParams {
  /** Public key injected as MN_SSH_AUTHORIZED_KEY for mn-sshd-init.sh. */
  sshAuthorizedKey: string;
  /** Model path/id for the frontend `--router-tokenizer-path`. */
  model: string;
  framework: string;
  kvTransferBackend: string;
  pdMode: "aggregated" | "disaggregated";
  pdPrefillNodes?: number;
  pdDecodeNodes?: number;
  pdPrefillTp?: number;
  pdDecodeTp?: number;
  sshPortBase?: number;
  rdmaResource?: string;
  frontendCpu?: number;
  frontendMemGi?: number;
  frontendPort?: number;
}

/**
 * SaFE CreateWorkloadRequest for an IDLE multi-node InferaDeployment.
 *
 * GPU pods deploy idle (`mn-idle.sh`: sshd, then block) so the optimizer can
 * SSH in and relaunch the engine per round without redeploying the workload,
 * which preserves the aiter JIT cache across restarts. `worker.replica` IS the
 * node count for a multinode role (one LeaderWorkerSet group spanning nodes),
 * not a Deployment replica count.
 */
export function buildInferaWorkloadBody(p: InferaWorkloadParams): Record<string, unknown> {
  assertCommon(p);
  if (!p.model.trim()) {
    throw new Error("model is required (infera frontend --router-tokenizer-path)");
  }
  if (!p.sshAuthorizedKey.trim()) {
    throw new Error("sshAuthorizedKey is required for the Infera idle-pod control plane");
  }

  const sshPortBase = p.sshPortBase ?? inferaSshPortBase(p.displayName);
  const frontendPort = p.frontendPort ?? inferaFrontendPort(p.displayName);
  const rdmaResource = p.rdmaResource ?? "1";

  // Frontend (role 0): CPU-only OpenAI-compatible router.
  const frontendResource = {
    replica: 1,
    cpu: String(p.frontendCpu ?? 4),
    memory: `${p.frontendMemGi ?? 16}Gi`,
  };

  /** One GPU pod slot; RDMA is only meaningful when the role spans nodes. */
  const gpuResource = (replica: number, multinode: boolean): Record<string, unknown> => {
    const res: Record<string, unknown> = {
      replica,
      cpu: String(p.cpusPerNode),
      memory: `${p.memGiPerNode}Gi`,
      gpu: String(p.gpusPerNode),
      ephemeralStorage: `${p.ephemeralGiPerNode}Gi`,
    };
    if (multinode) res.rdmaResource = rdmaResource;
    return res;
  };

  const frontendEp = b64(
    `python3 -m infera.server --host 0.0.0.0 --port ${frontendPort} ` +
    `--router-policy round-robin --router-tokenizer-path ${p.model.trim()} --enable-profiling`,
  );

  let resources: Record<string, unknown>[];
  let images: string[];
  let entryPoints: string[];
  let serviceRoles: string[];
  let multinodeRoles: string[];

  if (p.pdMode === "disaggregated") {
    const pn = Math.max(1, p.pdPrefillNodes ?? 0);
    const dn = Math.max(1, p.pdDecodeNodes ?? 0);
    // A role spans nodes (LeaderWorkerSet) only when its TP exceeds one pod's
    // GPUs; otherwise replica is an independent single-node instance count.
    const prefillMn = (p.pdPrefillTp ?? 0) > p.gpusPerNode;
    const decodeMn = (p.pdDecodeTp ?? 0) > p.gpusPerNode;
    const prefillRes = gpuResource(pn, prefillMn);
    const decodeRes = gpuResource(dn, decodeMn);
    // Both PD roles stream the KV cache across pods, so both need an RDMA
    // device even when single-node; without one the transfer plane no-ops.
    const pdRdma = rdmaResource && rdmaResource !== "1" ? rdmaResource : "1k";
    prefillRes.rdmaResource = pdRdma;
    decodeRes.rdmaResource = pdRdma;
    resources = [frontendResource, prefillRes, decodeRes];
    images = [p.image, p.image, p.image];
    entryPoints = [
      frontendEp,
      b64(idleWorkerEntrypoint("prefill", sshPortBase)),
      b64(idleWorkerEntrypoint("decode", sshPortBase)),
    ];
    serviceRoles = ["frontend", "prefill", "decode"];
    multinodeRoles = [...(prefillMn ? ["prefill"] : []), ...(decodeMn ? ["decode"] : [])];
  } else {
    resources = [frontendResource, gpuResource(p.nodes, p.nodes > 1)];
    images = [p.image, p.image];
    entryPoints = [frontendEp, b64(idleWorkerEntrypoint("worker", sshPortBase))];
    serviceRoles = ["frontend", "worker"];
    multinodeRoles = p.nodes > 1 ? ["worker"] : [];
  }

  const env = sanitizeEnv(p.extraEnv);
  env.MN_SSH_AUTHORIZED_KEY = p.sshAuthorizedKey.trim();
  env.MN_SSH_PORT = String(sshPortBase);
  applyCorrelationEnv(env, "infera", p.sessionId, p.messageId);

  const inferaOptions: Record<string, unknown> = {
    backendFramework: p.framework,
    kvTransferBackend: p.kvTransferBackend,
    serviceRoles,
  };
  if (multinodeRoles.length > 0) inferaOptions.multinodeRoles = multinodeRoles;

  const body: Record<string, unknown> = {
    ...baseBody("InferaDeployment"),
    timeout: workloadTimeout(p.timeoutSec, p.defaultTimeoutSec),
    displayName: p.displayName,
    workspaceId: p.workspace,
    resources,
    images,
    entryPoints,
    env,
    labels: correlationLabels(
      p.extraLabels,
      "infera",
      p.sessionId,
      p.messageId,
    ),
    inferaOptions,
    service: {
      protocol: "TCP",
      port: frontendPort,
      targetPort: frontendPort,
      serviceType: "ClusterIP",
    },
  };
  applyWorkloadId(body, p.messageId);
  if (p.description) body.description = p.description;
  if (p.ownerId) body.ownerId = p.ownerId;
  return body;
}

/** Positional serviceRoles for a topology; must match the builders above. */
export function serviceRolesFor(pdMode: string): string[] {
  return pdMode.toLowerCase() === "disaggregated"
    ? ["frontend", "prefill", "decode"]
    : ["frontend", "worker"];
}
