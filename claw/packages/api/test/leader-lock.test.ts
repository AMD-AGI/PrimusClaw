// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which periodic scans may run on every replica, and which may not.
 *
 * The distinction is the point of this lock. A reaper whose action is one
 * `UPDATE ... WHERE status IN (...)` is its own compare-and-swap: run it on
 * four replicas and three of them update nothing. A scan that reads a handle,
 * decides the DAG behind it is finished, and then destroys a sandbox is not --
 * the second replica acts on a world the first one already changed, which is
 * how a sandbox Brain has just rebuilt gets torn down under it.
 *
 * So this pins two things: the lock actually excludes, and losing it is an
 * ordinary outcome rather than an error the caller has to handle.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { db } from "../src/infra/db.js";
import { LEADER_LOCK_IDS, withLeaderLock } from "../src/infra/leader-lock.js";

const originalConnect = db.lockPool.connect;
after(() => { db.lockPool.connect = originalConnect; });

interface FakePg {
  /** Lock ids currently held, shared across the fake's clients. */
  held: Set<number>;
  released: number;
  /** Connections handed back with the destroy flag set. */
  destroyed: number;
  queries: string[];
}

/** A lock pool whose advisory locks behave like Postgres session locks. */
function stubLockPool(): FakePg {
  const state: FakePg = { held: new Set(), released: 0, destroyed: 0, queries: [] };
  db.lockPool.connect = (async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      state.queries.push(sql);
      const id = Number(params[0]);
      if (sql.includes("pg_try_advisory_lock")) {
        if (state.held.has(id)) return { rows: [{ ok: false }] };
        state.held.add(id);
        return { rows: [{ ok: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        // Postgres answers with whether this session was holding it, which is
        // exactly what Set.delete reports.
        return { rows: [{ released: state.held.delete(id) }] };
      }
      return { rows: [] };
    },
    release: (destroy?: boolean) => {
      state.released++;
      if (destroy) state.destroyed++;
    },
  })) as unknown as typeof db.lockPool.connect;
  return state;
}

test("only one replica runs the scan; the rest skip without erroring", async () => {
  stubLockPool();
  let running = 0;
  let concurrent = 0;
  let ran = 0;

  const scan = async () => {
    running++;
    concurrent = Math.max(concurrent, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    ran++;
    return "swept";
  };

  const outcomes = await Promise.all(
    [1, 2, 3, 4].map(() => withLeaderLock(LEADER_LOCK_IDS.orphanHandles, "orphan_handles", scan)),
  );

  assert.equal(ran, 1, "four replicas, one traversal");
  assert.equal(concurrent, 1);
  assert.equal(outcomes.filter((o) => o.ran).length, 1);
  const winner = outcomes.find((o) => o.ran);
  assert.equal(winner && winner.ran && winner.result, "swept", "the leader's result reaches its caller");
});

test("the lock is released, so the next tick can be led by anyone", async () => {
  const pg = stubLockPool();
  await withLeaderLock(LEADER_LOCK_IDS.uploadSweep, "upload_sweep", async () => 1);
  assert.equal(pg.held.size, 0, "a lock held past the scan makes the next tick a no-op forever");

  let secondRan = false;
  await withLeaderLock(LEADER_LOCK_IDS.uploadSweep, "upload_sweep", async () => { secondRan = true; });
  assert.ok(secondRan);
});

test("a scan that throws still gives up the lock", async () => {
  const pg = stubLockPool();
  await assert.rejects(
    withLeaderLock(LEADER_LOCK_IDS.uploadSweep, "upload_sweep", async () => {
      throw new Error("S3 unreachable");
    }),
    /S3 unreachable/,
    "the failure belongs to the caller, not swallowed here",
  );
  assert.equal(pg.held.size, 0);
  assert.equal(pg.released, 1, "and the connection goes back to the pool");
});

test("a scan that turns out not to have held the lock is not a clean pass", async () => {
  // `pg_advisory_unlock` returning false is the one signal this lock can give
  // that its guarantee did not hold: the session took the lock, ran a whole
  // read-decide-act traversal under it, and is now told it was holding nothing
  // -- so another replica was free to take the same lock and act on the same
  // state at the same time, which is exactly what this exists to prevent. The
  // answer used to be discarded, which made that indistinguishable from a
  // successful sweep. Modelled by the lock not being there at unlock time,
  // whatever reset the session state.
  const pg = stubLockPool();
  const outcome = await withLeaderLock(LEADER_LOCK_IDS.uploadSweep, "upload_sweep", async () => {
    pg.held.clear();
    return "swept";
  });

  assert.ok(outcome.ran && outcome.result === "swept",
    "reported, not thrown: the scan is over, and the caller has sweeps left that need no leader");
  assert.equal(pg.destroyed, 1,
    "a session that denies holding the lock it took is not handed to the next caller");
});

test("an unlock that answers nothing is read the way the acquire reads nothing", async () => {
  // The two ends have to agree in direction. The acquire treats anything but
  // `true` as "not the leader" and skips, while this used to treat anything but
  // `false` as released -- so whatever stops the column coming back, a proxy
  // rewriting the statement or a driver change, would have made one end fail
  // closed and the other fail open. The fail-open end is the one that reports a
  // scan as exclusive when nothing confirmed it was. Behind a transaction-pooling
  // proxy this is not hypothetical: a session-level advisory lock cannot work
  // there at all, so the answer is worthless on every tick.
  const state = { destroyed: 0, released: 0 };
  db.lockPool.connect = (async () => ({
    query: async (sql: string) => (
      sql.includes("pg_try_advisory_lock") ? { rows: [{ ok: true }] } : { rows: [] }
    ),
    release: (destroy?: boolean) => {
      state.released++;
      if (destroy) state.destroyed++;
    },
  })) as unknown as typeof db.lockPool.connect;

  const outcome = await withLeaderLock(LEADER_LOCK_IDS.uploadSweep, "upload_sweep", async () => "swept");

  assert.ok(outcome.ran, "the scan itself still ran and its result still belongs to the caller");
  assert.equal(state.destroyed, 1,
    "an unconfirmed release is not a release, and the session is not reused");
});

test("the ordinary path keeps its connection", async () => {
  // The other half of the case above: destroying on every pass would churn the
  // lock pool once a tick for no reason.
  const pg = stubLockPool();
  await withLeaderLock(LEADER_LOCK_IDS.uploadSweep, "upload_sweep", async () => 1);
  assert.equal(pg.destroyed, 0);
  assert.equal(pg.released, 1);
});

test("losing leadership is reported at a level somebody sees", () => {
  // The level carries the whole of this signal's value and nothing observable
  // depends on it, so a guard on the source is the only thing that can hold it.
  // The other unlock failure here warns and deserves to: it is self-correcting,
  // since the connection closes and takes the lock with it. This one is not --
  // it says the exclusion the scan ran under had already failed -- and a
  // warning about that is a warning nobody goes looking for.
  const src = readFileSync(
    fileURLToPath(new URL("../src/infra/leader-lock.ts", import.meta.url)),
    "utf-8",
  );
  assert.match(src, /logger\.error\([^)]*\s*"leader\.unlock_not_held/s);
});

test("the scans do not exclude each other", async () => {
  // They share the advisory-lock namespace with everything else in the
  // database, so reusing an id would silently serialise unrelated work: one
  // sweep would take the lock, and the others would report a clean pass having
  // done nothing, once a tick, for ever. Asserted over the whole table rather
  // than over a pair, since the failure arrives with whichever id is added next.
  stubLockPool();
  const ids = Object.entries(LEADER_LOCK_IDS);

  const outcomes = await Promise.all(
    ids.map(([name, id]) => withLeaderLock(id, name, async () => name)),
  );

  assert.deepEqual(outcomes.map((o) => o.ran), ids.map(() => true));
  assert.equal(new Set(ids.map(([, id]) => id)).size, ids.length, "every id is its own");
});
