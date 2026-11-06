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
 *
 * The other half of a switchover is the old primary terminating its backends (57P01) under statements in flight. A
 * statement cut off that way may have taken effect, so only one that only reads is sent again; and a transaction
 * cut off before its COMMIT was sent rolled back, so one that asked to be retried is run once more.
 *
 *   F5  a read cut off by the switchover is sent again once and answers; a write cut off the same way is not sent again
 *   F6  a transaction that asked to be retried and was cut off before its COMMIT runs once more and lands once; one that
 *       did not ask fails
 *   F7  a transaction cut off during its COMMIT is not run again, though it asked: the COMMIT may have taken effect
 *   F8  the Router's say whose COMMIT took effect and whose answer the failover lost: the Router is told it was said,
 *       not to say it again, the web client is told, and the message is stored once
 *   F9  the same, while the database cannot be asked: the Router is told the outcome is unknown and not to say it again,
 *       the turn's final words are not delivered on top of the stored message, and the message is announced once the
 *       database answers
 *   F10 a caller that checks a connection out of the advisory-lock pool itself gets one made since the failover, and
 *       one whose server says it is not in recovery
 *   F11 the say cap's notice whose COMMIT took effect and whose answer the failover lost: the web client is told, once,
 *       and the Router hears the user was told
 *   F12 the same while the database cannot be asked: the notice is announced once the database answers, and the next
 *       refusal does not send another
 *   F13 the cap's notice whose COMMIT failed and did not take effect: it is stored and announced shortly after, once
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

  /**
   * The old primary going away under a statement in flight: the backend running the statement tagged `tag` is
   * terminated (57P01), as a switchover terminates every backend of the server it demotes. Resolves once it has been.
   */
  async function terminateWhenRunning(tag: string): Promise<void> {
    for (let i = 0; i < 500; i += 1) {
      const hit = await admin.query(
        `SELECT pg_terminate_backend(pid) AS done FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE $1`,
        [`%${tag}%`],
      );
      if (hit.rows.some((r) => r.done)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`no statement tagged ${tag} ever ran`);
  }
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

  test("F5 a read cut off by the switchover is sent again once and answers; a write cut off the same way is not", async () => {
    const { isIdempotentStatement } = w.h.app.db;
    for (const read of ["SELECT 1", "  select updated_at, deleted_at FROM t WHERE id = $1", "WITH x AS (SELECT 1) SELECT * FROM x"]) {
      assert.equal(isIdempotentStatement(read), true, read);
    }
    for (const notOnly of [
      "UPDATE t SET x = 1", "SELECT * FROM t FOR UPDATE", "SELECT nextval('s')", "SELECT pg_advisory_lock(1)",
      "SELECT 1; DELETE FROM t", "WITH x AS (DELETE FROM t RETURNING 1) SELECT * FROM x", "SELECT * INTO t2 FROM t",
    ]) {
      assert.equal(isIdempotentStatement(notOnly), false, notOnly);
    }

    const [read] = await Promise.all([
      w.h.app.db.db.query("SELECT pg_sleep(0.4) AS slept, 'f5-read' AS tag, 42 AS answer"),
      terminateWhenRunning("f5-read"),
    ]);
    assert.equal(read.rows[0].answer, 42);

    await Promise.all([
      assert.rejects(
        w.h.app.db.db.query(
          "WITH w AS (INSERT INTO failover_probe (note) VALUES ('f5-write') RETURNING id) SELECT pg_sleep(0.4), (SELECT COUNT(*) FROM w) AS n",
        ),
        (err: { code?: string; message?: string }) => err.code === "57P01" || /^Connection terminated/.test(err.message ?? ""),
      ),
      terminateWhenRunning("f5-write"),
    ]);
    assert.equal(await probes(), 0, "a statement that may have taken effect is not run again");
  });

  test("F6 a transaction that asked to be retried and was cut off before its COMMIT runs once more and lands once", async () => {
    let runs = 0;
    const cutOff = (tag: string) => async (q: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => {
      runs += 1;
      await q("INSERT INTO failover_probe (note) VALUES ($1)", [tag]);
      if (runs === 1) await Promise.all([q(`SELECT pg_sleep(0.4), '${tag}-sleep'`), terminateWhenRunning(`${tag}-sleep`)]);
    };
    await w.h.app.db.inTransaction(cutOff("f6-retried"), { retryOnFailover: true });
    assert.equal(runs, 2);
    assert.deepEqual((await w.q("SELECT note FROM failover_probe")).map((r) => r.note), ["f6-retried"], "stored once");

    runs = 0;
    await assert.rejects(w.h.app.db.inTransaction(cutOff("f6-not-asked")), (err: { code?: string; message?: string }) =>
      err.code === "57P01" || /^Connection terminated/.test(err.message ?? ""));
    assert.equal(runs, 1);
    assert.equal(await probes(), 1);
  });

  test("F7 a transaction cut off during its COMMIT is not run again, though it asked", async () => {
    // A deferred trigger that takes a while: the transaction's COMMIT is the statement in flight when the backend goes.
    await w.q("CREATE TABLE IF NOT EXISTS failover_slow_commit (id int)");
    await w.q(`CREATE OR REPLACE FUNCTION failover_slow_commit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN PERFORM pg_sleep(0.4); RETURN NULL; END $$`);
    await w.q("DROP TRIGGER IF EXISTS failover_slow_commit ON failover_slow_commit");
    await w.q(`CREATE CONSTRAINT TRIGGER failover_slow_commit AFTER INSERT ON failover_slow_commit
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION failover_slow_commit()`);
    let runs = 0;
    await Promise.all([
      assert.rejects(
        w.h.app.db.inTransaction(async (q) => {
          runs += 1;
          await q("INSERT INTO failover_slow_commit VALUES (1)");
        }, { retryOnFailover: true }),
        (err: { code?: string; message?: string }) => err.code === "57P01" || /^Connection terminated/.test(err.message ?? ""),
      ),
      terminateWhenRunning("COMMIT"),
    ]);
    assert.equal(runs, 1, "a COMMIT that may have taken effect is not followed by a second run");
  });

  /**
   * A switchover between a COMMIT taking effect and its answer: the first COMMIT runs, and then the connection is
   * reported gone. `alsoFail` statements fail the same way while `run` lasts.
   */
  async function commitAnswerLost<T>(run: () => Promise<T>, alsoFail: (text: string) => boolean = () => false): Promise<{ out: T; cut: number }> {
    const { default: pgModule } = await import("pg");
    const proto = pgModule.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const real = proto.query;
    const gone = () => Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    let cut = 0;
    proto.query = function (this: unknown, ...args: unknown[]) {
      if (args[0] === "COMMIT" && cut === 0) {
        cut += 1;
        return (real.apply(this, args) as Promise<unknown>).then(() => { throw gone(); });
      }
      if (cut > 0 && typeof args[0] === "string" && alsoFail(args[0])) {
        const callback = args.find((a) => typeof a === "function") as ((err: Error) => void) | undefined;
        if (callback) { setImmediate(() => callback(gone())); return undefined; }
        return Promise.reject(gone());
      }
      return real.apply(this, args);
    };
    try {
      return { out: await run(), cut };
    } finally {
      proto.query = real;
    }
  }

  test("F8 the Router's say whose COMMIT took effect and whose answer the failover lost: told it was said, stored once", async () => {
    const turn = await w.routerTurn(alice);
    const { out, cut } = await commitAnswerLost(() => w.mod.tools.say(turn as never, { text: "The deploy is done." }, w.sayDeps));
    assert.equal(cut, 1, "the COMMIT's answer was lost");
    assert.equal(out.ok, true, "not a fault: the Router would say it again");
    const says = await w.q("SELECT say_id, text FROM claw_assistant_says");
    assert.deepEqual(says.map((s) => [s.say_id, s.text]), [[out.say_id, "The deploy is done."]]);
    assert.deepEqual(w.events.map((e) => e.say_id), [out.say_id], "the web client is told, once");
  });

  test("F9 the same while the database cannot be asked: the outcome is unknown, and the message is not sent twice", async () => {
    const turn = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = 'Is the deploy done?' WHERE task_id = $1", [turn.task_id]);
    const { out, cut } = await commitAnswerLost(
      () => w.mod.tools.say(turn as never, { text: "The deploy is done." }, w.sayDeps).then(
        () => "said", (err: { code?: string }) => err.code ?? String(err)),
      (text) => /FROM claw_assistant_says WHERE say_id/.test(text),
    );
    assert.equal(cut, 1);
    assert.equal(out, "say_outcome_unknown", "a refusal that says not to say it again, not a fault that asks to");
    // The Router ends the turn with the words, as it is told to: they are not delivered on top of the stored message.
    const ended = await w.mod.routerTurnEnd.deliverUnsaidAnswer(
      { sessionId: alice.routerSid, runIds: [turn.task_id], failed: false, interrupted: false, finalText: "The deploy is done." },
      w.sayDeps,
    );
    assert.equal(ended, "skipped");
    const [stored] = await w.q("SELECT say_id, text FROM claw_assistant_says");
    assert.equal(stored.text, "The deploy is done.");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_says"))[0].n, 1);
    // Looked up again in the background once the database answers, and announced: the web client is told, once.
    const deadline = Date.now() + 5_000;
    while (!w.events.some((e) => e.say_id === stored.say_id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(w.events.map((e) => e.say_id), [stored.say_id]);
  });

  test("F10 a direct lock-pool checkout after a failover gets a connection made since, on a server not in recovery", async () => {
    const lockPool = w.h.app.db.db.lockPool;
    const pidOf = async (client: pg.PoolClient) => Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    // Connections the lock pool holds idle from before the switchover.
    const held = [await lockPool.connect(), await lockPool.connect(), await lockPool.connect()];
    const old = await Promise.all(held.map(pidOf));
    for (const client of held) client.release();
    w.h.app.db.noteFailover(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }));

    // While the Service still routes new connections to the demoted server: it is in recovery, twice.
    const { default: pgModule } = await import("pg");
    const proto = pgModule.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const real = proto.query;
    let asked = 0;
    proto.query = function (this: unknown, ...args: unknown[]) {
      if (args[0] === "SELECT pg_is_in_recovery() AS r") {
        asked += 1;
        if (asked <= 2) return Promise.resolve({ rows: [{ r: true }] });
      }
      return real.apply(this, args);
    };
    let client: pg.PoolClient;
    try {
      client = await lockPool.connect();
    } finally {
      proto.query = real;
    }
    try {
      assert.equal(asked, 3, "asked until a connection reached the primary");
      assert.ok(!old.includes(await pidOf(client)), "a connection from before the failover was handed out");
    } finally {
      client.release();
    }
  });

  test("F11 the cap's notice whose COMMIT took effect and whose answer the failover lost: announced, once", async () => {
    const turn = await w.routerTurn(alice);
    const capped = { ...w.sayDeps, maxPerHour: 1 };
    assert.equal((await w.mod.tools.say(turn as never, { text: "First." }, capped)).ok, true);
    w.events.length = 0;
    // At the cap the say's own transaction rolls back, so the first COMMIT is the notice's.
    const { out, cut } = await commitAnswerLost(() => w.mod.tools.say(turn as never, { text: "Second." }, capped).then(
      () => ({ code: "said", message: "" }), (err: { code?: string; message?: string }) => ({ code: err.code, message: err.message ?? "" })));
    assert.equal(cut, 1, "the notice's COMMIT answer was lost");
    assert.equal(out.code, "say_rate_limited");
    assert.match(out.message, /has been told/);
    const notices = await w.q("SELECT say_id, text FROM claw_assistant_says WHERE fallback");
    assert.deepEqual(notices.map((n) => n.text), [w.mod.outbound.sayCapNotice("Second.")]);
    assert.deepEqual(w.events.map((e) => e.say_id), [notices[0].say_id], "the web client is told, once");
  });

  test("F12 the cap's notice whose COMMIT answer was lost while the database cannot be asked: announced later, once", async () => {
    const turn = await w.routerTurn(alice);
    const capped = { ...w.sayDeps, maxPerHour: 1 };
    assert.equal((await w.mod.tools.say(turn as never, { text: "First." }, capped)).ok, true);
    w.events.length = 0;
    const refused = (text: string) => w.mod.tools.say(turn as never, { text }, capped).then(
      () => "said", (err: { code?: string }) => err.code ?? String(err));
    const { out, cut } = await commitAnswerLost(() => refused("Second."), (text) => /FROM claw_assistant_says WHERE say_id/.test(text));
    assert.equal(cut, 1);
    assert.equal(out, "say_rate_limited");
    const [notice] = await w.q("SELECT say_id FROM claw_assistant_says WHERE fallback");
    assert.ok(notice, "the notice is stored");
    const deadline = Date.now() + 5_000;
    while (!w.events.some((e) => e.say_id === notice.say_id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(w.events.map((e) => e.say_id), [notice.say_id], "announced once the database answered");
    assert.equal(await refused("Third."), "say_rate_limited");
    assert.equal(w.events.length, 1, "the next refusal finds the notice and sends no other");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_says WHERE fallback"))[0].n, 1);
  });

  test("F13 the cap's notice whose COMMIT failed without taking effect: stored and announced shortly after, once", async () => {
    const turn = await w.routerTurn(alice);
    const capped = { ...w.sayDeps, maxPerHour: 1 };
    assert.equal((await w.mod.tools.say(turn as never, { text: "First." }, capped)).ok, true);
    w.events.length = 0;
    const refused = (text: string) => w.mod.tools.say(turn as never, { text }, capped).then(
      () => ({ code: "said", message: "" }), (err: { code?: string; message?: string }) => ({ code: err.code, message: err.message ?? "" }));
    // The notice's COMMIT is lost with the connection before it took effect: rolled back, and reported as 57P01.
    const { default: pgModule } = await import("pg");
    const proto = pgModule.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const real = proto.query;
    let cut = 0;
    proto.query = function (this: unknown, ...args: unknown[]) {
      if (args[0] === "COMMIT" && cut === 0) {
        cut += 1;
        return (real.apply(this, ["ROLLBACK"]) as Promise<unknown>).then(() => {
          throw Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
        });
      }
      return real.apply(this, args);
    };
    let out: { code?: string; message: string };
    try {
      out = await refused("Second.");
    } finally {
      proto.query = real;
    }
    assert.equal(cut, 1);
    assert.equal(out.code, "say_rate_limited");
    assert.doesNotMatch(out.message, /has been told/, "the Router is not told the user heard of it");
    const deadline = Date.now() + 5_000;
    const notices = async () => w.q("SELECT say_id FROM claw_assistant_says WHERE fallback");
    while (!w.events.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const [notice] = await notices();
    assert.ok(notice, "the notice is stored after all");
    assert.deepEqual(w.events.map((e) => e.say_id), [notice.say_id], "and announced, once");
    assert.equal((await refused("Third.")).code, "say_rate_limited");
    assert.equal(w.events.length, 1, "the next refusal finds it and sends no other");
    assert.equal((await notices()).length, 1);
  });
});
