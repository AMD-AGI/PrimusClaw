// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What one retention pass costs: no statement that reads the events table
 * whole, and no hold of the lock longer than its time budget.
 *
 * Both measured on a live deployment:
 *   - the purge asked which deleted sessions still had rows with one query whose
 *     `EXISTS ... OR EXISTS ...` Postgres plans as a hashed subplan over every
 *     stamped row of `claw_session_events` (20 GB there); it ran past the
 *     statement timeout on every pass and the purge never removed a row;
 *   - a 5000-session deletion batch held the retention lock for 13.5 minutes,
 *     past the leader lock's ten-minute stall alarm.
 *
 * Coverage:
 *   B1 every purge statement that reads the events table is an index lookup by
 *      session, on a table large enough for the planner to choose a scan if it
 *      may, and each page of the walk over deleted sessions is a range read of
 *      its own index (EXPLAIN of each statement the pass actually sent);
 *   B2 a hold stops at its time budget, and the next hold carries on with what
 *      is left of the batch; the batch is the limit across holds;
 *   B3 the purge walk resumes after the last session it visited, to the
 *      microsecond, so a session is never visited twice;
 *   B4 the entry point spreads a pass over holds and finishes it.
 *
 * Each has a timeout: a walk that revisits a page never ends, and a hang is
 * not a failure anyone reads.
 *
 * Skipped without DATABASE_URL; a skip is not a pass.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const skip = postgresSkipReason();
const cluster: PgCluster | undefined = skip ? undefined : await startPgCluster();
if (cluster) {
  process.env.DATABASE_URL = cluster.url;
  delete process.env.DB_SCHEMA;
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
}

describe("session retention: bounded statements and holds", { skip }, () => {
  let dbModule: typeof import("../src/infra/db.js");
  let retention: typeof import("../src/sessions/retention.js");

  const q = (text: string, params: unknown[] = []) => dbModule.db.query(text, params);
  const deletedCount = async () =>
    ((await q("SELECT COUNT(*)::int AS n FROM claw_sessions WHERE deleted_at IS NOT NULL")).rows[0] as { n: number }).n;

  const seedArchived = (id: string, archivedDays: number) => q(
    `INSERT INTO claw_sessions (session_id, user_id, status, agent_status, config, archived_at, updated_at)
     VALUES ($1, 'u1', 'archived', 'idle', '{}'::jsonb, NOW() - ($2::int * INTERVAL '1 day'), NOW() - INTERVAL '90 days')`,
    [id, archivedDays],
  );
  /** A session deleted at `deletedAt` (SQL expression), with `events` stamped rows of its own. */
  async function seedDeleted(id: string, deletedAt: string, events: number): Promise<void> {
    await q(
      `INSERT INTO claw_sessions (session_id, user_id, status, agent_status, config, updated_at, deleted_at)
       VALUES ($1, 'u1', 'archived', 'idle', '{}'::jsonb, NOW() - INTERVAL '90 days', ${deletedAt})`,
      [id],
    );
    if (events > 0) {
      await q(
        `INSERT INTO claw_session_events (event_id, session_id, event, deleted_at)
         SELECT $1 || '-' || g, $1, 'text', ${deletedAt} FROM generate_series(1, $2::int) g`,
        [id, events],
      );
    }
  }
  const eventsOf = async (id: string) =>
    ((await q("SELECT COUNT(*)::int AS n FROM claw_session_events WHERE session_id = $1", [id])).rows[0] as { n: number }).n;

  before(async () => {
    dbModule = await import("../src/infra/db.js");
    const named = (await dbModule.db.query("SELECT current_database() AS name")).rows[0] as { name: string };
    assert.equal(named.name, cluster!.schema);
    await dbModule.initDb();
    await dbModule.buildDeferredIndexes(); // the walk's index, which index.ts builds after listen
    retention = await import("../src/sessions/retention.js");
  });
  after(async () => {
    await dbModule?.db.pool.end().catch(() => {});
    await dbModule?.db.lockPool.end().catch(() => {});
    await cluster?.end();
  });
  beforeEach(async () => {
    for (const t of ["claw_conversation_turns", "claw_session_events", "claw_session_summaries", "claw_sessions"]) {
      await q(`DELETE FROM ${t}`);
    }
  });

  test("B1 no purge statement reads the events table except by session", { timeout: 120_000 }, async () => {
    // The live shape, scaled down: most event rows belong to sessions that are
    // not purgeable, many sessions were deleted and purged long ago, a few still
    // have stamped rows past the window.
    await q(
      `INSERT INTO claw_sessions (session_id, user_id, status, agent_status, config, updated_at)
       SELECT 'live-' || g, 'u1', 'active', 'idle', '{}'::jsonb, NOW() FROM generate_series(1, 200) g`,
    );
    await q(
      `INSERT INTO claw_session_events (event_id, session_id, event, deleted_at)
       SELECT 'e-' || g, 'live-' || (g % 200 + 1), 'text',
              CASE WHEN g % 4 = 0 THEN NOW() - INTERVAL '40 days' END
         FROM generate_series(1, 200000) g`,
    );
    await q(
      `INSERT INTO claw_sessions (session_id, user_id, status, agent_status, config, updated_at, deleted_at)
       SELECT 'purged-' || g, 'u1', 'archived', 'idle', '{}'::jsonb, NOW() - INTERVAL '90 days',
              NOW() - INTERVAL '60 days'
         FROM generate_series(1, 20000) g`,
    );
    await seedDeleted("gone-a", "NOW() - INTERVAL '40 days'", 3);
    await seedDeleted("gone-b", "NOW() - INTERVAL '41 days'", 2);
    await q("ANALYZE claw_sessions");
    await q("ANALYZE claw_session_events");

    const sent: Array<{ text: string; params: unknown[] }> = [];
    const original = dbModule.db.query;
    dbModule.db.query = ((text: string, params?: unknown[]) => {
      sent.push({ text, params: params ?? [] });
      return original(text, params);
    }) as typeof dbModule.db.query;
    let report;
    try {
      report = await retention.runSessionRetention({ retentionDays: 0, purgeDays: 30, batch: 100, dryRun: false });
    } finally {
      dbModule.db.query = original;
    }
    assert.equal(report.purgedSessions, 2);
    assert.equal(report.purgedRows.claw_session_events, 5);
    assert.deepEqual([await eventsOf("gone-a"), await eventsOf("gone-b")], [0, 0]);
    assert.equal(await eventsOf("live-1"), 1000, "rows of a live session are not touched, stamped or not");

    const readsEvents = sent.filter((s) => s.text.includes("claw_session_events"));
    assert.ok(readsEvents.length > 0, "the purge sent statements that read the events table");
    const client = await cluster!.connect();
    try {
      for (const { text, params } of readsEvents) {
        const plan = (await client.query(`EXPLAIN ${text}`, params)).rows
          .map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
        assert.doesNotMatch(plan, /Seq Scan on claw_session_events/, `a scan of the events table:\n${text}\n${plan}`);
        assert.doesNotMatch(plan, /hashed SubPlan/, `a hashed subplan:\n${text}\n${plan}`);
      }
      // And the walk itself is an index range read from its cursor, not a scan
      // and sort of every deleted session on each page.
      const pages = sent.filter((s) => s.text.includes("ORDER BY s.deleted_at, s.session_id"));
      assert.ok(pages.some((p) => p.text.includes("> ($2::timestamptz, $3::text)")),
        "the walk went past its first page, so a page from a cursor was asked");
      for (const { text, params } of pages) {
        const plan = (await client.query(`EXPLAIN ${text}`, params)).rows
          .map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
        assert.match(plan, /Index (Only )?Scan using idx_sessions_deleted_walk/, `the walk's index:\n${text}\n${plan}`);
        assert.doesNotMatch(plan, /\bSort\b/, `a sort of the deleted sessions:\n${text}\n${plan}`);
        // From the cursor, not from the start with the rows before it filtered out.
        if (params.length > 2) {
          assert.match(plan, /Index Cond: .*ROW\(deleted_at, session_id\) > ROW\(/,
            `a page that does not start at its cursor:\n${text}\n${plan}`);
        }
      }
    } finally {
      await client.end();
    }
  });

  test("B2 a hold stops at its budget and the next carries on, within one batch", { timeout: 30_000 }, async () => {
    for (let i = 1; i <= 5; i += 1) await seedArchived(`old-${i}`, 40 + i);
    const s = { retentionDays: 30, purgeDays: 0, batch: 3, dryRun: false };
    const progress = retention.newRetentionProgress(s);
    const holds = [];
    // A budget already spent: each hold does exactly the one item it always does.
    for (let i = 0; i < 5; i += 1) {
      const r = await retention.runSessionRetention(s, undefined, { deadline: 0, progress });
      holds.push([r.deleted, r.timedOut]);
      if (!r.timedOut) break;
    }
    assert.deepEqual(holds, [[1, true], [1, true], [1, false]], "one per hold, and the batch of 3 ends the pass");
    assert.equal(await deletedCount(), 3, "the batch is the limit across holds");
    const left = await q("SELECT session_id FROM claw_sessions WHERE deleted_at IS NULL ORDER BY session_id");
    assert.deepEqual(left.rows.map((r) => r.session_id), ["old-1", "old-2"], "oldest first, across holds");
  });

  test("B3 the purge walk resumes after the last session it visited, to the microsecond", { timeout: 30_000 }, async () => {
    // Same millisecond, different microseconds: a cursor kept as a JS Date
    // rounds both to one value and hands the walk the first one again.
    await seedDeleted("gone-1", "'2020-01-01 00:00:00.123456+00'::timestamptz", 2);
    await seedDeleted("gone-2", "'2020-01-01 00:00:00.123457+00'::timestamptz", 2);
    const s = { retentionDays: 0, purgeDays: 30, batch: 10, dryRun: false };
    const progress = retention.newRetentionProgress(s);
    const first = await retention.runSessionRetention(s, undefined, { deadline: 0, progress });
    assert.deepEqual([first.purgedSessions, first.timedOut], [1, true]);
    const second = await retention.runSessionRetention(s, undefined, { deadline: 0, progress });
    assert.deepEqual([second.purgedSessions, second.timedOut], [1, false],
      "the second hold purges the second session and the walk ends");
    assert.deepEqual([await eventsOf("gone-1"), await eventsOf("gone-2")], [0, 0]);
  });

  test("B4 the entry point spreads a pass over holds and finishes it", { timeout: 30_000 }, async () => {
    for (let i = 1; i <= 3; i += 1) await seedArchived(`old-${i}`, 40 + i);
    await seedDeleted("gone", "NOW() - INTERVAL '40 days'", 2);
    await retention.runSessionRetentionOnce(
      { retentionDays: 30, purgeDays: 30, batch: 10, dryRun: false },
      { ...retention.DEFAULT_RETENTION_RUN, holdBudgetMs: 0, continueDelayMs: 10 },
    );
    assert.equal(await deletedCount(), 4, "the three expired sessions and the one already deleted");
    assert.equal(await eventsOf("gone"), 0, "the purge ran after the deletions, in a later hold");
    // Advisory locks are cluster-wide: count this file's database only, since
    // other suites run beside this one on the same server.
    const held = await q("SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted"
      + " AND database = (SELECT oid FROM pg_database WHERE datname = current_database())");
    assert.equal((held.rows[0] as { n: number }).n, 0, "no hold is left behind");
  });
});
