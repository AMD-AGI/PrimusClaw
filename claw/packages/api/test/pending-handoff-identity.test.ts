// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One durable run identity per queued message.
 *
 * Publishing and deleting the queue row are two steps, so a drain that
 * publishes and then fails to delete comes back to the same message. Without an
 * identity recorded on the queue row it opens a second run, and once the first
 * is terminal no active-state uniqueness index can stop that second one
 * executing -- the turn runs twice, and the transcript is the only place it
 * shows.
 */

/**
 * Both reapers, not one. `reapStaleTasks` is the only pass gated on this flag,
 * and with it off the cases below could never drive the ordering the whole
 * classification turns on: `sweeperTick` runs it *before* `reapOrphanedFatRuns`,
 * so on a deployment that has enabled it the deadline backstop is what
 * terminalizes a never-published fat row and the orphan reaper never sees it.
 * Set here rather than in a single case because the sweeper reads it once, at
 * import, and two cases in this file import that module.
 */
process.env.RUN_ROWS_SWEEPABLE = "true";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { closedDoorbellBarrier, openDoorbellBarrier } from "./doorbell-barrier-stub.js";
import { CHAT_TURN_CLAIM_INDEX, db } from "../src/infra/db.js";
import { startHarness, seedSession, seedRun, type Harness } from "./scenario-harness.js";

/**
 * The active-turn uniqueness index, which these cases are not allowed to be
 * decided without.
 *
 * Every answer this file asserts on is an answer about opening a second row for
 * one session and message id, and that is the pair `initDb` forbids while the
 * first row is active. A scenario that reaches its conclusion through an insert
 * production would refuse with 23505 is validating a recovery that cannot
 * happen -- which is exactly what the stranded-row case below used to do.
 *
 * Installed here rather than in `startHarness`, having tried it there: the
 * harness is shared with the scenarios about duplicate-turn debris
 * (doorbell-scenario.test.ts's held sibling, doorbell-completion-routing.test.ts's
 * unheld fat and legacy siblings), and those seed on purpose the rows this
 * index forbids -- the residue of a dispatch retried before the index existed,
 * or written while a concurrent build was still INVALID, which is what
 * `closeDuplicateDispatchSiblings` and `reconcileDuplicateChatTurns` exist for.
 * Five of them fail outright with it installed globally, so the index belongs
 * to the files whose subject it is.
 *
 * The predicate is `ACTIVE_CHAT_TURN_SQL` from db.ts, which is not exported;
 * the name is, so at least the object this builds cannot drift from the one the
 * migration builds. If the predicate there changes, this copy has to follow.
 */
const CHAT_TURN_INDEX_SQL = `CREATE UNIQUE INDEX ${CHAT_TURN_CLAIM_INDEX}
       ON claw_tasks(session_id, (metadata->>'message_id'))
    WHERE origin = 'chat'
      AND metadata->>'message_id' IS NOT NULL
      AND status IN ('preparing','running','cancelling')`;

/**
 * Publish and workspace binding, replaced together.
 *
 * The binding is stubbed because the scenario table is narrower than the
 * production lookup and a bind failure refuses the dispatch before it reaches
 * the identity decision these cases are about.
 */
function stubPorts(
  ports: { publish: unknown; bindWorkspace: unknown; doorbellDispatch: unknown },
  published: unknown[],
  /**
   * Which branch the drain takes. Open by default because the identity was
   * recorded for the doorbell hand-off first; the fat cases at the end of this
   * file pass the closed barrier, because that branch keeps the same
   * reservation now and it is the branch every drain takes on a deployment that
   * has never observed a usable capability floor.
   */
  barrier: typeof openDoorbellBarrier | typeof closedDoorbellBarrier = openDoorbellBarrier,
): () => void {
  const publish = ports.publish;
  const bind = ports.bindWorkspace;
  const gate = ports.doorbellDispatch;
  ports.doorbellDispatch = barrier;
  ports.publish = (async (...args: unknown[]) => {
    published.push(args);
    return published.length;
  });
  ports.bindWorkspace = (async () => "kws_1");
  return () => {
    ports.publish = publish;
    ports.bindWorkspace = bind;
    ports.doorbellDispatch = gate;
  };
}

let h: Harness;
let originalConnect: typeof db.pool.connect;
before(async () => {
  h = await startHarness();
  await h.sql(CHAT_TURN_INDEX_SQL);
  originalConnect = db.pool.connect;
  db.pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => db.query(text, params),
    release: () => {},
  })) as unknown as typeof db.pool.connect;
});
beforeEach(async () => { await h.reset(); });
after(async () => {
  db.pool.connect = originalConnect;
  await h?.close();
});

async function seedPending(id: number): Promise<void> {
  await h.sql(
    "INSERT INTO claw_pending_messages (id, session_id, user_id, content) VALUES ($1, 's1', 'u-1', 'hi')",
    [id],
  );
}

async function recordedId(id: number): Promise<string | null> {
  const rows = await h.sql("SELECT dispatch_task_id FROM claw_pending_messages WHERE id = $1", [id]);
  return (rows[0]?.dispatch_task_id as string | null) ?? null;
}

const DRAIN = {
  sessionId: "s1", userId: "u-1", messageId: "claw-1", prompt: "hi", workspaceId: "kws_1",
  task: { session_id: "s1", prompt: "hi" } as Record<string, unknown>,
};

test("the queue row names the run before that run's turn goes out", async () => {
  // The record has to be durable before the publish, or a drain that dies in
  // between comes back with nothing to recognise its own hand-off by.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published);
  const publish = pendingDispatchPorts.publish;
  let recordedWhenPublished: string | null = null;
  pendingDispatchPorts.publish = (async (...args: [string, string, string]) => {
    recordedWhenPublished = await recordedId(42);
    return publish(...args);
  }) as typeof pendingDispatchPorts.publish;
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(42);

    const result = await dispatchPendingMessage({ ...DRAIN, pendingId: 42 });

    assert.equal(published.length, 1);
    assert.equal(
      recordedWhenPublished, result.runId,
      "the queue row named this run before anything was sent for it",
    );
  } finally {
    restore();
  }
});

test("a drain that resumes after another has published opens no second run", async () => {
  // The pending selection takes no lock, so a drain can resume after another
  // has published this message and deleted its queue row. Answering that with a
  // fresh id is a second turn on the stream under an identity nothing recorded,
  // and no active-state index can stop it once the first row is terminal.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published);
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(42);
    const first = await dispatchPendingMessage({ ...DRAIN, pendingId: 42 });
    assert.equal(published.length, 1);
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 42")).length, 0,
      "the drain that published deleted the row it had handed off",
    );

    const resumed = await dispatchPendingMessage({ ...DRAIN, pendingId: 42 });

    assert.equal(resumed.runId, null, "the resumed drain has nothing left to hand off");
    assert.equal(published.length, 1, "and publishes nothing");
    const rows = await h.sql("SELECT task_id FROM claw_tasks WHERE session_id = 's1'");
    assert.deepEqual(
      rows.map((row) => row.task_id), [first.runId],
      "the only run is the one the first drain opened",
    );
  } finally {
    restore();
  }
});

test("a retry whose recorded run is still open publishes nothing and clears the queue", async () => {
  // The recorded run owns the message: claim-next is its wakeup and the queue
  // reaper its bound, so a second publish would be a second wakeup for a turn
  // that already has one.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published);
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(42);
    await seedRun(h, "ktsk_recorded", "s1", { status: "queued", dispatch: "doorbell" });
    await h.sql(
      "UPDATE claw_pending_messages SET dispatch_task_id = 'ktsk_recorded' WHERE id = 42",
    );

    const result = await dispatchPendingMessage({
      sessionId: "s1", pendingId: 42, userId: "u-1", messageId: "claw-1",
      prompt: "hi", workspaceId: "kws_1",
      task: { session_id: "s1", prompt: "hi" } as Record<string, unknown>,
    });

    assert.equal(result.runId, "ktsk_recorded", "the recorded run is the one that owns the turn");
    assert.deepEqual(published, [], "and it is not woken a second time");
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 42")).length, 0,
      "the queue row is cleared, so the drain stops replaying it",
    );
  } finally {
    restore();
  }
});

test("a retry whose recorded run was consumed opens no second run", async () => {
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published);
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(43);
    await seedRun(h, "ktsk_done", "s1", { status: "completed", dispatch: "doorbell", claimCount: 1 });
    await h.sql("UPDATE claw_pending_messages SET dispatch_task_id = 'ktsk_done' WHERE id = 43");

    const result = await dispatchPendingMessage({
      sessionId: "s1", pendingId: 43, userId: "u-1", messageId: "claw-2",
      prompt: "hi", workspaceId: "kws_1",
      task: { session_id: "s1", prompt: "hi" } as Record<string, unknown>,
    });

    assert.equal(result.runId, null, "a turn that already ran is not run again");
    assert.deepEqual(published, []);
    const rows = await h.sql("SELECT 1 FROM claw_tasks WHERE session_id = 's1'");
    assert.equal(rows.length, 1, "and no sibling row is opened for it");
  } finally {
    restore();
  }
});

test("a terminal run no worker ever reached is the one shape a retry may open again", async () => {
  // Rewritten. This case used to seed `failure_reason = 'dispatch_failed'` and
  // assert that the retry dispatched -- pinning the string the certain-failure
  // path happens to write rather than the property that made the retry safe.
  // The string is not evidence about anything: two reapers write two of them
  // for one physical situation. `reapOrphanedFatRuns` closes a never-held fat
  // row `dispatch_unconfirmed`; `reapStaleTasks`, which `sweeperTick` runs
  // first and which consults no delivery evidence at all, closes exactly the
  // same row `brain_timeout` -- or `run_budget_exhausted` if the row carried a
  // deadline. A classifier reading the string therefore answered one physical
  // state two ways, and the message was silently dropped in whichever ordering
  // it did not recognise.
  //
  // What actually proves the turn is still owed is on the row and cannot be
  // rewritten: it is terminal, so nothing can act on it again, and no lease, no
  // expiry and no claim was ever taken on it, so nothing ever did. Asserted
  // over every reason the dispatch compensation and the two reapers write,
  // which must all come out the same.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  for (const reason of [
    "dispatch_failed", "dispatch_unconfirmed", "brain_timeout", "run_budget_exhausted",
  ]) {
    await h.reset();
    const published: unknown[] = [];
    const restore = stubPorts(pendingDispatchPorts, published);
    try {
      await seedSession(h, "s1", { agentStatus: "idle" });
      await seedPending(44);
      await seedRun(h, "ktsk_failed", "s1", { status: "failed", dispatch: "doorbell" });
      await h.sql(
        "UPDATE claw_tasks SET failure_reason = $1 WHERE task_id = 'ktsk_failed'", [reason],
      );
      await h.sql("UPDATE claw_pending_messages SET dispatch_task_id = 'ktsk_failed' WHERE id = 44");

      await dispatchPendingMessage({
        sessionId: "s1", pendingId: 44, userId: "u-1", messageId: "claw-3",
        prompt: "hi", workspaceId: "kws_1",
        task: { session_id: "s1", prompt: "hi" } as Record<string, unknown>,
      });

      assert.equal(
        published.length, 1,
        `the turn is dispatched again, because nothing ran (${reason})`,
      );
    } finally {
      restore();
    }
  }
});

test("a terminal run a worker did reach is never dispatched again", async () => {
  // The other side of the same evidence, and the reason the widened answer
  // above is safe. A lease, an expiry or a claim is written only by a Brain
  // taking the row, and nothing ever takes one back -- so a terminal row
  // carrying one is a turn that was served, however it ended and whatever
  // string the row was closed with. `failed` is the shape that matters here: a
  // turn whose agent errored is finished, and re-running it would answer one
  // user message twice.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published);
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(44);
    await seedRun(h, "ktsk_ran", "s1", {
      status: "failed", dispatch: "doorbell", claimCount: 1, leaseOwner: "brain-7",
    });
    // The reason a dispatch compensation writes, on a row a worker plainly had:
    // the string must not be able to resurrect it.
    await h.sql(
      "UPDATE claw_tasks SET failure_reason = 'dispatch_failed' WHERE task_id = 'ktsk_ran'",
    );
    await h.sql("UPDATE claw_pending_messages SET dispatch_task_id = 'ktsk_ran' WHERE id = 44");

    const result = await dispatchPendingMessage({
      sessionId: "s1", pendingId: 44, userId: "u-1", messageId: "claw-3",
      prompt: "hi", workspaceId: "kws_1",
      task: { session_id: "s1", prompt: "hi" } as Record<string, unknown>,
    });

    assert.equal(result.runId, null, "a turn that already ran is not run again");
    assert.deepEqual(published, [], "and nothing goes out for it");
    const rows = await h.sql("SELECT 1 FROM claw_tasks WHERE session_id = 's1'");
    assert.equal(rows.length, 1, "no sibling row is opened either");
  } finally {
    restore();
  }
});

test("a turn the user stopped is not resurrected by the retry", async () => {
  // `cancelled` is answered by status alone, ahead of the reach question, and
  // has to be: a Stop taken before any worker reached the row leaves exactly
  // the shape the case above calls retryable. `SETTLED_REASON_SQL` marks it
  // `cancelled_before_dispatch_confirmed` for this reason; the classification
  // must not need that string either.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published);
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(44);
    await seedRun(h, "ktsk_stopped", "s1", { status: "cancelled", dispatch: "doorbell" });
    await h.sql(
      "UPDATE claw_pending_messages SET dispatch_task_id = 'ktsk_stopped' WHERE id = 44",
    );

    const result = await dispatchPendingMessage({
      sessionId: "s1", pendingId: 44, userId: "u-1", messageId: "claw-3",
      prompt: "hi", workspaceId: "kws_1",
      task: { session_id: "s1", prompt: "hi" } as Record<string, unknown>,
    });

    assert.equal(result.runId, null, "the turn the user stopped stays stopped");
    assert.deepEqual(published, [], "and no copy of it goes out");
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 44")).length, 0,
      "the queue row goes with it, so the drain stops replaying a cancelled turn",
    );
  } finally {
    restore();
  }
});

/**
 * Refuse every receipt statement, which is the one dispatch failure the fat
 * path cannot compensate for: the compensation is itself a receipt write, so it
 * fails too and the row is left exactly as a killed process would leave it --
 * `preparing`, armed, and still saying no publish was ever attempted.
 *
 * Matched on the path the writers set rather than on the word, because the
 * handoff inspection reads the same receipt to tell those two apart.
 */
function breakReceiptWrites(): () => void {
  const query = db.query;
  db.query = (async (text: string, params?: unknown[]) => {
    if (/'\{dispatch_compensation/.test(text)) throw new Error("connection terminated");
    return query(text, params);
  }) as typeof db.query;
  return () => { db.query = query; };
}

test("a fat drain that published and could not delete its queue row opens no second run", async () => {
  // The branch below is the one a deployment without a capability floor takes
  // for every drain, and it used to hand its reservation back before opening --
  // so the queue row named nobody from the insert until the delete, and the
  // delete is exactly the step that can still fail. The turn finishes before
  // the retry arrives here, which is what takes the active-turn uniqueness
  // index out of the way: the reservation is the only thing left that can
  // recognise the hand-off.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published, closedDoorbellBarrier);
  const query = db.query;
  let refuseDelete = true;
  db.query = (async (text: string, params?: unknown[]) => {
    if (refuseDelete && /DELETE FROM claw_pending_messages/.test(text)) {
      refuseDelete = false;
      throw new Error("delete_failed");
    }
    return query(text, params);
  }) as typeof db.query;
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(45);

    await assert.rejects(
      dispatchPendingMessage({ ...DRAIN, pendingId: 45 }),
      "the drain reports the failed delete for the outer nak to retry",
    );
    assert.equal(published.length, 1, "the turn did reach the stream");
    const dispatched = await recordedId(45);
    assert.ok(dispatched, "and the queue row still names the run it went out under");
    db.query = query;
    await h.sql("UPDATE claw_tasks SET status = 'completed' WHERE task_id = $1", [dispatched]);

    const resumed = await dispatchPendingMessage({ ...DRAIN, pendingId: 45 });

    assert.equal(resumed.runId, null, "the turn this drain was sent for has already been run");
    assert.equal(published.length, 1, "so nothing goes out for it a second time");
    const rows = await h.sql("SELECT task_id FROM claw_tasks WHERE session_id = 's1'");
    assert.deepEqual(
      rows.map((row) => row.task_id), [dispatched],
      "and no sibling run is opened to execute the message again",
    );
  } finally {
    db.query = query;
    restore();
  }
});

test("a fat row that never published does not count as the run that owns the turn", async () => {
  // The other half of keeping the reservation. A fat row is inert without its
  // message -- no claimer takes one -- so a row still at `preparing` whose
  // receipt says nothing was ever sent is not a hand-off in progress, it is
  // what a drain that died before its publish left behind. Read as the run that
  // owns the turn it would delete the queue row and shut the gate for a message
  // nothing will ever deliver, and the user's turn would go missing with only
  // the transcript to say it had been asked for.
  //
  // The whole path is walked here rather than only its first step, because the
  // first step cannot finish on its own. While the stranded row is still open
  // no drain may act on it at all -- open is the one state in which a live
  // dispatcher and a dead one look alike (the two cases below), so the answer
  // there is to wait. What actually delivers this turn is the orphan reaper
  // closing the row and the drain after it reading `dispatch_unconfirmed` for
  // what it is -- the reaper's own proof that nothing ran, and the first state
  // of this row in which nothing more is coming for it.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const { reapOrphanedFatRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published, closedDoorbellBarrier);
  const settlement = sweeperPorts.deliverySettlement;
  const restoreReceipts = breakReceiptWrites();
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(46);

    await assert.rejects(dispatchPendingMessage({ ...DRAIN, pendingId: 46 }));
    restoreReceipts();
    const stranded = await recordedId(46);
    const [debris] = await h.sql(
      "SELECT status, metadata->'dispatch_compensation'->>'publish' AS publish"
      + " FROM claw_tasks WHERE task_id = $1",
      [stranded],
    );
    assert.deepEqual(
      [debris?.status, debris?.publish], ["preparing", "not_attempted"],
      "the row is open and still denies that any message for it exists",
    );
    assert.deepEqual(published, [], "nothing was sent under it");

    // What moves the row out of the way. `not_attempted` is proof no message
    // exists, so this reap needs no reading of the durable at all -- and it
    // writes `dispatch_unconfirmed` only through the CAS that requires exactly
    // that proof, which is why the drain below may read it as "nothing ran".
    sweeperPorts.deliverySettlement = async () => null;
    await h.sql(
      "UPDATE claw_tasks SET started_at = NOW() - INTERVAL '10 hours' WHERE task_id = $1",
      [stranded],
    );
    assert.equal(await reapOrphanedFatRuns(), 1, "the orphan reaper closes the never-held row");

    const resumed = await dispatchPendingMessage({ ...DRAIN, pendingId: 46 });

    assert.equal(published.length, 1, "the turn is still owed, so the retry sends it");
    assert.notEqual(resumed.runId, stranded, "under a fresh identity, not the stranded row's");
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 46")).length, 0,
      "and the queue row goes only once the message has actually gone out",
    );
  } finally {
    sweeperPorts.deliverySettlement = settlement;
    restoreReceipts();
    restore();
  }
});

test("a drain that finds a never-published row open waits it out where it stands", async () => {
  // The stranded row from the case above, met by the *next* drain rather than
  // by the reaper. It is still `preparing` and still says nothing was sent, and
  // that is precisely the shape this file may not act on: it is what a drain
  // that died before its publish leaves, and it is equally what a drain that is
  // alive and one statement short of its publish looks like. So the drain here
  // stands down keeping both the message and the reservation.
  //
  // It used to call this row retryable and rotate the reservation, on the
  // argument that `idx_tasks_chat_turn_unique` would refuse any sibling run
  // while the stranded row was open, so the answer cost nothing. The refusal is
  // real -- nothing is opened here either -- but the rotation was committed to
  // the queue row before the insert was refused, and that is the whole cost: the
  // turn's durable identity is the queue row's memory of which run is its own,
  // and a queue row pointing at an id nothing was ever opened under has no
  // memory at all. The case after this one is what that costs.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published, closedDoorbellBarrier);
  const restoreReceipts = breakReceiptWrites();
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(48);
    await assert.rejects(dispatchPendingMessage({ ...DRAIN, pendingId: 48 }));
    restoreReceipts();
    const stranded = await recordedId(48);

    const waited = await dispatchPendingMessage({ ...DRAIN, pendingId: 48 });

    assert.equal(waited.runId, null, "nothing here is a hand-off this drain may finish");
    assert.deepEqual(published, [], "nothing goes out while the stranded row is open");
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 48")).length, 1,
      "and the message is still queued, which is the only thing that remembers it is owed",
    );
    assert.equal(
      await recordedId(48), stranded,
      "still named by the run that is in the way, so the next drain judges that run",
    );
    const rows = await h.sql("SELECT task_id FROM claw_tasks WHERE session_id = 's1'");
    assert.deepEqual(
      rows.map((row) => row.task_id), [stranded],
      "no second row is opened beside it either",
    );
  } finally {
    restoreReceipts();
    restore();
  }
});

test("a fat publish that may not have landed keeps its message until the durable settles", async () => {
  // The other thing a retained reservation changed. A publish that times out
  // leaves the row saying `attempted` and naming no message: it may be on the
  // stream, and it may have reached nothing at all. Read as the run that owns
  // the turn, the next drain deletes the queue row for a message that might not
  // exist -- and no claimer takes a fat row, so all that followed was the
  // orphan reaper closing it as `dispatch_unconfirmed` an hour later with the
  // user's turn never executed and nothing left that remembered it was asked
  // for. The queue row is that memory, so an unsettled delivery keeps it.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const { reapOrphanedFatRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published, closedDoorbellBarrier);
  const settlement = sweeperPorts.deliverySettlement;
  const publish = pendingDispatchPorts.publish;
  let timeOut = true;
  pendingDispatchPorts.publish = (async (...args: [string, string, string]) => {
    // Not a refusal the server sent back: nothing here says whether the message
    // arrived, which is the whole of the case.
    if (timeOut) { timeOut = false; throw new Error("no response from the stream in time"); }
    return publish(...args);
  }) as typeof pendingDispatchPorts.publish;
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(47);

    await assert.rejects(
      dispatchPendingMessage({ ...DRAIN, pendingId: 47 }),
      "an ambiguous publish is the outer nak's to retry",
    );
    const ambiguous = await recordedId(47);
    const [row] = await h.sql(
      "SELECT status, metadata->'dispatch_compensation'->>'publish' AS publish,"
      + " metadata->>'dispatch_seq' AS seq FROM claw_tasks WHERE task_id = $1",
      [ambiguous],
    );
    assert.deepEqual(
      [row?.status, row?.publish, row?.seq], ["preparing", "attempted", null],
      "the row is open, says a publish was attempted, and names no message it reached",
    );
    assert.deepEqual(published, [], "and nothing was recorded as sent");

    const resumed = await dispatchPendingMessage({ ...DRAIN, pendingId: 47 });

    assert.equal(resumed.runId, null, "a delivery in doubt is not a hand-off this drain may finish");
    assert.equal(
      await recordedId(47), ambiguous,
      "the queue row stays, still naming the run whose message is in doubt",
    );
    assert.deepEqual(
      published, [],
      "and no second copy goes out while the first might be on the stream",
    );

    // The durable answers it: the whole stream has settled past anything this
    // row could have published, and no Brain ever took a lease under it.
    sweeperPorts.deliverySettlement = async () => ({ ackFloor: 200, lastSeq: 200 });
    await h.sql(
      "UPDATE claw_tasks SET started_at = NOW() - INTERVAL '10 hours' WHERE task_id = $1",
      [ambiguous],
    );
    assert.equal(await reapOrphanedFatRuns(), 1, "so the ambiguous row is compensated");

    const retried = await dispatchPendingMessage({ ...DRAIN, pendingId: 47 });

    assert.equal(published.length, 1, "the turn the reaper proved never ran is finally sent");
    assert.notEqual(retried.runId, ambiguous, "under a fresh identity, not the compensated row's");
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 47")).length, 0,
      "and only now is the queue row done with",
    );
  } finally {
    sweeperPorts.deliverySettlement = settlement;
    restore();
  }
});

test("a drain that lands inside a live dispatch leaves the reservation where it is", async () => {
  // The window the classification above is written against, driven rather than
  // described: the second drain runs from inside the first one's
  // `recordPublishState`, which is to say after the first has committed its run
  // row and before it has armed it to publish. The row it finds is open,
  // unheld, and still denying that any message exists -- indistinguishable from
  // the stranded row of the case above, except that this one is about to send.
  //
  // Answering that with "retryable" reproduced the double execution the
  // reservation was introduced to prevent, and it did so through the index that
  // was supposed to bound it: the racing drain rotated the queue row onto a
  // fresh id, `idx_tasks_chat_turn_unique` refused the run it wanted to open
  // under it, and the rotation stayed committed anyway. The live dispatcher
  // then published and failed its DELETE -- the one step that still can -- and
  // the queue row was left naming an id no run had ever been opened under. The
  // drain after it read "absent", found the real run terminal by then and so
  // the index out of its way, and ran the user's turn a second time.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published, closedDoorbellBarrier);
  const query = db.query;
  let raced = false;
  let refuseDelete = true;
  let concurrent: { runId: string | null } | Error | null = null;
  db.query = (async (text: string, params?: unknown[]) => {
    if (!raced && /dispatch_compensation,publish/.test(text) && params?.[1] === "attempted") {
      raced = true;
      concurrent = await dispatchPendingMessage({ ...DRAIN, pendingId: 49 })
        .catch((err: unknown) => err as Error);
    }
    if (refuseDelete && /DELETE FROM claw_pending_messages/.test(text)) {
      refuseDelete = false;
      throw new Error("delete_failed");
    }
    return query(text, params);
  }) as typeof db.query;
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(49);

    await assert.rejects(dispatchPendingMessage({ ...DRAIN, pendingId: 49 }));
    db.query = query;
    assert.ok(raced, "the second drain ran inside the first one's publish window");
    assert.equal(published.length, 1, "the live dispatcher's turn did reach the stream");
    const rows = await h.sql("SELECT task_id FROM claw_tasks WHERE session_id = 's1'");
    const live = rows[0]?.task_id as string;
    assert.ok(!(concurrent instanceof Error), `the racing drain stood down: ${concurrent}`);
    assert.equal(
      await recordedId(49), live,
      "the queue row still names the run that is publishing for it",
    );

    await h.sql("UPDATE claw_tasks SET status = 'completed' WHERE task_id = $1", [live]);
    const resumed = await dispatchPendingMessage({ ...DRAIN, pendingId: 49 });

    assert.equal(resumed.runId, null, "the turn has already run");
    assert.equal(published.length, 1, "so no second copy of it goes out");
    const after = await h.sql("SELECT task_id FROM claw_tasks WHERE session_id = 's1'");
    assert.deepEqual(after.map((row) => row.task_id), [live], "and there is only ever one run");
  } finally {
    db.query = query;
    restore();
  }
});

test("a never-published row the deadline backstop closed is still the turn's to retry", async () => {
  // The ordering the classification may not depend on, driven end to end.
  // `sweeperTick` runs `reapStaleTasks` before `reapOrphanedFatRuns`, and with
  // `RUN_ROWS_SWEEPABLE` set the first one reaches chat rows. A fat drain that
  // died between its insert and its publish leaves a row the never-claimed arm
  // matches on `started_at` alone -- it consults no delivery evidence, no
  // receipt and no holder beyond the null lease -- so the backstop closes it
  // `brain_timeout` and the orphan reaper, which would have written
  // `dispatch_unconfirmed`, finds nothing left to close.
  //
  // Nothing about the turn is different: no message was ever published for it
  // and no worker ever held it. Only the string on the row is different, and
  // the classification read the string: the same stranded turn was retried when
  // one reaper won and deleted -- silently, with the user's message gone and
  // the transcript the only place it had ever existed -- when the other did.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const { reapStaleTasks, reapOrphanedFatRuns, sweeperPorts } =
    await import("../src/tasks/sweeper.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published, closedDoorbellBarrier);
  const settlement = sweeperPorts.deliverySettlement;
  const restoreReceipts = breakReceiptWrites();
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(50);

    await assert.rejects(dispatchPendingMessage({ ...DRAIN, pendingId: 50 }));
    restoreReceipts();
    const stranded = await recordedId(50);
    assert.deepEqual(published, [], "nothing was sent under the stranded row");

    sweeperPorts.deliverySettlement = async () => null;
    await h.sql(
      "UPDATE claw_tasks SET started_at = NOW() - INTERVAL '10 hours' WHERE task_id = $1",
      [stranded],
    );
    assert.equal(await reapStaleTasks(), 1, "the deadline backstop gets there first");
    const [closed] = await h.sql(
      "SELECT status, failure_reason FROM claw_tasks WHERE task_id = $1", [stranded],
    );
    assert.deepEqual(
      [closed?.status, closed?.failure_reason], ["failed", "brain_timeout"],
      "under the reason that reaper writes, not the one the orphan reaper does",
    );
    assert.equal(
      await reapOrphanedFatRuns(), 0,
      "and the orphan reaper never sees the row, so `dispatch_unconfirmed` is never written",
    );

    const resumed = await dispatchPendingMessage({ ...DRAIN, pendingId: 50 });

    assert.equal(published.length, 1, "the turn nothing ever delivered is still sent");
    assert.notEqual(resumed.runId, stranded, "under a fresh identity, not the closed row's");
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 50")).length, 0,
      "and the queue row goes only once the message has actually gone out",
    );
  } finally {
    sweeperPorts.deliverySettlement = settlement;
    restoreReceipts();
    restore();
  }
});

test("a drain refused by admission does not end a turn another drain dispatched", async () => {
  // The selection that finds a queue row takes no lock, so two drains can both
  // read `absent` for the id they share. One of them opens, publishes and
  // deletes; the other resumes and walks into admission -- where, with a hard
  // ceiling in force, it is the first one's now-open run that puts the fleet
  // over the limit. Its refusal publishes an `exec_complete` for this session
  // and message, and a completion that names no row is matched by
  // `closeUnnamedChatRun` on `(session_id, message_id)` alone: it failed the
  // run that had just been dispatched successfully. The user's turn was on the
  // stream, about to be executed, and the API told the session it had ended.
  //
  // The reservation protected the INSERT from this drain. It did not protect
  // this earlier exit, which never reaches the insert at all -- so the refusal
  // reads the hand-off once more, and finds the turn is no longer its to refuse.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published, closedDoorbellBarrier);
  const admit = pendingDispatchPorts.admit;
  const publishSessionEvent = pendingDispatchPorts.publishSessionEvent;
  const events: Record<string, unknown>[] = [];
  pendingDispatchPorts.publishSessionEvent = (async (
    _sessionId: string, event: Record<string, unknown>,
  ) => { events.push(event); }) as typeof pendingDispatchPorts.publishSessionEvent;
  let raced = false;
  let winner: { runId: string | null } | null = null;
  pendingDispatchPorts.admit = (async (ask: never, client: never) => {
    if (!raced) {
      raced = true;
      // The sibling drain, resuming from the same reservation.
      winner = await dispatchPendingMessage({ ...DRAIN, pendingId: 51 });
      // Its open run is what the ceiling now counts.
      return { kind: "reject", reason: "runs_hard_limit" } as never;
    }
    return await admit(ask, client);
  }) as typeof pendingDispatchPorts.admit;
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(51);

    const stale = await dispatchPendingMessage({ ...DRAIN, pendingId: 51 });

    assert.ok(raced, "the refused drain ran after the other had published");
    assert.equal(published.length, 1, "one turn reached the stream");
    assert.deepEqual(
      events, [],
      "and no terminal event was published that could be applied to the run carrying it",
    );
    assert.equal(
      stale.runId, (winner as unknown as { runId: string }).runId,
      "the refused drain reports the hand-off it found instead of refusing it",
    );
    const rows = await h.sql(
      "SELECT task_id, status FROM claw_tasks WHERE session_id = 's1'",
    );
    assert.deepEqual(
      rows.map((row) => [row.task_id, row.status]),
      [[(winner as unknown as { runId: string }).runId, "preparing"]],
      "the dispatched run is untouched, and no second row was opened beside it",
    );
  } finally {
    pendingDispatchPorts.admit = admit;
    pendingDispatchPorts.publishSessionEvent = publishSessionEvent;
    restore();
  }
});

test("a turn the fleet really has no room for is still refused, and named", async () => {
  // The control for the case above: a refusal that withdraws itself whenever it
  // is inconvenient would pass that assertion and leave every over-ceiling turn
  // queued for ever. With no run under the reservation there is nothing the
  // completion can be absorbed by, so the refusal goes out -- and it names the
  // reserved id, which is what stops a sibling row being read as its subject.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published, closedDoorbellBarrier);
  const admit = pendingDispatchPorts.admit;
  const publishSessionEvent = pendingDispatchPorts.publishSessionEvent;
  const events: Record<string, unknown>[] = [];
  pendingDispatchPorts.publishSessionEvent = (async (
    _sessionId: string, event: Record<string, unknown>,
  ) => { events.push(event); }) as typeof pendingDispatchPorts.publishSessionEvent;
  pendingDispatchPorts.admit = (async () =>
    ({ kind: "reject", reason: "runs_hard_limit" })) as unknown as typeof pendingDispatchPorts.admit;
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(52);
    const reserved = await (async () => {
      const result = await dispatchPendingMessage({ ...DRAIN, pendingId: 52 });
      return result;
    })();

    assert.equal(reserved.runId, null, "nothing was dispatched");
    assert.deepEqual(published, [], "and nothing reached the stream");
    assert.deepEqual(
      events.map((e) => e.type), ["AssistantMessage", "ResultMessage", "exec_complete"],
      "the user is told the turn ended",
    );
    const named = new Set(events.map((e) => e.task_id));
    assert.equal(named.size, 1, "every event of the refusal names one run");
    assert.ok([...named][0], "and it is the id the queue row reserved, not nothing at all");
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_tasks WHERE session_id = 's1'")).length, 0,
      "no row was opened for a turn that was refused",
    );
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 52")).length, 0,
      "and the queue row does not replay a hard refusal",
    );
  } finally {
    pendingDispatchPorts.admit = admit;
    pendingDispatchPorts.publishSessionEvent = publishSessionEvent;
    restore();
  }
});

/**
 * Persist an event the way the durable consumer does, since there is no
 * consumer here.
 *
 * `publishSessionEvent` hands the event to JetStream; the row in
 * `claw_session_events` is written by `events/consumer.ts`, which inserts every
 * event BEFORE it processes it. That ordering is the whole reason a drain
 * re-entered by a completion can see the announcement that triggered it, so the
 * stand-in has to keep it: insert on publish, synchronously, with the same
 * `event` and `data` columns the consumer writes.
 */
function recordAnnouncements(
  ports: { publishSessionEvent: unknown },
  seen: Record<string, unknown>[],
): () => void {
  const publishSessionEvent = ports.publishSessionEvent;
  let seq = 0;
  ports.publishSessionEvent = (async (
    sessionId: string, event: Record<string, unknown>,
  ) => {
    seen.push(event);
    await h.sql(
      `INSERT INTO claw_session_events (event_id, session_id, event, data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [`claw-${++seq}`, sessionId, String(event.type ?? "message"), JSON.stringify(event)],
    );
  });
  return () => { ports.publishSessionEvent = publishSessionEvent; };
}

test("a row a completed sibling closed as a duplicate is not a turn still owed", async () => {
  // Unclaimed and `failed` is not by itself proof that the turn is still owed,
  // and this is the first of the two shapes that prove it. A duplicate row for
  // a turn is closed by `closeDuplicateDispatchSiblings`, which runs from
  // `closeChatRun` *after* a sibling carried the same message to completion. It
  // takes no lease and no claim -- it never had one, which is precisely why the
  // sibling was the one that ran -- so the row it leaves is terminal, unheld,
  // and until now read as "nobody ran this, send it again".
  //
  // Which sends it again. The sibling that answered the turn is terminal by
  // then, so it no longer holds `idx_tasks_chat_turn_unique` against a
  // replacement, and the retry's own doorbell row is a row claim-next will
  // execute whatever the stream does with the wakeup -- the dedup window stops
  // the second wakeup, not the second run. One user message, two answers.
  //
  // What settles it is the sibling itself: a row for this session and this
  // message that a worker held and that reached a terminal state is the turn's
  // answer, durable in `claw_tasks` and rewritable by nothing. No completion
  // event is seeded here on purpose -- production would have one, since the
  // duplicate close runs inside `handleComplete` -- so that the sibling is the
  // only evidence this case can pass on.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published);
  const query = db.query;
  let refuseDelete = true;
  db.query = (async (text: string, params?: unknown[]) => {
    if (refuseDelete && /DELETE FROM claw_pending_messages/.test(text)) {
      refuseDelete = false;
      throw new Error("delete_failed");
    }
    return query(text, params);
  }) as typeof db.query;
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(53);

    await assert.rejects(
      dispatchPendingMessage({ ...DRAIN, pendingId: 53 }),
      "the drain publishes and then cannot delete its queue row",
    );
    db.query = query;
    const spare = await recordedId(53);
    assert.ok(spare, "so the queue row survives, still naming the run it opened");

    // The row that actually carried this turn. It is `preparing` while the
    // spare sits at `queued`, which is how both can exist under the active-turn
    // index at once -- the index's predicate does not include `queued`.
    await seedRun(h, "ktsk_sibling", "s1", {
      status: "preparing", dispatch: "doorbell", claimCount: 1, messageId: "claw-1",
    });
    await closeChatRun("s1", "claw-1", "completed", undefined, { taskId: "ktsk_sibling" });
    const [duplicate] = await h.sql(
      "SELECT status, failure_reason, COALESCE(claim_count, 0) AS claims, lease_owner"
      + " FROM claw_tasks WHERE task_id = $1",
      [spare],
    );
    assert.deepEqual(
      [duplicate?.status, duplicate?.failure_reason, Number(duplicate?.claims), duplicate?.lease_owner],
      ["failed", "duplicate_dispatch_row", 0, null],
      "the sibling close leaves exactly the terminal, never-held shape",
    );

    const resumed = await dispatchPendingMessage({ ...DRAIN, pendingId: 53 });

    assert.equal(published.length, 1, "the turn a sibling already answered is not sent again");
    assert.equal(resumed.runId, null, "and this drain reports no run of its own");
    assert.equal(
      await recordedId(53), null,
      "the reservation is not rotated onto a fresh identity either",
    );
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 53")).length, 0,
      "the queue row goes, because the message it remembers has been answered",
    );
    const rows = await h.sql(
      "SELECT task_id FROM claw_tasks WHERE session_id = 's1' ORDER BY task_id",
    );
    assert.deepEqual(
      rows.map((row) => row.task_id).sort(), [spare, "ktsk_sibling"].sort(),
      "and no third row is opened to run the message a second time",
    );
  } finally {
    db.query = query;
    restore();
  }
});

test("a queue timeout the user was already told about is not dispatched again", async () => {
  // The second shape, and the one with no sibling anywhere. A doorbell row that
  // waits out `RUN_QUEUE_MAX_SEC` is closed by `reapExpiredQueuedRuns`, which
  // never claims it -- the whole point is that nothing claimed it -- and then
  // ANNOUNCES the turn's end: an AssistantMessage saying the wait ran out, a
  // ResultMessage, and an `exec_complete` carrying `failed: true`. The user has
  // their answer and has been told, in those words, that they may send it
  // again.
  //
  // So the row is terminal and unheld, and the turn is nevertheless not owed.
  // Retrying it dispatches a turn the session has already ended, behind a
  // completion the consumer has already processed -- and the reservation is
  // rotated off the row the announcement named, so nothing afterwards connects
  // the two.
  //
  // The evidence is the announcement, which is durable in `claw_session_events`
  // and is the same fact `completionAlreadyPublished` reads two hundred lines
  // above, for the same reason: a message with a completion recorded against it
  // is a message whose turn has ended. No sibling row is seeded here, so the
  // announcement is the only thing that can carry this case.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const { reapExpiredQueuedRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published);
  const announced: Record<string, unknown>[] = [];
  const restoreAnnouncements = recordAnnouncements(sweeperPorts, announced);
  const query = db.query;
  let refuseDelete = true;
  db.query = (async (text: string, params?: unknown[]) => {
    if (refuseDelete && /DELETE FROM claw_pending_messages/.test(text)) {
      refuseDelete = false;
      throw new Error("delete_failed");
    }
    return query(text, params);
  }) as typeof db.query;
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(54);

    await assert.rejects(
      dispatchPendingMessage({ ...DRAIN, pendingId: 54 }),
      "the drain publishes the wakeup and then cannot delete its queue row",
    );
    db.query = query;
    const queued = await recordedId(54);
    assert.ok(queued, "the queue row still names the run that was opened for it");

    await h.sql(
      "UPDATE claw_tasks SET queued_at = NOW() - INTERVAL '10 hours' WHERE task_id = $1",
      [queued],
    );
    assert.equal(await reapExpiredQueuedRuns(), 1, "nothing ever claimed it, so the queue reaps it");
    assert.deepEqual(
      announced.map((event) => event.type),
      ["AssistantMessage", "ResultMessage", "exec_complete"],
      "and the user is told the turn ended",
    );
    const [timedOut] = await h.sql(
      "SELECT status, failure_reason, COALESCE(claim_count, 0) AS claims, lease_owner"
      + " FROM claw_tasks WHERE task_id = $1",
      [queued],
    );
    assert.deepEqual(
      [timedOut?.status, timedOut?.failure_reason, Number(timedOut?.claims), timedOut?.lease_owner],
      ["failed", "queue_timeout", 0, null],
      "leaving the same terminal, never-held shape the duplicate close leaves",
    );

    const resumed = await dispatchPendingMessage({ ...DRAIN, pendingId: 54 });

    assert.equal(published.length, 1, "the turn the user was told had ended is not sent again");
    assert.equal(resumed.runId, null, "and this drain reports no run of its own");
    assert.equal(
      await recordedId(54), null,
      "the reservation is not rotated onto a fresh identity either",
    );
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 54")).length, 0,
      "the queue row goes with the turn the announcement closed",
    );
    const rows = await h.sql("SELECT task_id FROM claw_tasks WHERE session_id = 's1'");
    assert.deepEqual(
      rows.map((row) => row.task_id), [queued],
      "and no second row is opened to answer the message twice",
    );
  } finally {
    db.query = query;
    restoreAnnouncements();
    restore();
  }
});

test("an announcement for a different message is not this turn's answer", async () => {
  // The positive control for the case above, and the one that stops the new
  // evidence from becoming "any completion on this session ends every queued
  // turn". A session accumulates a completion per turn, so a predicate keyed on
  // the session alone would read the PREVIOUS turn's answer as this one's and
  // drop every message that arrived behind it -- which is the silent drop this
  // whole classification exists to prevent, reintroduced from the other side.
  //
  // Same terminal, never-held row as the two cases above; the only difference
  // is that the recorded completion names another message.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published);
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(55);
    await seedRun(h, "ktsk_unreached", "s1", {
      status: "failed", dispatch: "doorbell", messageId: "claw-1",
    });
    await h.sql(
      "UPDATE claw_tasks SET failure_reason = 'queue_timeout' WHERE task_id = 'ktsk_unreached'",
    );
    await h.sql(
      "UPDATE claw_pending_messages SET dispatch_task_id = 'ktsk_unreached' WHERE id = 55",
    );
    // The turn before this one, answered and recorded, as every live session has.
    await h.sql(
      `INSERT INTO claw_session_events (event_id, session_id, event, data)
       VALUES ('claw-9', 's1', 'exec_complete', jsonb_build_object('message_id', 'claw-0'))`,
    );

    const resumed = await dispatchPendingMessage({ ...DRAIN, pendingId: 55 });

    assert.equal(published.length, 1, "this turn has no answer of its own, so it is sent");
    assert.notEqual(resumed.runId, "ktsk_unreached", "under a fresh identity, not the closed row's");
    assert.equal(
      (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 55")).length, 0,
      "and the queue row goes only once the message has actually gone out",
    );
  } finally {
    restore();
  }
});
