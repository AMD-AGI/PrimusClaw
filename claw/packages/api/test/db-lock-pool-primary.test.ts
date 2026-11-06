// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Both pools hand out only connections whose server is the primary, against a real Postgres. Skipped without
 * DATABASE_URL, and a skip is not a pass.
 *
 * A file of its own, so the process has seen no failover: in a switchover the first connection the Service routes to
 * the demoted server can come before any statement has failed, and a lock taken there fences nothing. A server in
 * recovery is what `pg_is_in_recovery()` says; this file's database is a primary, so the answer is put in its mouth.
 *
 *   P1  a new connection of the advisory-lock pool, or of the main pool, that reached a server in recovery is not
 *       handed out, before any failover was seen; one that reached the primary is asked once, not at every checkout
 */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import type pg from "pg";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("lock pool on the primary", { skip }, () => {
  let w: World;

  before(async () => { w = await startWorld({ PG_FAILOVER_RETRY_DELAY_MS: "50" }); });
  after(async () => { await w?.stop(); });

  for (const which of ["lockPool", "pool"] as const) {
    test(`P1 a new ${which} connection on a server in recovery is not handed out, with no failover seen`, async () => {
      const p = w.h.app.db.db[which];
      // Nothing idle from before: each connection this test is handed is new to the pool.
      const idle: pg.PoolClient[] = [];
      while (p.idleCount > 0) idle.push(await p.connect());
      for (const client of idle) client.release(true);
      const pidOf = async (client: pg.PoolClient) => Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const { default: pgModule } = await import("pg");
      const proto = pgModule.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
      const real = proto.query;
      let asked = 0;
      const standbys: unknown[] = [];
      proto.query = function (this: unknown, ...args: unknown[]) {
        if (args[0] === "SELECT pg_is_in_recovery() AS r") {
          asked += 1;
          if (asked <= 2) {
            standbys.push(this);
            return Promise.resolve({ rows: [{ r: true }] });
          }
        }
        return real.apply(this, args);
      };
      let first: pg.PoolClient;
      try {
        first = await p.connect();
      } finally {
        proto.query = real;
      }
      let pid: number;
      try {
        assert.equal(asked, 3, "asked until a connection reached the primary");
        assert.ok(!standbys.includes(first), "a connection on a server in recovery was handed out");
        pid = await pidOf(first);
      } finally {
        first.release();
      }
      // The same connection again: it stays on the server it reached, so it is not asked again.
      proto.query = function (this: unknown, ...args: unknown[]) {
        if (args[0] === "SELECT pg_is_in_recovery() AS r") asked += 1;
        return real.apply(this, args);
      };
      let again: pg.PoolClient;
      try {
        again = await p.connect();
      } finally {
        proto.query = real;
      }
      try {
        assert.equal(await pidOf(again), pid);
        assert.equal(asked, 3, "a connection on the primary is asked once");
      } finally {
        again.release();
      }
    });
  }
});
