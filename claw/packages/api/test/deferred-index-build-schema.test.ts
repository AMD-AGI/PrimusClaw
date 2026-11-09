// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With DB_SCHEMA set, the deferred index builds (infra/db.ts, buildDeferredIndexes) land in that schema, beside
 * the tables initDb created there: the builder runs on its own connection, not one the pools set the schema on.
 * Its own file because DB_SCHEMA is read once, when the module loads. Skipped without DATABASE_URL (and a skip is
 * not a pass).
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const skip = postgresSkipReason();
const SCHEMA = "claw_alt";

let cluster: PgCluster | undefined;
let dbm: typeof import("../src/infra/db.js") | undefined;

before(async () => {
  if (skip) return;
  cluster = await startPgCluster();
  const admin = await cluster.connect();
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  process.env.DATABASE_URL = cluster.url;
  process.env.DB_SCHEMA = SCHEMA;
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
  dbm = await import("../src/infra/db.js");
  await dbm.initDb();
});
after(async () => {
  await dbm?.db.pool.end().catch(() => {});
  await dbm?.db.lockPool.end().catch(() => {});
  await cluster?.end();
});

test("the deferred indexes are built in DB_SCHEMA, next to their tables", { skip }, async () => {
  assert.equal(await dbm!.buildDeferredIndexes(), "built");
  const rows = (await dbm!.db.query(
    `SELECT n.nspname AS schema, c.relname AS name, i.indisvalid AS valid
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = ANY($1) ORDER BY 2`,
    [["idx_events_memory_saved", "idx_events_session_recent", "idx_sessions_deleted_walk", "uq_session_events_app_event"]],
  )).rows;
  assert.deepEqual(rows.map((r: any) => [r.schema, r.name, r.valid]), [
    [SCHEMA, "idx_events_memory_saved", true],
    [SCHEMA, "idx_events_session_recent", true],
    [SCHEMA, "idx_sessions_deleted_walk", true],
    [SCHEMA, "uq_session_events_app_event", true],
  ]);
});
