// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One failing sweep must not take the rest of the tick with it.
 *
 * The tick is a sequence of independent reconcilers sharing one try/catch, so
 * whatever throws first decides how much of the tick happened -- and everything
 * after it is skipped for the whole interval, silently, because the log line
 * says "tick_failed" and names one error. That is tolerable while every sweep
 * depends on the same database, since a database that cannot answer one of them
 * cannot answer any.
 *
 * Leadership broke that symmetry. The orphan-handle sweep sits in the middle of
 * the tick and is the only one that needs a connection from the dedicated lock
 * pool, which is small and separate by design. An exhausted or unreachable lock
 * pool therefore had nothing to do with the sweeps after it -- workspace
 * references, the idempotency prune -- and skipped them anyway, so a pool
 * problem presented as workspaces that were never released.
 *
 * Containment has two halves, and the second one is the easier to lose: a
 * `.catch()` wide enough to keep the tick going is wide enough to swallow the
 * reason it was needed. A sweep that fails on every tick and reports nothing is
 * the same silence as before, arrived at from the other direction.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { db } from "../src/infra/db.js";
import { sweeperTick } from "../src/tasks/sweeper.js";

const originalQuery = db.query;
const originalConnect = db.lockPool.connect;
after(() => {
  db.query = originalQuery;
  db.lockPool.connect = originalConnect;
});

/** Record every statement the tick issues, and reap nothing. */
function stubDb(): string[] {
  const seen: string[] = [];
  db.query = (async (text: string) => {
    seen.push(text.replace(/\s+/g, " ").trim());
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  return seen;
}

/** The last sweep of the tick, and the one furthest from the lock. */
const IDEMPOTENCY_PRUNE = /DELETE FROM claw_idempotency_keys/;
const PLATFORM_FACT_DRAIN =
  /sandbox_workload_id IS NOT NULL[\s\S]*platform_facts_resolved_at IS NULL/;

test("a lock pool that cannot hand out a connection costs one sweep, not the tick", async () => {
  const seen = stubDb();
  db.lockPool.connect = (async () => {
    throw new Error("timeout exceeded when trying to connect");
  }) as unknown as typeof db.lockPool.connect;

  await sweeperTick();

  assert.ok(
    seen.some((sql) => IDEMPOTENCY_PRUNE.test(sql)),
    "the sweeps after the leader-locked one need no leader and must still run",
  );
});

test("the tick reaches its end when the lock pool is healthy too", async () => {
  // The control for the case above: it would pass just as well if the tick had
  // stopped reaching that statement for some unrelated reason.
  const seen = stubDb();
  db.lockPool.connect = (async () => ({
    query: async () => ({ rows: [{ ok: false }] }),
    release: () => {},
  })) as unknown as typeof db.lockPool.connect;

  await sweeperTick();

  assert.ok(seen.some((sql) => IDEMPOTENCY_PRUNE.test(sql)));
});

test("platform fact backlog drains even when no new stale row was reaped", async () => {
  const seen = stubDb();
  db.lockPool.connect = (async () => ({
    query: async () => ({ rows: [{ ok: false }] }),
    release: () => {},
  })) as unknown as typeof db.lockPool.connect;

  await sweeperTick();

  assert.ok(
    seen.some((sql) => PLATFORM_FACT_DRAIN.test(sql)),
    "the drain was hidden behind reapStaleTasks' empty-result return",
  );
});

test("a scan that throws inside the lock is contained the same way", async () => {
  // The pool is not the only thing that can fail here. This replica does take
  // leadership, so the traversal itself runs -- and reads a NATS KV bucket that
  // this process has not connected to, which is how the sweep fails in a test and
  // how it fails against an unreachable NATS in production. Containment has to
  // cover the scan and not just the connection it was handed.
  const seen = stubDb();
  db.lockPool.connect = (async () => ({
    query: async (sql: string) => ({
      rows: [sql.includes("pg_try_advisory_lock") ? { ok: true } : { released: true }],
    }),
    release: () => {},
  })) as unknown as typeof db.lockPool.connect;

  await sweeperTick();

  assert.ok(
    seen.some((sql) => IDEMPOTENCY_PRUNE.test(sql)),
    "the sweeps after a failed traversal need no leader and must still run",
  );
});

test("a reaper that throws a non-Error still costs that sweep, not the tick", async () => {
  // `(e as Error).message` without `?.` rethrows from the catch when the
  // rejection is null or undefined, which escapes the tick and stops the
  // setTimeout loop from scheduling the next one.
  const seen: string[] = [];
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push(sql);
    if (/executor IS DISTINCT FROM 'dag'/.test(sql)) throw null;
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  db.lockPool.connect = (async () => ({
    query: async () => ({ rows: [{ ok: false }] }),
    release: () => {},
  })) as unknown as typeof db.lockPool.connect;

  await sweeperTick();

  assert.ok(
    seen.some((sql) => IDEMPOTENCY_PRUNE.test(sql)),
    "a null rejection must not take the rest of the tick with it",
  );
});

test("a reaper that throws costs that sweep, not the ones after it", async () => {
  const seen: string[] = [];
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push(sql);
    if (/executor IS DISTINCT FROM 'dag'/.test(sql)) {
      throw new Error("statement timeout");
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  db.lockPool.connect = (async () => ({
    query: async () => ({ rows: [{ ok: false }] }),
    release: () => {},
  })) as unknown as typeof db.lockPool.connect;

  await sweeperTick();

  assert.ok(
    seen.some((sql) => IDEMPOTENCY_PRUNE.test(sql)),
    "the rest of the tick must still run after an early reaper throws",
  );
});

test("every contained failure is still reported, at a level somebody sees", () => {
  // Nothing observable survives containment -- that is what containment means --
  // and pino writes past `process.stdout`, so there is no output for a test to
  // capture either. A guard on the source is what can hold this: each catch that
  // keeps the tick alive has to name the sweep that failed and report it at error
  // level, because a sweep that fails on every tick and reports nothing is the
  // same silence as before.
  const src = readFileSync(
    fileURLToPath(new URL("../src/tasks/sweeper.ts", import.meta.url)),
    "utf-8",
  );

  for (const [lock, event] of [
    ["orphanHandles", "sweeper.orphan_handles_failed"],
    ["sessionCleanup", "sweeper.session_cleanup_failed"],
  ]) {
    const fromTheLock = src.slice(src.indexOf(`withLeaderLock(LEADER_LOCK_IDS.${lock}`));
    const containment = fromTheLock.slice(0, fromTheLock.indexOf("});") + 3);

    assert.match(containment, /\.catch\(/, `${lock} is contained`);
    assert.match(
      containment,
      new RegExp(`logger\\.error\\([\\s\\S]*?"${event.replace(".", "\\.")}"`),
      "a containment that reports nothing is the silence this fix was for",
    );
  }

  for (const event of [
    "sweeper.stale_tasks_failed",
    "sweeper.stuck_dag_roots_failed",
    "sweeper.requeued_doorbell_leases_failed",
    "sweeper.lost_leases_failed",
    "sweeper.expired_queue_failed",
    "sweeper.wait_external_failed",
    "sweeper.stuck_sessions_failed",
    "sweeper.platform_backfill_drain_failed",
    "sweeper.release_finished_refs_failed",
    "sweeper.release_deleted_refs_failed",
    "sweeper.release_idle_refs_failed",
    "sweeper.idempotency_prune_failed",
  ]) {
    assert.match(
      src,
      new RegExp(`runContained\\("${event.replaceAll(".", "\\.")}"`),
      `${event} is contained`,
    );
  }

  assert.match(
    src,
    /logger\.error\([\s\S]*?"sweeper\.tick_failed"/,
    "a tick that still throws has to reschedule, and say so",
  );
  assert.match(
    src,
    /\(e as Error\)\?\.message/,
    "a null rejection must not rethrow from the catch that contains it",
  );
});
