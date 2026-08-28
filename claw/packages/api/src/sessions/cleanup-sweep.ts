// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The half of a session delete that outlives the request that asked for it.
 *
 * Deleting a session commits one transaction and then finishes the job outside
 * this database -- the tombstone, the sandbox handle, the gate locks, the event
 * stream, the objects in S3 (see sessions/teardown.ts). The request runs that
 * cleanup itself on a five-second budget, which is enough on a healthy cluster
 * and is not the mechanism. This is: every session whose cleanup did not finish
 * is `cleanup_state = 'pending'` on its own row, and this sweep runs the same
 * body again until it does.
 *
 * That is what makes the delete a promise rather than an attempt. It is also why
 * this file ends with a report nobody wants to need: once the client is told
 * "deleted" before the files are gone, a cleanup that can never finish is
 * invisible unless something says so. On a working cluster the pending set is
 * empty between ticks, so a row that stays in it is a real fault and not a
 * backlog -- which is exactly the property that makes the alert worth having.
 */
import pino from "pino";

import { db } from "../infra/db.js";
import { envInt, reportSettingProblem, TASK_SWEEPER_TICK_MS } from "../config.js";
import {
  CLEANUP_RETRY_MAX_SEC, recordCleanupOutcome, runSessionCleanup,
} from "./teardown.js";

const logger = pino({ name: "session-cleanup-sweep" });

/**
 * How many outstanding deletions one pass takes on.
 *
 * A bound rather than a throttle, and what it bounds is the first tick after an
 * upgrade: every session deleted before this existed is backfilled as pending
 * (see the migration in db.ts), so on a cluster with a year of deletions behind
 * it the first scan would otherwise walk every one of their prefixes in a single
 * pass while holding the leader lock. Twenty a minute drains a few thousand
 * overnight, which is the right speed for reconciling something nobody is
 * waiting on.
 */
const CLEANUP_BATCH = envInt("SESSION_CLEANUP_BATCH", 20, { min: 1 });

/**
 * How long a deletion may stay unfinished before it is somebody's problem.
 *
 * Twice the retry ceiling, so that a row is only reported once it has been tried,
 * backed off to the longest interval, and tried again -- a fifteen-minute S3
 * outage is not a fault of the delete. And below anything a compliance answer
 * would be given in: the point of the report is that somebody finds out on the
 * day, not that the number is precise.
 *
 * Derived rather than merely documented, because the two settings live in
 * different modules and a raised retry ceiling would otherwise turn every row
 * waiting out its own backoff into a page. A hand-set value below the floor is
 * raised to it and reported at startup, the way every other refused setting is.
 */
const STUCK_AFTER_SEC = resolveStuckAfterSec();

function resolveStuckAfterSec(): number {
  const floor = 2 * CLEANUP_RETRY_MAX_SEC;
  const configured = envInt("SESSION_CLEANUP_STUCK_SEC", floor, { min: 1 });
  if (configured >= floor) return configured;
  reportSettingProblem(
    `SESSION_CLEANUP_STUCK_SEC=${configured} is under twice SESSION_CLEANUP_RETRY_MAX_SEC `
    + `(${CLEANUP_RETRY_MAX_SEC}), which would report deletions that are only waiting out `
    + `their backoff; using ${floor}`,
  );
  return floor;
}

/**
 * How much of a tick one pass may spend.
 *
 * The sweeper tick is a serial chain and the next one is scheduled only when this
 * one returns, so a pass that does not bound itself is not merely slow: the
 * workspace-reference sweeps behind it and the next tick's lease reapers -- the
 * backstop that decides whether a run is still alive -- wait for it. Twenty
 * sessions against an endpoint that accepts connections and then stops answering
 * is twenty times the S3 client's own timeouts, which is well past a tick.
 *
 * Half a tick, so that a pass which spends all of it still leaves the rest of the
 * chain the other half, and derived rather than named so it follows a deployment
 * that changes the tick. What the bound costs is deletions deferred to the next
 * pass, which is what the pending set is for.
 */
const SWEEP_BUDGET_MS = envInt(
  "SESSION_CLEANUP_SWEEP_BUDGET_MS",
  Math.max(1, Math.floor(TASK_SWEEPER_TICK_MS / 2)),
  { min: 1 },
);

/** A deletion this pass has to finish. */
interface PendingCleanup {
  session_id: string;
  /** The owner the objects are filed under, which is the row's, not a caller's. */
  user_id: string | null;
}

/**
 * Finish the deletions that are due, oldest schedule first.
 *
 * Bounded twice: by the batch, which is about the size of the backlog, and by
 * {@link SWEEP_BUDGET_MS}, which is about the tick this runs inside. A budget
 * more generous than the request's, since nobody is waiting on this one, but a
 * budget nonetheless -- the deadline is passed down so that a session too large
 * for what is left stops at a page boundary instead of overrunning it.
 *
 * Sequential rather than concurrent, because the work is a page-at-a-time walk
 * of somebody's whole workspace and the pool it goes through is shared with
 * request handling -- twenty of them at once is how a background reconcile
 * becomes the reason a download is slow.
 *
 * @returns how many deletions this pass finished.
 */
export async function sweepSessionCleanups(): Promise<number> {
  const due = (await db.query(
    `SELECT session_id, user_id
       FROM claw_sessions
      WHERE cleanup_state = 'pending'
        AND (cleanup_next_at IS NULL OR cleanup_next_at <= NOW())
      ORDER BY cleanup_next_at NULLS FIRST
      LIMIT $1`,
    [CLEANUP_BATCH],
  )).rows as PendingCleanup[];
  if (!due.length) return 0;

  const deadline = Date.now() + SWEEP_BUDGET_MS;
  let finished = 0;
  let attempted = 0;
  for (const row of due) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    attempted += 1;
    // No platform key: there is no caller to take one from, and nothing here
    // needs one. The compute side is Brain's, reached through the parked
    // `hands.<sid>` handle that carries the session's own key -- see
    // sweepStaleHands in brain/src/sandbox/reaper.ts.
    const incomplete = await runSessionCleanup(
      { sessionId: row.session_id, ownerId: row.user_id },
      { budgetMs: left },
    );
    await recordCleanupOutcome(row.session_id, incomplete);
    if (!incomplete.length) finished += 1;
  }
  logger.info(
    { due: due.length, attempted, finished },
    "session_cleanup.pass_complete",
  );
  return finished;
}

/** The oldest unfinished deletion, and how many others are as old. */
export interface StuckCleanups {
  sessionId: string;
  attempts: number;
  error: string | null;
  pendingSec: number;
  /** How many deletions have been outstanding past the threshold, this one included. */
  stuck: number;
}

/**
 * Name the oldest deletion that is not getting anywhere, if there is one.
 *
 * Counted over every outstanding row and not only the batch above, so a pass
 * that reconciles twenty backfilled sessions cannot hide the one that has been
 * failing since yesterday. The count comes from the same statement as the
 * sample: two queries would let the number and the session it names disagree,
 * and the number on its own says nothing an operator can start from.
 *
 * Only rows that have been tried, which is the same as rows that got nowhere:
 * an attempt is counted for a cleanup that failed and for one whose clock ran
 * out before it had reached the files, and withheld only from one that was
 * in the files when the clock stopped. So a deletion that can never finish
 * accumulates attempts and arrives here however many passes it takes, while a
 * session merely too large for one pass does not.
 *
 * What the count excludes is the row the upgrade backfilled and the sweep has
 * not reached yet -- a queue draining at a batch a tick, all of it older than
 * any threshold, and reporting it would make the first hour after an upgrade a
 * page about sessions deleted last year that are being dealt with as designed.
 *
 * @returns the report, or null when every outstanding deletion is recent.
 */
export async function stuckCleanups(): Promise<StuckCleanups | null> {
  const r = await db.query(
    `SELECT session_id,
            cleanup_attempts,
            cleanup_error,
            EXTRACT(EPOCH FROM (NOW() - deleted_at))::int AS pending_sec,
            COUNT(*) OVER ()::int AS stuck
       FROM claw_sessions
      WHERE cleanup_state = 'pending'
        AND cleanup_attempts > 0
        AND deleted_at < NOW() - ($1::int * INTERVAL '1 second')
      ORDER BY deleted_at
      LIMIT 1`,
    [STUCK_AFTER_SEC],
  );
  const row = r.rows[0] as {
    session_id: string;
    cleanup_attempts: number;
    cleanup_error: string | null;
    pending_sec: number;
    stuck: number;
  } | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id,
    attempts: row.cleanup_attempts,
    error: row.cleanup_error,
    pendingSec: row.pending_sec,
    stuck: row.stuck,
  };
}

/**
 * One pass: finish what is due, then say whether anything is stuck.
 *
 * The report comes after the work so that a deletion this pass has just
 * completed is not reported as outstanding, and it runs whether or not the pass
 * found anything to do -- a row whose backoff has not elapsed is not due and is
 * exactly the row worth reporting.
 */
export async function runCleanupSweep(): Promise<void> {
  await sweepSessionCleanups();
  const stuck = await stuckCleanups();
  if (!stuck) return;
  logger.error(
    { ...stuck, thresholdSec: STUCK_AFTER_SEC },
    "session_cleanup.stuck (a session reported as deleted still has files, a sandbox "
    + "handle or a tombstone outstanding, and retrying is not fixing it)",
  );
}
