// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One drain of a session's queue at a time, and no message taking the session while one is under way.
 *
 * A drain reads the oldest queued message, dispatches it and only then takes the gate, so for the span of the
 * dispatch the session still reads free. Two drains in that span -- the completion's and the sweeper's, or two
 * reports waking an idle Router a moment apart -- each started a turn: the second dispatched the next message, or
 * the same one under the same reserved run id (a duplicate key on `claw_tasks`), and its forced take named its own
 * turn over the first, whose tools were then refused as superseded. A message the owner sent in that span did the
 * same from the other side: it took the free gate and the drain's take superseded the owner's turn.
 *
 * The claim is a lease on the session row (`pending_drain_until`), taken in the statement that asks whether the
 * session is free, so a drain that finds another one under way, or the turn it started, leaves the queue to that one.
 * A row, not a lock held on a connection: the completion that drains already holds the lock pool's connection for
 * its own lock, and a drain must not need a second one to finish. A message reads the lease under the session row's
 * lock and is queued behind a drain under way. The lease outlives a drain that died, so the sweeper drains after it.
 */
import pino from "pino";
import { db, type StatementRunner } from "../infra/db.js";

const logger = pino({ name: "pending-drain-claim" });

/** Longer than a drain takes, including a publish that times out; how long a dead drain's claim holds the queue. */
const CLAIM_SECONDS = 120;

/** SQL: a drain holds the claim on the session row the statement reads. */
export const DRAIN_UNDER_WAY_SQL = "(pending_drain_until IS NOT NULL AND pending_drain_until > NOW())";

/**
 * Run `drain` while holding the session's claim, if the session is free and no other drain holds it.
 *
 * @returns whether `drain` ran.
 */
export async function withPendingDrainClaim(sessionId: string, drain: () => Promise<void>): Promise<boolean> {
  const claim = await takeClaim(db, sessionId);
  if (claim === null) {
    logger.info({ sessionId }, "pending.drain_session_taken");
    return false;
  }
  try {
    await drain();
    return true;
  } finally {
    try {
      await db.query(
        "UPDATE claw_sessions SET pending_drain_until = NULL WHERE session_id = $1 AND pending_drain_until = $2::timestamptz",
        [sessionId, claim],
      );
    } catch (err) {
      // The lease runs out by itself; until then the next message is queued and drained by the sweeper.
      logger.warn({ err, sessionId }, "pending.drain_claim_release_failed");
    }
  }
}

/** The claim's own value, which is what releases it; null when the session is running or another drain holds it. */
async function takeClaim(q: StatementRunner, sessionId: string): Promise<string | null> {
  const r = await q.query(
    `UPDATE claw_sessions SET pending_drain_until = clock_timestamp() + make_interval(secs => $2)
      WHERE session_id = $1 AND deleted_at IS NULL AND agent_status <> 'running' AND NOT ${DRAIN_UNDER_WAY_SQL}
      RETURNING pending_drain_until::text AS claim`,
    [sessionId, CLAIM_SECONDS],
  );
  return (r.rows[0] as { claim?: string } | undefined)?.claim ?? null;
}
