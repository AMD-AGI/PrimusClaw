// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An API start cannot stall the tables it migrates, and does not re-walk
 * `claw_session_events` for a rewrite that is already done.
 *
 * Coverage:
 *   K1-K4 which statements the guard recognises (pure)
 *   L1 an ADD COLUMN that already happened is not sent: with a reader holding
 *      the table it returns at once, and a third session's read is not queued
 *   L2 a CREATE INDEX IF NOT EXISTS whose index exists is not sent either
 *   L3 a real ADD COLUMN behind a reader waits in bounded slices: other reads
 *      get through between them, and it lands once the reader ends
 *   L4 a lock that never frees is an error after the attempts, with the
 *      session's own lock_timeout put back
 *   L5 inside an explicit transaction nothing is retried
 *   L6 an index of the same name in another schema on the search path does
 *      not count as the one asked for
 *   E1 the uniqueness step swaps the constraint first; the legacy pass then
 *      rewrites, including ids two sessions share, leaves a row whose new id
 *      its session already has, and records itself
 *   E2 a start that finds the record does not walk the table again
 *
 * The Postgres cases skip without DATABASE_URL; CI sets it, and the last test
 * fails a CI run that skipped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";

import { classifyMigrationStatement, hasTopLevelSeparator, lockBoundedMigrationClient } from "../src/infra/migration-guard.js";
import { isCi, postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

test("K1 single-action ADD COLUMN IF NOT EXISTS is recognised, with types that hold commas", () => {
  assert.deepEqual(
    classifyMigrationStatement("ALTER TABLE claw_sessions ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT 'a,b'"),
    { kind: "add_column", table: "claw_sessions", column: "user_id" },
  );
  assert.deepEqual(
    classifyMigrationStatement("\n  -- note\n  alter table T add if not exists Price NUMERIC(10,2) NOT NULL DEFAULT 0;"),
    { kind: "add_column", table: "t", column: "price" },
  );
});

test("K2 a second action or statement is not reduced to an existence test", () => {
  assert.equal(
    classifyMigrationStatement("ALTER TABLE t ADD COLUMN IF NOT EXISTS a INT, ADD COLUMN IF NOT EXISTS b INT").kind,
    "locking_ddl",
  );
  assert.equal(
    classifyMigrationStatement("ALTER TABLE t ADD COLUMN IF NOT EXISTS a INT; UPDATE t SET a = 1").kind,
    "locking_ddl",
  );
  assert.equal(hasTopLevelSeparator(" x INT DEFAULT 'a;b'"), false);
});

test("K3 CREATE INDEX IF NOT EXISTS is recognised; CONCURRENTLY is left alone", () => {
  assert.deepEqual(
    classifyMigrationStatement("CREATE UNIQUE INDEX IF NOT EXISTS uq_x ON t(a, b) WHERE c IN ('p','q')"),
    { kind: "create_index", index: "uq_x", table: "t" },
  );
  assert.deepEqual(
    classifyMigrationStatement("CREATE INDEX IF NOT EXISTS idx_tsv ON claw_memory_entries USING GIN(content_tsv)"),
    { kind: "create_index", index: "idx_tsv", table: "claw_memory_entries" },
  );
  assert.equal(classifyMigrationStatement("CREATE INDEX IF NOT EXISTS i ON s.t(a)").kind, "locking_ddl");
  assert.equal(classifyMigrationStatement("CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t(a)").kind, "other");
});

test("K4 locking DDL is bounded; plain statements pass through", () => {
  assert.equal(classifyMigrationStatement("ALTER TABLE t ALTER COLUMN a SET DEFAULT 1").kind, "locking_ddl");
  assert.equal(classifyMigrationStatement("DO $$ BEGIN ALTER TABLE t DROP COLUMN a; END $$").kind, "locking_ddl");
  assert.equal(classifyMigrationStatement("CREATE TABLE IF NOT EXISTS t (a INT)").kind, "other");
  assert.equal(classifyMigrationStatement("SELECT pg_advisory_lock(1)").kind, "other");
});

const skip = postgresSkipReason();
const POLICY = { lockTimeoutMs: 150, attempts: 4, backoffMs: 50, maxBackoffMs: 100 };

test("startup DDL against a real Postgres", { skip: skip || false }, async (t) => {
  const cluster: PgCluster = await startPgCluster();
  const reader = await cluster.connect();
  const other = await cluster.connect();
  const migrator = await cluster.connect();
  t.after(() => cluster.end());

  await migrator.query("CREATE TABLE t (id INT PRIMARY KEY, a TEXT)");
  await migrator.query("CREATE INDEX t_a ON t(a)");
  await migrator.query("INSERT INTO t VALUES (1, 'x')");
  const guarded = lockBoundedMigrationClient(migrator, POLICY);

  /** A read from a third session, timed: what a serving replica sees meanwhile. */
  const timedRead = async () => {
    const s = Date.now();
    await other.query("SELECT a FROM t WHERE id = 1");
    return Date.now() - s;
  };
  const holdReader = async () => {
    await reader.query("BEGIN");
    await reader.query("SELECT count(*) FROM t");
  };

  await t.test("L1 a satisfied ADD COLUMN takes no lock", async () => {
    await holdReader();
    try {
      const s = Date.now();
      const r = await guarded.query("ALTER TABLE t ADD COLUMN IF NOT EXISTS a TEXT");
      assert.ok(Date.now() - s < 1000, "returned without waiting for the reader");
      assert.equal(r.rowCount, null);
      assert.ok((await timedRead()) < 1000, "a third session's read was not queued");
      const locks = await other.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE relation = 't'::regclass AND mode = 'AccessExclusiveLock'",
      );
      assert.equal(locks.rows[0].n, 0);
    } finally {
      await reader.query("COMMIT");
    }
  });

  await t.test("L2 a satisfied CREATE INDEX takes no lock", async () => {
    await other.query("BEGIN");
    await other.query("INSERT INTO t VALUES (2, 'y')"); // ROW EXCLUSIVE: conflicts with SHARE
    try {
      const s = Date.now();
      await guarded.query("CREATE INDEX IF NOT EXISTS t_a ON t(a)");
      assert.ok(Date.now() - s < 1000);
    } finally {
      await other.query("ROLLBACK");
    }
  });

  await t.test("L3 a real ADD COLUMN waits in bounded slices and then lands", async () => {
    const pid = (await migrator.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await holdReader();
    let migration: Promise<unknown> | undefined;
    // Enough attempts to outlast the reader below, so what is measured is the
    // wait between slices and not a budget running out.
    const patient = lockBoundedMigrationClient(migrator, { ...POLICY, attempts: 100 });
    try {
      migration = patient.query("ALTER TABLE t ADD COLUMN IF NOT EXISTS b INT");
      migration.catch(() => {});
      // Until the migration is actually queued on the table lock.
      for (let i = 0; ; i++) {
        const w = await other.query(
          "SELECT 1 FROM pg_locks WHERE pid = $1 AND relation = 't'::regclass AND NOT granted",
          [pid],
        );
        if (w.rowCount) break;
        assert.ok(i < 400, "the migration never queued on the table lock");
        await new Promise((r) => setTimeout(r, 5));
      }
      // While it retries, a read from elsewhere is delayed by at most one
      // slice, not for as long as the reader stays open.
      const until = Date.now() + 700;
      let worst = 0;
      while (Date.now() < until) {
        const waited = await Promise.race([
          timedRead(),
          new Promise<number>((r) => setTimeout(() => r(Infinity), 1500)),
        ]);
        worst = Math.max(worst, waited);
        if (waited === Infinity) break;
      }
      assert.ok(worst < 1000, `a read waited ${worst} ms behind the migration`);
    } finally {
      await reader.query("COMMIT");
    }
    await migration;
    const col = await other.query("SELECT 1 FROM information_schema.columns WHERE table_name = 't' AND column_name = 'b'");
    assert.equal(col.rowCount, 1);
  });

  await t.test("L4 a lock that never frees fails after the attempts and restores lock_timeout", async () => {
    await migrator.query("SET lock_timeout = '7s'");
    await holdReader();
    try {
      await assert.rejects(
        guarded.query("ALTER TABLE t ADD COLUMN IF NOT EXISTS c INT"),
        (err: { code?: string }) => err.code === "55P03",
      );
    } finally {
      await reader.query("COMMIT");
    }
    assert.equal((await migrator.query("SHOW lock_timeout")).rows[0].lock_timeout, "7s");
    await migrator.query("RESET lock_timeout");
  });

  await t.test("L6 a same-named index in another schema is not the one asked for", async () => {
    await migrator.query("CREATE SCHEMA other");
    await migrator.query("CREATE TABLE other.x (a INT)");
    await migrator.query("CREATE INDEX t_dup ON other.x(a)");
    await migrator.query("SET search_path = other, public");
    try {
      await guarded.query("CREATE INDEX IF NOT EXISTS t_dup ON t(a)");
      const r = await other.query(
        "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 't' AND indexname = 't_dup'",
      );
      assert.equal(r.rowCount, 1);
    } finally {
      await migrator.query("RESET search_path");
    }
  });

  await t.test("L5 inside an explicit transaction nothing is retried", async () => {
    await holdReader();
    let attempts = 0;
    const counting = lockBoundedMigrationClient(
      new Proxy(migrator, {
        get(target, prop) {
          if (prop === "query") {
            return (text: string, params?: unknown[]) => {
              if (/^ALTER/.test(text)) attempts++;
              return target.query(text, params);
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as pg.Client,
      POLICY,
    );
    try {
      await counting.query("BEGIN");
      await counting.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(counting.query("ALTER TABLE t ADD COLUMN IF NOT EXISTS d INT"));
      await counting.query("ROLLBACK");
      assert.equal(attempts, 1);
    } finally {
      await reader.query("COMMIT");
    }
  });
});

test("the legacy event-id pass runs once per database", { skip: skip || false }, async (t) => {
  const cluster = await startPgCluster();
  process.env.DATABASE_URL = cluster.url;
  delete process.env.DB_SCHEMA;
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  const dbm = await import("../src/infra/db.js");
  const legacy = await import("../src/events/legacy-event-ids.js");
  const obs = await cluster.connect();
  t.after(async () => {
    await dbm.db.pool.end().catch(() => {});
    await dbm.db.lockPool.end().catch(() => {});
    await cluster.end();
  });
  await dbm.initDb();

  // A table as an old deployment left it: UNIQUE(event_id) only, and ids in
  // each of the legacy shapes.
  await obs.query("ALTER TABLE claw_session_events DROP CONSTRAINT claw_session_events_event_id_session_id_key");
  await obs.query("ALTER TABLE claw_session_events ADD CONSTRAINT claw_session_events_event_id_key UNIQUE (event_id)");
  await obs.query(
    `INSERT INTO claw_session_events (event_id, session_id, event) VALUES
       ('PRIMUS_CLAW_EVENTS-11', 's1', 'e'), ('claw-evt-12', 's1', 'e'), ('13', 's2', 'e'),
       ('claw-14', 's2', 'e'), ('no-digits', 's2', 'e'),
       ('PRIMUS_CLAW_EVENTS-7', 's1', 'e'), ('claw-evt-7', 's2', 'e'),
       ('claw-9', 's4', 'e'), ('PRIMUS_CLAW_EVENTS-9', 's4', 'e'),
       ('claw-evt-8', 's5', 'e'), ('8', 's5', 'e')`,
  );
  for (let i = 0; i < 7; i++) {
    await obs.query("INSERT INTO claw_session_events (event_id, session_id, event) VALUES ($1, 's3', 'e')", [`claw-${100 + i}`]);
  }

  await t.test("E1 swaps the constraint, then rewrites and records itself", async () => {
    // Before uniqueness is in place the pass does not start.
    assert.equal(await legacy.normalizeLegacyEventIdsOnce({ batch: 3, pauseMs: 0 }), "interrupted");
    await legacy.ensureEventIdUniqueness();
    const old = await obs.query("SELECT 1 FROM pg_constraint WHERE conname = 'claw_session_events_event_id_key'");
    assert.equal(old.rowCount, 0);
    const idx = await obs.query(
      "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('claw_session_events_event_session_idx')",
    );
    assert.equal(idx.rows[0]?.indisvalid, true);

    assert.equal(await legacy.normalizeLegacyEventIdsOnce({ batch: 3, pauseMs: 0 }), "done");
    const rows = (await obs.query("SELECT event_id, session_id FROM claw_session_events ORDER BY id")).rows
      .map((r) => `${r.session_id}:${r.event_id}`);
    assert.deepEqual(rows.slice(0, 11), [
      "s1:claw-11", "s1:claw-12", "s2:claw-13", "s2:claw-14", "s2:no-digits",
      // Two sessions' legacy ids that normalise to the same id: both rewritten.
      "s1:claw-7", "s2:claw-7",
      // The session already holds claw-9: the legacy spelling stays.
      "s4:claw-9", "s4:PRIMUS_CLAW_EVENTS-9",
      // Two legacy spellings of one id in one session: the first wins.
      "s5:claw-8", "s5:8",
    ]);
    assert.equal(await legacy.legacyEventIdsDone(), true);
  });

  await t.test("E3 a migrated database takes no lock for uniqueness", async () => {
    await obs.query("BEGIN");
    await obs.query("SELECT 1 FROM claw_session_events LIMIT 1");
    try {
      const s = Date.now();
      await legacy.ensureEventIdUniqueness();
      assert.ok(Date.now() - s < 1000);
    } finally {
      await obs.query("COMMIT");
    }
  });

  await t.test("E2 a later start does not walk the table", async () => {
    // A legacy id written after the marker: a pass that ran would rewrite it.
    await obs.query("INSERT INTO claw_session_events (event_id, session_id, event) VALUES ('claw-evt-900', 's9', 'e')");
    assert.equal(await legacy.normalizeLegacyEventIdsOnce({ batch: 3, pauseMs: 0 }), "already_done");
    const r = await obs.query("SELECT event_id FROM claw_session_events WHERE session_id = 's9'");
    assert.equal(r.rows[0].event_id, "claw-evt-900");
  });
});

test("CI runs the Postgres cases rather than skipping them", { skip: isCi() ? false : "not CI" }, () => {
  assert.equal(skip, false, "DATABASE_URL must be set in CI");
});
