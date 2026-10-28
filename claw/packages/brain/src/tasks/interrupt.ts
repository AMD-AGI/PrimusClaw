// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an `interrupt.<address>` message does on this pod, and what a session's
 * deletion does to the runs of the session. Pulled out of index.ts so the two can
 * be driven without a NATS connection.
 */
import pino from "pino";
import {
  activeAbort, gracefulStopRemainingMs, resolveAbortTargets, resolveSessionEndTargets,
} from "./abort-registry.js";
import { releaseTaskLock } from "./lock.js";

const logger = pino({ name: "brain" });

/** Abort the runs `address` names, and force-release a lock whose run ignores it. Returns the gate keys aborted. */
export function interruptRunsAt(address: string, forceReleaseAfterMs = 30_000): string[] {
  const aborted: string[] = [];
  for (const lockKey of resolveAbortTargets(address)) {
    const ctrl = activeAbort.get(lockKey);
    if (!ctrl) continue;
    ctrl.abort();
    aborted.push(lockKey);
    logger.info({ address, lockKey }, "task.interrupted");
    // The SDK may not propagate abort through an in-flight tool RPC.
    const forceRelease = (): void => {
      if (activeAbort.get(lockKey) !== ctrl) return;
      // A run winding down on purpose (an app run's SIGTERM grace) is given the
      // time it asked for, and no more: when that is up it is released like any other.
      const left = gracefulStopRemainingMs(ctrl);
      if (left > 0) { setTimeout(forceRelease, left).unref(); return; }
      logger.error({ address, lockKey }, "task.interrupt_force_release");
      activeAbort.delete(lockKey);
      releaseTaskLock(lockKey).catch(() => {});
    };
    setTimeout(forceRelease, forceReleaseAfterMs).unref();
  }
  return aborted;
}

/** The session is being deleted: abort every run of it, whatever it answers to, and release their locks. */
export async function abortRunsOfDeletedSession(sid: string): Promise<void> {
  const lockKeys = resolveSessionEndTargets(sid);
  for (const lockKey of lockKeys) {
    const ctrl = activeAbort.get(lockKey);
    if (!ctrl) continue;
    ctrl.abort();
    activeAbort.delete(lockKey);
    logger.info({ sessionId: sid, lockKey }, "session.cleanup_aborted_task");
  }
  for (const lockKey of lockKeys.length ? lockKeys : [sid]) {
    await releaseTaskLock(lockKey);
  }
}
