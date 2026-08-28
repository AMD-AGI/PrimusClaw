// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Run a background scan on one replica at a time.
 *
 * Not everything periodic needs this. A reaper whose whole action is a single
 * `UPDATE ... WHERE status IN (...)` is already safe to run everywhere at
 * once: the statement is its own compare-and-swap, so the second replica
 * updates nothing and the outcome is identical. Deletion is the same -- doing
 * it twice leaves the same absence.
 *
 * What is not safe is the shape of scan that reads, decides, and then acts on
 * something outside the database. Two replicas can both read the same state,
 * both conclude it is abandoned, and both act -- and by the time the second
 * one acts, the world it decided against is gone. The workload teardown in
 * `reapOrphanHandles` is exactly this: it reads a handle, checks the DAG's
 * status, and destroys a sandbox, which races a Brain that is rebuilding one.
 * The upload sweep is the same shape and additionally does the whole listing
 * and HEAD traversal once per replica, paying N times for one answer.
 *
 * So the rule is the distinction, not the ceremony: single idempotent
 * statements run unguarded, read-decide-act scans take the lock.
 *
 * Postgres advisory locks are the mechanism because the database is already
 * the thing every replica agrees on, and a session-scoped lock is released by
 * the server when the connection dies -- so a replica that is killed
 * mid-scan hands leadership over without anything having to notice it died.
 * Not instantly, though: on a graceful shutdown the socket closes and the
 * release is immediate, but on SIGKILL or a node failure the server releases
 * when it notices the socket is gone, which is TCP keepalive territory and can
 * take minutes. Nothing is lost -- the next tick after the release picks the
 * scan up -- but the handover is not the same as a handoff.
 * `try` rather than a wait: a replica that does not get the lock has nothing
 * to wait for, since the holder is running the very scan it wanted to run.
 *
 * What the lock cannot do is bound the scan. Serialising it means one stuck
 * replica stops every replica, where before this each swept independently and a
 * stuck one only wasted its own time. So the work has to be able to end on its
 * own -- see the S3 client timeouts in upload-sweeper -- and a hold that outlasts
 * `maxHoldMs` says so at error level while it is still happening, because the
 * alternative symptom is a log line that stops appearing, which nothing alerts
 * on. Releasing the lock under a scan that is still running is deliberately not
 * an option: that hands two replicas the read-decide-act race this exists to
 * prevent, which is worse than the stall.
 */
import pino from "pino";

import { db } from "./db.js";

const logger = pino({ name: "leader-lock" });

/**
 * Advisory lock ids for the periodic scans.
 *
 * Arbitrary but permanent, and they share one namespace with every other
 * advisory lock in this database (see `SCHEMA_MIGRATION_LOCK_ID` in db.ts):
 * reusing a number for a second purpose would silently make two unrelated
 * things mutually exclusive.
 */
export const LEADER_LOCK_IDS = {
  orphanHandles: 8_264_179_233_101,
  uploadSweep: 8_264_179_233_102,
  sessionCleanup: 8_264_179_233_103,
} as const;

/**
 * How long a scan may hold the lock before the hold is reported as a fault.
 *
 * Not a limit -- nothing is cancelled -- but the difference between a stall
 * somebody can be paged about and one whose only evidence is the absence of a
 * log line. Ten minutes is far above any healthy pass and far below the hours a
 * hung connection would otherwise sit there.
 */
const DEFAULT_MAX_HOLD_MS = 10 * 60 * 1000;

/**
 * Run `fn` if this replica can take the lock, and skip otherwise.
 *
 * @returns whether the work ran. A skip is the normal outcome on every
 * replica but one and is not an error.
 */
export async function withLeaderLock<T>(
  lockId: number,
  name: string,
  fn: () => Promise<T>,
  opts: { maxHoldMs?: number } = {},
): Promise<{ ran: true; result: T } | { ran: false }> {
  // The dedicated lock pool, so a long scan cannot occupy a connection that
  // request handling needs.
  const client = await db.lockPool.connect();
  let held = false;
  let stallAlarm: NodeJS.Timeout | undefined;
  try {
    const r = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [lockId]);
    held = r.rows[0]?.ok === true;
    if (!held) {
      logger.debug({ scan: name }, "leader.skipped_not_leader");
      return { ran: false };
    }
    // Fires while fn is still pending, which is the only moment at which a hang
    // can be reported at all: a scan that never returns runs no code afterwards.
    const maxHoldMs = opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
    stallAlarm = setTimeout(() => {
      logger.error(
        { scan: name, heldForMs: maxHoldMs },
        "leader.hold_exceeded (this scan is not progressing and no replica can run it)",
      );
    }, maxHoldMs);
    stallAlarm.unref?.();
    return { ran: true, result: await fn() };
  } finally {
    if (stallAlarm) clearTimeout(stallAlarm);
    let unlocked = true;
    if (held) {
      try {
        const r = await client.query("SELECT pg_advisory_unlock($1) AS released", [lockId]);
        // `pg_advisory_unlock` answers false when this session does not hold the
        // lock -- which cannot happen to a session that took it and kept it, so
        // false says the leadership the scan just ran under was not actually
        // held. That is the one condition this lock exists to detect: another
        // replica was free to take it and run the same read-decide-act traversal
        // concurrently, so every decision the scan reached may have raced one it
        // could not see. Discarding the answer made that indistinguishable from
        // a clean pass.
        //
        // Reported rather than thrown, because the scan is already over by the
        // time this runs: a throw would prevent nothing and would only take out
        // the caller's remaining sweeps, which need no leadership at all. At
        // error level rather than the warn the failed-unlock path below uses,
        // because that one is self-correcting -- the connection closes and the
        // lock goes with it -- while this one is a report that the exclusion has
        // already failed, and a stall gets error level for less.
        //
        // Read the way the acquire above reads its own answer: `true` is the
        // only confirmation, and a missing row or a missing column is not one.
        // The two directions have to match, because anything that stops the
        // column coming back -- a proxy rewriting the statement, a driver
        // change, a stub in a test -- would otherwise make the acquire fail
        // closed, so nothing runs, while this failed open and called every hold
        // clean.
        //
        // One cause of a false answer is worth naming, because it is not a
        // transient and this code cannot fix it: behind a transaction-pooling
        // proxy a session-level advisory lock cannot work at all, since the
        // acquire and the release are free to land on different backends. On
        // such a deployment every tick reports false here and destroys its
        // connection, and the scans have never been exclusive -- the reading is
        // not "one lost leadership" but "this lock has no effect on this
        // cluster". The remedy is a session-pooling endpoint for `lockPool`, not
        // a looser check here.
        unlocked = r.rows[0]?.released === true;
        if (!unlocked) {
          logger.error(
            { scan: name, lockId },
            "leader.unlock_not_held (this scan ran without the leadership it assumed it had)",
          );
        }
      } catch (err) {
        // Best-effort: a lock we cannot release is released for us when this
        // connection closes, and a throw here would mask the scan's own error.
        logger.warn({ scan: name, err: (err as Error)?.message }, "leader.unlock_failed");
        unlocked = false;
      }
    }
    // Destroy rather than return to the pool when the unlock did not land. The
    // reasoning above only holds if the connection actually closes, and
    // `release()` on its own hands a possibly-still-locked session to the next
    // caller -- which would then skip for ever, having been given the lock it is
    // checking for. The migration path in db.ts destroys here for the same reason.
    // A session that denies holding the lock it took goes the same way: whatever
    // reset its state will do so again, and its next answer to
    // `pg_try_advisory_lock` would be worth no more than this one.
    client.release(!unlocked);
  }
}
