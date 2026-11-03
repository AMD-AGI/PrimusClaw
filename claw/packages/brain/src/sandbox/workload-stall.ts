// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading "the sandbox is waiting, and for what" out of a workload detail.
 *
 * A sandbox that cannot start looks the same to the user whichever way it
 * cannot: a progress bar that does not move. The platform does know the
 * difference -- the workload is queued behind others, or it has been admitted and
 * nobody has taken its pod -- and says so in fields the wait loop was already
 * reading for something else. This turns them into one answer, so the user can be
 * told why, and so the one state that is not a wait at all (a pod that was
 * admitted and that no node has picked up) can be given up on early.
 *
 * Generic on purpose: nothing here names a deployment, a connector or a channel.
 * The wording is the platform's where the platform supplied any.
 */

/**
 * The two ways a sandbox that is not ready can be waiting for the platform:
 *
 *  - `queued`: the platform is holding the workload and says why. Either its own
 *    scheduler has not admitted it yet (queue position above zero, usually
 *    because capacity is taken), or it was admitted and the platform has put a
 *    reason on it anyway -- waiting for a node to scale up, say. Both are waits
 *    the platform manages and can be hours long (a GPU queue, a node that takes
 *    minutes to arrive); the user is told the reason, and the queue ceiling is
 *    the only limit.
 *  - `unscheduled`: the workload was admitted (queue position zero), its pod
 *    exists, nothing has taken it -- no node has acknowledged it -- and the
 *    platform has said nothing about why. That is what a pod that no node will
 *    accept (every node cordoned, or down) looks like, and no amount of waiting
 *    changes it. It is the state the early limit applies to: only a wait nothing
 *    is explaining is a wait nothing is working on.
 */
export type WaitingKind = "queued" | "unscheduled";

export interface WaitingState {
  kind: WaitingKind;
  /** The platform's account of why, in its own words where it gave one. */
  reason: string;
}

/** Long enough for any real reason, short enough to be one line of progress text. */
const REASON_LIMIT = 300;

/**
 * Platform text is data, not wording of ours: it ends up in a progress event and
 * in the error the model is shown. One line, no control characters, bounded.
 */
export function cleanPlatformText(raw: unknown, limit = REASON_LIMIT): string {
  const text = String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

type Pod = Record<string, unknown>;

/**
 * Whether anything has taken this pod. Evidence that a node's kubelet (or a
 * virtual one) acknowledged it -- an address, a start time, a container -- or a
 * phase past Pending. Deliberately not "has a node name": a pod bound to a node
 * that never answers carries a node name and nothing else, and that is exactly
 * the pod that will not start.
 */
function podTaken(p: Pod): boolean {
  const phase = String(p.phase ?? "").toLowerCase();
  if (phase && phase !== "pending") return true;
  if (String(p.hostIP ?? "") || String(p.podIP ?? "") || String(p.startTime ?? "")) return true;
  return Array.isArray(p.containers) && p.containers.length > 0;
}

/**
 * What a not-yet-ready workload is waiting for, or null when it is not waiting
 * on the platform (it is starting: a pod has been taken and is pulling or
 * booting, which has its own, longer limit).
 *
 * Only a workload that is neither ready nor terminal is asked; the caller has
 * already ruled those out. A phase other than Pending or NotReady is not read as
 * waiting at all, so a state this does not know about keeps whatever handling it
 * had.
 */
export function readWaitingState(detail: Record<string, unknown>): WaitingState | null {
  const phase = String(detail.phase ?? "").toLowerCase();
  if (phase !== "pending" && phase !== "notready") return null;

  const pods = Array.isArray(detail.pods) ? (detail.pods as Pod[]) : [];
  if (pods.some(podTaken)) return null;

  const message = cleanPlatformText(detail.message);
  const position = Number(detail.queuePosition) || 0;

  if (phase === "pending" && position > 0) {
    return { kind: "queued", reason: message || "the platform has not admitted the sandbox yet" };
  }

  // Admitted. The platform clears its reason when it admits a workload, so a
  // reason that is there is one it wrote afterwards -- for a pod it is waiting
  // on capacity for (a node scaling up reports itself this way). That wait is
  // the platform's to bound, and a scale-up can take longer than any limit of
  // ours; it is announced with its reason and left to the queue ceiling.
  if (message) return { kind: "queued", reason: message };

  const pod = pods.find((p) => p?.podId) ?? pods[0];
  const podId = cleanPlatformText(pod?.podId, 80);
  const node = cleanPlatformText(pod?.adminNodeName, 80);
  const name = `the pod${podId ? ` ${podId}` : ""}`;
  const reason = pods.length === 0
    ? "the platform has accepted the sandbox, but no node has taken its pod yet"
    : node
      ? `${name} was assigned to node ${node}, which has not started it`
      : `${name} is Pending and has not been placed on any node`;
  return { kind: "unscheduled", reason };
}

/** The one line of progress text for a waiting state. */
export function describeWaiting(w: WaitingState, queuePosition: number): string {
  if (w.kind === "queued" && queuePosition > 0) return `Waiting in queue (position ${queuePosition}): ${w.reason}`;
  return w.kind === "queued"
    ? `Sandbox is waiting on the platform: ${w.reason}`
    : `Sandbox is waiting for the platform to schedule it: ${w.reason}`;
}
