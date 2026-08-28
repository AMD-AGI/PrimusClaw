// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Deleting a session, in the two halves it is now made of.
 *
 * The old cascade ran a dozen steps in a row and decided at each one whether
 * its failure was fatal, which produced states nobody had a use for: a session
 * tombstoned and still visible, files deleted under a session the retry then
 * answered 404 for, records closed with the row left readable. The failures
 * were reported honestly and there was still no way to finish the job.
 *
 * What replaces it is a commit and a cleanup. Everything inside this database
 * goes in one transaction, and until it commits nothing has happened at all;
 * everything outside it -- the tombstone, the notification, the parked handle,
 * the locks, the events, the objects, the reference -- is idempotent, recorded
 * on the row, and retried by the sweeper until it is done.
 *
 * So there are three properties worth pinning, and they are what the groups
 * below are for: nothing outside the database happens before the commit, the
 * commit is one transaction or none of it, and no failure after the commit can
 * stop the rest of the cleanup or lose the record that it is unfinished.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";

import {
  BUDGET_EXHAUSTED,
  NO_PROGRESS,
  commitSessionDeletion,
  recordCleanupOutcome,
  runSessionCleanup,
  teardownPorts,
  teardownSession,
  TeardownRefused,
  writeSessionTombstones,
} from "../src/sessions/teardown.js";
import { stubDb, type DbStub } from "./support/db-stub.js";
import { resetDeletedSessionCache } from "../src/sessions/deleted-cache.js";
import { sessionWasDeleted, tombstoneReader } from "../src/events/consumer.js";

const SID = "sess-delete-1";
const INPUT = { sessionId: SID, ownerId: "u-1", platformKey: "k" };

const originalPorts = { ...teardownPorts };
let dbStub: DbStub | null = null;

afterEach(() => {
  Object.assign(teardownPorts, originalPorts);
  dbStub?.restore();
  dbStub = null;
  resetDeletedSessionCache();
});

/** A KV bucket that either records the put or refuses it. */
function bucket(err?: Error): { kv: KV; keys: string[] } {
  const keys: string[] = [];
  const kv = {
    async put(key: string) {
      if (err) throw err;
      keys.push(key);
      return 1;
    },
  } as unknown as KV;
  return { kv, keys };
}

/**
 * Every step of the cleanup, succeeding, and a record of the order they ran in.
 *
 * All of them replaced, because each one reaches a store no unit test has a
 * copy of: left real, the cleanup would report five failures for reasons that
 * have nothing to do with what is under test.
 */
function healthyPorts(): string[] {
  const ran: string[] = [];
  teardownPorts.writeTombstones = async () => { ran.push("tombstone"); return "written"; };
  teardownPorts.notifyCleanup = () => { ran.push("cleanup_notify"); return true; };
  teardownPorts.parkHands = async () => { ran.push("hands_park"); return "parked"; };
  teardownPorts.deleteGateLocks = async () => { ran.push("lock_release"); return true; };
  teardownPorts.purgeSessionEvents = async () => { ran.push("events_purge"); };
  teardownPorts.deleteWorkspaceObjects = async () => {
    ran.push("workspace_objects");
    return { deleted: 2, failed: 0, complete: true };
  };
  teardownPorts.releaseWorkspaceRefs = async () => { ran.push("workspace_refs"); return "released"; };
  return ran;
}

// ── The mark that outlives a redelivery ──────────────────────────────────────

test("both marks are written, and the durable one is the point", async () => {
  const durable = bucket();
  const legacy = bucket();

  assert.equal(await writeSessionTombstones(durable.kv, legacy.kv, SID), "written");
  assert.deepEqual(durable.keys, [`deleted.${SID}`]);
  assert.deepEqual(legacy.keys, [`deleted.${SID}`]);
});

test("a durable write on this replica is remembered without another KV read", async () => {
  // The event consumer on this process would otherwise keep a live answer for
  // ten seconds and admit the exec_complete the cleanup notification is about
  // to provoke. The bucket is not consulted: the write just succeeded.
  const originalHas = tombstoneReader.has;
  tombstoneReader.has = async () => {
    throw new Error("the cache has to answer without the bucket");
  };
  try {
    assert.equal(await writeSessionTombstones(bucket().kv, bucket().kv, SID), "written");
    assert.equal(await sessionWasDeleted(SID), true);
  } finally {
    tombstoneReader.has = originalHas;
  }
});

test("the compatibility copy is not written over a durable mark that failed", async () => {
  // Issued together, the registry copy survives the durable write failing --
  // and Brain reads either mark as the session being gone, so the cleanup would
  // look partly done while the mark that actually outlives a redelivery is
  // missing, and the retry would see a step it thought had landed.
  const durable = bucket(new Error("no responders available for request"));
  const legacy = bucket();

  assert.equal(await writeSessionTombstones(durable.kv, legacy.kv, SID), "failed");
  assert.deepEqual(legacy.keys, []);
});

test("losing only the compatibility copy is not a cleanup to come back for", async () => {
  // It lives five minutes against a redelivery window measured in hours, so it
  // was never the protection -- it is there for replicas mid-upgrade. A bucket
  // that has gone for good would otherwise hold every deleted session pending
  // for ever.
  const durable = bucket();
  const legacy = bucket(new Error("bucket not found"));

  assert.equal(await writeSessionTombstones(durable.kv, legacy.kv, SID), "legacy_missing");
  assert.deepEqual(durable.keys, [`deleted.${SID}`], "the mark that matters still landed");

  healthyPorts();
  teardownPorts.writeTombstones = async () => "legacy_missing";
  const incomplete = await runSessionCleanup(INPUT);
  assert.ok(!incomplete.includes("tombstone"));
});

// ── The commit ───────────────────────────────────────────────────────────────

test("the deletion is one transaction, on one connection", async () => {
  // `db.query` takes a connection per call, so these four writes issued through
  // it could each land or not land on their own -- which is how a session ended
  // up hidden with its queued messages still stored, or its runs cancelled with
  // the session still visible. The single connection is the whole guarantee.
  dbStub = stubDb();

  await commitSessionDeletion(SID);

  assert.equal(dbStub.connections, 1);
  assert.deepEqual(new Set(dbStub.seen.map((q) => q.conn)), new Set([1]));
  const sql = dbStub.sql();
  assert.equal(sql[0], "BEGIN");
  assert.equal(sql.at(-1), "COMMIT");
  assert.ok(dbStub.ran(/DELETE FROM claw_pending_messages/));
  assert.ok(dbStub.ran(/UPDATE claw_tasks SET status = 'cancelled'/));
  assert.ok(dbStub.ran(/UPDATE claw_conversation_turns SET deleted_at/));
  assert.ok(dbStub.ran(/UPDATE claw_sessions SET deleted_at = COALESCE/));
});

test("a statement that fails takes the whole deletion with it", async () => {
  // The property the transaction exists for: the session stays visible, its
  // queued messages stay queued, and the same request run again is the repair.
  // A partial deletion is the one outcome a caller cannot do anything with.
  dbStub = stubDb((sql) => {
    if (/DELETE FROM claw_pending_messages/.test(sql)) throw new Error("deadlock detected");
  });

  await assert.rejects(() => commitSessionDeletion(SID), (err: unknown) => {
    assert.ok(err instanceof TeardownRefused);
    assert.match((err as Error).message, /Retry the delete/,
      "the caller's move is the one thing the message has to get across");
    return true;
  });

  assert.ok(dbStub.ran(/^ROLLBACK$/));
  assert.ok(!dbStub.ran(/^COMMIT$/));
  assert.ok(
    !dbStub.ran(/UPDATE claw_sessions SET deleted_at/),
    "hiding the session is what makes the retry impossible, so it cannot have run",
  );
});

test("nothing outside the database happens before the commit", async () => {
  // The claim the refusal makes to the caller -- 503, nothing changed, retry --
  // is only true if every step that leaves this process runs after the commit.
  // In the old order the tombstone was third, behind a published cleanup and a
  // destroyed sandbox, so a caller told to retry got a session it could still
  // see with no sandbox behind it.
  const ran = healthyPorts();
  dbStub = stubDb((sql) => {
    if (/UPDATE claw_tasks/.test(sql)) throw new Error("deadlock detected");
  });

  await assert.rejects(() => teardownSession(INPUT), TeardownRefused);

  assert.deepEqual(ran, [], "a refusal that destroyed something is not a refusal");
});

test("committing again over a deleted session does not move its timestamp", async () => {
  // What a retry of a request whose commit landed and whose response was lost
  // looks like. The work item is rebuilt so the sweeper picks the session up
  // again; `deleted_at` is left where it was, because it is the timestamp the
  // deletion is dated by and every retention window is measured from.
  dbStub = stubDb();

  await commitSessionDeletion(SID);

  const hide = dbStub.seen.find((q) => /UPDATE claw_sessions/.test(q.sql));
  assert.ok(hide);
  assert.match(hide.sql, /deleted_at = COALESCE\(deleted_at, NOW\(\)\)/);
  assert.match(hide.sql, /cleanup_state = 'pending'/);
  assert.match(hide.sql, /cleanup_attempts = 0/);
  assert.match(hide.sql, /cleanup_error = NULL/);
});

test("the sweeper is not due to start while the request is still cleaning up", async () => {
  // Both callers run the same seven steps, so a work item due immediately lets a
  // tick land beside the request that committed it: the same S3 prefixes walked
  // twice, and whichever finishes second recording its own answer over the
  // other's. One inline budget of delay is the whole of the coordination -- by
  // then the request has either finished, leaving the row `done` and unselected,
  // or written a schedule of its own.
  dbStub = stubDb();

  await commitSessionDeletion(SID);

  const hide = dbStub.seen.find((q) => /UPDATE claw_sessions/.test(q.sql));
  assert.ok(hide);
  assert.match(hide.sql, /cleanup_next_at = NOW\(\) \+ \(\$2::int \* INTERVAL '1 millisecond'\)/);
  assert.equal(hide.params[1], 5_000, "the default inline budget, which this has to outlast");
});

// ── The cleanup ──────────────────────────────────────────────────────────────

test("the tombstone is written before anything else the cleanup does", async () => {
  // The step whose absence is unsafe rather than untidy: until it lands, a task
  // or event already in flight is dispatched into a session that is gone. It
  // had a unit test of its own for exactly this, passed it, and was still
  // written after the sandbox had been destroyed -- a position no test could
  // see. This one watches the position.
  const ran = healthyPorts();

  await runSessionCleanup(INPUT);

  assert.equal(ran[0], "tombstone");
  assert.deepEqual(ran.slice(0, 4), [
    "tombstone", "cleanup_notify", "hands_park", "lock_release",
  ]);
  assert.equal(ran.at(-1), "workspace_refs",
    "the reference is what tells the collector the files are in use, so it goes after them");
});

test("a tombstone that could not be written stops the rest of the pass", async () => {
  // Continuing would park the sandbox and delete the files while the mark that
  // later events and tasks are checked against is missing -- the race the
  // step exists to close. Reported, and a later pass retries from the top.
  const ran = healthyPorts();
  teardownPorts.writeTombstones = async () => { ran.push("tombstone"); return "failed"; };

  const incomplete = await runSessionCleanup(INPUT);

  assert.deepEqual(incomplete, ["tombstone"]);
  assert.deepEqual(ran, ["tombstone"]);
});

test("a later step that fails does not take the steps after it", async () => {
  // Every one of these reaches a different store, and a delete that stopped at
  // the first unavailable one would leave the rest undone for as long as that
  // store is down -- including the reference release, which nothing else ever
  // comes back for. Reported, not raised, and the rest still runs. The tombstone
  // is the exception -- it stops the pass -- and is pinned separately.
  const ran = healthyPorts();
  teardownPorts.deleteWorkspaceObjects = async () => { throw new Error("connect ECONNREFUSED"); };

  const incomplete = await runSessionCleanup(INPUT);

  assert.deepEqual(incomplete, ["workspace_objects"]);
  assert.ok(ran.includes("workspace_refs"));
});

test("a walk that was cut short is out of time, not failed", async () => {
  // `failed` and `complete` are different questions, and so are the answers they
  // deserve. A walk that expired mid-prefix deleted everything it reached and
  // left the rest: recording that as finished is how a deleted session keeps its
  // files, and recording it as a failure puts a large deletion onto the backoff
  // of a store that is refusing. It is reported as the budget, which the record
  // reads as progress.
  healthyPorts();
  teardownPorts.deleteWorkspaceObjects = async () => ({
    deleted: 40, failed: 0, complete: false,
  });

  assert.deepEqual(await runSessionCleanup(INPUT), [BUDGET_EXHAUSTED]);
});

test("an object that refused to go is a failure, however much else went", async () => {
  // The other half of the distinction: a walk that reached the end of both
  // prefixes and could not delete one key has nothing to come back for at once,
  // and repeating it every tick would only repeat the refusal.
  healthyPorts();
  teardownPorts.deleteWorkspaceObjects = async () => ({
    deleted: 40, failed: 1, complete: true,
  });

  assert.deepEqual(await runSessionCleanup(INPUT), ["workspace_objects"]);
});

test("the inline budget stops the cleanup at a step boundary", async () => {
  // The request runs the cleanup itself so that the pending set is normally
  // empty, but it may not hold a client for as long as an unavailable store
  // takes. What the budget produces is a shorter run of finished steps, never a
  // half-finished one -- every step is idempotent, and the sweeper repeats
  // whatever was skipped. Stopping before the files is not progress: the
  // steps in front of them return true without deleting anything.
  const ran = healthyPorts();
  teardownPorts.writeTombstones = async () => {
    ran.push("tombstone");
    await new Promise((r) => setTimeout(r, 20));
    return "written";
  };

  const incomplete = await runSessionCleanup(INPUT, { budgetMs: 5 });

  assert.deepEqual(ran, ["tombstone"], "the budget is checked between steps, not inside one");
  assert.deepEqual(incomplete, [NO_PROGRESS]);
});

test("a walk that listed nothing before the clock ran out is not the budget", async () => {
  // Reaching the files step without deleting anything used to be recorded as
  // progress: no attempt, retry immediately, invisible to the stuck report.
  // The next pass has the same work it started with.
  healthyPorts();
  teardownPorts.deleteWorkspaceObjects = async () => ({
    deleted: 0, failed: 0, complete: false,
  });

  assert.deepEqual(await runSessionCleanup(INPUT), [NO_PROGRESS]);
});

test("a cleanup with no budget set runs every step, however slow", async () => {
  // Both callers do set one -- the sweeper's is just wider, since nobody is
  // waiting on it -- so what this pins is that the bound comes from the caller
  // and nothing here stops on its own.
  const ran = healthyPorts();
  teardownPorts.writeTombstones = async () => {
    ran.push("tombstone");
    await new Promise((r) => setTimeout(r, 20));
    return "written";
  };

  assert.deepEqual(await runSessionCleanup({ sessionId: SID, ownerId: "u-1" }), []);
  assert.equal(ran.length, 7, "every step ran, with the slow one no reason to stop");
});

// ── The record the sweeper reads ─────────────────────────────────────────────

test("a finished cleanup is written down as finished", async () => {
  dbStub = stubDb();

  await recordCleanupOutcome(SID, []);

  const [q] = dbStub.seen;
  assert.match(q.sql, /cleanup_state = 'done'/);
  assert.match(q.sql, /cleanup_next_at = NULL/);
  assert.match(q.sql, /cleanup_attempts = cleanup_attempts \+ 1/);
});

test("an unfinished cleanup stays pending, with a later time to try again", async () => {
  // The state is deliberately not touched on this path: a row is `pending`
  // until a whole run of the body finishes, which is what makes the pending set
  // exactly the set of unfinished deletions -- and that is the set the stuck
  // report reads.
  dbStub = stubDb();

  await recordCleanupOutcome(SID, ["workspace_objects", "workspace_refs"]);

  const [q] = dbStub.seen;
  assert.ok(!/cleanup_state =/.test(q.sql));
  assert.match(q.sql, /cleanup_next_at = NOW\(\) \+ \(\s*LEAST/);
  assert.match(q.sql, /POWER\(2, LEAST\(cleanup_attempts, 16\)\)/,
    "an uncapped exponent overflows into a retry date past the end of the epoch");
  assert.equal(q.params[1], "workspace_objects,workspace_refs",
    "which step is failing is the whole of what an operator has to go on");
  assert.equal(q.params[2], 60, "the base interval, which the first retry waits");
  assert.equal(q.params[3], 900, "the ceiling, so a store coming back is noticed within it");
});

test("a cleanup that got nowhere is recorded as a failure, not as the budget", async () => {
  dbStub = stubDb();

  await recordCleanupOutcome(SID, [NO_PROGRESS]);

  const [q] = dbStub.seen;
  assert.match(q.sql, /cleanup_attempts = cleanup_attempts \+ 1/);
  assert.match(q.sql, /POWER\(2, LEAST\(cleanup_attempts, 16\)\)/);
  assert.ok(!/cleanup_next_at = NOW\(\),/.test(q.sql),
    "no_progress must not take the immediate-retry path the budget uses");
});

test("a cleanup that only ran out of time is due again at once, and not an attempt", async () => {
  // A session large enough to need several passes is not a session anything is
  // wrong with. Counted and backed off, it would reach the ceiling and then make
  // thirty seconds of progress every fifteen minutes, and it would occupy the
  // stuck report while doing exactly what it is supposed to.
  dbStub = stubDb();

  await recordCleanupOutcome(SID, [BUDGET_EXHAUSTED]);

  const [q] = dbStub.seen;
  assert.match(q.sql, /cleanup_next_at = NOW\(\)/);
  assert.ok(!/LEAST/.test(q.sql), "no backoff: it was making progress when it stopped");
  assert.ok(!/cleanup_attempts/.test(q.sql), "and the attempt counter is what the report reads");
  assert.ok(!/cleanup_state/.test(q.sql), "still pending, like every unfinished cleanup");
});

test("failing to write the record does not fail the cleanup", async () => {
  // The work is done or it is not, and this only decides when somebody looks
  // again: a row whose update was lost keeps the schedule it had.
  dbStub = stubDb(() => { throw new Error("terminating connection due to shutdown"); });

  await recordCleanupOutcome(SID, []);
});

// ── The two halves together ──────────────────────────────────────────────────

test("a healthy delete is finished by the time the response is written", async () => {
  // Not the mechanism -- the sweeper is -- but the reason the pending set is
  // normally empty, which is what makes anything in it worth alerting on.
  healthyPorts();
  dbStub = stubDb();

  assert.deepEqual(await teardownSession(INPUT), []);
  assert.ok(dbStub.ran(/cleanup_state = 'done'/));
});

test("a delete whose cleanup could not finish is still a delete", async () => {
  // The client is told the session is gone, because it is: the commit landed,
  // and what is left is recorded on the row for the sweeper. Raising here would
  // ask a caller to retry a session that now answers 404.
  healthyPorts();
  teardownPorts.deleteWorkspaceObjects = async () => { throw new Error("connect ECONNREFUSED"); };
  dbStub = stubDb();

  const incomplete = await teardownSession(INPUT);

  assert.deepEqual(incomplete, ["workspace_objects"]);
  // The backoff write, not the commit's own schedule: matching a plain
  // `cleanup_next_at =` would pass with the outcome never recorded at all, which
  // is the failure this test is about.
  assert.ok(dbStub.ran(/cleanup_next_at = NOW\(\) \+ \(\s*LEAST/));
  assert.ok(!dbStub.ran(/cleanup_state = 'done'/));
});
