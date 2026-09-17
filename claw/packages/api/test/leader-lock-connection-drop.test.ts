// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What happens to a scan when the lock under it is released and the scan is not.
 *
 * The lock is a session-scoped advisory lock on a connection from `lockPool`.
 * Postgres drops such a lock the instant that backend goes -- which is the whole
 * reason a dead replica hands leadership over cleanly -- but the replica here is
 * not dead. Only its connection is. The scan's own work goes through `db.query`
 * on the main pool, it never touches the client the lock is on, and so it walks
 * the rest of its read-decide-act traversal while another replica is free to
 * take the same lock and walk it too.
 *
 * Reproduced against a real server: after a `pg_terminate_backend` of the
 * holder, a second connection's `pg_try_advisory_lock` answers true while the
 * first callback is still running, and the callback then returned `{ran: true}`
 * to a caller which recorded a clean exclusive pass. The only trace was one
 * warn-level `leader.unlock_failed` -- the error-level `leader.unlock_not_held`
 * alarm could not fire, because a dropped client makes `pg_advisory_unlock`
 * throw rather than answer false.
 *
 * So there are three separate facts to hold, and they fail separately:
 *   - the scan stops at its next loop boundary instead of running on,
 *   - the caller is told the pass was not exclusive instead of being told it
 *     was,
 *   - and a hold that never loses anything is completely unaffected.
 *
 * None of this makes the pass transactional: the handles torn down before the
 * drop stay torn down. It bounds the exposure, and it stops the exposure being
 * recorded as a clean pass.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { db } from "../src/infra/db.js";
import {
  LEADER_LOCK_IDS, LeadershipLostError, withLeaderLock,
} from "../src/infra/leader-lock.js";
import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const originalConnect = db.lockPool.connect;
after(() => { db.lockPool.connect = originalConnect; });

/* ------------------------------------------------------------------ *
 * The repro, against a real Postgres and real advisory locks.
 * ------------------------------------------------------------------ */

const skip = postgresSkipReason();

let cluster: PgCluster | undefined;
before(async () => { if (!skip) cluster = await startPgCluster(); });
after(async () => { await cluster?.end(); });

/** Connections handed back to the pool, and whether with the destroy flag. */
interface Handback { released: number; destroyed: number }

/**
 * A `lockPool` whose one client is a real backend on the test database.
 *
 * Wired through the pool's own 'connect' event because that is where db.ts
 * attaches the listener that both keeps a dropped client from taking the
 * process down and records the drop for the holder. Going around it would be
 * testing a fake.
 */
async function realLockClient(url: string): Promise<{ client: pg.Client; handback: Handback }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const handback: Handback = { released: 0, destroyed: 0 };
  (client as unknown as { release: (destroy?: boolean) => void }).release = (destroy?: boolean) => {
    handback.released += 1;
    if (destroy) handback.destroyed += 1;
  };
  (db.lockPool as unknown as EventEmitter).emit("connect", client);
  db.lockPool.connect = (async () => client) as unknown as typeof db.lockPool.connect;
  return { client, handback };
}

const backendPid = async (client: pg.Client): Promise<number> =>
  Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);

test("a scan whose lock connection drops stops, and its caller is not told it swept alone", {
  skip,
}, async () => {
  const url = cluster!.url;
  const { client: leader, handback } = await realLockClient(url);
  const leaderPid = await backendPid(leader);

  // The scan's own work, on a connection that is not the lock's -- which is the
  // shape of every scan this lock guards, and the reason the drop is invisible
  // to them.
  const worker = await cluster!.connect();
  // The other replica, asking for the same lock while the first scan runs.
  const rival = await cluster!.connect();
  const admin = await cluster!.connect();

  const lockId = LEADER_LOCK_IDS.orphanHandles;
  const STEPS = 25;
  let steps = 0;
  let rivalTookItMidScan = false;

  const hold = withLeaderLock(lockId, "orphan_handles", async (lease) => {
    for (let i = 0; i < STEPS; i += 1) {
      // The boundary. Everything after it in this iteration is the irreversible
      // half -- in the real scan, a sandbox teardown.
      if (lease.lost()) return "stopped";
      steps += 1;
      await worker.query("SELECT 1");
      if (steps === 5) {
        // The connection goes here, with twenty items still to walk.
        await admin.query("SELECT pg_terminate_backend($1)", [leaderPid]);
        // The scan does not stop because it was terminated; it stops because it
        // looks. Give the drop time to land so that the next boundary is a real
        // test of whether this loop reads one, rather than a race.
        await new Promise((r) => setTimeout(r, 150));
        const rivalSaw = await rival.query("SELECT pg_try_advisory_lock($1) AS ok", [lockId]);
        rivalTookItMidScan = rivalSaw.rows[0].ok === true;
      }
    }
    return "completed";
  });

  const err = await hold.then(
    (outcome) => outcome as never,
    (e: unknown) => e as Error,
  );

  assert.ok(
    rivalTookItMidScan,
    "the premise: the server really did release the lock, and a second replica really "
    + "was free to run the same traversal",
  );
  assert.ok(
    steps < STEPS,
    `the scan ran all ${STEPS} steps after its leadership ended (stopped at ${steps})`,
  );
  assert.equal(steps, 5, "and it stopped at the first boundary after the drop, not later");
  assert.ok(
    err instanceof LeadershipLostError,
    `the caller was told ${JSON.stringify(err)} -- a pass that was not exclusive must not `
    + "reach the caller as one that was",
  );
  assert.equal((err as LeadershipLostError).scan, "orphan_handles");
  assert.equal((err as LeadershipLostError).lockId, lockId);
  assert.equal(handback.destroyed, 1, "a dropped session is not handed to the next caller");

  await rival.query("SELECT pg_advisory_unlock($1)", [lockId]);
});

test("a hold that loses nothing behaves exactly as before", { skip }, async () => {
  const url = cluster!.url;
  const { client: leader, handback } = await realLockClient(url);
  const other = await cluster!.connect();
  const lockId = LEADER_LOCK_IDS.uploadSweep;

  let saw: Error | undefined = new Error("never asked");
  const outcome = await withLeaderLock(lockId, "upload_sweep", async (lease) => {
    saw = lease.lost();
    return "swept";
  });

  assert.deepEqual(outcome, { ran: true, result: "swept" },
    "the ordinary pass still returns its result to its caller");
  assert.equal(saw, undefined, "a live connection must not read as lost");
  assert.equal(handback.destroyed, 0, "and its connection is not churned");
  assert.equal(handback.released, 1);
  assert.equal(
    (await other.query("SELECT pg_try_advisory_lock($1) AS ok", [lockId])).rows[0].ok,
    true,
    "the lock is released, so the next tick can be led by anyone",
  );
  await other.query("SELECT pg_advisory_unlock($1)", [lockId]);
  await leader.end().catch(() => {});
});

/* ------------------------------------------------------------------ *
 * The same two facts without a server, so they are held on every run.
 * ------------------------------------------------------------------ */

/** A lock client the pool has handed out: an emitter that answers the two statements. */
function fakeLockClient(): { client: EventEmitter; handback: Handback; held: Set<number> } {
  const held = new Set<number>();
  const handback: Handback = { released: 0, destroyed: 0 };
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let alive = true;
  client.query = async (sql: string, params: unknown[] = []) => {
    // What a dropped pg client does to any statement sent after the drop. It is
    // the reason `pg_advisory_unlock` never answers false on this path.
    if (!alive) throw new Error("Client was closed and is not queryable");
    const id = Number(params[0]);
    if (sql.includes("pg_try_advisory_lock")) {
      if (held.has(id)) return { rows: [{ ok: false }] };
      held.add(id);
      return { rows: [{ ok: true }] };
    }
    if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: held.delete(id) }] };
    return { rows: [] };
  };
  client.release = (destroy?: boolean) => {
    handback.released += 1;
    if (destroy) handback.destroyed += 1;
  };
  client.on("error", () => {
    alive = false;
    // The server released the session's locks when the backend went.
    held.clear();
  });
  (db.lockPool as unknown as EventEmitter).emit("connect", client);
  db.lockPool.connect = (async () => client) as unknown as typeof db.lockPool.connect;
  return { client, handback, held };
}

test("the scan stops at the boundary after the drop rather than running to the end", async () => {
  const { client } = fakeLockClient();
  const STEPS = 25;
  let steps = 0;

  await assert.rejects(
    withLeaderLock(LEADER_LOCK_IDS.orphanHandles, "orphan_handles", async (lease) => {
      for (let i = 0; i < STEPS; i += 1) {
        if (lease.lost()) return "stopped";
        steps += 1;
        await Promise.resolve();
        if (steps === 5) client.emit("error", new Error("terminating connection"));
      }
      return "completed";
    }),
    (e: unknown) => e instanceof LeadershipLostError,
  );

  assert.equal(steps, 5, "the scan kept acting after the lock it assumed it held was gone");
});

test("a scan with no boundary to check still does not report a clean exclusive pass", async () => {
  // The other half of the lease: a body that cannot stop -- one statement, or a
  // loop that is mid-teardown -- still must not have its result recorded as a
  // pass that excluded anybody. This is the completion path's shape exactly, and
  // the rejection is what turns into a nak and a redelivery there.
  const { client, handback } = fakeLockClient();
  let finished = false;

  const err = await withLeaderLock(LEADER_LOCK_IDS.sessionCleanup, "session_cleanup", async () => {
    client.emit("error", new Error("Connection terminated unexpectedly"));
    await Promise.resolve();
    finished = true;
    return "done";
  }).then((o) => o as never, (e: unknown) => e as Error);

  assert.ok(finished, "the work was not cancelled -- nothing here can cancel it");
  assert.ok(
    err instanceof LeadershipLostError,
    "a body that ran without exclusion was reported to its caller as a clean pass",
  );
  assert.match(
    err.message,
    /ran on/,
    "the caller's error has to say what happened, not merely that something did",
  );
  assert.equal(handback.destroyed, 1);
});

test("the drop does not become the unhandled 'error' this branch exists to prevent", async () => {
  // The listener in db.ts is why four replicas stopped restarting every few
  // hours. Consuming what it publishes must not put that back: a watcher runs on
  // the emit path, and a throw from one is a process exit.
  const { client } = fakeLockClient();

  await assert.rejects(
    withLeaderLock(LEADER_LOCK_IDS.uploadSweep, "upload_sweep", async () => {
      assert.doesNotThrow(
        () => client.emit("error", new Error("Connection terminated unexpectedly")),
        "an unhandled 'error' on a checked-out client ends the process, not the scan",
      );
      return 1;
    }),
    (e: unknown) => e instanceof LeadershipLostError,
  );
});

test("a skip is still a skip, and an ordinary pass is still untouched", async () => {
  const { handback, held } = fakeLockClient();
  held.add(LEADER_LOCK_IDS.uploadSweep);

  const skipped = await withLeaderLock(LEADER_LOCK_IDS.uploadSweep, "upload_sweep", async () => {
    throw new Error("a scan that skipped must not run");
  });

  assert.deepEqual(skipped, { ran: false }, "losing the race stays an ordinary outcome");
  assert.equal(handback.destroyed, 0, "and costs no connection");
});

test("the orphan-handle traversal reads its lease before it acts on the next handle", () => {
  // The one sweep whose action is irreversible, and the one place a boundary
  // check can sit: `reapOrphanHandles` walks every handle and destroys the
  // sandbox behind each terminal one, so two overlapping holders tear the same
  // sandbox down twice -- including one Brain has just rebuilt.
  //
  // A source guard, and reluctantly: the traversal opens with
  // `handleMap().listAll()`, which binds a NATS KV bucket through a module-level
  // memo that no test can reach without a broker, and the loop cannot be entered
  // without it. What the mechanism does once a lease says lost is held
  // behaviourally by the tests above, against real advisory locks and a real
  // dropped backend. What is left for this to hold is the placement, which is
  // the part that is easy to lose in an edit: the check has to be the first
  // thing in the iteration, ahead of the statement that reads the DAG's status
  // and the teardown that follows it. A check after the teardown would report a
  // loss it had already acted through.
  const src = readFileSync(
    fileURLToPath(new URL("../src/tasks/sweeper.ts", import.meta.url)),
    "utf-8",
  );
  const traversal = src.slice(src.indexOf("export async function reapOrphanHandles"));
  const loop = traversal.slice(traversal.indexOf("for (const [dagRoot] of all) {"));
  const body = loop.slice(0, loop.indexOf("await db.query("));

  assert.match(
    body,
    /^for \(const \[dagRoot\] of all\) \{\s*const lost = lease\?\.lost\(\);\s*if \(lost\) \{/,
    "the lease has to be read at the top of the iteration, before the handle is judged",
  );
  assert.match(body, /break;/, "a boundary check that does not stop the loop is not a boundary");
});

test("an unlock that throws on a dropped connection is the not-held alarm, not the warn", () => {
  // The level is the whole of this signal's value and nothing observable
  // depends on it -- pino writes past `process.stdout` through its own
  // descriptor, so there is no output for a test to capture. A guard on the
  // source is what can hold it, the way the sibling guard in leader-lock.test.ts
  // already holds the false-answer branch.
  //
  // What is being pinned is the classification, not the string: a dropped client
  // throws from `pg_advisory_unlock` rather than answering false, so before this
  // the one case where leadership had demonstrably ended was the one case logged
  // at warn, under a comment calling it self-correcting. The connection's own
  // recorded death is the evidence -- nothing here invents a `released: false`
  // row the server never sent.
  const src = readFileSync(
    fileURLToPath(new URL("../src/infra/leader-lock.ts", import.meta.url)),
    "utf-8",
  );
  const unlockCatch = src.slice(src.indexOf("} catch (err) {"));

  assert.match(
    unlockCatch,
    /const lost = connectionLost\(client\);[\s\S]{0,200}?logger\.error\([^)]*"leader\.unlock_not_held/,
    "an unlock that threw because the client is gone is the not-held case and has to say so",
  );
  assert.match(
    unlockCatch,
    /\} else \{[\s\S]{0,600}?logger\.warn\([^)]*"leader\.unlock_failed/,
    "and an unlock that failed on a connection still up keeps the warn it deserves",
  );
});
