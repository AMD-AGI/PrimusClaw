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
 * The claim is a Postgres advisory lock on the session, held by the drain for the whole drain on a connection of
 * its own and taken by a message's transaction before it locks the session row. Under it the drain asks again
 * whether the session is free, so a drain that waited for another one finds the turn that one started and leaves
 * the queue to that turn's completion.
 */
import pino from "pino";
import { db, type StatementRunner } from "../infra/db.js";

const logger = pino({ name: "pending-drain-claim" });

const CLAIM_ARGS = "hashtext('claw_pending_drain'), hashtext($1)";

/**
 * Wait for a drain of this session to finish, inside the caller's transaction, and keep the next one out until it
 * commits. Taken before the session row's lock: a drain takes the row's lock while holding the claim, so the other
 * order deadlocks.
 */
export async function holdPendingDrainClaim(client: StatementRunner, sessionId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(${CLAIM_ARGS})`, [sessionId]);
}

/**
 * Run `drain` while holding the session's claim, if the session is free once the claim is held.
 *
 * @returns whether `drain` ran.
 */
export async function withPendingDrainClaim(sessionId: string, drain: () => Promise<void>): Promise<boolean> {
  const client = await db.lockPool.connect();
  let held = false;
  try {
    await client.query(`SELECT pg_advisory_lock(${CLAIM_ARGS})`, [sessionId]);
    held = true;
    const free = await db.query(
      "SELECT 1 FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL AND agent_status <> 'running'",
      [sessionId],
    );
    if (!free.rowCount) {
      logger.info({ sessionId }, "pending.drain_session_taken");
      return false;
    }
    await drain();
    return true;
  } finally {
    if (held) {
      try {
        await client.query(`SELECT pg_advisory_unlock(${CLAIM_ARGS})`, [sessionId]);
        client.release();
      } catch (err) {
        // The lock may still be held on this backend: a connection returned to the pool with it would keep every
        // later drain of the session waiting, so it is destroyed instead.
        logger.warn({ err, sessionId }, "pending.drain_claim_release_failed");
        client.release(err as Error);
      }
    } else {
      client.release();
    }
  }
}
