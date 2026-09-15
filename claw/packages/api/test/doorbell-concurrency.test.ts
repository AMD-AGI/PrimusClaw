// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The interleaving the shipped doorbell tests cannot reach.
 *
 * `takeClaim` guards a sibling with `NOT EXISTS`. Under READ COMMITTED two
 * transactions claiming two rows of one turn each see the other still `queued`,
 * both pass, and the turn runs twice. Asserting the predicate proves nothing
 * about that; only two connections holding two transactions open at the same
 * moment do, which is what everything here is for -- including the negative
 * control, whose whole point is to show which of these cases the index is not
 * what decided.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  startConcurrencyHarness, type ConcurrencyHarness,
} from "./concurrency-harness.js";
import { isCi, postgresSkipReason } from "./support/pg-cluster.js";

const skip = postgresSkipReason();

const RUN_CLAIM_SRC = readFileSync(new URL("../src/tasks/run-claim.ts", import.meta.url), "utf8");
const FENCE_LINE = "AND ${RUN_CLAIM_FENCE_SQL}";
const fenceSkip = RUN_CLAIM_SRC.includes("RUN_CLAIM_FENCE_SQL")
  ? skip
  : `takeClaim does not take the claim fence yet: its UPDATE needs \`${FENCE_LINE}\` in the WHERE clause`;

let h: ConcurrencyHarness;

before(async () => {
  if (skip) return;
  h = await startConcurrencyHarness();
});

after(async () => {
  if (h) await h.stop();
});

test("CI runs this proof rather than skipping it", { skip: isCi() ? false : "not CI" }, () => {
  // A skipped concurrency proof in an automated run reads exactly like a passing
  // one, which is how an exactly-once invariant stops being checked without
  // anybody deciding to stop checking it.
  assert.ok(
    process.env.DATABASE_URL,
    "DATABASE_URL must be set in CI: both workflows run this suite and it cannot skip",
  );
});

test("the second claim of one turn blocks, then loses to the unique index", { skip }, async () => {
  await h.clearTasks();
  await h.seed({ taskId: "task-a", sessionId: "s1", messageId: "m1" });
  await h.seed({ taskId: "task-b", sessionId: "s1", messageId: "m1" });

  await h.a.query("BEGIN");
  assert.equal((await h.claim(h.a, "task-a", "brain-a")).verdict, "claimed");

  await h.b.query("BEGIN");
  const contender = h.claim(h.b, "task-b", "brain-b");

  // Asserted before the commit, because after it the same verdict would also be
  // produced by the cheap pre-check, and this case is about the index.
  assert.ok(
    await h.waitingOnLock(h.b),
    "the second claim must be parked on the first transaction's index entry",
  );

  await h.a.query("COMMIT");
  const outcome = await contender;
  await h.b.query("ROLLBACK");

  assert.equal(outcome.verdict, "busy");

  const winner = await h.taskRow("task-a");
  assert.equal(winner.status, "preparing");
  assert.equal(winner.lease_owner, "brain-a");
  assert.equal(Number(winner.claim_count), 1);

  const loser = await h.taskRow("task-b");
  assert.equal(loser.status, "queued", "the losing row is left exactly as it was");
  assert.equal(loser.lease_owner, null);
  assert.equal(Number(loser.claim_count), 0);
});

test("the sequential control is refused by the pre-check, not the index", { skip }, async () => {
  // Retained deliberately: this is the shape the existing scenario tests
  // already cover, and it stays "busy" with the index dropped. It proves the
  // verdict, and nothing whatever about concurrency.
  await h.clearTasks();
  await h.seed({ taskId: "task-c", sessionId: "s2", messageId: "m2" });
  await h.seed({ taskId: "task-d", sessionId: "s2", messageId: "m2" });

  await h.a.query("BEGIN");
  assert.equal((await h.claim(h.a, "task-c", "brain-a")).verdict, "claimed");
  await h.a.query("COMMIT");

  const outcome = await h.claim(h.b, "task-d", "brain-b");
  assert.equal(outcome.verdict, "busy");
  assert.equal(
    outcome.raisedUniqueViolation, false,
    "the sibling NOT EXISTS saw a preparing row; the index was never consulted",
  );
});

test("reconciliation keeps the row holding the turn, however old it is", { skip }, async () => {
  await h.clearTasks();
  await h.dropClaimIndex();
  await h.seed({
    taskId: "task-holder", sessionId: "s3", messageId: "m3",
    status: "running", claimCount: 1, leaseOwner: "brain-a", ageSeconds: 600,
  });
  await h.seed({ taskId: "task-spare", sessionId: "s3", messageId: "m3", status: "preparing" });

  await h.app.initDb();

  const holder = await h.taskRow("task-holder");
  assert.equal(holder.status, "running", "the executing row survives its younger sibling");
  const spare = await h.taskRow("task-spare");
  assert.equal(spare.status, "failed");
  assert.equal(spare.failure_reason, "dispatch_retried");
  assert.equal(await h.indexIsValid(), true);
});

test("two holders close nothing, build nothing, and refuse startup", { skip }, async () => {
  await h.clearTasks();
  await h.dropClaimIndex();
  await h.seed({
    taskId: "task-h1", sessionId: "s4", messageId: "m4",
    status: "running", claimCount: 1, leaseOwner: "brain-a",
  });
  await h.seed({
    taskId: "task-h2", sessionId: "s4", messageId: "m4",
    status: "running", claimCount: 1, leaseOwner: "brain-b",
  });

  await assert.rejects(
    h.app.initDb(),
    /more than one active row holds the same chat turn.*s4\/m4/s,
    "the group is named, because choosing which execution to kill is not a migration's call",
  );

  assert.equal((await h.taskRow("task-h1")).status, "running");
  assert.equal((await h.taskRow("task-h2")).status, "running");
  assert.equal(await h.indexIsValid(), null, "and no index claims an invariant that does not hold");
});

test("a claim in flight delays the build, which then arrives valid", { skip }, async () => {
  await h.clearTasks();
  await h.dropClaimIndex();
  // The shared side of the fence, taken exactly as the claim statement takes
  // it: a transaction open on the id `initDb` is about to want exclusively.
  await h.b.query("BEGIN");
  await h.b.query("SELECT pg_advisory_xact_lock_shared($1)", [h.app.claimFenceLockId]);

  let settled = false;
  const migration = h.app.initDb().then(() => { settled = true; });

  assert.ok(
    await h.waitingOnPid(await h.fenceWaiterPid(), 10_000),
    "the migration must wait for the claim rather than build alongside it",
  );
  assert.equal(settled, false);

  await h.b.query("COMMIT");
  await migration;
  assert.equal(await h.indexIsValid(), true);
});

test("a claim arriving during the build waits for the fence", { skip: fenceSkip }, async () => {
  await h.clearTasks();
  await h.seed({ taskId: "task-fenced", sessionId: "s5", messageId: "m5" });
  await h.observer.query("SELECT pg_advisory_lock($1)", [h.app.claimFenceLockId]);

  const claim = h.claim(h.b, "task-fenced", "brain-b");
  assert.ok(await h.waitingOnLock(h.b), "the claim waits while reconciliation holds the fence");

  await h.observer.query("SELECT pg_advisory_unlock($1)", [h.app.claimFenceLockId]);
  assert.equal((await claim).verdict, "claimed");
  assert.equal(await h.indexIsValid(), true);
});

test("an interrupted build is refused, then dropped and rebuilt", { skip }, async () => {
  await h.clearTasks();
  await h.invalidateClaimIndex();

  await assert.rejects(
    h.app.assertChatTurnClaimIndex(h.observer),
    /is not valid/,
    "an index present but not valid enforces nothing, so the process must not serve",
  );

  await h.app.initDb();
  assert.equal(await h.indexIsValid(), true);
  await h.app.assertChatTurnClaimIndex(h.observer);
});
