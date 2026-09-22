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
 * That release is a clean handover only while the thing that died is the
 * replica. It is not when the thing that died is only the connection. The
 * server drops the lock the instant that backend goes, and this process is
 * still here, still inside `fn`, still walking its traversal -- because the
 * scan's own work goes through `db.query` on the main pool, which the drop does
 * not touch, and nothing in the scan ever speaks to the client the lock is on.
 * Measured against a real server, twice: after a `pg_terminate_backend` of the
 * holder, `pg_locks` showed no holder, a second replica's `pg_try_advisory_lock`
 * answered true 200ms later, and the first callback went on to run twenty-one
 * more queries and returned `{ran: true}` to a caller that recorded a clean
 * exclusive pass. The only trace was one warn-level `leader.unlock_failed`,
 * under a comment claiming the situation is self-correcting -- which it is when
 * the connection closes at the END of the hold and is the precise opposite of
 * the truth when it closed at the start of one.
 *
 * So the drop has to reach this function, and it does, in the two shapes db.ts
 * publishes it in: `onConnectionLost` to report the loss at the moment it
 * happens, which for a scan that then never returns is the only moment it can
 * be reported at all, and `connectionLost` both for the verdict this function
 * gives its caller and for the {@link LeaderLease} a scan checks at its own
 * loop boundaries. What none of it can do is undo the part of the scan that
 * already ran: a sandbox torn down before the drop stays torn down, an S3
 * prefix deleted before it stays deleted. This bounds the exposure. It does not
 * make a pass transactional, and no amount of checking here would.
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

import { connectionLost, db, onConnectionLost } from "./db.js";

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
 * What a scan can ask about the leadership it is running under.
 *
 * Handed to `fn` because a callback fired mid-await cannot by itself stop a
 * loop that is between two queries: the watcher runs, sets a flag, and the loop
 * -- which is inside `await stopAllHandlesForDag(...)` and not reading any flag
 * -- carries on to the next handle. Only the loop can stop the loop, and the
 * only place it can do that is the top of an iteration, which is why this is a
 * pull and not a subscription.
 *
 * `lost()` is a read of db.ts's per-client record, not a cached copy of it: a
 * connection that is gone stays gone, so one read at the boundary is as good as
 * a subscription and has no window to arrive late for.
 *
 * Optional at every call site on purpose -- a scan with nothing it can usefully
 * stop between should not take one, because a boundary check that reports a
 * loss it cannot act on is noise in the shape of diligence.
 */
export interface LeaderLease {
  /** The drop that ended this hold's leadership, or undefined while it holds. */
  lost(): Error | undefined;
}

/**
 * The scan ran, but not under the leadership it was handed.
 *
 * Thrown rather than returned, and the alternative it was chosen over is
 * `{ran: false}` -- which every caller in this repo reads as "another replica
 * has this one", the most ordinary outcome there is. That reading is exactly as
 * false as the `{ran: true}` it replaces, only in the other direction: the scan
 * did run and it did act, and the untrue part is that it acted alone. A skip
 * that silently means "some handles were torn down, possibly twice" is the
 * worse of the two lies, because a skip is a thing nobody looks at.
 *
 * A throw is what the callers already route correctly, all six of them, without
 * a line of change:
 *   - `sweeperTick`'s two holds each `.catch` into their own `sweeper.*_failed`
 *     error line, and the tick carries on with the sweeps that need no leader.
 *   - `runSweepPass` catches into `upload-sweep.failed`.
 *   - `processCompletionEvent`'s caller catches, naks the delivery for ten
 *     seconds and leaves `processed_at` NULL, so the completion is redone under
 *     a lock that is actually held -- which is the only remedy that exists for a
 *     completion that may have been terminalized twice. Under `{ran: false}` it
 *     would nak too, on the one-second "someone else has it" path, and log
 *     nothing whatsoever.
 *   - `runCleanupAction`'s row is caught per row and keeps its reconcile marker
 *     armed, so it returns next tick.
 *   - `publishSummaryIfCurrent`'s caller is `maybeSummarize(...).catch(...)`.
 *
 * The union this function returns is therefore unchanged, which matters more
 * than it looks. A third variant would have to be narrowed by every caller
 * before it could be read at all, and a caller that did not narrow it would go
 * on reading `ran === false` and skipping -- the silent reading again, arrived
 * at this time by doing nothing.
 *
 * What it does not mean: it is not a rollback, and nothing here undoes the work
 * the scan did before the drop.
 */
export class LeadershipLostError extends Error {
  /** The scan name, as it appears in this module's log lines. */
  readonly scan: string;
  readonly lockId: number;
  /** The connection drop that ended the leadership. */
  readonly lostBy: Error;
  /** How long the scan went on running after the lock was already free. */
  readonly ranOnMs: number;

  constructor(scan: string, lockId: number, lostBy: Error, ranOnMs: number) {
    super(
      `leadership for ${scan} ended mid-scan (${lostBy.message}); the scan ran on for `
      + `${ranOnMs}ms and its work was not exclusive`,
    );
    this.name = "LeadershipLostError";
    this.scan = scan;
    this.lockId = lockId;
    this.lostBy = lostBy;
    this.ranOnMs = ranOnMs;
  }
}

/**
 * Run `fn` if this replica can take the lock, and skip otherwise.
 *
 * `fn` is handed a {@link LeaderLease} it may ignore. A scan with a loop over
 * items it destroys should not ignore it -- see `reapOrphanHandles`.
 *
 * @returns whether the work ran. A skip is the normal outcome on every
 * replica but one and is not an error.
 * @throws {LeadershipLostError} when the lock connection dropped while `fn` was
 * running, so the pass was not exclusive. The work `fn` had already done before
 * the drop is not undone by this and cannot be.
 */
export async function withLeaderLock<T>(
  lockId: number,
  name: string,
  fn: (lease: LeaderLease) => Promise<T>,
  opts: { maxHoldMs?: number } = {},
): Promise<{ ran: true; result: T } | { ran: false }> {
  // The dedicated lock pool, so a long scan cannot occupy a connection that
  // request handling needs.
  const client = await db.lockPool.connect();
  let held = false;
  let stallAlarm: NodeJS.Timeout | undefined;
  // Set by the watcher below rather than derived at the end, because the end is
  // the one thing a lost hold cannot be relied on to reach, and because the
  // interval between this and the return is the number an operator wants: how
  // long the scan kept acting on a lock the server had already given away.
  let lostAt = 0;
  let stopWatching: () => void = () => {};
  try {
    const r = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [lockId]);
    held = r.rows[0]?.ok === true;
    if (!held) {
      logger.debug({ scan: name }, "leader.skipped_not_leader");
      return { ran: false };
    }
    // Reported here, while `fn` is still pending, for the same reason the stall
    // alarm below is: a scan that never returns runs no code afterwards, so the
    // check after `await fn(...)` is not a place a hung hold's loss can be said
    // out loud from. The watcher only says it -- stopping is the lease's job,
    // and the caller's verdict is decided after `fn` returns, from the same
    // record this reads.
    //
    // It cannot throw: db.ts calls watchers inside a try/catch, and the reason
    // it publishes a callback rather than an `AbortSignal` is that
    // `AbortController.abort()` rethrows a listener's error from a
    // `process.nextTick` where no try/catch reaches it -- which would be the
    // unhandled 'error' crash that whole listener exists to prevent.
    stopWatching = onConnectionLost(client, (err) => {
      lostAt = Date.now();
      logger.error(
        { scan: name, lockId, err: err.message },
        "leader.lock_lost_mid_scan (the server released this lock when the connection "
        + "dropped; another replica may be running the same scan from here on)",
      );
    });
    // Fires while fn is still pending, which is the only moment at which a hang
    // can be reported at all: a scan that never returns runs no code afterwards.
    const maxHoldMs = opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
    stallAlarm = setTimeout(() => {
      // "No replica can run it" stops being true the moment the lock is gone,
      // so the alarm says which of the two stalls this is rather than asserting
      // an exclusion that has already ended.
      const lost = connectionLost(client);
      if (lost) {
        logger.error(
          { scan: name, heldForMs: maxHoldMs, lockId, err: lost.message },
          "leader.hold_exceeded (this scan is not progressing and lost its lock while "
          + "running, so another replica is free to run it concurrently)",
        );
        return;
      }
      logger.error(
        { scan: name, heldForMs: maxHoldMs },
        "leader.hold_exceeded (this scan is not progressing and no replica can run it)",
      );
    }, maxHoldMs);
    stallAlarm.unref?.();
    const result = await fn({ lost: () => connectionLost(client) });
    // After `fn`, not instead of it. Racing the drop against `fn` and returning
    // early was considered and rejected: nothing here can cancel `fn`, so an
    // early return leaves it running detached -- which turns a serial sweeper
    // tick into a concurrent one, adds an unhandled rejection to catch, and buys
    // no reduction in exposure at all, since the scan runs exactly as long
    // either way. The lease is what shortens the scan; this only decides what
    // the caller is told about it.
    //
    // Read from db.ts rather than from `lostAt`, so a drop that somehow reached
    // the record without reaching the watcher is still caught -- the record is
    // written before anything that can fail, the watcher call after it.
    const lost = connectionLost(client);
    if (lost) throw new LeadershipLostError(name, lockId, lost, lostAt ? Date.now() - lostAt : 0);
    return { ran: true, result };
    // A `fn` that threw is deliberately not converted: its own error is the more
    // specific account of what went wrong, a caller that catches it already
    // treats the pass as failed rather than as a clean exclusive one, and the
    // loss has been reported at error level by the watcher above regardless.
  } finally {
    stopWatching();
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
        // error level rather than the warn the unlock-failed path below uses,
        // because that one is about a lock this session may still be holding,
        // while this one is a report that the exclusion has already failed, and
        // a stall gets error level for less.
        //
        // The return value is left alone here, and only here: this branch's
        // commonest real cause is a transaction-pooling proxy, on which it
        // fires on every tick of every scan for ever, and turning a deployment
        // whose locks have never worked into one whose every sweep also throws
        // would be a second fault laid over the first. The dropped-connection
        // case below is not that shape -- it is an event, it has an error to
        // name, and the pass it ends is one the caller must not be told was
        // clean.
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
        const unlockErr = (err as Error)?.message;
        // Which of the two failures this is, decided from the connection and
        // not from the throw. A dropped client does not answer `false` here --
        // it throws, on `Client was closed and is not queryable` or on the
        // socket error itself -- so before this the alarm written for exactly
        // the not-held condition sat on a branch that a drop could never take,
        // and the one case where leadership had demonstrably ended was the one
        // case logged at warn.
        //
        // A lost connection IS the not-held case, and by a stronger proof than
        // `pg_advisory_unlock` returning false: the server released the lock
        // when the backend went, so this session holds nothing, and it has held
        // nothing since the drop rather than merely at this instant. Nothing is
        // synthesised from that -- no `released: false` row is invented for an
        // answer the server never gave. The evidence is the connection's own
        // recorded death, and it is named in the line.
        //
        // The remaining arm keeps warn and keeps its old reasoning, now that
        // the reasoning is only claimed where it holds: an unlock that failed on
        // a connection which is still up -- a statement timeout, a cancelled
        // query, a proxy refusing the statement -- is against a session that may
        // still be holding the lock, and that one really is self-correcting,
        // because the connection is destroyed on the way out of this block and
        // the server releases the lock with it. What is not self-correcting, and
        // what the old comment claimed anyway, is a lock released at the START
        // of the hold: there is nothing left to correct by then, only a scan
        // that has been running unguarded ever since.
        const lost = connectionLost(client);
        if (lost) {
          logger.error(
            { scan: name, lockId, err: unlockErr, lostBy: lost.message },
            "leader.unlock_not_held (the lock connection dropped mid-scan, so the server "
            + "released this lock then and the scan ran on without the leadership it assumed)",
          );
        } else {
          // Best-effort: a lock we cannot release on a connection that is still
          // up is released for us when that connection is destroyed below, and a
          // throw here would mask the scan's own error.
          logger.warn({ scan: name, err: unlockErr }, "leader.unlock_failed");
        }
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
