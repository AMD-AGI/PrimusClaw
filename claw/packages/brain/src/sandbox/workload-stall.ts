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
 * What the user is shown is a summary in our own words; the platform's text,
 * which carries its identifiers (pool ids, namespaces, pod names, taint keys), is
 * kept for the logs and never shown.
 */

/**
 * The two ways a sandbox that is not ready can be waiting for the platform:
 *
 *  - `queued`: the platform is holding the workload and something is moving.
 *    Either its own scheduler has not admitted it yet (queue position above
 *    zero, usually because capacity is taken), or it was admitted and a node is
 *    actually being added for it (the autoscaler reports `TriggeredScaleUp`,
 *    and the scale-up stays in force until the platform says otherwise).
 *    Both are waits the platform manages and can be long (a GPU queue, a node
 *    that takes minutes to arrive); the user is told the reason, and the ceilings
 *    for the phase are the only limit.
 *  - `unscheduled`: the workload was admitted (queue position zero), no node has
 *    taken its pod, and nothing is visibly being done about it. That is what a
 *    pod that no node will accept (every node cordoned, or down, or tainted for
 *    other workloads) looks like, and no amount of waiting changes it. It is the
 *    state the early limit applies to. The platform usually does put a message on
 *    such a workload -- the scheduler's "0/7 nodes are available" and the
 *    autoscaler's "pod didn't trigger scale-up" -- but that message says why it
 *    is stuck, not that anything is being done: only a scale-up that was
 *    triggered, or a message that keeps changing, is progress.
 */
export type WaitingKind = "queued" | "unscheduled";

export interface WaitingState {
  kind: WaitingKind;
  /**
   * One line for the user: what the sandbox is waiting for, in our words and
   * without the platform's identifiers. Fit to be embedded in a sentence.
   */
  reason: string;
  /**
   * The platform's account as it gave it (or our own sentence naming the pod and
   * node, where it gave none), whole. For logs, and for telling a state that has
   * changed from one that repeats. Never shown to the user.
   */
  detail: string;
  /**
   * Set when a node is being added for the sandbox: the autoscaler's
   * `TriggeredScaleUp` is on the message, or was seen earlier in this stall and
   * nothing since has said it was withdrawn (see `readWaitingState`).
   */
  scalingUp?: true;
  /**
   * Set when the platform has said nothing about why the sandbox waits (no
   * message), so the state is one of our own sentences about the pod. It is also
   * what a workload looks like in the seconds before the platform has synced it,
   * which a sandbox that is simply starting passes through; the wait loop does not
   * announce it until it has lasted a while.
   */
  silent?: true;
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
 * Whether the platform says a node is actually being added for this workload.
 * The autoscaler's own event reason, `TriggeredScaleUp`, and nothing weaker: the
 * platform's "waiting for scale-up" prefix is on every message it writes while a
 * pod is unplaced, whether or not any scale-up was triggered, so the prefix is
 * not evidence. `NotTriggerScaleUp` ("pod didn't trigger scale-up") is the
 * opposite and does not match, nor does a negated `NotTriggeredScaleUp`.
 *
 * Read from the whole message, not the bounded one: the scheduler's account comes
 * first and the autoscaler's event last, after any amount of text.
 */
function scaleUpTriggered(text: string): boolean {
  return /\bTriggeredScaleUp\b/.test(text);
}

/**
 * Whether the platform has since said that it will not add a node. The newest of
 * the autoscaler's events is what the platform writes on the workload, so this
 * is the autoscaler withdrawing an earlier scale-up, and the only thing that is.
 */
function scaleUpWithdrawn(text: string): boolean {
  return /\bNotTriggerScaleUp\b/.test(text);
}

const count = (text: string, re: RegExp): number => Number(re.exec(text)?.[1] ?? 0);

/** Said while a node is being added for the sandbox. */
const ADDING_NODE = "the platform is adding a node for the sandbox";

/** Said when the platform's text is not one we can summarise, and the workload is admitted. */
const UNPLACED = "the platform has not been able to place the sandbox on a node yet";

/** Said when the platform's queue text is not a phrase of its own that we can repeat. */
const NOT_ADMITTED = "the platform has not admitted the sandbox yet";

/**
 * The platform's own queue wording: a short phrase of words and separators, the way
 * its scheduler writes it ("In queue - insufficient resources, no cpu available").
 * Anything with more in it -- digits, paths, braces, a colon and a message after it,
 * which is where an id or a name from the platform would be -- is not this, and is
 * not repeated to the user.
 */
const QUEUE_PHRASE = /^In queue - [A-Za-z][A-Za-z ,'-]{0,150}$/;

/**
 * A line for the user out of the scheduler's and the autoscaler's text, or null
 * when the text is neither. Only what the user can use survives: how many nodes
 * there are and why each cannot take the sandbox, and whether a node is being
 * added. Pool ids, namespaces, pod names and taint keys do not, which is the
 * reason this is a summary and not the text cut short.
 */
export function summarizeScheduling(text: string): string | null {
  if (scaleUpTriggered(text)) return ADDING_NODE;
  const total = /\b\d+\/(\d+) nodes are available\b/.exec(text)?.[1];
  const notAdded = /\bNotTriggerScaleUp\b/.test(text);
  if (!total && !notAdded) return null;

  const causes: string[] = [];
  const unschedulable = count(text, /\b(\d+) node\(s\) were unschedulable\b/);
  if (unschedulable) causes.push(`${unschedulable} unschedulable`);
  const tainted = count(text, /\b(\d+) node\(s\) had untolerated taint/);
  if (tainted) causes.push(`${tainted} restricted to other workloads`);
  // The resource is a short lowercase name (cpu, memory, ephemeral-storage, amd.com/gpu);
  // anything else after "Insufficient" is not ours to repeat.
  for (const m of text.matchAll(/\b(\d+) Insufficient ([a-z][a-z0-9./-]{0,38}[a-z0-9])\b/g)) {
    causes.push(`${m[1]} short of ${m[2]}`);
  }
  const nodes = total ? ` (${total} nodes${causes.length ? `: ${causes.join(", ")}` : ", none available"})` : "";
  return `no node can take the sandbox right now${nodes}${notAdded ? ", and no new node is being added" : ""}`;
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
 *
 * `scaleUpSeen` is whether the read before this one was a node being added. The
 * platform writes only the newest of the autoscaler's and the scheduler's events
 * on the workload, and the autoscaler says `TriggeredScaleUp` once while the
 * scheduler goes on repeating `FailedScheduling`, so a scale-up is visible for
 * only as long as it is the newest event; seconds later the message reads as the
 * scheduler's account of a pod it cannot place, which is also exactly what a pod
 * no node will take looks like. A scale-up that has been seen therefore stays in
 * force through every message that does not take it back: until the autoscaler
 * says `NotTriggerScaleUp`, the platform withdraws its message, a pod is taken or
 * the workload goes back to the queue.
 */
export function readWaitingState(detail: Record<string, unknown>, scaleUpSeen = false): WaitingState | null {
  const phase = String(detail.phase ?? "").toLowerCase();
  if (phase !== "pending" && phase !== "notready") return null;

  const pods = Array.isArray(detail.pods) ? (detail.pods as Pod[]) : [];
  if (pods.some(podTaken)) return null;

  // Whole, not bounded: what tells a scale-up from its absence is at the end.
  const text = cleanPlatformText(detail.message, Infinity);
  const position = Number(detail.queuePosition) || 0;
  const summary = text ? summarizeScheduling(text) : null;

  // The platform's own queue: the reason is its own wording, which for this
  // state is a short phrase about capacity, repeated as written when it is one
  // and summarised or replaced when it is not.
  if (phase === "pending" && position > 0) {
    return {
      kind: "queued",
      reason: summary ?? (QUEUE_PHRASE.test(text) ? text : NOT_ADMITTED),
      detail: text,
    };
  }

  // Admitted. The platform writes its message here for a pod it could not place,
  // and says in it whether a node is being added. A node being added is a wait
  // the platform manages, can take longer than any limit of ours, and is left to
  // the ceilings of the phase; so is one that was being added and whose event has
  // since been followed by the scheduler's own account (see above). Everything
  // else is a pod stuck for a reason, and the reason does not change by being
  // repeated.
  if (text && (scaleUpTriggered(text) || (scaleUpSeen && !scaleUpWithdrawn(text)))) {
    return { kind: "queued", reason: ADDING_NODE, detail: text, scalingUp: true };
  }
  if (text) return { kind: "unscheduled", reason: summary ?? UNPLACED, detail: text };

  const pod = pods.find((p) => p?.podId) ?? pods[0];
  const podId = cleanPlatformText(pod?.podId, 80);
  const node = cleanPlatformText(pod?.adminNodeName, 80);
  const name = `the pod${podId ? ` ${podId}` : ""}`;
  // The platform has said nothing: what follows is our own account of the pod.
  if (pods.length === 0) {
    const none = "the platform has accepted the sandbox, but no node has taken its pod yet";
    return { kind: "unscheduled", reason: none, detail: none, silent: true };
  }
  return node
    ? {
      kind: "unscheduled",
      reason: "the sandbox's pod was assigned to a node that has not started it",
      detail: `${name} was assigned to node ${node}, which has not started it`,
      silent: true,
    }
    : {
      kind: "unscheduled",
      reason: "the sandbox's pod has not been placed on any node",
      detail: `${name} is Pending and has not been placed on any node`,
      silent: true,
    };
}

/** The one line of progress text for a waiting state. */
export function describeWaiting(w: Pick<WaitingState, "kind" | "reason">, queuePosition: number): string {
  if (w.kind === "queued" && queuePosition > 0) return `Waiting in queue (position ${queuePosition}): ${w.reason}`;
  return w.kind === "queued"
    ? `Sandbox is waiting on the platform: ${w.reason}`
    : `Sandbox is waiting for the platform to schedule it: ${w.reason}`;
}
