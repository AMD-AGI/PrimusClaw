// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Returning the sandbox handle of a session nothing is running any more.
 *
 * Its own module because it has four callers in two files and no natural home
 * in either. Three are the sweeper reapers, which reach it through the gate
 * release they already share; the fourth is the claim-budget give-up in
 * run-claim.ts, which is not a sweep at all and was missed when this was
 * written as a sweeper-local helper -- a run claimed to exhaustion is a run
 * nobody finished, which is the same fact and the same handle.
 */

import pino from "pino";
import { parkHandsAfterRun, type RunEndedParkResult } from "@claw/protocol";

import { db } from "../infra/db.js";
import { kv } from "../infra/nats.js";

const logger = pino({ name: "park-settled-hands" });

export const parkSettledHandsPorts = {
  /**
   * Parking the handle, as a port rather than a direct call.
   *
   * `kv` is a live binding filled in at connect time, so a test that imports
   * this module has `undefined` there: a direct call would throw inside the
   * helper's own try, be reported as "failed", and pass every assertion about
   * the reap while the write it is supposed to make never happened. Bound here
   * so the arrow reads `kv` per call -- the real one in production, a stub in
   * the tests that check what gets written.
   */
  parkHandsAfterRun: (
    sessionId: string,
    workloadId?: string | null,
  ): Promise<RunEndedParkResult> => parkHandsAfterRun(kv, sessionId, workloadId),
};

/**
 * Put the sandbox handle of a settled session back in the idle pool.
 *
 * Brain parks its own handle when a run ends in-process. A run whose worker
 * went away never reaches that line -- the process holding it is gone -- so
 * `hands.<sid>` keeps `keepalive` unset, every replica goes on pinging the pod
 * once a tick, the platform's `lastActivity` never goes stale, and the sandbox
 * outlives the conversation by as long as the workload's own absolute deadline
 * allows. Nothing else closes it: the idle-reclaim sweep only considers handles
 * that are already parked, and `reapOrphanHandles` is scoped to DAG roots.
 *
 * Here rather than in each reaper because "the run is over and no worker is
 * coming back" is the same fact the gate release is computed from, and every
 * reaper that closes a chat row already calls that. Adding the park to one
 * reaper would put the guard on one of the three paths into this state, which
 * is how the hole got opened in the first place.
 *
 * Settled is re-asked of the database rather than assumed from the reap: the
 * row this tick closed is not necessarily the only one, and a session with
 * another turn still running must keep its pod.
 *
 * Best-effort throughout. A handle that cannot be parked is the behaviour that
 * exists today, while a throw here would take the reapers behind it down with
 * it -- and those close rows, which matters more than reclaiming a pod one
 * tick sooner.
 */
export async function parkHandsOfSettledSessions(
  sessionIds: string[],
  workloadBySession?: Map<string, string | null>,
): Promise<void> {
  const unique = [...new Set(sessionIds)];
  if (!unique.length) return;
  let settled: string[];
  try {
    const r = await db.query(
      `SELECT s.session_id
         FROM claw_sessions s
        WHERE s.session_id = ANY($1::text[])
          AND s.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM claw_tasks t
             WHERE t.session_id = s.session_id
               AND t.status IN ('queued','preparing','running','cancelling')
          )`,
      [unique],
    );
    settled = r.rows.map((row) => (row as { session_id: string }).session_id);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message ?? err }, "sweeper.park_hands_query_failed");
    return;
  }
  if (!settled.length) return;

  const parked: string[] = [];
  const skipped: Record<string, number> = {};
  for (const sessionId of settled) {
    let result: RunEndedParkResult;
    try {
      result = await parkSettledHandsPorts.parkHandsAfterRun(
        sessionId,
        workloadBySession?.get(sessionId),
      );
    } catch (err) {
      // The helper catches its own failures, so reaching here means the port
      // itself threw -- an unconnected KV binding, or a stub in a test. Caught
      // per session rather than around the loop: one unreachable handle must
      // not stop the others being parked, and none of them may stop the
      // reapers queued behind this call, which close rows.
      logger.warn(
        { sessionId, err: (err as Error)?.message ?? err },
        "sweeper.park_hands_failed",
      );
      continue;
    }
    switch (result.outcome) {
      case "parked":
        parked.push(sessionId);
        break;
      case "failed":
        logger.warn(
          { sessionId, err: (result.error as Error)?.message ?? result.error },
          "sweeper.park_hands_failed",
        );
        break;
      default: {
        // "gone" (no handle), "superseded" (somebody rewrote it under us --
        // including the reuse that takes the pod back, which is the outcome
        // this must lose to) and "skipped" are all ordinary. Counted rather
        // than logged per session so a fleet-wide change of shape is visible
        // without a line per handle per tick.
        const label = result.reason ?? result.outcome;
        skipped[label] = (skipped[label] ?? 0) + 1;
      }
    }
  }
  if (parked.length || Object.keys(skipped).length) {
    logger.info(
      { parked: parked.length, sessions: parked, skipped },
      "sweeper.parked_hands_of_settled_sessions",
    );
  }
}
