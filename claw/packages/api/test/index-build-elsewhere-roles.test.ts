// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What another role's index build means to the API, which runs as an ordinary (non-superuser) role and so reads
 * NULL for the index and table of every build in `pg_stat_progress_create_index` it may not inspect. Over a real
 * Postgres, skipped without DATABASE_URL (and a skip is not a pass). Its own file because the API's role is fixed
 * when the db module loads.
 *
 *   R1 a required index (the chat-turn claim index assertSchema checks) left INVALID is dropped and rebuilt, and
 *      the replica starts, while another role builds an unrelated index it cannot see into
 *   R2 a deferred (performance-only) index left INVALID is left alone while such a build runs, and rebuilt by the
 *      next start once it has ended
 *   R3 a build this role can read, of an index on another table, does not keep a deferred leftover from being
 *      rebuilt
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const skip = postgresSkipReason();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("index builds by other roles", { skip }, () => {
  const suffix = randomBytes(4).toString("hex");
  const APP = `claw_app_${suffix}`;
  const OTHER = `claw_other_${suffix}`;
  const PASSWORD = `pw_${suffix}`;
  let cluster: PgCluster;
  let admin: pg.Client;
  let dbm: typeof import("../src/infra/db.js");
  const clients: pg.Client[] = [];

  const urlFor = (role: string) => {
    const u = new URL(cluster.url);
    u.username = role;
    u.password = PASSWORD;
    return u.toString();
  };
  const connectAs = async (role: string) => {
    const c = new pg.Client({ connectionString: urlFor(role) });
    c.on("error", () => {});
    await c.connect();
    clients.push(c);
    return c;
  };
  const state = async (name: string) => (await admin.query(
    "SELECT c.oid::bigint AS oid, i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1",
    [name],
  )).rows[0] as { oid: string; valid: boolean } | undefined;
  const invalidate = (name: string) => admin.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${name}'::regclass`);

  /**
   * A `CREATE INDEX CONCURRENTLY` by `role` on its table `table`, held in "waiting for writers" by an open insert.
   * A plain-column index, as a DBA's usually is, so the API's own concurrent builds do not wait for it.
   */
  async function heldBuild(role: string, table: string, index: string) {
    const writer = await connectAs(role);
    const builder = await connectAs(role);
    await writer.query("BEGIN");
    await writer.query(`INSERT INTO ${table} VALUES (1)`);
    const build = builder.query(`CREATE INDEX CONCURRENTLY ${index} ON ${table} (x)`);
    for (let i = 0; ; i++) {
      const rows = (await admin.query("SELECT 1 FROM pg_stat_progress_create_index WHERE relid = $1::regclass", [table])).rows;
      if (rows.length) break;
      if (i > 300) throw new Error(`the build on ${table} never started`);
      await sleep(100);
    }
    return {
      async end() {
        await writer.query("COMMIT");
        await build;
        await admin.query(`DROP INDEX ${table.split(".")[0]}.${index}`);
      },
    };
  }

  before(async () => {
    cluster = await startPgCluster();
    admin = await cluster.connect();
    for (const role of [APP, OTHER]) await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${PASSWORD}'`);
    await admin.query(`ALTER DATABASE "${cluster.schema}" OWNER TO ${APP}`);
    await admin.query(`GRANT ALL ON SCHEMA public TO ${APP}`);
    await admin.query(`CREATE SCHEMA other_s AUTHORIZATION ${OTHER}`);
    await admin.query(`CREATE TABLE other_s.t (x int)`);
    await admin.query(`ALTER TABLE other_s.t OWNER TO ${OTHER}`);
    await admin.query(`CREATE TABLE public.app_t (x int)`);
    await admin.query(`ALTER TABLE public.app_t OWNER TO ${APP}`);

    process.env.DATABASE_URL = urlFor(APP);
    delete process.env.DB_SCHEMA;
    process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    dbm = await import("../src/infra/db.js");
    const [me] = (await dbm.db.query("SELECT current_user AS name, usesuper FROM pg_user WHERE usename = current_user")).rows as any[];
    assert.deepEqual([me.name, me.usesuper], [APP, false], "the API runs as an ordinary role");
    await dbm.initDb();
    assert.equal(await dbm.buildDeferredIndexes(), "built");
  });
  after(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await dbm?.db.pool.end().catch(() => {});
    await dbm?.db.lockPool.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.end();
  });

  test("R1 a required index left INVALID is rebuilt and the replica starts while another role builds elsewhere", async () => {
    const before = await state(dbm.CHAT_TURN_CLAIM_INDEX);
    assert.equal(before?.valid, true);
    await invalidate(dbm.CHAT_TURN_CLAIM_INDEX);
    const other = await heldBuild(OTHER, "other_s.t", "t_x");
    try {
      const seen = (await dbm.db.query("SELECT relid, index_relid FROM pg_stat_progress_create_index")).rows;
      assert.deepEqual(seen, [{ relid: null, index_relid: null }], "the API's role sees the other build only as NULLs");
      await dbm.initDb();
      const now = await state(dbm.CHAT_TURN_CLAIM_INDEX);
      assert.equal(now?.valid, true, "the required index was rebuilt");
      assert.notEqual(now?.oid, before?.oid);
    } finally {
      await other.end();
    }
  });

  test("R2 a deferred leftover waits out a build it cannot see into, and is rebuilt by the next start", async () => {
    await invalidate("idx_events_memory_saved");
    const leftover = await state("idx_events_memory_saved");
    const other = await heldBuild(OTHER, "other_s.t", "t_x");
    try {
      assert.equal(await dbm.buildDeferredIndexes(), "built");
      assert.deepEqual(await state("idx_events_memory_saved"), leftover, "left alone: it may be that build");
    } finally {
      await other.end();
    }
    assert.equal(await dbm.buildDeferredIndexes(), "built");
    const now = await state("idx_events_memory_saved");
    assert.equal(now?.valid, true);
    assert.notEqual(now?.oid, leftover?.oid);
  });

  test("R3 a readable build of another table's index does not keep a deferred leftover", async () => {
    await invalidate("idx_events_memory_saved");
    const leftover = await state("idx_events_memory_saved");
    const mine = await heldBuild(APP, "public.app_t", "app_t_x");
    try {
      const seen = (await dbm.db.query("SELECT relid::regclass::text AS relid FROM pg_stat_progress_create_index")).rows;
      assert.deepEqual(seen, [{ relid: "app_t" }], "this build is readable");
      assert.equal(await dbm.indexBuildInProgress(dbm.db, "idx_events_memory_saved"), false);
      assert.equal(await dbm.buildDeferredIndexes(), "built");
      const now = await state("idx_events_memory_saved");
      assert.equal(now?.valid, true);
      assert.notEqual(now?.oid, leftover?.oid);
    } finally {
      await mine.end();
    }
  });
});
