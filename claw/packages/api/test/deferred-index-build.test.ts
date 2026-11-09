// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The concurrent index builds over large tables run after the API listens, one replica at a time, and nothing
 * drops an index another backend is still building. Over a real Postgres, skipped without DATABASE_URL (and a
 * skip is not a pass).
 *
 * A slow build is a real one: a transaction holding a snapshot open makes every `CREATE INDEX CONCURRENTLY` in the
 * database wait for it, which is what a long build over a large table looks like from the outside.
 *
 *   D1 initDb returns while a build would be stuck, and the build itself runs (and stays stuck) only in
 *      buildDeferredIndexes; the pool serves meanwhile
 *   D2 a second replica finds the build taken and leaves it alone: same index, not dropped, finished by the first
 *   D3 a build started outside the API (a release job, an older replica) is not dropped as a leftover, and the
 *      replica does not wait behind it either
 *   D4 index.ts starts the deferred builds after listen and does not wait for them; initDb holds none of them
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before, describe } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const skip = postgresSkipReason();
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const INDEX = "idx_events_memory_saved";
const BUILD_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_memory_saved
         ON claw_session_events ((data->>'memory_id')) WHERE event = 'memory_saved'`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Settles to "pending" if `p` has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | "pending"> =>
  Promise.race([p, sleep(ms).then(() => "pending" as const)]);

describe("deferred concurrent index builds", { skip }, () => {
  let cluster: PgCluster;
  let dbm: typeof import("../src/infra/db.js");
  const clients: pg.Client[] = [];

  const raw = async () => {
    const c = new pg.Client({ connectionString: cluster.url });
    c.on("error", () => {});
    await c.connect();
    clients.push(c);
    return c;
  };
  const q = async (text: string, params: unknown[] = []) => (await dbm.db.query(text, params)).rows as Array<Record<string, any>>;
  const indexState = async () => (await q(
    "SELECT c.oid::bigint AS oid, i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1",
    [INDEX],
  ))[0] as { oid: string; indisvalid: boolean } | undefined;
  /** A transaction holding a snapshot: every concurrent build in the database waits until it ends. */
  const holdSnapshot = async () => {
    const c = await raw();
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await c.query("SELECT count(*) FROM claw_sessions");
    return { release: () => c.query("COMMIT") };
  };
  /** Until a build of the index is under way, i.e. its INVALID entry exists and a backend reports building it. */
  const buildUnderWay = async () => {
    for (let i = 0; i < 300; i++) {
      const rows = await q(
        `SELECT 1 FROM pg_stat_progress_create_index p JOIN pg_class c ON c.oid = p.index_relid WHERE c.relname = $1`,
        [INDEX],
      );
      if (rows.length) return;
      await sleep(100);
    }
    throw new Error(`no build of ${INDEX} started`);
  };

  before(async () => {
    cluster = await startPgCluster();
    process.env.DATABASE_URL = cluster.url;
    delete process.env.DB_SCHEMA;
    process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    dbm = await import("../src/infra/db.js");
    await dbm.initDb();
    assert.equal(await dbm.buildDeferredIndexes(), "built");
    await q(
      `INSERT INTO claw_session_events (event_id, session_id, event, data)
       SELECT 'e' || g, 's' || (g % 50), CASE WHEN g % 10 = 0 THEN 'memory_saved' ELSE 'text_delta' END,
              jsonb_build_object('memory_id', g) FROM generate_series(1, 2000) g`,
    );
  });
  after(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await dbm?.db.pool.end().catch(() => {});
    await dbm?.db.lockPool.end().catch(() => {});
    await cluster?.end();
  });

  test("D1 initDb does not wait for a slow build; buildDeferredIndexes does, and the pool serves meanwhile", async () => {
    await q(`DROP INDEX ${INDEX}`);
    const hold = await holdSnapshot();
    try {
      const init = await within(dbm.initDb().then(() => "done" as const), 60_000);
      assert.equal(init, "done", "initDb waited for a concurrent build");
      assert.equal(await indexState(), undefined, "initDb built (or started) the deferred index");

      const build = dbm.buildDeferredIndexes();
      await buildUnderWay();
      assert.equal(await within(build, 1_000), "pending", "the build is the one that waits");
      assert.deepEqual(await q("SELECT 1 AS ok"), [{ ok: 1 }], "the pool serves while it does");
      await hold.release();
      assert.equal(await build, "built");
    } finally {
      await hold.release().catch(() => {});
    }
    assert.equal((await indexState())?.indisvalid, true);
  });

  test("D2 a second replica leaves a build in progress to the replica running it", async () => {
    await q(`DROP INDEX ${INDEX}`);
    const hold = await holdSnapshot();
    let first: Promise<string> | undefined;
    try {
      first = dbm.buildDeferredIndexes();
      await buildUnderWay();
      const building = await indexState();
      assert.equal(building?.indisvalid, false);

      assert.equal(await within(dbm.buildDeferredIndexes(), 10_000), "held_elsewhere", "the second replica neither waited nor built");
      assert.equal((await indexState())?.oid, building!.oid, "the index being built is still the same one");
      await hold.release();
      assert.equal(await first, "built");
      assert.deepEqual(await indexState(), { oid: building!.oid, indisvalid: true }, "the first replica finished its own build");
    } finally {
      await hold.release().catch(() => {});
      await first?.catch(() => {});
    }
  });

  test("D3 a build started outside the API is not dropped as a leftover, and is not waited for", async () => {
    await q(`DROP INDEX ${INDEX}`);
    const hold = await holdSnapshot();
    const outside = await raw();
    let job: Promise<unknown> | undefined;
    try {
      job = outside.query(BUILD_SQL);
      await buildUnderWay();
      const building = await indexState();
      assert.equal(building?.indisvalid, false);

      assert.equal(await within(dbm.buildDeferredIndexes(), 10_000), "built", "the replica waited behind the outside build");
      assert.equal((await indexState())?.oid, building!.oid, "the outside build was dropped");
      await hold.release();
      await job;
      assert.deepEqual(await indexState(), { oid: building!.oid, indisvalid: true }, "the outside build finished");
    } finally {
      await hold.release().catch(() => {});
      await job?.catch(() => {});
    }
  });

  test("D3b a leftover with no build behind it is still dropped and rebuilt", async () => {
    await q(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${INDEX}'::regclass`);
    const before = await indexState();
    assert.equal(before?.indisvalid, false);
    assert.equal(await dbm.indexBuildInProgress(dbm.db, INDEX), false);
    assert.equal(await dbm.buildDeferredIndexes(), "built");
    const now = await indexState();
    assert.equal(now?.indisvalid, true);
    assert.notEqual(now?.oid, before?.oid, "rebuilt, not left INVALID");
  });

  test("D4 index.ts starts the deferred builds after listen without waiting; initDb holds none of them", () => {
    const main = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
    const listenAt = main.indexOf("await app.listen(");
    const startAt = main.indexOf("buildDeferredIndexes()");
    assert.ok(listenAt > 0 && startAt > listenAt, "buildDeferredIndexes is started after app.listen");
    assert.doesNotMatch(main.slice(startAt - 40, startAt), /await\s*$/, "and is not awaited");

    const SRC = readFileSync(join(SRC_DIR, "infra", "db.ts"), "utf8");
    const init = SRC.slice(SRC.indexOf("export async function initDb"), SRC.indexOf("export const DEFERRED_INDEX_LOCK_ID"));
    const deferred = SRC.slice(SRC.indexOf("async function buildDeferredIndexesOn"));
    for (const name of [
      "idx_sessions_deleted_walk", "idx_events_session_recent", "idx_events_memory_saved",
      "idx_tasks_platform_facts_pending_v3", "idx_tasks_terminal_completed_task_v2",
    ]) {
      assert.ok(!init.includes(`"${name}"`), `initDb still builds ${name}`);
      assert.ok(deferred.includes(`"${name}"`), `${name} is not built after listen`);
    }
    assert.ok(!init.includes("buildAppEventIndex(") && deferred.includes("buildAppEventIndex("), "the app-event index is deferred");
  });
});
