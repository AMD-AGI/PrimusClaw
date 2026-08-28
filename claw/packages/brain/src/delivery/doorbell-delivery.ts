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

import { failClaimedRun, unclaimRun } from "../clients/run-claim.js";

/** Why a claimed row is going back. Only contention is a wait; the rest are faults. */
export type RetryReason = "lock_contention" | "retry" | "drain";

export interface ClaimedDeliveryActions {
  retryLater: (taskId: string, claimCount?: number, reason?: RetryReason) => Promise<void>;
  fail: (taskId: string, claimCount?: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const defaultActions: ClaimedDeliveryActions = {
  retryLater: (taskId, claimCount, reason) => unclaimRun(taskId, claimCount, reason ?? "retry"),
  fail: (taskId, claimCount) => failClaimedRun(taskId, "claim_abandoned", claimCount),
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

export function declareRetryReason(taskId: string, reason: RetryReason): void {
  if (taskId) declaredReasons.set(taskId, reason);
}

function takeDeclaredReason(taskId: string): RetryReason {
  const r = declaredReasons.get(taskId);
  declaredReasons.delete(taskId);
  return r ?? "retry";
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
    ack() {},
    nak(millis?: number) {
      const delayMs = typeof millis === "number" ? Math.max(0, millis) : 0;
      void settleRetry(taskId, claimCount, delayMs, sleep, actions.retryLater);
    },
    term() {
      void actions.fail(taskId, claimCount);
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
  retryLater: (taskId: string, claimCount?: number, reason?: RetryReason) => Promise<void>,
): Promise<void> {
  if (!taskId) return;
  const reason = takeDeclaredReason(taskId);
  let fired = false;
  const fire = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    pendingRetries.delete(taskId);
    const p = retryLater(taskId, claimCount, reason);
    inFlightReleases.add(p);
    try { await p; } finally { inFlightReleases.delete(p); }
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
