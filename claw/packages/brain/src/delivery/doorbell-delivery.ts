// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * JetStream settlement for a run that has already been claimed from the row.
 *
 * The wakeup is acked at claim time so a full replica cannot pocket it. After
 * that, `nak` is no longer a redelivery: nats.js drops it once `didAck` is
 * set, and claim-next has no message at all. Retry means putting the row back
 * on the queue after the same delay the fat path would have nacked for.
 */

import type { JsMsg } from "nats";
import type { RunTimeReport } from "@claw/protocol";

import { failClaimedRun, settleClaimedRun, unclaimRun } from "../clients/run-claim.js";

/** Why a claimed row is going back. Only contention is a wait; the rest are faults. */
export type RetryReason = "lock_contention" | "retry" | "drain";

export interface ClaimedDeliveryActions {
  retryLater: (
    taskId: string, claimCount?: number, reason?: RetryReason, runTime?: RunTimeReport,
  ) => Promise<void>;
  fail: (taskId: string, claimCount?: number, runTime?: RunTimeReport) => Promise<void>;
  settle: (taskId: string, claimCount?: number, runTime?: RunTimeReport) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const defaultActions: ClaimedDeliveryActions = {
  retryLater: (taskId, claimCount, reason, runTime) =>
    unclaimRun(taskId, claimCount, reason ?? "retry", runTime),
  fail: (taskId, claimCount, runTime) =>
    failClaimedRun(taskId, "claim_abandoned", claimCount, runTime),
  settle: (taskId, claimCount, runTime) => settleClaimedRun(taskId, claimCount, runTime),
};

/**
 * Reasons declared for the next nak, by task.
 *
 * The reason cannot ride on `nak(ms)` -- that signature belongs to JsMsg and
 * the wrapper has to keep it -- so the site that knows the reason states it
 * just before naking. Everything that does not is a retry of unspecified
 * cause, which is the honest default: `TaskRunner` naks this same wrapper for
 * a retryable model error, for an undelivered agent_done, and on the SIGTERM
 * checkpoint path. Labelling all of those `lock_contention`, as the default
 * action briefly did, made the poison guard tell a user whose run kept
 * crashing that the workspace had been busy.
 */
const declaredReasons = new Map<string, RetryReason>();

/**
 * The attempt's last word on its own time, waiting for the release that ends it.
 *
 * Travels the same way the reason does, and for the same reason: the release is
 * issued from the delivery loop, which knows the task id and nothing about what
 * the attempt did. Taken once, so a release that never arrives leaves nothing
 * behind for the next attempt to send under its own token.
 */
const declaredReports = new Map<string, RunTimeReport>();

export function declareRetryReason(taskId: string, reason: RetryReason): void {
  if (taskId) declaredReasons.set(taskId, reason);
}

/** State the coverage this attempt is releasing with, before it naks. */
export function declareFinalReport(taskId: string, report: RunTimeReport | undefined): void {
  if (taskId && report) declaredReports.set(taskId, report);
}

function takeDeclaredReason(taskId: string): RetryReason {
  const r = declaredReasons.get(taskId);
  declaredReasons.delete(taskId);
  return r ?? "retry";
}

function takeDeclaredReport(taskId: string): RunTimeReport | undefined {
  const r = declaredReports.get(taskId);
  declaredReports.delete(taskId);
  return r;
}

/**
 * Retries waiting out a backoff, so a shutdown can settle them.
 *
 * The wait is a detached unref'd timer: it must not hold the process open for
 * the five minutes the backoff can reach. That also means SIGTERM ends the
 * process with the row still claimed and no release sent, and the row then
 * waits out its lease plus the sweeper's grace before anyone can take it --
 * minutes of a turn sitting still, for a pod that shut down cleanly and knew
 * exactly which rows it was holding.
 */
interface PendingRetry {
  claimCount?: number;
  timer: NodeJS.Timeout | null;
  /** Idempotent: whichever of the timer and the drain gets there first wins. */
  fire: () => Promise<void>;
}

const pendingRetries = new Map<string, PendingRetry>();

/**
 * Releases that have been sent and not yet answered.
 *
 * A zero-delay nak registers nothing to wait on -- it goes straight to the
 * POST -- and that is the SIGTERM path: `handleSigtermCheckpoint` ends with
 * `nak(0)`. So the drain could find an empty map, exit, and take an unclaim
 * that was still in flight with it, leaving the row to time its lease out
 * after a shutdown that knew exactly which row it held.
 */
const inFlightReleases = new Set<Promise<unknown>>();

/**
 * Release every row waiting out a backoff, now. Called from the drain path.
 *
 * Each release is generation-guarded, so one that races a reclaim is refused
 * rather than pulling the row out from under whoever took it.
 */
/**
 * Every settle here is fire-and-forget -- JsMsg's verdicts return void -- so a
 * shutdown that did not wait would exit past one still on the wire.
 */
function trackRelease(send: () => Promise<unknown>): Promise<unknown> {
  const p: Promise<unknown> = send().finally(() => inFlightReleases.delete(p));
  inFlightReleases.add(p);
  return p;
}

export async function flushPendingRetries(
  release?: (taskId: string, claimCount?: number) => Promise<void>,
): Promise<number> {
  const waiting = [...pendingRetries.entries()];
  pendingRetries.clear();
  for (const [, entry] of waiting) if (entry.timer) clearTimeout(entry.timer);
  await Promise.allSettled(waiting.map(([taskId, e]) => (
    release ? release(taskId, e.claimCount) : e.fire()
  )));
  // Whatever was already on the wire when the drain started, including every
  // zero-delay nak, which never had a timer to cancel.
  await Promise.allSettled([...inFlightReleases]);
  return waiting.length;
}

export function claimedDoorbellMsg(
  base: {
    seq: number;
    info: { deliveryCount: number };
    redelivered?: boolean;
    data?: Uint8Array;
  },
  taskId: string,
  claimCount?: number,
  actions: ClaimedDeliveryActions = defaultActions,
): JsMsg {
  const sleep = actions.sleep ?? defaultSleep;
  return {
    // A chat row has no `callback_url`, so a clean finish issues no
    // `agent_done`: this ack is the only boundary left to end the attempt on.
    ack() {
      void trackRelease(() => actions.settle(taskId, claimCount, takeDeclaredReport(taskId)));
    },
    nak(millis?: number) {
      const delayMs = typeof millis === "number" ? Math.max(0, millis) : 0;
      void settleRetry(taskId, claimCount, delayMs, sleep, actions.retryLater);
    },
    term() {
      void actions.fail(taskId, claimCount, takeDeclaredReport(taskId));
    },
    working() {},
    seq: base.seq,
    info: base.info as JsMsg["info"],
    redelivered: base.redelivered ?? false,
    data: base.data ?? new Uint8Array(),
  } as unknown as JsMsg;
}

async function settleRetry(
  taskId: string,
  claimCount: number | undefined,
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
  retryLater: ClaimedDeliveryActions["retryLater"],
): Promise<void> {
  if (!taskId) return;
  const reason = takeDeclaredReason(taskId);
  // Taken now rather than when the retry fires: the attempt that declared it
  // is ending here, and a later attempt must not release under its coverage.
  const runTime = takeDeclaredReport(taskId);
  let fired = false;
  const fire = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    pendingRetries.delete(taskId);
    await trackRelease(() => retryLater(taskId, claimCount, reason, runTime));
  };

  if (delayMs > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
      pendingRetries.set(taskId, { claimCount, timer, fire });
      // The injected sleep is what tests drive; the timer above is then only
      // the registry entry, so drop it once that resolves.
      if (sleep !== defaultSleep) {
        void sleep(delayMs).then(() => { clearTimeout(timer); resolve(); });
      }
    });
  } else {
    // Registered even with nothing to wait for, so a drain in the same tick
    // finds it and waits for the release rather than exiting past it.
    pendingRetries.set(taskId, { claimCount, timer: null, fire });
  }
  await fire();
}
