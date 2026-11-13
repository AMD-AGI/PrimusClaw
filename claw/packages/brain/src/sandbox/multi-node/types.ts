// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Deploy-mode-agnostic contract for provisioning the multi-node inference
 * cluster a task runs against.
 *
 * Clusters are created as SaFE workloads (RayJob, Infera, Atom, or SGLangRouter); see factory.ts,
 * which rejects a deployment without SaFE. The result is a `MultiNodeContext`,
 * all the sandbox needs to drive the cluster via Hyperloom's "external mode"
 * (see sandbox/params.ts applyMultiNodeExternalEnv).
 */

import type { ExecuteRequest, TopologyBackend } from "@claw/protocol";

/** Engine topology, from the prompt's `--mn-backend`. */
export type MultiNodeBackend = TopologyBackend;

/** Which mechanism provisioned the cluster. */
export type MultiNodeProviderKind = "safe";

/** Handle on a provisioned multi-node cluster, consumed by the sandbox env. */
export interface MultiNodeContext {
  backend: MultiNodeBackend;
  provider: MultiNodeProviderKind;
  /** SaFE workload id. */
  name: string;
  namespace: string;
  /** Total GPU nodes; drives INFERENCE_OPTIMIZER_NODES. */
  nodeCount: number;
  /** GPUs on each node; carried to the sandbox in the topology handoff. */
  gpusPerNode: number;
  /** Base URL benchmarks target: Ray head :8888, the Infera frontend, or the Atom/SGLangRouter router :8000. */
  serviceUrl: string;
  /** rayjob: host serving Ray Dashboard :8265 and GCS :6379. */
  headHost?: string;
  /** rayjob: Ray Dashboard auth token, when the dashboard is authenticated. */
  dashboardToken?: string;
  /** infera, atomesh, sglangrouter: PEM private key authorised on the GPU pods. */
  sshPrivateKey?: string;
  /** infera, atomesh, sglangrouter: path the private key is materialised at inside the sandbox. */
  sshKeyPath?: string;
  /** infera: SSH base port, decode pods role-offset; atomesh/sglangrouter: the one port of every pod. */
  sshPortBase?: number;
  /** infera: the sshd port of each pod, by pod IP. */
  sshPorts?: Record<string, number>;
  /** atomesh/sglangrouter: router pod IPs. */
  routerIps?: string[];
  /** PD: prefill pod IPs, rank order. */
  prefillIps?: string[];
  /** PD: decode pod IPs, rank order. */
  decodeIps?: string[];
  /** infera aggregated: worker pod IPs, rank order (leader first). */
  workerIps?: string[];
  /** atomesh/sglangrouter: prefill engine Service URL. */
  prefillUrl?: string;
  /** atomesh/sglangrouter: decode engine Service URL. */
  decodeUrl?: string;
  /** atomesh/sglangrouter/infera: what the prompt asked of the launch, carried into the node list. */
  pdLaunch?: PdLaunchRequest;
}

/** The prompt's launch settings, as the cluster was created with them. */
export interface PdLaunchRequest {
  /** `--model`. */
  model: string;
  /** infera: `--framework`, the engine the GPU pods run. */
  framework?: string;
  /** infera: `--pd-mode`; atomesh and sglangrouter are always disaggregated. */
  mode?: "aggregated" | "disaggregated";
  /** `--pd-transfer-backend`, the KV transfer backend the cluster runs. */
  kvTransferBackend: string;
  /** `--pd-prefill-tp`; 0 when the prompt does not fix it. */
  prefillTp: number;
  /** `--pd-decode-tp`; 0 when the prompt does not fix it. */
  decodeTp: number;
  /** `--server-args`, for both roles. */
  serverArgs: string;
  /** `--pd-prefill-extra-args`. */
  prefillExtraArgs: string;
  /** `--pd-decode-extra-args`. */
  decodeExtraArgs: string;
}

/** One role's parallelism the operator fixed; `null` leaves it to the launch source. */
export interface NodeListRoleTopology {
  tp: number | null;
  ep: number | null;
  dp_attention: boolean | null;
}

/** One host of the node list; `ssh_port` when its sshd listens on a port of its own. */
export interface NodeListHost {
  host: string;
  ssh_port?: number;
}

/**
 * The InferenceSuite multi-node node list (`inference_suite.multinode` input
 * contract): the cluster's service and engine URLs, serving mode, hosts per
 * role (prefill and decode when disaggregated, worker when aggregated), SSH
 * access, GPUs per node and the operator's optional topology and args. Holds
 * the SSH key by path only.
 */
export interface MultiNodeNodeList {
  framework: "sglang" | "atom";
  /** The router the router pod runs; `infera` is the platform's frontend, which the suite never launches. */
  frontend: "sglang-router" | "atomesh" | "infera";
  model: string;
  /** Router Service URL the client and accuracy eval target. */
  service_url: string;
  /** Absent means disaggregated. */
  mode?: "aggregated" | "disaggregated";
  /** Prefill engine Service URL; its port is the one the engines listen on. */
  prefill_url?: string;
  /** Decode engine Service URL; its port is the one the engines listen on. */
  decode_url?: string;
  /** Required unless the frontend is `infera`. */
  router?: NodeListHost;
  prefill?: NodeListHost[];
  decode?: NodeListHost[];
  worker?: NodeListHost[];
  gpus_per_node: number;
  ssh?: { port: number; user: string; key_file: string };
  transfer_backend?: string;
  topology?: { prefill?: NodeListRoleTopology; decode?: NodeListRoleTopology; worker?: NodeListRoleTopology };
  launch_mode: "direct" | "in_place";
  config?: { prefill_args?: string; decode_args?: string; worker_args?: string; router_args: string };
}

export interface MultiNodeEnsureOptions {
  /** NATS delivery count, surfaced in provisioning events for redeliveries. */
  deliveryCount?: number;
  /** SaFE API key of the requesting user; required by the safe provider. */
  platformKey?: string;
  /** The run's cancel signal: aborting ends the wait for the cluster and deletes it. */
  signal?: AbortSignal;
  /** False when that signal's abort is not a cancel (restart, successor, deadline):
   *  the cluster is then left for the run's own handling; only a cancel deletes it. */
  reclaimOnAbort?: () => boolean;
}

/** Emitted to the client while provisioning progresses. */
export type MultiNodeEventSink = (evt: Record<string, unknown>) => Promise<void>;

export interface MultiNodeProvider {
  readonly kind: MultiNodeProviderKind;

  /**
   * Provision (or adopt) the cluster for a multi-node task. Idempotent on the
   * message id so a redelivered message reuses the running cluster.
   */
  ensure(
    sessionId: string,
    request: ExecuteRequest,
    onEvent: MultiNodeEventSink,
    opts?: MultiNodeEnsureOptions,
  ): Promise<MultiNodeContext>;

  /** Release the message-scoped cluster once its task finishes. */
  releaseForMessage(
    sessionId: string,
    namespace: string,
    messageId: string,
    opts?: MultiNodeEnsureOptions,
  ): Promise<void>;

  /** Tear down every cluster belonging to a session (session delete). */
  destroyForSession(
    sessionId: string,
    opts?: MultiNodeEnsureOptions,
  ): Promise<SessionDestroyResult>;
}

/**
 * What a session teardown actually managed to do.
 *
 * Reported rather than thrown because none of these are exceptional: a session
 * with no clusters, a SaFE list that timed out, one workload that refused to
 * delete. They do differ in one way that matters to the caller, though —
 * whether anything the session owns was left unhandled — and that has to
 * survive the return. A teardown that reports success over a cluster it never
 * even enumerated is how clusters get left behind.
 */
export interface SessionDestroyResult {
  /**
   * True when every workload the session owns had its deletion accepted, i.e.
   * nothing was missed.
   *
   * Not a claim that the processes are already gone. A DELETE answered with 2xx
   * means SaFE has taken ownership of the removal; waiting for it to physically
   * finish would mean polling, and this runs inside the cleanup subscriber.
   * What the caller needs to know is whether anything escaped being handled at
   * all — a list that failed, a page that was truncated, a delete that was
   * refused — because that is what nothing else will come back for.
   */
  complete: boolean;
  /** Why it is incomplete, for the caller's log and retry decision. */
  reason?: "no_platform_key" | "lookup_failed" | "delete_failed" | "list_truncated";
  /** Non-terminal workloads found for the session. */
  found: number;
  /** Of those, how many are confirmed gone. */
  deleted: number;
}
