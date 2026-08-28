// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Deploy-mode-agnostic contract for provisioning the multi-node inference
 * cluster a task runs against.
 *
 * Clusters are created as SaFE workloads (RayJob or Infera); see factory.ts,
 * which rejects a deployment without SaFE. The result is a `MultiNodeContext`,
 * all the sandbox needs to drive the cluster via Hyperloom's "external mode"
 * (see sandbox/params.ts applyMultiNodeExternalEnv).
 */

import type { ExecuteRequest } from "@claw/protocol";

/** Engine topology, from the prompt's `--mn-backend`. */
export type MultiNodeBackend = "rayjob" | "infera";

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
  /** Base URL benchmarks target: Ray head :8888, or the Infera frontend on its derived port. */
  serviceUrl: string;
  /** rayjob: host serving Ray Dashboard :8265 and GCS :6379. */
  headHost?: string;
  /** rayjob: Ray Dashboard auth token, when the dashboard is authenticated. */
  dashboardToken?: string;
  /** infera: PEM private key authorised on the GPU pods. */
  sshPrivateKey?: string;
  /** infera: path the private key is materialised at inside the sandbox. */
  sshKeyPath?: string;
  /** infera: SSH base port; decode pods are role-offset (see sandbox/multi-node/safe-body.ts). */
  sshPortBase?: number;
  /** infera PD: prefill pod IPs, rank order. */
  prefillIps?: string[];
  /** infera PD: decode pod IPs, rank order. */
  decodeIps?: string[];
  /** infera aggregated: worker pod IPs, rank order (leader first). */
  workerIps?: string[];
}

export interface MultiNodeEnsureOptions {
  /** NATS delivery count, surfaced in provisioning events for redeliveries. */
  deliveryCount?: number;
  /** SaFE API key of the requesting user; required by the safe provider. */
  platformKey?: string;
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
