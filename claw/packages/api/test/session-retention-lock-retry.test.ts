// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The retention lock left behind by a replica that died mid-pass.
 *
 * Measured on a rolling update: an API pod was killed in the middle of its
 * retention pass, the server kept that pod's idle lock-pool backend -- and the
 * session-scoped advisory lock on it -- because nothing told it the peer was
 * gone and its TCP keepalive was the OS default of two hours, and the pod that
 * replaced it tried once, a minute after boot, found the lock held and skipped
 * until the next day. Two things fix it, and each is asserted here against a
 * real Postgres:
 *
 *   L1 every API connection asks the server for short TCP keepalives, so the
 *      server drops a dead peer's backend, and its locks, within minutes;
 *   L2 a pass that finds the lock held asks again after a delay, so once the
 *      dead backend is dropped the next attempt takes the lock and runs;
 *   L3 and gives up after its retries while the holder stays, deleting nothing.
 *
 * The dead replica's backend is a real second connection holding the real lock;
 * the server dropping it is `pg_terminate_backend`, which is what the keepalive
 * timeout does to it. Skipped without DATABASE_URL; a skip is not a pass.
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
  // The keepalive settings under test are the defaults, not an override.
  delete process.env.PG_TCP_KEEPALIVES_IDLE_S;
  delete process.env.PG_TCP_KEEPALIVES_INTERVAL_S;
  delete process.env.PG_TCP_KEEPALIVES_COUNT;
}

const SETTINGS = { retentionDays: 30, purgeDays: 0, batch: 100, dryRun: false };

describe("session retention lock after a dead replica", { skip }, () => {
  let dbModule: typeof import("../src/infra/db.js");
  let retention: typeof import("../src/sessions/retention.js");
  let lockIds: typeof import("../src/infra/leader-lock.js")["LEADER_LOCK_IDS"];

  const q = (text: string, params: unknown[] = []) => dbModule.db.query(text, params);
  const isDeleted = async (id: string) =>
    ((await q("SELECT deleted_at IS NOT NULL AS gone FROM claw_sessions WHERE session_id = $1", [id]))
      .rows[0] as { gone: boolean }).gone;

  /** A session archived 40 days ago, which a pass with the lock deletes. */
  const seedExpired = (id: string) => q(
    `INSERT INTO claw_sessions (session_id, user_id, status, agent_status, config, archived_at, updated_at)
     VALUES ($1, 'u1', 'archived', 'idle', '{}'::jsonb, NOW() - INTERVAL '40 days', NOW() - INTERVAL '45 days')`,
    [id],
  );

  /** The dead replica's backend: a connection of its own holding the retention lock. */
  async function deadReplicaHoldingTheLock(): Promise<number> {
    const holder = await cluster!.connect();
    // A terminated backend makes the client emit 'error'; it is expected here.
    holder.on("error", () => {});
    const took = await holder.query("SELECT pg_try_advisory_lock($1) AS ok", [lockIds.sessionRetention]);
    assert.equal(took.rows[0].ok, true);
    return Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  }

  before(async () => {
    dbModule = await import("../src/infra/db.js");
    const named = (await dbModule.db.query("SELECT current_database() AS name")).rows[0] as { name: string };
    assert.equal(named.name, cluster!.schema);
    await dbModule.initDb();
    retention = await import("../src/sessions/retention.js");
    lockIds = (await import("../src/infra/leader-lock.js")).LEADER_LOCK_IDS;
  });
  after(async () => {
    await dbModule?.db.pool.end().catch(() => {});
    await dbModule?.db.lockPool.end().catch(() => {});
    await cluster?.end();
  });
  beforeEach(async () => {
    await q("DELETE FROM claw_sessions");
  });

  test("L1 every API connection asks the server for short TCP keepalives", async () => {
    // Over TCP: on a Unix socket the server reports 0 whatever was asked.
    assert.ok(!new URL(cluster!.url).searchParams.has("host"), "the test database is reached over TCP");
    for (const [name, pool] of [["lockPool", dbModule.db.lockPool], ["pool", dbModule.db.pool]] as const) {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `SELECT current_setting('tcp_keepalives_idle') AS idle,
                  current_setting('tcp_keepalives_interval') AS interval,
                  current_setting('tcp_keepalives_count') AS count,
                  (SELECT client_addr IS NOT NULL FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS tcp`,
        );
        const row = r.rows[0] as { idle: string; interval: string; count: string; tcp: boolean };
        assert.equal(row.tcp, true, `${name}: the backend is on a TCP connection`);
        assert.deepEqual([row.idle, row.interval, row.count], ["60", "10", "6"], `${name}: keepalive settings`);
      } finally {
        client.release();
      }
    }
  });

  test("L2 a pass that finds a dead replica's lock takes it once the server drops that backend", async () => {
    await seedExpired("expired");
    const holderPid = await deadReplicaHoldingTheLock();

    const delayMs = 1_000;
    const started = Date.now();
    const pass = retention.runSessionRetentionOnce(SETTINGS, { delayMs, retries: 5 });
    let settled = false;
    void pass.then(() => { settled = true; }, () => { settled = true; });

    // The first attempt is a non-blocking try, done in milliseconds; it found
    // the lock held and the pass is now waiting for its retry.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await isDeleted("expired"), false, "nothing is deleted while the dead replica holds the lock");
    assert.equal(settled, false, "the pass did not give up on the first busy lock");

    // What the server's keepalive timeout does to the dead peer's backend.
    const admin = await cluster!.connect();
    assert.equal((await admin.query("SELECT pg_terminate_backend($1) AS ok", [holderPid])).rows[0].ok, true);

    await pass;
    const tookMs = Date.now() - started;
    assert.equal(await isDeleted("expired"), true, "the retried attempt took the lock and ran the pass");
    assert.ok(tookMs < 2 * delayMs + 1_000, `the pass ran on its first retry, not later (took ${tookMs}ms)`);
    const left = await admin.query(
      "SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted");
    assert.equal(left.rows[0].n, 0, "the pass released the lock it took");
  });

  test("L3 a pass gives up after its retries while the lock stays held, and deletes nothing", async () => {
    await seedExpired("expired");
    const holderPid = await deadReplicaHoldingTheLock();

    await retention.runSessionRetentionOnce(SETTINGS, { delayMs: 50, retries: 2 });
    assert.equal(await isDeleted("expired"), false);

    const admin = await cluster!.connect();
    const held = await admin.query(
      "SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = $1", [holderPid]);
    assert.equal(held.rows[0].n, 1, "the holder still has the lock: the pass never took it");
    await admin.query("SELECT pg_terminate_backend($1)", [holderPid]);
  });
});
