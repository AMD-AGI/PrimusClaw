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
  /** Deleted sessions past the purge window that still have rows, before the batch limit. */
  purgeEligible: number;
  /** Deleted sessions whose rows this pass removed (in a dry run, would have). */
  purgedSessions: number;
  /** Rows removed per table (in a dry run, the rows the purged sessions hold). */
  purgedRows: Record<(typeof PURGED_TABLES)[number], number>;
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
  lease?: LeaderLease,
): Promise<void> {
  const workItems = await tableExists(db, "claw_work_items");
  const counted = await db.query(
    `SELECT COUNT(*)::int AS n FROM claw_sessions s WHERE ${retentionPredicate(1, workItems)}`,
    [s.retentionDays],
  );
  report.eligible = (counted.rows[0] as { n: number }).n;
  if (report.eligible === 0) return;
  if (s.dryRun) {
    report.deleted = Math.min(report.eligible, s.batch);
    return;
  }
  const picked = (await db.query(
    `SELECT s.session_id FROM claw_sessions s
      WHERE ${retentionPredicate(1, workItems)}
      ORDER BY COALESCE(s.archived_at, s.updated_at)
      LIMIT $2`,
    [s.retentionDays, s.batch],
  )).rows as Array<{ session_id: string }>;

  for (const { session_id: sessionId } of picked) {
    const lost = lease?.lost();
    if (lost) {
      logger.error(
        { deleted: report.deleted, err: lost.message },
        "session_retention.stopped (the lock connection dropped; the rest is left to the next pass)",
      );
      break;
    }
    const committed = await commitSessionDeletion(sessionId, {
      onlyIf: async (query: Querier) => {
        // A team member's run starts by writing the member's own row, not this
        // one, so the session lock alone does not hold it off: lock the members
        // too, so a run starting now is waited for and seen, and none starts
        // before this commits.
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
}

/**
 * Remove the stamped rows of sessions deleted more than `purgeDays` ago.
 *
 * Per session, so each statement is an index lookup on `session_id` rather than
 * a scan of the events table, which is the largest one in the database.
 */
async function purgeDeletedRows(
  s: RetentionSettings,
  report: RetentionReport,
  lease?: LeaderLease,
): Promise<void> {
  // The same row condition the DELETE below uses, so a session is selected only
  // while it has a row this pass can remove and never spends the batch on nothing.
  const hasRows = PURGED_TABLES.map((t) =>
    `EXISTS (SELECT 1 FROM ${t} x WHERE x.session_id = s.session_id AND x.deleted_at IS NOT NULL
             AND x.deleted_at < NOW() - ($1::int * INTERVAL '1 day'))`,
  ).join(" OR ");
  const where = `s.deleted_at < NOW() - ($1::int * INTERVAL '1 day') AND (${hasRows})`;
  const counted = await db.query(
    `SELECT COUNT(*)::int AS n FROM claw_sessions s WHERE ${where}`,
    [s.purgeDays],
  );
  report.purgeEligible = (counted.rows[0] as { n: number }).n;
  if (report.purgeEligible === 0) return;
  const picked = (await db.query(
    `SELECT s.session_id FROM claw_sessions s WHERE ${where} ORDER BY s.deleted_at LIMIT $2`,
    [s.purgeDays, s.batch],
  )).rows as Array<{ session_id: string }>;

  for (const { session_id: sessionId } of picked) {
    if (lease?.lost()) break;
    for (const table of PURGED_TABLES) {
      // A row is purged only once its own stamp is past the window too: a late
      // write stamped by a second deletion commit is not older than the session's.
      const cond = `session_id = $1 AND deleted_at IS NOT NULL
                    AND deleted_at < NOW() - ($2::int * INTERVAL '1 day')`;
      if (s.dryRun) {
        const r = await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${cond}`, [sessionId, s.purgeDays]);
        report.purgedRows[table] += (r.rows[0] as { n: number }).n;
      } else {
        const r = await db.query(`DELETE FROM ${table} WHERE ${cond}`, [sessionId, s.purgeDays]);
        report.purgedRows[table] += r.rowCount ?? 0;
      }
    }
    report.purgedSessions += 1;
  }
}

/**
 * One retention pass: delete what has expired, then purge what was deleted.
 *
 * Each half is skipped when its setting is 0. Errors in the first half do not
 * stop the second.
 */
export async function runSessionRetention(
  s: RetentionSettings,
  lease?: LeaderLease,
): Promise<RetentionReport> {
  const report: RetentionReport = {
    dryRun: s.dryRun,
    eligible: 0,
    deleted: 0,
    skipped: 0,
    purgeEligible: 0,
    purgedSessions: 0,
    purgedRows: { claw_conversation_turns: 0, claw_session_events: 0, claw_session_summaries: 0 },
  };
  if (s.retentionDays > 0) {
    await deleteExpiredSessions(s, report, lease)
      .catch((err) => logger.error({ err }, "session_retention.delete_pass_failed"));
  }
  if (s.purgeDays > 0) {
    await purgeDeletedRows(s, report, lease)
      .catch((err) => logger.error({ err }, "session_retention.purge_pass_failed"));
  }
  logger.info(
    { ...report, retentionDays: s.retentionDays, purgeDays: s.purgeDays, batch: s.batch },
    s.dryRun ? "session_retention.dry_run" : "session_retention.pass_complete",
  );
  return report;
}

/**
 * The maintenance entry point: one replica at a time, so two replicas do not
 * walk the same batch.
 */
export async function runSessionRetentionOnce(s: RetentionSettings): Promise<void> {
  if (!(s.retentionDays > 0) && !(s.purgeDays > 0)) return;
  await withLeaderLock(LEADER_LOCK_IDS.sessionRetention, "session_retention",
    (lease) => runSessionRetention(s, lease));
}
