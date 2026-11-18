// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The legacy event-id migration, done once per database instead of on every
 * API start.
 *
 * Event ids were once written as `PRIMUS_CLAW_EVENTS-<seq>`, `claw-evt-<seq>` or
 * a bare number, under UNIQUE(event_id); today's writer only ever writes
 * `claw-<seq>`, under UNIQUE(event_id, session_id). The conversion used to run
 * at the top of `startEventConsumer` on every start: one UPDATE whose WHERE is
 * two regular expressions, so a sequential scan of the whole of
 * `claw_session_events` (22M rows in production) on every replica of every
 * rollout, under the pool's 30 s statement timeout; then an `ALTER TABLE ...
 * DROP CONSTRAINT IF EXISTS`, which asks for ACCESS EXCLUSIVE on the table
 * every event is written to before it learns there is nothing to drop.
 *
 * Now the two halves are separate:
 *  - {@link ensureEventIdUniqueness} makes sure a composite unique index exists
 *    and the old UNIQUE(event_id) is gone. It reads the catalog first, so on a
 *    migrated database it is two catalog lookups and takes no lock. It runs
 *    before the consumer starts: the consumer's `ON CONFLICT (event_id,
 *    session_id)` needs that index as its arbiter.
 *  - {@link normalizeLegacyEventIdsOnce} rewrites the ids, once per database: a
 *    row in `claw_schema_markers` records that it is done, and a start that
 *    finds it does nothing more than that one lookup. The pass walks the table
 *    by primary-key range in short batches, under the leader lock so only one
 *    replica walks, and off the consumer's path so events are persisted while
 *    it runs.
 *
 * The rewrite runs after the old global constraint is gone, so two sessions'
 * legacy ids that normalise to the same `claw-<seq>` no longer collide. A
 * legacy row whose normalised id its own session already holds is left as it
 * is -- the same stream message stored twice under two spellings -- so one
 * such pair cannot fail the pass on every start.
 */

import { pino } from "pino";
import { db, ensureConcurrentIndexOrWarn, MIGRATION_LOCK_POLICY } from "../infra/db.js";
import { LEADER_LOCK_IDS, withLeaderLock, type LeaderLease } from "../infra/leader-lock.js";
import { lockBoundedMigrationClient } from "../infra/migration-guard.js";

const logger = pino({ name: "event-consumer" });

export const LEGACY_EVENT_IDS_MARKER = "session_events_legacy_event_ids_v1";

/** Rows of `claw_session_events.id` per UPDATE: small enough to finish well inside the pool's statement timeout. */
export const LEGACY_EVENT_ID_BATCH = 50_000;

/**
 * The original rewrite, restricted to one id range, and skipping a row whose
 * normalised id its session already holds or that an earlier row of the same
 * batch is taking: the composite unique index would refuse either.
 */
export const LEGACY_EVENT_ID_BATCH_SQL = `WITH cand AS (
       SELECT id, session_id, 'claw-' || regexp_replace(event_id, '^.*?(\\d+)$', '\\1') AS target
         FROM claw_session_events
        WHERE id >= $1 AND id < $2
          AND event_id !~ '^claw-\\d'
          AND event_id ~ '\\d+$'
          AND deleted_at IS NULL
     ), pick AS (
       SELECT DISTINCT ON (c.session_id, c.target) c.id, c.target
         FROM cand c
        WHERE NOT EXISTS (
          SELECT 1 FROM claw_session_events o WHERE o.session_id = c.session_id AND o.event_id = c.target)
        ORDER BY c.session_id, c.target, c.id
     )
     UPDATE claw_session_events e SET event_id = p.target FROM pick p WHERE e.id = p.id`;

export type LegacyEventIdOutcome = "already_done" | "done" | "not_leader" | "interrupted";

export async function legacyEventIdsDone(): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM claw_schema_markers WHERE name = $1", [LEGACY_EVENT_IDS_MARKER]);
  return (r.rowCount ?? 0) > 0;
}

/** A valid, non-partial UNIQUE index on exactly (event_id, session_id), whatever its name. */
async function compositeUniqueIndexExists(): Promise<boolean> {
  const r = await db.query(
    `SELECT 1
       FROM pg_index i
      WHERE i.indrelid = to_regclass('claw_session_events')
        AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
        AND i.indnkeyatts = 2
        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
            = ARRAY['event_id', 'session_id']`,
  );
  return (r.rowCount ?? 0) > 0;
}

async function oldEventIdConstraintExists(): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('claw_session_events') AND conname = 'claw_session_events_event_id_key'`,
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * UNIQUE(event_id) becomes UNIQUE(event_id, session_id), so sessions sharing
 * stream-sequence space cannot collide. The composite first, then the old
 * constraint goes; each step only if the catalog says it is still to do, and
 * the drop only once the composite is there. Never throws.
 */
export async function ensureEventIdUniqueness(): Promise<void> {
  try {
    const needIndex = !(await compositeUniqueIndexExists());
    const needDrop = await oldEventIdConstraintExists();
    if (!needIndex && !needDrop) return;
    // Its own connection: the concurrent build lifts statement_timeout on the
    // client it is given, and this one is destroyed afterwards, not pooled.
    const raw = await db.pool.connect();
    const client = lockBoundedMigrationClient(raw, MIGRATION_LOCK_POLICY);
    let broken: Error | undefined;
    try {
      if (needIndex) {
        await ensureConcurrentIndexOrWarn(
          client,
          "claw_session_events_event_session_idx",
          "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS claw_session_events_event_session_idx ON claw_session_events (event_id, session_id)",
        );
        if (!(await compositeUniqueIndexExists())) {
          logger.warn("event-consumer.composite_event_index_missing");
          return;
        }
      }
      if (needDrop) {
        await client.query("ALTER TABLE claw_session_events DROP CONSTRAINT IF EXISTS claw_session_events_event_id_key");
        logger.info("event-consumer.dropped_old_unique_constraint");
      }
    } catch (err) {
      broken = err as Error;
      throw err;
    } finally {
      raw.release(broken ?? true);
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "event-consumer.event_id_uniqueness_failed");
  }
}

async function walk(lease: LeaderLease, opts: { batch: number; pauseMs: number }): Promise<LegacyEventIdOutcome> {
  // Checked again under the lock: the replica that held it before may have finished.
  if (await legacyEventIdsDone()) return "already_done";
  // The skip-if-taken test in the batch reads through the composite index, and
  // two sessions' rows can only both be rewritten once the old one is gone.
  if (!(await compositeUniqueIndexExists()) || (await oldEventIdConstraintExists())) {
    logger.warn("event-consumer.legacy_event_ids_waiting_for_uniqueness");
    return "interrupted";
  }

  // Rows past today's max are written by the current writer, which never
  // writes a legacy id, so the walk has a fixed end.
  const bounds = await db.query("SELECT min(id) AS lo, max(id) AS hi FROM claw_session_events");
  const lo = bounds.rows[0]?.lo == null ? null : Number(bounds.rows[0].lo);
  const hi = bounds.rows[0]?.hi == null ? null : Number(bounds.rows[0].hi);
  let rewritten = 0;
  if (lo !== null && hi !== null) {
    for (let from = lo; from <= hi; from += opts.batch) {
      if (lease.lost()) return "interrupted";
      const r = await db.query(LEGACY_EVENT_ID_BATCH_SQL, [from, from + opts.batch]);
      rewritten += r.rowCount ?? 0;
      if (opts.pauseMs > 0) await new Promise((res) => setTimeout(res, opts.pauseMs));
    }
  }
  if (rewritten > 0) logger.info({ count: rewritten }, "event-consumer.migrated_legacy_event_ids");

  if (lease.lost()) return "interrupted";
  await db.query(
    "INSERT INTO claw_schema_markers (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
    [LEGACY_EVENT_IDS_MARKER],
  );
  return "done";
}

/**
 * Rewrite legacy ids if no earlier start has finished it. Never throws: a pass
 * that fails leaves no marker and the next start tries again.
 */
export async function normalizeLegacyEventIdsOnce(
  opts: { batch?: number; pauseMs?: number } = {},
): Promise<LegacyEventIdOutcome | "failed"> {
  const settings = { batch: opts.batch ?? LEGACY_EVENT_ID_BATCH, pauseMs: opts.pauseMs ?? 20 };
  try {
    if (await legacyEventIdsDone()) return "already_done";
    const started = Date.now();
    const r = await withLeaderLock(
      LEADER_LOCK_IDS.legacyEventIds, "legacy_event_ids", (lease) => walk(lease, settings),
      { maxHoldMs: 60 * 60 * 1000 },
    );
    const outcome = r.ran ? r.result : "not_leader";
    logger.info({ outcome, ms: Date.now() - started }, "event-consumer.legacy_event_ids_pass");
    return outcome;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "event-consumer.migration_failed");
    return "failed";
  }
}
