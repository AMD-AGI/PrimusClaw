// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading the platform's account of a dead workload out of a SaFE detail.
 *
 * SaFE already returns everything needed and this side already fetches it -- the
 * wait loop reads `detail.phase` and throws the rest away. What it throws away is
 * the only place a preemption is visible: `pods[].failedMessage`, which SaFE
 * builds as `pod.status.reason + ", " + pod.status.message`, and where Kubernetes
 * writes `Evicted`, `Preempted`, `NodeLost` and the rest.
 *
 * Without it a node reclaim and a crashed agent are the same row all the way up,
 * so the model that happened to be running is charged for the cluster's decision.
 *
 * Pure, so the reading can be checked against captured payloads rather than
 * against a cluster.
 */

export interface PlatformFacts {
  /** Verbatim `failedMessage`, so a wrong reading upstream can be re-derived. */
  message: string;
  /** `adminNodeName` of the pod that failed, for the placement block. */
  node: string;
  /** Exit code of the pod's last terminated container, or null when none. */
  exitCode: number | null;
  /**
   * The container's own termination reason, when the platform reports one.
   *
   * The only place an OOM is stated. The pod-level reason in `message` covers the
   * kills decided above the container -- Evicted, Preempted, NodeLost -- and is
   * empty when the kernel killed one for memory, which left exit code 137 as the
   * only hint: any SIGKILL, and therefore also every eviction and every stop.
   *
   * Empty against a platform that does not report it yet, and an empty reason
   * simply means the reading falls back to what the pod said.
   */
  containerReason: string;
}

interface RawContainer {
  exitCode?: unknown;
  message?: unknown;
  /** `state.terminated.reason`: OOMKilled, Error, ContainerCannotRun, … */
  reason?: unknown;
}

interface RawPod {
  phase?: unknown;
  failedMessage?: unknown;
  adminNodeName?: unknown;
  containers?: unknown;
  endTime?: unknown;
}

function pods(detail: Record<string, unknown>): RawPod[] {
  const raw = detail.pods;
  return Array.isArray(raw) ? (raw as RawPod[]) : [];
}

/**
 * The pod whose ending explains the workload's.
 *
 * The failed one, preferring the latest to end. A multi-pod workload can lose one
 * pod to a reclaim while the others exit cleanly on the way down, and reading the
 * first entry would report whichever the list happened to start with.
 */
function decisivePod(all: RawPod[]): RawPod | null {
  const failed = all.filter((p) => String(p.phase ?? "").toLowerCase() === "failed");
  const candidates = failed.length > 0 ? failed : all;
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, p) =>
    String(p.endTime ?? "") > String(latest.endTime ?? "") ? p : latest,
  );
}

/** The pod's last terminated container, or null. */
function terminatedContainer(pod: RawPod): RawContainer | null {
  const containers = Array.isArray(pod.containers) ? (pod.containers as RawContainer[]) : [];
  // The first one carrying an exit code. A sandbox pod runs one workload
  // container; a sidecar that exits cleanly alongside it would report zero, and
  // preferring a non-zero one would read a sidecar's failure as the run's.
  return containers.find((c) => typeof c.exitCode === "number") ?? null;
}

/**
 * What the platform says about this workload's ending.
 *
 * Returns null when the detail carries no pod account at all, which is different
 * from an ending with nothing to say: a caller must not record "no reason" as a
 * fact it read.
 */
export function platformFactsFromWorkloadDetail(
  detail: Record<string, unknown> | null | undefined,
): PlatformFacts | null {
  if (!detail) return null;
  const pod = decisivePod(pods(detail));
  if (!pod) return null;
  const message = String(pod.failedMessage ?? "").trim();
  const node = String(pod.adminNodeName ?? "").trim();
  const container = terminatedContainer(pod);
  const exitCode = typeof container?.exitCode === "number" ? container.exitCode : null;
  const containerReason = String(container?.reason ?? "").trim();
  if (!message && !node && !containerReason && exitCode === null) return null;
  return { message, node, exitCode, containerReason };
}
