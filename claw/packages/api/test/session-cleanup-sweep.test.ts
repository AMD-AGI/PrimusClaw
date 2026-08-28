// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The sweep that finishes deletions the request could not.
 *
 * Which is what makes a delete a promise rather than an attempt: the client is
 * told the session is gone as soon as the transaction commits, and everything
 * outside this database -- the tombstone, the parked handle, the objects in S3
 * -- is finished afterwards, by this, however many attempts that takes.
 *
 * Two things are pinned here, because each of them is a way for a deleted
 * session to keep its files with nobody finding out. The scan has to select
 * exactly the deletions that are unfinished and due, since a row it does not
 * select is a row nothing else ever comes back for. And the report has to fire
 * on the whole pending set rather than on the batch, since the sessions worth
 * hearing about are precisely the ones whose backoff means they were not tried
 * this time.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { runCleanupSweep, stuckCleanups, sweepSessionCleanups } from "../src/sessions/cleanup-sweep.js";
import { teardownPorts } from "../src/sessions/teardown.js";
import { stubDb, type Answer, type DbStub } from "./support/db-stub.js";

const originalPorts = { ...teardownPorts };
let dbStub: DbStub | null = null;

afterEach(() => {
  Object.assign(teardownPorts, originalPorts);
  dbStub?.restore();
  dbStub = null;
});

/** Every step of the cleanup, succeeding, with a record of the sessions it ran for. */
function healthyPorts(): string[] {
  const cleaned: string[] = [];
  teardownPorts.writeTombstones = async () => "written";
  teardownPorts.notifyCleanup = () => true;
  teardownPorts.parkHands = async () => "parked";
  teardownPorts.purgeSessionEvents = async () => {};
  teardownPorts.deleteGateLocks = async () => true;
  teardownPorts.deleteWorkspaceObjects = async (_owner, sessionId) => {
    cleaned.push(sessionId);
    return { deleted: 1, failed: 0, complete: true };
  };
  teardownPorts.releaseWorkspaceRefs = async () => "released";
  return cleaned;
}

/** A database with these deletions outstanding and nothing else to say. */
function withPending(rows: unknown[], extra?: Answer): void {
  dbStub = stubDb((sql, params) => {
    if (/FROM claw_sessions WHERE cleanup_state = 'pending'/.test(sql)) return rows;
    return extra?.(sql, params) ?? [];
  });
}

test("the scan takes the deletions that are unfinished and due", async () => {
  // Both halves of the predicate are load-bearing. Without the state, the sweep
  // walks the S3 prefixes of every session ever deleted, on every tick; without
  // the schedule, a cleanup that is failing is retried as fast as the tick
  // comes round, which for a store that is down is a retry storm at the moment
  // it is least able to answer.
  withPending([]);

  await sweepSessionCleanups();

  const [scan] = dbStub!.seen;
  assert.match(scan.sql, /cleanup_state = 'pending'/);
  assert.match(scan.sql, /cleanup_next_at IS NULL OR cleanup_next_at <= NOW\(\)/);
  assert.match(scan.sql, /ORDER BY cleanup_next_at NULLS FIRST/);
  assert.equal(scan.params[0], 20, "the first tick after an upgrade has a year of them to take");
});

test("a deletion that finishes is written down as finished", async () => {
  const cleaned = healthyPorts();
  withPending([{ session_id: "s-1", user_id: "u-1", cleanup_attempts: 3 }]);

  assert.equal(await sweepSessionCleanups(), 1);

  assert.deepEqual(cleaned, ["s-1"], "the files are the reason this exists");
  assert.ok(dbStub!.ran(/cleanup_state = 'done'/));
});

test("a deletion that fails again is left pending, with a longer wait", async () => {
  healthyPorts();
  teardownPorts.deleteWorkspaceObjects = async () => { throw new Error("connect ECONNREFUSED"); };
  withPending([{ session_id: "s-1", user_id: "u-1", cleanup_attempts: 3 }]);

  assert.equal(await sweepSessionCleanups(), 0);

  assert.ok(dbStub!.ran(/cleanup_next_at = NOW\(\) \+/));
  assert.ok(!dbStub!.ran(/cleanup_state = 'done'/),
    "a session recorded as cleaned up is a session nothing comes back for");
});

test("a walk that deleted objects before the clock stopped comes straight back", async () => {
  // The case the budget outcome exists for: a workspace too large for one pass.
  // It is not stuck, it is long, so it is due again at once and no attempt is
  // counted against it -- pushing it onto the backoff of a store that is
  // refusing would buy thirty seconds of progress every fifteen minutes.
  healthyPorts();
  teardownPorts.deleteWorkspaceObjects = async () => ({ deleted: 4000, failed: 0, complete: false });
  withPending([{ session_id: "s-1", user_id: "u-1", cleanup_attempts: 0 }]);

  await sweepSessionCleanups();

  assert.ok(dbStub!.ran(/cleanup_next_at = NOW\(\),/), "due again on the next tick");
  assert.ok(!dbStub!.ran(/cleanup_attempts = cleanup_attempts \+ 1/),
    "a pass that was working is not an attempt against it");
});

test("a walk that ran out of time having deleted nothing is an attempt", async () => {
  // Reaching the files step is not progress. Recording it as the budget parked
  // the row at the tail of the due set, never counted an attempt, and kept it
  // out of the stuck report -- so a cleanup that can never finish was silent.
  healthyPorts();
  teardownPorts.deleteWorkspaceObjects = async () => ({ deleted: 0, failed: 0, complete: false });
  withPending([{ session_id: "s-1", user_id: "u-1", cleanup_attempts: 0 }]);

  await sweepSessionCleanups();

  assert.ok(dbStub!.ran(/cleanup_attempts = cleanup_attempts \+ 1/),
    "zero work is an attempt, so the stuck report can see it");
  assert.ok(dbStub!.ran(/cleanup_next_at = NOW\(\) \+/),
    "and it takes the backoff rather than cutting the queue");
  assert.ok(!dbStub!.ran(/cleanup_next_at = NOW\(\),/),
    "the immediate retry is for a walk that had already deleted something");
});

test("one session's cleanup failing does not strand the next one", async () => {
  // They are unrelated deletions that happen to be due together, and the reason
  // the first one is failing -- an unavailable store, an id nothing will accept
  // -- can be permanent. A pass that stopped at it would never reach the rest.
  const cleaned = healthyPorts();
  teardownPorts.parkHands = async (sessionId: string) => {
    if (sessionId === "s-1") throw new Error("no responders available for request");
    return "parked";
  };
  withPending([
    { session_id: "s-1", user_id: "u-1", cleanup_attempts: 0 },
    { session_id: "s-2", user_id: "u-2", cleanup_attempts: 0 },
  ]);

  assert.equal(await sweepSessionCleanups(), 1);
  assert.deepEqual(cleaned, ["s-1", "s-2"]);
});

test("every session the sweep takes on is given a deadline to stop at", async () => {
  // The sweeper tick is a serial chain and the next tick is only scheduled once
  // this one returns, so an unbounded pass does not merely run long: the lease
  // reapers that decide whether a run is still alive wait behind it. One S3
  // endpoint that accepts connections and stops answering is enough, which is why
  // the bound is handed all the way down to the walk rather than only checked
  // between sessions.
  healthyPorts();
  const deadlines: Array<number | undefined> = [];
  teardownPorts.deleteWorkspaceObjects = async (_owner, _sessionId, deadline) => {
    deadlines.push(deadline);
    return { deleted: 1, failed: 0, complete: true };
  };
  withPending([
    { session_id: "s-1", user_id: "u-1", cleanup_attempts: 0 },
    { session_id: "s-2", user_id: "u-2", cleanup_attempts: 0 },
  ]);

  await sweepSessionCleanups();

  assert.equal(deadlines.length, 2);
  for (const deadline of deadlines) {
    assert.equal(typeof deadline, "number",
      "an unbounded walk is the one thing a pass inside a tick cannot afford");
    assert.ok(deadline! > Date.now(), "and it has to be a stop time still ahead of the walk");
  }
});

test("the sweep's cleanup owns the files, not the caller's credentials", async () => {
  // There is no caller to take a platform key from, and nothing in the cleanup
  // body needs one: the compute side is reached through the parked handle,
  // which carries the session's own key. What the row does have to supply is
  // the owner, since it is the owner segment the objects are filed under.
  healthyPorts();
  const owners: Array<string | null> = [];
  teardownPorts.deleteWorkspaceObjects = async (ownerId) => {
    owners.push(ownerId);
    return { deleted: 0, failed: 0, complete: true };
  };
  withPending([{ session_id: "s-1", user_id: "u-1", cleanup_attempts: 0 }]);

  await sweepSessionCleanups();

  assert.deepEqual(owners, ["u-1"]);
});

test("nothing outstanding is nothing to report", async () => {
  withPending([]);

  assert.equal(await stuckCleanups(), null);
});

test("the report counts every outstanding deletion and names the oldest", async () => {
  // A count on its own says nothing anybody can start from, and a sample whose
  // count came from a second statement can disagree with it. The one that has
  // been failing longest is also the one whose error is worth reading.
  withPending([{
    session_id: "s-old",
    cleanup_attempts: 12,
    cleanup_error: "workspace_objects",
    pending_sec: 7_200,
    stuck: 4,
  }]);

  const stuck = await stuckCleanups();

  assert.deepEqual(stuck, {
    sessionId: "s-old",
    attempts: 12,
    error: "workspace_objects",
    pendingSec: 7_200,
    stuck: 4,
  });
  const [q] = dbStub!.seen;
  assert.match(q.sql, /COUNT\(\*\) OVER \(\)/,
    "the number and the session it names have to come from one statement");
  assert.match(q.sql, /ORDER BY deleted_at LIMIT 1/);
});

test("a backlog nobody has reached yet is not a stuck deletion", async () => {
  // An upgrade hands the sweep every session ever deleted, all of them older
  // than any threshold this could use. They drain at a batch a tick and each
  // one is tried before it can be reported, which is what `cleanup_attempts`
  // separates: without it the first hour after an upgrade is a page about
  // sessions deleted last year that are being dealt with as designed.
  withPending([]);

  await stuckCleanups();

  assert.match(dbStub!.seen[0].sql, /cleanup_attempts > 0/);
});

test("the report is taken after the work, over rows the pass never touched", async () => {
  // A session whose backoff has not elapsed is not due, so no pass picks it up
  // -- and a report scoped to what the pass did would be silent about exactly
  // the deletions that are stuck. Ordering it after the work is what keeps a
  // deletion this pass has just finished out of it.
  healthyPorts();
  const order: string[] = [];
  dbStub = stubDb((sql) => {
    if (/deleted_at < NOW\(\)/.test(sql)) {
      order.push("report");
      return [];
    }
    if (/cleanup_state = 'pending'/.test(sql)) {
      order.push("scan");
      return [{ session_id: "s-1", user_id: "u-1", cleanup_attempts: 0 }];
    }
    return [];
  });

  await runCleanupSweep();

  assert.deepEqual(order, ["scan", "report"]);
});
