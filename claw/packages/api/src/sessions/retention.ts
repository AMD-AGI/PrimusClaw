// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Retention: archived sessions are deleted, and deleted sessions' rows purged.
 *
 * Two steps of the daily maintenance pass, each off until its setting is set.
 *
 * `SESSION_RETENTION_DAYS` deletes a session that has been archived for that
 * many days. It deletes through {@link commitSessionDeletion}, the same commit a
 * user's delete makes, so everything that delete does happens here too: the
 * queued messages go, the conversation rows are stamped `deleted_at`, and the
 * row is left `cleanup_state = 'pending'` for the cleanup sweeper
 * (sessions/cleanup-sweep.ts), which removes the S3 workspace and checkpoint
 * prefixes, the tombstone, the sandbox handle and the gate locks. Nothing is
 * cleaned inline: the sweeper already drains a backlog at its own pace, and a
 * daily batch of hundreds of S3 walks does not belong in this pass.
 *
 * The archive time is `archived_at`. A session archived before that column
 * existed has none, and its `updated_at` stands in -- archiving never moved it,
 * so for those sessions the clock starts at their last activity, which is
 * earlier than the archive and never later.
 *
 * Never taken, whatever their age:
 *   - a session not `archived`, or already deleted;
 *   - one made through the Anthropic-compatible API: there `archived` is the
 *     client's own `terminated`, and the client keeps listing those sessions
 *     (`include_archived=true`) and deletes them itself;
 *   - one with a run in flight: `agent_status = 'running'` on it or on a team
 *     member, or a task of its own not yet finished;
 *   - one with queued messages, which are a turn about to start;
 *   - the worker session of any work item (`claw_work_items.worker_session_id`),
 *     open or done: the item's board links to it. This is also every session a
 *     trigger reuses -- a trigger made from an item wakes that item's worker,
 *     and every other trigger starts a new session per firing and never comes
 *     back to an old one.
 *
 * The same predicate selects the batch and is asked again under the row locks
 * of the session and its team members inside the deletion's own transaction, so a session that became
 * ineligible between the scan and its turn -- a message sent, an unarchive -- is
 * skipped rather than deleted.
 *
 * `SESSION_PURGE_DAYS` removes for good the rows a deletion only stamped: the
 * turns, events and summaries of a session deleted more than that many days
 * ago. The session row itself stays, because it carries the cleanup state the
 * sweeper and its stuck report read, and the deletion time retention windows are
 * measured from.
 *
 * Each hold of the lock is bounded in time as well as in count. Deleting a
 * session takes a fraction of a second, so a daily batch of thousands held the
 * lock past the leader lock's stall alarm (a 5000-session pass held it 13.5
 * minutes). A hold stops at its time budget and the pass continues in a fresh
 * hold a little later, until the day's batch is spent.
 *
 * The batch is a limit on the day and not on a pass, because a pass is not a
 * day: every replica starts one a minute after it boots and every 24 hours
 * after that, so one rollout of four replicas is four passes. Each hold reads
 * what is left of the day from the deletions already made -- see
 * {@link retentionAllowance} -- which is the one record every replica shares.
 *
 * The day is the last 24 hours, and the next daily pass starts 24 hours after
 * the last one, so it finds yesterday's deletions still inside the window: they
 * were made a little after that pass started, and leave it a little after this
 * one starts. So a pass whose batch is spent by deletions that leave the window
 * soon waits for them and deletes as they leave, rather than ending with
 * nothing done and leaving the backlog to the day after (a batch every other
 * day). One whose window frees later than that -- a replica booted mid-day,
 * after the day's pass -- ends, and the next daily pass takes it.
 */
import pino from "pino";

import { db, type Querier } from "../infra/db.js";
import { LEADER_LOCK_IDS, type LeaderLease, withLeaderLock } from "../infra/leader-lock.js";
import { commitSessionDeletion } from "./teardown.js";

const logger = pino({ name: "session-retention" });

type Queryable = Pick<typeof db, "query">;

/** The tables a deletion stamps `deleted_at` on, which the purge empties. */
export const PURGED_TABLES = [
  "claw_conversation_turns",
  "claw_session_events",
  "claw_session_summaries",
] as const;

/** Task states a run is still in; the same set a deletion cancels. */
const OPEN_TASK_STATES = "'waiting_deps','waiting_external','queued','preparing','running','cancelling'";

export interface RetentionSettings {
  retentionDays: number;
  purgeDays: number;
  batch: number;
  dryRun: boolean;
}

export interface RetentionReport {
  dryRun: boolean;
  /** Archived sessions past the retention window and not excluded, before the batch limit. */
  eligible: number;
  /** Sessions this pass deleted (in a dry run, would have). */
  deleted: number;
  /** Sessions selected but found ineligible under their row lock. */
  skipped: number;
  /**
   * Deleted sessions past the purge window found with rows to remove. Counted
   * while walking them, so the walk's stop at the batch or the time budget
   * bounds it.
   */
  purgeEligible: number;
  /** Deleted sessions whose rows this pass removed (in a dry run, would have). */
  purgedSessions: number;
  /** Rows removed per table (in a dry run, the rows the purged sessions hold). */
  purgedRows: Record<(typeof PURGED_TABLES)[number], number>;
  /** This hold stopped at its time budget with work left; the pass continues in another hold. */
  timedOut: boolean;
}

/**
 * Where a pass that spans several holds of the lock has got to. One per daily
 * pass; each hold reads and advances it.
 */
export interface RetentionProgress {
  /**
   * Deletions left in this pass's batch. What is left of the day's, read from
   * the deletions themselves at every hold, can be less.
   */
  deleteLeft: number;
  /** Purges left in the day's batch. */
  purgeLeft: number;
  /**
   * The purge walk's position: the last session it visited, in (deleted_at,
   * session_id) order. The time is Postgres's own text for it, because a JS
   * Date keeps milliseconds and the column has microseconds: a cursor rounded
   * down would hand the walk the same session again.
   */
  purgeCursor?: { deletedAt: string; sessionId: string };
  /**
   * Set when the last 24 hours' deletions, not this pass's batch, stopped the
   * deletions and the window frees part of the day's batch soon: when (by
   * `Date.now()`) the next hold should start to delete what has left it.
   */
  deleteResumeAt?: number;
  deleteDone: boolean;
  purgeDone: boolean;
}

export function newRetentionProgress(s: RetentionSettings): RetentionProgress {
  return { deleteLeft: s.batch, purgeLeft: s.batch, deleteDone: false, purgeDone: false };
}

/** The deletions the day's limit counts, over `claw_sessions s`; see {@link retentionAllowance}. */
const COUNTED_TODAY = `s.deleted_at > NOW() - INTERVAL '1 day'
        AND s.status = 'archived'
        AND NOT COALESCE(s.config ? 'primus_anthropic_compat', false)`;

/** What is left of the day's batch. */
interface Allowance {
  /** Deletions left. */
  left: number;
  /**
   * With none left, how long until one of the counted deletions turns 24 hours
   * old and frees a place, measured on the database's clock from now.
   */
  freesInMs?: number;
}

/**
 * How many sessions retention may still delete today, counted across the fleet.
 *
 * The batch was a limit per pass, and passes are per replica and per boot: one
 * rollout of four replicas ran four, each with a whole batch of its own. With a
 * batch of 5000 that deleted 22,781 sessions on one day and 16,535 in the 53
 * minutes after a single rollout, and every one of them is a row the cleanup
 * sweeper has to walk the object store for. It takes twenty a pass, so that
 * backlog took about four hours to drain, and a user's own delete that did not
 * finish inline waited behind it.
 *
 * So what is left of the day is read from the deletions themselves: the batch,
 * less the sessions deleted in the last 24 hours that retention could have
 * taken (archived, and not the Anthropic-compatible API's, which its clients
 * delete themselves). Asked at the start of every hold, under the lock, so an
 * earlier hold of this pass and a pass another replica ran are both already in
 * it. It also counts an archived session a user deleted themselves -- nothing on
 * the row says who deleted it -- which can only make a day's retention smaller,
 * and how much deletion one day adds is what the limit is for.
 */
async function retentionAllowance(batch: number): Promise<Allowance> {
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM claw_sessions s WHERE ${COUNTED_TODAY}`);
  const n = (r.rows[0] as { n: number }).n;
  if (n < batch) return { left: batch - n };
  // One place frees when the (n - batch + 1)th oldest of them leaves the window.
  // The wait is the server's arithmetic, so the two hosts' clocks never meet.
  const next = (await db.query(
    `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (s.deleted_at + INTERVAL '1 day' - NOW())) * 1000))::bigint AS ms
       FROM claw_sessions s WHERE ${COUNTED_TODAY}
      ORDER BY s.deleted_at OFFSET $1 LIMIT 1`,
    [n - batch],
  )).rows[0] as { ms: string } | undefined;
  // None: they left the window between the two statements.
  return { left: 0, freesInMs: next ? Number(next.ms) : 0 };
}

/** The bound on one hold: when it ends, and where it starts from. */
interface HoldLimits {
  deadline: number;
  progress: RetentionProgress;
  /**
   * How soon the window has to free a place for the pass to wait for it, when
   * the day's batch is spent; unset, a spent day ends the deletions.
   */
  windowWaitMs?: number;
}

/**
 * The day's batch stopped this hold's deletions: wait for the window to free
 * a place if it does so within `windowWaitMs`, else the deletions are done.
 */
function afterDaySpent(day: Allowance, progress: RetentionProgress, limits: HoldLimits): void {
  if (day.left > 0) {
    // Places freed while this hold deleted: the next hold takes them.
    progress.deleteResumeAt = Date.now();
  } else if (limits.windowWaitMs !== undefined && day.freesInMs !== undefined
    && day.freesInMs <= limits.windowWaitMs) {
    progress.deleteResumeAt = Date.now() + day.freesInMs;
  } else {
    progress.deleteDone = true;
  }
}

/**
 * The retention predicate over `claw_sessions s`, with the age in days as
 * `$<daysParam>`. `workItems` says whether `claw_work_items` exists: it is
 * created only on a deployment that has turned the assistant on.
 */
export function retentionPredicate(daysParam: number, workItems: boolean): string {
  return `
        s.deleted_at IS NULL
        AND s.status = 'archived'
        AND NOT COALESCE(s.config ? 'primus_anthropic_compat', false)
        AND COALESCE(s.archived_at, s.updated_at) < NOW() - ($${daysParam}::int * INTERVAL '1 day')
        AND s.agent_status IS DISTINCT FROM 'running'
        AND NOT EXISTS (
          SELECT 1 FROM claw_sessions c
           WHERE c.parent_session_id = s.session_id
             AND c.deleted_at IS NULL
             AND c.agent_status = 'running')
        AND NOT EXISTS (
          SELECT 1 FROM claw_tasks t
           WHERE t.session_id = s.session_id
             AND t.status IN (${OPEN_TASK_STATES}))
        AND NOT EXISTS (
          SELECT 1 FROM claw_pending_messages p WHERE p.session_id = s.session_id)${workItems ? `
        AND NOT EXISTS (
          SELECT 1 FROM claw_work_items w WHERE w.worker_session_id = s.session_id)` : ""}`;
}

async function tableExists(q: Queryable, name: string): Promise<boolean> {
  const r = await q.query("SELECT to_regclass($1) IS NOT NULL AS ok", [name]);
  return (r.rows[0] as { ok: boolean } | undefined)?.ok === true;
}

/**
 * Delete the archived sessions past the retention window, up to `batch` of them.
 */
async function deleteExpiredSessions(
  s: RetentionSettings,
  report: RetentionReport,
  limits: HoldLimits,
  lease?: LeaderLease,
): Promise<void> {
  const { progress } = limits;
  progress.deleteResumeAt = undefined;
  const workItems = await tableExists(db, "claw_work_items");
  const counted = await db.query(
    `SELECT COUNT(*)::int AS n FROM claw_sessions s WHERE ${retentionPredicate(1, workItems)}`,
    [s.retentionDays],
  );
  report.eligible = (counted.rows[0] as { n: number }).n;
  if (report.eligible === 0 || progress.deleteLeft <= 0) {
    progress.deleteDone = true;
    return;
  }
  // This hold deletes up to what is left of both the pass's batch and the
  // day's; the pass's own still bounds a pass that waits for the window.
  const day = await retentionAllowance(s.batch);
  const room = Math.min(progress.deleteLeft, day.left);
  if (s.dryRun) {
    // What deleting now would take; a dry run does not wait for the window.
    report.deleted = Math.min(report.eligible, room);
    progress.deleteDone = true;
    return;
  }
  if (room <= 0) {
    afterDaySpent(day, progress, limits);
    return;
  }
  const picked = (await db.query(
    `SELECT s.session_id FROM claw_sessions s
      WHERE ${retentionPredicate(1, workItems)}
      ORDER BY COALESCE(s.archived_at, s.updated_at)
      LIMIT $2`,
    [s.retentionDays, room],
  )).rows as Array<{ session_id: string }>;

  let attempted = 0;
  for (const { session_id: sessionId } of picked) {
    // At least one per hold, so a budget shorter than one deletion still moves.
    if (attempted > 0 && Date.now() >= limits.deadline) {
      report.timedOut = true;
      return;
    }
    const lost = lease?.lost();
    if (lost) {
      logger.error(
        { deleted: report.deleted, err: lost.message },
        "session_retention.stopped (the lock connection dropped; the rest is left to the next pass)",
      );
      return;
    }
    attempted += 1;
    // Spent whatever the outcome: a session that fails every time is still
    // retried by the next daily pass, not by every hold of this one.
    progress.deleteLeft -= 1;
    const committed = await commitSessionDeletion(sessionId, {
      onlyIf: async (query: Querier) => {
        // A team member's run starts by writing the member's own row, not this
        // one, so the session lock alone does not hold it off: lock the members
        // too, so a run starting now is waited for and seen, and none starts
        // before this commits. A member created or attached from now on reads
        // this session `FOR KEY SHARE` (routes/sessions.ts, routes/a2a.ts), so
        // it waits for this commit and then finds the parent deleted.
        await query(
          `SELECT 1 FROM claw_sessions WHERE parent_session_id = $1 AND deleted_at IS NULL
            ORDER BY session_id FOR UPDATE`,
          [sessionId],
        );
        return (await query(
          `SELECT 1 FROM claw_sessions s WHERE s.session_id = $2 AND ${retentionPredicate(1, workItems)}`,
          [s.retentionDays, sessionId],
        )).rows.length > 0;
      },
    }).catch((err: unknown) => {
      // One session's transaction failing is not a reason to stop the batch;
      // it is still archived and the next pass selects it again.
      logger.warn({ sessionId, err: (err as Error)?.message }, "session_retention.delete_failed");
      return null;
    });
    if (committed === true) report.deleted += 1;
    else if (committed === false) report.skipped += 1;
  }
  // The day's batch, not the pass's, ended the selection, and there was more
  // to delete than it took.
  if (progress.deleteLeft > 0 && picked.length === room && report.eligible > room) {
    afterDaySpent(await retentionAllowance(s.batch), progress, limits);
    return;
  }
  progress.deleteDone = true;
}

/**
 * Remove the stamped rows of sessions deleted more than `purgeDays` ago.
 *
 * Every statement is per session, so each is an index lookup on `session_id`
 * rather than a scan of the events table, which is the largest one in the
 * database. That includes choosing which sessions to purge: the first version
 * asked it as one query, `s.deleted_at < ... AND (EXISTS ... OR EXISTS ...)`,
 * and Postgres turns EXISTS under OR into a hashed subplan, which reads every
 * stamped row of the events table to build the hash. On a 20 GB table that ran
 * past the statement timeout on every pass, and the purge never removed a row.
 * So the walk is over `claw_sessions` alone, in (deleted_at, session_id) order,
 * a page at a time, and each session is asked on its own whether it has rows
 * to remove.
 */
async function purgeDeletedRows(
  s: RetentionSettings,
  report: RetentionReport,
  limits: HoldLimits,
  lease?: LeaderLease,
): Promise<void> {
  const { progress } = limits;
  // A row is purged only once its own stamp is past the window too: a late
  // write stamped by a second deletion commit is not older than the session's.
  const cond = `session_id = $1 AND deleted_at IS NOT NULL
                AND deleted_at < NOW() - ($2::int * INTERVAL '1 day')`;
  const probe = `SELECT ${PURGED_TABLES.map((t) => `EXISTS (SELECT 1 FROM ${t} WHERE ${cond})`).join(" OR ")} AS has`;
  const PAGE = 500;
  let visited = 0;
  for (;;) {
    // Two statements rather than one with `$2 IS NULL OR ...`: the row
    // comparison has to stand on its own to be a range condition on
    // idx_sessions_deleted_walk, which starts each page at the cursor.
    const cursor = progress.purgeCursor;
    const page = (await (cursor
      ? db.query(
        `SELECT s.session_id, s.deleted_at::text AS deleted_at FROM claw_sessions s
          WHERE s.deleted_at IS NOT NULL AND s.deleted_at < NOW() - ($1::int * INTERVAL '1 day')
            AND (s.deleted_at, s.session_id) > ($2::timestamptz, $3::text)
          ORDER BY s.deleted_at, s.session_id
          LIMIT $4`,
        [s.purgeDays, cursor.deletedAt, cursor.sessionId, PAGE],
      )
      : db.query(
        `SELECT s.session_id, s.deleted_at::text AS deleted_at FROM claw_sessions s
          WHERE s.deleted_at IS NOT NULL AND s.deleted_at < NOW() - ($1::int * INTERVAL '1 day')
          ORDER BY s.deleted_at, s.session_id
          LIMIT $2`,
        [s.purgeDays, PAGE],
      ))).rows as Array<{ session_id: string; deleted_at: string }>;

    for (const { session_id: sessionId, deleted_at: deletedAt } of page) {
      if (progress.purgeLeft <= 0) {
        progress.purgeDone = true;
        return;
      }
      if (visited > 0 && Date.now() >= limits.deadline) {
        report.timedOut = true;
        return;
      }
      if (lease?.lost()) return;
      visited += 1;
      const has = (await db.query(probe, [sessionId, s.purgeDays])).rows[0] as { has: boolean };
      if (has.has) {
        report.purgeEligible += 1;
        for (const table of PURGED_TABLES) {
          if (s.dryRun) {
            const r = await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${cond}`, [sessionId, s.purgeDays]);
            report.purgedRows[table] += (r.rows[0] as { n: number }).n;
          } else {
            const r = await db.query(`DELETE FROM ${table} WHERE ${cond}`, [sessionId, s.purgeDays]);
            report.purgedRows[table] += r.rowCount ?? 0;
          }
        }
        report.purgedSessions += 1;
        progress.purgeLeft -= 1;
      }
      progress.purgeCursor = { deletedAt, sessionId };
    }
    if (page.length < PAGE) {
      progress.purgeDone = true;
      return;
    }
  }
}

/**
 * One hold of a retention pass: delete what has expired, then purge what was
 * deleted.
 *
 * Each half is skipped when its setting is 0. Errors in the first half do not
 * stop the second. Without `limits` the hold has no time budget and a fresh
 * batch: the whole pass in one hold.
 */
export async function runSessionRetention(
  s: RetentionSettings,
  lease?: LeaderLease,
  limits: HoldLimits = { deadline: Infinity, progress: newRetentionProgress(s) },
): Promise<RetentionReport> {
  const report: RetentionReport = {
    dryRun: s.dryRun,
    eligible: 0,
    deleted: 0,
    skipped: 0,
    purgeEligible: 0,
    purgedSessions: 0,
    purgedRows: { claw_conversation_turns: 0, claw_session_events: 0, claw_session_summaries: 0 },
    timedOut: false,
  };
  const { progress } = limits;
  if (s.retentionDays > 0 && !progress.deleteDone) {
    await deleteExpiredSessions(s, report, limits, lease)
      .catch((err) => {
        // Failed, not unfinished: the next daily pass starts it again.
        progress.deleteDone = true;
        logger.error({ err }, "session_retention.delete_pass_failed");
      });
  }
  // The purge waits for the deletions of the day's batch, which come first.
  if (s.purgeDays > 0 && !progress.purgeDone && !report.timedOut) {
    await purgeDeletedRows(s, report, limits, lease)
      .catch((err) => {
        progress.purgeDone = true;
        logger.error({ err }, "session_retention.purge_pass_failed");
      });
  }
  logger.info(
    { ...report, retentionDays: s.retentionDays, purgeDays: s.purgeDays, batch: s.batch },
    s.dryRun ? "session_retention.dry_run" : "session_retention.pass_complete",
  );
  return report;
}

/** How a daily pass spreads over holds of the lock. */
export interface RetentionRunOptions {
  /** The time budget of one hold; past it the hold stops and the pass continues in another. */
  holdBudgetMs: number;
  /** The pause between two holds of one pass. */
  continueDelayMs: number;
  /** The wait before asking again for a lock another session holds. */
  lockRetryDelayMs: number;
  /** How many times a pass asks again for a held lock. */
  lockRetries: number;
  /**
   * How soon the last 24 hours' deletions have to start leaving the window for
   * a pass whose day's batch they spent to wait for them. It covers how much
   * later than yesterday's this pass reached its deletions -- the archive step
   * before it, a lock it waited for -- and it is far short of a day, so a pass
   * after the day's own (a replica booted mid-day) does not wait into the next.
   */
  windowWaitMs: number;
}

export const DEFAULT_RETENTION_RUN: RetentionRunOptions = {
  holdBudgetMs: 5 * 60 * 1000,
  continueDelayMs: 30 * 1000,
  lockRetryDelayMs: 10 * 60 * 1000,
  lockRetries: 12,
  windowWaitMs: 2 * 60 * 60 * 1000,
};

/** A backstop on holds per pass; the batch is what normally ends it. */
const MAX_HOLDS = 200;

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * The maintenance entry point: one replica at a time, so two replicas do not
 * walk the same batch.
 *
 * A hold that reaches its time budget lets go of the lock and the pass carries
 * on in a new hold after `continueDelayMs`, from where it stopped and with what
 * is left of the day's batch. One that found the day's batch spent by
 * deletions about to leave the window lets go of it too, and the pass carries
 * on when they have left (and not sooner than `continueDelayMs`).
 *
 * A pass that finds the lock taken asks again after `lockRetryDelayMs`, up to
 * `lockRetries` times, rather than skipping until the next day. The holder is
 * usually another replica in its own pass, and then the later attempt finds the
 * day's batch already spent by it (see {@link retentionAllowance}) and deletes
 * only what that pass left of it. But it can also be a
 * replica that is gone and whose backend the server has not dropped yet -- a
 * pod killed mid-pass by a rolling update -- and the replica that replaced it
 * starts its pass a minute after boot, well inside that window. Skipping then
 * meant no retention for a day, or for as long as deploys kept landing inside
 * the window. The server releases such a lock once its TCP keepalive gives up
 * on the dead peer (see db.ts), which the default delay comfortably outlasts.
 */
export async function runSessionRetentionOnce(
  s: RetentionSettings,
  run: RetentionRunOptions = DEFAULT_RETENTION_RUN,
): Promise<void> {
  if (!(s.retentionDays > 0) && !(s.purgeDays > 0)) return;
  const progress = newRetentionProgress(s);
  let busy = 0;
  for (let holds = 0; holds < MAX_HOLDS;) {
    const outcome = await withLeaderLock(LEADER_LOCK_IDS.sessionRetention, "session_retention",
      (lease) => runSessionRetention(s, lease, {
        deadline: Date.now() + run.holdBudgetMs, progress, windowWaitMs: run.windowWaitMs,
      }));
    if (!outcome.ran) {
      if (busy >= run.lockRetries) {
        logger.warn({ attempts: busy + 1 },
          "session_retention.lock_busy_gave_up (another session held the lock on every attempt; "
          + "the next daily pass tries again)");
        return;
      }
      busy += 1;
      logger.info({ attempt: busy, retryInMs: run.lockRetryDelayMs }, "session_retention.lock_busy_retrying");
      await pause(run.lockRetryDelayMs);
      continue;
    }
    holds += 1;
    if (outcome.result.timedOut) {
      logger.info(
        { holds, deleteLeft: progress.deleteLeft, purgeLeft: progress.purgeLeft, continueInMs: run.continueDelayMs },
        "session_retention.continuing (the hold reached its time budget)",
      );
      await pause(run.continueDelayMs);
      continue;
    }
    const resumeAt = progress.deleteDone ? undefined : progress.deleteResumeAt;
    if (resumeAt === undefined) return;
    const waitMs = Math.max(run.continueDelayMs, resumeAt - Date.now());
    logger.info(
      { holds, deleteLeft: progress.deleteLeft, continueInMs: waitMs },
      "session_retention.waiting_for_window (the last 24 hours' deletions spent the day's batch and start leaving it soon)",
    );
    await pause(waitMs);
  }
  logger.warn({ holds: MAX_HOLDS }, "session_retention.stopped_at_hold_limit");
}
