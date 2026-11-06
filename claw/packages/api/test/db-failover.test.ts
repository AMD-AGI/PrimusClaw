// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A database failover in the middle of a turn, against a real Postgres. Skipped without DATABASE_URL, and a skip is
 * not a pass.
 *
 * A switchover demotes the old primary in place: for a moment every connection, the pool's open ones and the new
 * ones the Service still routes there, is on a server that refuses writes (25006), and then new connections reach the
 * new primary while the old ones stay on the replica. That is what `failover()` makes of this file's database: each
 * idle connection of the pool is set read-only for good, as a connection to the demoted server is, and connections
 * opened during the window are read-only too, until `promote()`.
 *
 *   F1  a statement Postgres refused as read-only is sent again once, on a new connection, and is stored once
 *   F2  a failed transaction does not hand its read-only connection back, and no transaction after a failover runs on
 *       a connection from before it
 *   F3  the Router's `say` mid-turn, while the database fails over: the message is stored once and the Router told so
 *   F4  a transaction that did not ask to be retried is not, and the next one runs on the new primary
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import type pg from "pg";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("database failover", { skip }, () => {
  let w: World;
  let admin: pg.Client;
  let alice: { userId: string; routerSid: string };

  before(async () => {
    // Short enough for a test, long enough that `promote()` lands before the retry.
    w = await startWorld({ PG_FAILOVER_RETRY_DELAY_MS: "300" });
    admin = await w.h.connect();
    await w.q("CREATE TABLE IF NOT EXISTS failover_probe (id serial PRIMARY KEY, note text NOT NULL)");
  });
  after(async () => {
    await admin?.query(`ALTER DATABASE "${w.h.cluster.schema}" RESET default_transaction_read_only`).catch(() => {});
    await w?.stop();
  });
  beforeEach(async () => {
    await promote();
    // Each test starts from a pool with nothing left on the read-only server of the one before, fix or no fix.
    const held: pg.PoolClient[] = [];
    while (pool().idleCount > 0) held.push(await pool().connect());
    for (const client of held) client.release(true);
    await w.q("TRUNCATE failover_probe, claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox, claw_notification_subscriptions CASCADE");
    w.events.length = 0;
    alice = await w.user("alice");
  });

  const pool = () => w.h.app.db.db.pool;

  /**
   * The old primary is demoted: connections opened from now on are read-only, and so, for good, is every connection
   * the pool holds idle (at least `atLeast` of them, opened first if the pool has fewer). Returns their backend pids.
   */
  async function failover(atLeast = 3): Promise<number[]> {
    const held: pg.PoolClient[] = [];
    while (held.length < Math.max(atLeast, pool().idleCount)) held.push(await pool().connect());
    const pids: number[] = [];
    for (const client of held) {
      await client.query("SET SESSION default_transaction_read_only = on");
      pids.push(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    }
    await admin.query(`ALTER DATABASE "${w.h.cluster.schema}" SET default_transaction_read_only = on`);
    for (const client of held) client.release();
    return pids;
  }

  /** The new primary takes over: connections opened from now on can write. The pool's old ones are still read-only. */
  async function promote(): Promise<void> {
    await admin.query(`ALTER DATABASE "${w.h.cluster.schema}" RESET default_transaction_read_only`);
  }

  const promoteSoon = () => setTimeout(() => { void promote(); }, 50);
  const probes = async () => Number((await w.q("SELECT COUNT(*)::int AS n FROM failover_probe"))[0].n);

  test("F1 a statement refused as read-only is sent again once, on a new connection, and stored once", async () => {
    await failover();
    promoteSoon();
    await w.h.app.db.db.query("INSERT INTO failover_probe (note) VALUES ('after the switchover')");
    assert.equal(await probes(), 1);
    // Every later write lands, whichever of the pool's connections it is first handed.
    for (let i = 0; i < 6; i += 1) await w.h.app.db.db.query("INSERT INTO failover_probe (note) VALUES ($1)", [`write ${i}`]);
    assert.equal(await probes(), 7);
  });

  test("F2 no transaction after a failover runs on a connection from before it", async () => {
    const old = await failover(4);
    promoteSoon();
    // The first transaction to meet the read-only server: retried, because it asked to be, on a new connection.
    const first = await w.h.app.db.inTransaction(async (q) => {
      await q("INSERT INTO failover_probe (note) VALUES ('first')");
      return Number((await q("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    }, { retryOnFailover: true });
    assert.ok(!old.includes(first), "the retry ran on a connection opened before the failover");
    // And from then on, every transaction: the pool's old connections are dropped as they come up, not used.
    for (let i = 0; i < 8; i += 1) {
      const pid = await w.h.app.db.inTransaction(async (q) => {
        await q("INSERT INTO failover_probe (note) VALUES ($1)", [`tx ${i}`]);
        return Number((await q("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      });
      assert.ok(!old.includes(pid), `transaction ${i} ran on a read-only connection from before the failover`);
    }
    assert.equal(await probes(), 9);
  });

  test("F3 the Router's say mid-turn, while the database fails over: stored once, and the Router is told it was", async () => {
    const turn = await w.routerTurn(alice);
    await failover();
    promoteSoon();
    const out = await w.mod.tools.say(turn as never, { text: "The build is green." }, w.sayDeps);
    assert.equal(out.ok, true);
    const says = await w.q("SELECT say_id, text, fallback FROM claw_assistant_says");
    assert.deepEqual(says.map((s) => [s.say_id, s.text, s.fallback]), [[out.say_id, "The build is green.", false]]);
    assert.equal(w.events.length, 1, "the web client is told once");
    assert.equal(w.events[0].say_id, out.say_id);
  });

  test("F4 a transaction that did not ask to be retried fails, and the next one runs on the new primary", async () => {
    const old = await failover(2);
    await assert.rejects(
      w.h.app.db.inTransaction(async (q) => { await q("INSERT INTO failover_probe (note) VALUES ('refused')"); }),
      (err: { code?: string }) => err.code === "25006",
    );
    await promote();
    const pid = await w.h.app.db.inTransaction(async (q) => {
      await q("INSERT INTO failover_probe (note) VALUES ('next')");
      return Number((await q("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    });
    assert.ok(!old.includes(pid));
    assert.deepEqual((await w.q("SELECT note FROM failover_probe")).map((r) => r.note), ["next"]);
  });
});
