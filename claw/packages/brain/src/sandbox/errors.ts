// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox this deployment has no way to stop, ever.
 *
 * Distinct from a stop that failed, because the two want opposite handling and
 * folding them together wedges sessions. Teardown refuses to replace a sandbox
 * it could not confirm stopped -- correctly, since a workload that is still
 * running would otherwise be orphaned while its replacement writes the same
 * workspace. But that reasoning assumes retrying could still succeed. An entry
 * with no platform key, or a deployment with no control-plane URL, has nothing
 * to retry: the stop is not failing, it is unavailable, and refusing forever
 * leaves the session unusable until its TTL with no operator action that helps.
 *
 * So this one is caught and the teardown continues: local state is released and
 * the entry cleared, and the workload is left to the control plane's own GC --
 * which is what happened before teardown could refuse at all. One leaked
 * workload, bounded by that GC, beats a session that can never be rebuilt.
 */
export class SandboxStopUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxStopUnavailable";
  }
}

/**
 * SandboxProvisionTerminalError marks a sandbox-provisioning outcome that is
 * TERMINAL — the SaFE Workload reached a terminal phase (Failed/Stopped, incl.
 * the TTL timeout that stops a running workload), the pod died before becoming
 * ready, or the workload disappeared. These must NOT be retried: the outcome
 * will not be fixed by re-queuing, and blind retries produce zombie
 * `launching`/`active` sessions (never a queryable terminal state).
 *
 * The task runner routes this ahead of the generic retryable-error check so the
 * session is failed terminally (ack, no nak, no reap-then-retry) with a stable
 * `failure_reason`.
 */
export class SandboxProvisionTerminalError extends Error {
  /** Stable machine reason surfaced as sandboxStatus.reason / failure_reason. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "SandboxProvisionTerminalError";
    this.reason = reason;
  }
}

/**
 * classifyWorkloadTerminalReason maps a SaFE workload detail payload (already
 * observed in a terminal phase) to a stable reason.
 *
 * Source preference: the terminal condition (conditions[].type = AdminFailed |
 * AdminStopped) message, NOT the top-level Status.Message. SaFE's top-level
 * message is written by the scheduler with the queue reason and never cleared,
 * so a workload that queued, then ran, then failed can still carry a stale
 * "In queue - insufficient resources" message; reading it would mislabel an
 * unrelated failure. We fall back to the top-level message only when no
 * terminal condition is present.
 *
 * We intentionally do NOT classify a resource shortage here: a resource-starved
 * workload stays Pending (polled indefinitely, never terminal), so a terminal
 * phase is never a "resource_unavailable" outcome. The only distinction worth
 * surfacing is the TTL timeout of a workload that did run (Stopped, message
 * "the workload has timed out"); everything else is a generic terminal failure.
 */
export function classifyWorkloadTerminalReason(info: Record<string, unknown>): string {
  const conds = Array.isArray(info.conditions)
    ? (info.conditions as Record<string, unknown>[])
    : [];
  const terminalCond = conds.find((c) => {
    const t = String(c?.type ?? "").toLowerCase();
    return t === "adminfailed" || t === "adminstopped";
  });
  const text = (terminalCond
    ? String(terminalCond.message ?? "")
    : String(info.message ?? "")
  ).toLowerCase();
  if (/timed out|timeout/.test(text)) {
    return "sandbox_timed_out";
  }
  return "sandbox_workload_terminal";
}

/**
 * The sandbox this call targeted does not exist any more.
 *
 * Distinct from a transport failure on purpose. Keepalive tolerates several
 * consecutive errors before declaring a sandbox lost, which is right for a
 * dropped packet and wrong for a definite answer: an absent workload does not
 * come back, and spending five ticks to confirm it costs about five minutes
 * during which the run reads healthy.
 */
export class SandboxGoneError extends Error {
  readonly sandboxGone = true;
  constructor(message: string) {
    super(message);
    this.name = "SandboxGoneError";
  }
}

/**
 * The workload still exists, but the Router could not execute inside it.
 *
 * Keepalive must not turn this data-plane failure into evidence that the
 * workload itself is dead. In particular, a wrong Router path can return 404
 * for every healthy sandbox at once.
 */
export class SandboxExecRouteUnavailableError extends Error {
  readonly sandboxConfirmedRunning = true;
  constructor(message: string) {
    super(message);
    this.name = "SandboxExecRouteUnavailableError";
  }
}

/**
 * A DAG handle row kept moving under a conditional write, so the write never
 * landed and the row still says what it said before.
 *
 * Raised only where the writer LOST A RACE and would have won it given another
 * read: `releaseHandlesForWorkload` re-reads the row, checks that the handle
 * still names the workload it is freeing, and writes back conditional on the
 * revision it just read. A concurrent registration into the same DAG's row --
 * a sibling node of the same DAG taking a second handle -- bumps that revision
 * and the conditional write is refused. Five of those in a row exhausts
 * `REGISTER_CAS_ATTEMPTS` and nothing was released.
 *
 * It exists as a class, and not as one more phrase for `isRetryable` to match
 * on, because the ONLY reader that can tell this apart from a permanent failure
 * is the code that raised it. By the time the error reaches the task runner, a
 * lost race and an unreadable row are the same shape -- a string out of the same
 * function saying a name was not freed -- and the previous version of the throw
 * genuinely conflated them: one message covered both "attempts exhausted" and
 * "its row could not be read". A caller cannot recover a distinction the raiser
 * threw away. So the raiser keeps it, the way `replaceDagHandle` already does
 * by raising `dag-handles row ... is not a JSON object` separately from its own
 * attempts-exhausted throw.
 *
 * What it is NOT: a blanket "the handle layer failed, try again". An unbound
 * bucket, a scan that overran its ceiling, a row that does not parse and a
 * transport error out of the store all still leave this module as ordinary
 * errors and are still judged on their own terms. The line between them is not
 * a guess about how long anything takes -- no claim is made here about how
 * quickly contention clears, and none has been measured. It is about what the
 * next read can possibly return. A row that is not a JSON object returns the
 * same bytes to every reader until something rewrites it, so re-reading it is
 * asking a question whose answer is already fixed. A row that MOVED returns
 * whatever the writer that moved it left, and that writer is another task
 * finishing its own registration -- so the next read is a genuinely different
 * question, and the only way to ask it is to be delivered again.
 *
 * The policy that acts on it -- nak the delivery rather than fail the task --
 * lives in `isRetryable` (brain/src/infra/retry.ts), next to every other
 * condition that earns a redelivery. This class carries the nature; that
 * function carries the decision.
 */
export class DagHandleContendedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagHandleContendedError";
  }
}
