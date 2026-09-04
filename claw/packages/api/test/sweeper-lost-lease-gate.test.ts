// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What happens to the conversation when its run is given up on.
 *
 * Closing the row answers "did that run finish". Whether the session may accept
 * another message is a different column, `claw_sessions.agent_status`, and the
 * lease reaper used to leave it alone -- so a pod death reclaimed the row in
 * minutes and left the conversation gated until the hourly session reaper came
 * past. Messages sent in between are parked rather than refused, so from the
 * outside the session had simply stopped answering.
 *
 * The release is deliberately narrow, because a session outlives any one turn:
 * the run being reaped is not necessarily the run holding the gate. Narrow
 * enough that one stray non-terminal row defeats it, which is how a replayed
 * dispatch -- two rows for one message, only one of them ever leased -- put the
 * hour back that this release exists to remove.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { closeChatRun } from "../src/tasks/chat-run.js";
import { db } from "../src/infra/db.js";
import { reapLostLeases, sweeperPorts } from "../src/tasks/sweeper.js";

interface SeenQuery { sql: string; params: unknown[] }

/**
 * Statements and publishes in the order they actually happened.
 *
 * Two of the properties this file checks are orderings across the two -- the
 * announce has to precede the gate release -- and a per-side list cannot say
 * which came first. Recorded by both stubs into one array instead.
 */
type Step =
  | { kind: "query"; sql: string }
  | { kind: "event"; type: string };

const originalQuery = db.query;
const originalPublish = sweeperPorts.publishSessionEvent;
after(() => {
  db.query = originalQuery;
  sweeperPorts.publishSessionEvent = originalPublish;
});

let timeline: Step[] = [];
let published: Array<Record<string, unknown>> = [];

/**
 * Answer the reap with `reaped`, the sibling close with `closed`, and anything
 * else with nothing.
 *
 * `closed` defaults to empty, which is the common case and also the one that
 * never reaches the statement's own reporting branch -- so the tests that care
 * about that branch pass rows here rather than trusting it unexecuted.
 *
 * `failOn` makes the matching statement throw, which is how the durability
 * tests reproduce a database that fails after the row has already been closed.
 *
 * Publishing is stubbed here rather than per-test because every fixture below
 * now carries the `failure_reason` the reap returns, so the announce runs in
 * tests that were written before it existed; left unstubbed they would reach
 * the real JetStream client.
 */
function stubDb(
  reaped: Array<Record<string, unknown>>,
  closed: Array<Record<string, unknown>> = [],
  released: Array<Record<string, unknown>> = [],
  failOn?: RegExp,
): SeenQuery[] {
  const seen: SeenQuery[] = [];
  timeline = [];
  published = [];
  sweeperPorts.publishSessionEvent = async (_sessionId, event) => {
    published.push(event);
    timeline.push({ kind: "event", type: String(event.type) });
  };
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    timeline.push({ kind: "query", sql });
    if (failOn?.test(sql)) throw new Error("db is down");
    // The reap itself is the statement without an alias; the sibling close is
    // `UPDATE claw_tasks t` and reports its own rows.
    if (sql.startsWith("UPDATE claw_tasks SET")) {
      return { rows: reaped, rowCount: reaped.length };
    }
    if (sql.startsWith("UPDATE claw_tasks t SET")) {
      return { rows: closed, rowCount: closed.length };
    }
    if (sql.startsWith("UPDATE claw_sessions")) {
      return { rows: released, rowCount: released.length };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  return seen;
}

/** Every column the reap's RETURNING hands the code below, as a real row has them. */
const CHAT_RUN = {
  task_id: "t-1", session_id: "s-1", origin: "chat",
  lease_owner: "brain-a", message_id: "claw-pending-7",
  sandbox_workload_id: null, failure_reason: "worker_lost",
  prompt: "optimise the kernel", user_id: "u-1",
};
const DAG_RUN = {
  task_id: "t-2", session_id: "s-2", origin: "dag_node",
  lease_owner: "brain-a", message_id: null,
  sandbox_workload_id: null, failure_reason: "worker_lost",
  prompt: null, user_id: null,
};

function sessionUpdates(seen: SeenQuery[]): SeenQuery[] {
  return seen.filter((q) => q.sql.includes("UPDATE claw_sessions"));
}

/** The statement that closes the rows a retried dispatch left unclaimed. */
function siblingClose(seen: SeenQuery[]): SeenQuery | undefined {
  return seen.find((q) => q.sql.startsWith("UPDATE claw_tasks t SET"));
}

test("a conversation whose run was given up on can be spoken to again", async () => {
  const seen = stubDb([CHAT_RUN]);

  assert.equal(await reapLostLeases(), 1);
  const updates = sessionUpdates(seen);
  assert.equal(updates.length, 1, "the row was closed but the gate was left shut");
  assert.match(updates[0].sql, /agent_status = 'idle'/);
  assert.deepEqual(updates[0].params, [["s-1"]]);
});

test("the gate stays shut while anything is still executing", async () => {
  // The user may have started another turn since. Freeing the gate under it
  // would let a second message dispatch into a session that is mid-reply, which
  // is the same hazard that keeps the deadline backstop away from chat rows.
  const seen = stubDb([CHAT_RUN]);
  await reapLostLeases();

  const [update] = sessionUpdates(seen);
  assert.match(update.sql, /NOT EXISTS/);
  assert.match(update.sql, /t\.status IN \('queued','preparing','running','cancelling'\)/);
  assert.match(update.sql, /s\.agent_status = 'running'/,
    "an idle or failed session is not this reaper's to overwrite");
  assert.match(update.sql, /s\.deleted_at IS NULL/);
});

test("a graph node's session is not touched, because it never held the gate", async () => {
  // `agent_status` is the conversation's gate: only chat dispatch sets it, so a
  // DAG node reaching for it would be writing to a column it knows nothing
  // about -- on a session that may well be busy with a real turn.
  const seen = stubDb([DAG_RUN]);

  assert.equal(await reapLostLeases(), 1);
  assert.deepEqual(sessionUpdates(seen), []);
});

test("a run the user stopped is archived as cancelled, not as a worker we lost", async () => {
  // This reaper reaches a `cancelling` row minutes after the stop, well before
  // the deadline backstop that has the same branch -- so it is the one that
  // decides how a stop whose worker died before confirming it is recorded.
  // Without the branch the row goes `failed / worker_lost`: the UI shows the
  // user's own cancellation as a failure, and the operator's worker-loss count
  // gains a death that never happened.
  const seen = stubDb([]);
  await reapLostLeases();

  const sql = seen[0]!.sql;
  assert.match(sql, /SET status = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'failed' END/);
  assert.match(sql, /failure_reason = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'worker_lost' END/);
  const errorMessage = /error_message = CASE (.*?) END, completed_at/.exec(sql)?.[1];
  assert.ok(errorMessage, "the error_message CASE has moved; this test is reading the wrong text");
  assert.match(errorMessage, /WHEN status = 'cancelling' THEN 'the run was cancelled/,
    "the message an operator reads first has to agree with the status beside it");
});

test("the messages that piled up behind the gate are counted, not silently left", async () => {
  // Releasing the gate does not itself answer them: draining is
  // handleComplete's job, and this statement publishes nothing. The announce a
  // few lines earlier does reach handleComplete for a worker_lost row, but only
  // once the gate is open for it, and the rows deliberately left unannounced --
  // a cancelled reap -- still have nobody to drain them. So the one thing this
  // path can do for certain is say how many are waiting.
  const seen = stubDb([CHAT_RUN], [], [{ session_id: "s-1" }]);
  await reapLostLeases();

  const pending = seen.find((q) => q.sql.includes("claw_pending_messages"));
  assert.ok(pending, "a released session with parked messages is the case worth reporting");
  assert.match(pending.sql, /COUNT\(\*\)::int AS n/);
  assert.deepEqual(pending.params, [["s-1"]],
    "counted for the sessions this reap released, not for the whole table");
});

test("reaping nothing asks nothing", async () => {
  const seen = stubDb([]);

  assert.equal(await reapLostLeases(), 0);
  assert.equal(seen.length, 1, "a tick that found no dead run should cost one query");
});

test("the row a replayed dispatch left behind is closed with the one that was leased", async () => {
  // The drain deletes the queue row after publishing, so a throw in between
  // replays the whole handler and opens a second run row for one message. The
  // republish is dropped as a duplicate, so only the first row is ever leased --
  // and this reaper matches on an expired lease, so it used to close that one
  // and leave the other at `preparing` forever.
  const seen = stubDb([CHAT_RUN]);
  await reapLostLeases();

  const close = siblingClose(seen);
  assert.ok(close, "the spare row is what holds the gate shut; something has to close it");
  assert.match(close.sql, /t\.lease_expires_at IS NULL/,
    "a row with a lease belongs to a worker and is the reap's business, not this one's");
  assert.match(close.sql, /t\.metadata->>'message_id' = sibling\.message_id/);
  assert.match(close.sql, /t\.origin = 'chat'/);
  assert.match(close.sql, /t\.status IN \('queued','preparing','running','cancelling'\)/,
    "idempotent: a row already closed by the completion event is left as it is");
  assert.deepEqual(close.params, [["s-1"], ["claw-pending-7"]]);
});

test("a never-leased row for a different message is not this reaper's to close", async () => {
  // The narrowness is the safety argument. Nothing writes `lease_expires_at`
  // until a worker renews, so every healthy run has a NULL lease for its first
  // few seconds; closing unleased chat rows by session would end whichever turn
  // the user had just started.
  const seen = stubDb([CHAT_RUN]);
  await reapLostLeases();

  const close = siblingClose(seen)!;
  assert.match(close.sql, /FROM unnest\(\$1::text\[\], \$2::text\[\]\) AS sibling\(session_id, message_id\)/,
    "the pair is what selects a row, so a different message in the same session misses");
  assert.deepEqual(close.params[1], ["claw-pending-7"],
    "only the message the reaped row was dispatched under");
});

test("the spare row is not archived as a worker that was lost", async () => {
  // No worker ever held it, so `worker_lost` would be a fabricated cause on the
  // one row in the pair that has no history at all.
  const seen = stubDb([CHAT_RUN]);
  await reapLostLeases();

  const close = siblingClose(seen)!;
  assert.match(close.sql, /failure_reason = 'dispatch_retried'/);
  assert.doesNotMatch(close.sql, /worker_lost/);
});

test("the gate is released after the spare row is closed, not before", async () => {
  // The release refuses to act while the session has anything non-terminal left,
  // which the spare row is until the statement above runs. In the other order
  // the release does nothing and the conversation waits for the hourly reaper --
  // the exact wait it exists to remove.
  const seen = stubDb([CHAT_RUN]);
  await reapLostLeases();

  const closeAt = seen.findIndex((q) => q.sql.startsWith("UPDATE claw_tasks t SET"));
  const releaseAt = seen.findIndex((q) => q.sql.includes("UPDATE claw_sessions"));
  assert.ok(closeAt >= 0 && releaseAt >= 0);
  assert.ok(closeAt < releaseAt, "releasing first releases nothing");
});

test("a reaped row with no recorded message id asks for no siblings", async () => {
  // Matching on a NULL message id would pair every such row with every other,
  // which is the one way this statement could reach a run nobody replayed.
  const seen = stubDb([{ ...CHAT_RUN, message_id: null }]);
  await reapLostLeases();

  assert.equal(siblingClose(seen), undefined);
  assert.equal(sessionUpdates(seen).length, 1, "the gate release is not conditional on that");
});

test("the two arrays reach unnest paired, with the unidentifiable rows dropped", async () => {
  // `unnest($1, $2)` pairs the arrays by position, so a row dropped from one and
  // not the other does not merely lose itself: every pair after it shifts, and
  // the statement then closes rows for messages that were never replayed, in
  // sessions that were never reaped. The one reap that has to drop out is the
  // row with no recorded message id, and it has to drop out of both.
  const seen = stubDb([
    { ...CHAT_RUN, task_id: "t-a", session_id: "s-a", message_id: "claw-pending-1" },
    { ...CHAT_RUN, task_id: "t-b", session_id: "s-b", message_id: null },
    { ...CHAT_RUN, task_id: "t-c", session_id: "s-c", message_id: "claw-pending-3" },
  ]);
  await reapLostLeases();

  const close = siblingClose(seen)!;
  assert.deepEqual(
    close.params,
    [["s-a", "s-c"], ["claw-pending-1", "claw-pending-3"]],
    "the surviving pairs must still be (s-a, 1) and (s-c, 3), in that order",
  );
});

test("closing spare rows is not counted as a run given up on", async () => {
  // The count this returns drives the sweeper's own logging and its idea of how
  // many runs were lost. A spare row was never a run, so folding it in would
  // double every replayed dispatch -- and the reporting branch itself only runs
  // when the statement matched something, which is the case a stub answering
  // `rowCount: 0` can never reach.
  const seen = stubDb(
    [CHAT_RUN],
    [{ task_id: "t-spare-1" }, { task_id: "t-spare-2" }],
  );

  assert.equal(await reapLostLeases(), 1, "one lease expired, whatever it left behind");
  assert.ok(siblingClose(seen), "the close still has to be attempted");
  assert.equal(sessionUpdates(seen).length, 1,
    "and the gate release still follows it -- one statement, all sessions at once");
});

// --- Defect fix: a reaped worker_lost chat run must still record its turn. ---
// recordCompletionTurns (the sole writer of claw_conversation_turns) runs only
// on exec_complete; reapLostLeases published none, so a later message rebuilt
// history from an empty table and the session forgot the reaped work.
/** The events `stubDb` has captured since it was installed. */
function captureEvents(): Array<Record<string, unknown>> {
  return published;
}

test("a reaped worker_lost chat run announces the terminal trio, carrying prompt and user_id", async () => {
  stubDb([{
    task_id: "t-1", session_id: "s-1", origin: "chat",
    lease_owner: "brain-a", message_id: "claw-1", sandbox_workload_id: null,
    failure_reason: "worker_lost", prompt: "optimise the kernel", user_id: "u-1",
  }]);
  const events = captureEvents();

  assert.equal(await reapLostLeases(), 1);
  assert.deepEqual(events.map((e) => e.type), ["AssistantMessage", "ResultMessage", "exec_complete"]);
  const done = events[2];
  assert.equal(done.failed, true);
  assert.equal(done.failure_reason, "worker_lost");
  assert.equal(done.message_id, "claw-1");
  assert.equal(done.user_id, "u-1");
  assert.equal(done.prompt, "optimise the kernel");
});

test("a cancelled reap does not announce a failed turn", async () => {
  // announceRunFailure emits failed:true with no interrupted flag, so a
  // user-cancelled row must be left out or it reads as a failure.
  stubDb([{
    task_id: "t-1", session_id: "s-1", origin: "chat",
    lease_owner: "brain-a", message_id: "claw-1", sandbox_workload_id: null,
    failure_reason: "cancelled", prompt: "stop", user_id: "u-1",
  }]);
  const events = captureEvents();

  assert.equal(await reapLostLeases(), 1);
  assert.deepEqual(events, []);
});

test("a non-chat reaped run announces nothing", async () => {
  stubDb([{
    task_id: "t-2", session_id: "s-2", origin: "dag_node",
    lease_owner: "brain-a", message_id: null, sandbox_workload_id: null,
    failure_reason: "worker_lost", prompt: null, user_id: null,
  }]);
  const events = captureEvents();

  assert.equal(await reapLostLeases(), 1);
  assert.deepEqual(events, []);
});

// --- Durability: the announce must not be contingent on the statements after it.
// The reap's own UPDATE has already put the row in a terminal status, and the
// reap only ever selects preparing/running/cancelling -- so a throw between the
// close and the publish loses the exec_complete for good, and no later sweep
// can make it up. The two statements that used to run in front of it are
// ordinary database calls, so this is not a hypothetical ordering.

test("the terminal trio survives a gate release that throws", async () => {
  const seen = stubDb([CHAT_RUN], [], [], /UPDATE claw_sessions/);
  const events = captureEvents();

  await assert.rejects(reapLostLeases(), /db is down/,
    "the failure is still a failure; what must not happen is losing the turn with it");
  assert.deepEqual(events.map((e) => e.type), ["AssistantMessage", "ResultMessage", "exec_complete"],
    "the row is already closed and unreachable to every later sweep, so the announce "
      + "cannot be left downstream of a statement that can throw");
  assert.equal(events[2].failure_reason, "worker_lost");
  assert.equal(events[2].prompt, "optimise the kernel");
  assert.ok(seen.some((q) => q.sql.includes("UPDATE claw_sessions")),
    "the release was reached -- otherwise this proves nothing about the order");
});

test("the terminal trio survives a sibling close that throws", async () => {
  // This one does run in front of the announce, because the consumer must not
  // find the spare row open (see the race test below). It is therefore the one
  // statement that could still suppress the announce by throwing -- so it is
  // caught rather than raised, and a spare row left open is accepted as the
  // smaller failure. reapStuckSessions is still the backstop for it.
  const seen = stubDb([CHAT_RUN], [], [], /UPDATE claw_tasks t SET/);
  const events = captureEvents();

  assert.equal(await reapLostLeases(), 1, "a spare row that would not close is not a failed tick");
  assert.deepEqual(events.map((e) => e.type), ["AssistantMessage", "ResultMessage", "exec_complete"]);
  assert.ok(seen.some((q) => q.sql.startsWith("UPDATE claw_tasks t SET")),
    "the close was attempted -- otherwise this proves nothing");
  assert.ok(seen.some((q) => q.sql.includes("UPDATE claw_sessions")),
    "and the pass carried on to the gate release");
});

test("the gate is not opened before the turn has been announced", async () => {
  // agent_status = 'idle' is what admits the next message, and the next message
  // rebuilds its history from claw_conversation_turns -- which stays empty
  // until recordCompletionTurns runs, and recordCompletionTurns runs on this
  // exec_complete. Releasing first is a race with the reply being composed.
  stubDb([CHAT_RUN]);
  await reapLostLeases();

  const doneAt = timeline.findIndex((step) => step.kind === "event" && step.type === "exec_complete");
  const releaseAt = timeline.findIndex(
    (step) => step.kind === "query" && step.sql.includes("UPDATE claw_sessions"));
  assert.ok(doneAt >= 0, "the worker_lost row has to be announced at all");
  assert.ok(releaseAt >= 0, "and the gate still has to be released");
  assert.ok(doneAt < releaseAt, "the session was reopened for new messages before its turn was published");
});

test("the whole announce lands before the gate release, not just the exec_complete", async () => {
  // The two events before it are the turn's own text, and a stream that gets
  // the result without them shows an empty reply.
  stubDb([CHAT_RUN]);
  await reapLostLeases();

  const lastEvent = timeline.map((step) => step.kind).lastIndexOf("event");
  const releaseAt = timeline.findIndex(
    (step) => step.kind === "query" && step.sql.includes("UPDATE claw_sessions"));
  assert.ok(releaseAt >= 0, "the gate release still runs");
  assert.ok(lastEvent < releaseAt,
    "the release can throw, and nothing that can throw belongs in front of the announce");
});

test("the spare row is closed before the turn is announced", async () => {
  // The other half of the same ordering, and it points the other way: the
  // announce is a publish, and what reads it closes rows by message id. See
  // the race below for what that costs when the publish goes first.
  stubDb([CHAT_RUN]);
  await reapLostLeases();

  const firstEvent = timeline.findIndex((step) => step.kind === "event");
  const siblingAt = timeline.findIndex(
    (step) => step.kind === "query" && step.sql.startsWith("UPDATE claw_tasks t SET"));
  assert.ok(siblingAt >= 0 && firstEvent >= 0);
  assert.ok(siblingAt < firstEvent,
    "the consumer must have nothing left to match by the time it sees the event");
});

// --- The other side of the same ordering: what reads the announce.
// `closeChatRun` is the consumer's first step on an exec_complete, and it
// closes every open chat row carrying the event's message id -- the spare row
// included, stamped with the event's own worker_lost. Publishing before the
// spare row is closed therefore races the consumer for it, and the row that
// loses is archived as a worker that was lost on the one row in the pair no
// worker ever held.

/** The pair of rows one replayed dispatch leaves: the leased one, and the spare. */
interface FakeRow { task_id: string; status: string; failure_reason: string | null }

/**
 * A database that answers the reap, and lets a consumer run against the same
 * rows in the middle of it.
 *
 * `onExecComplete` is called from the publish, which is where a JetStream
 * consumer that is quick enough would be: it is the reviewer's forced ordering
 * rather than a likelihood, and forcing it is the point -- the ordering has to
 * hold when the consumer wins the race, not merely when it usually loses.
 */
function stubDbWithSpare(spare: FakeRow, onExecComplete: () => Promise<void>): void {
  sweeperPorts.publishSessionEvent = async (_sessionId, event) => {
    published.push(event);
    timeline.push({ kind: "event", type: String(event.type) });
    if (event.type === "exec_complete") await onExecComplete();
  };
  const open = (): boolean =>
    ["queued", "preparing", "running", "cancelling"].includes(spare.status);
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    timeline.push({ kind: "query", sql });
    if (sql.startsWith("UPDATE claw_tasks SET status = CASE")) {
      return { rows: [CHAT_RUN], rowCount: 1 };
    }
    // The sibling close: the statement that knows this row was never claimed.
    if (sql.startsWith("UPDATE claw_tasks t SET")) {
      if (!open()) return { rows: [], rowCount: 0 };
      spare.status = "failed";
      spare.failure_reason = "dispatch_retried";
      return { rows: [{ task_id: spare.task_id }], rowCount: 1 };
    }
    // closeChatRun: a blanket update over every open row with this message id.
    if (sql.startsWith("UPDATE claw_tasks SET status = $3")) {
      if (!open() || params[5] !== CHAT_RUN.message_id) return { rows: [], rowCount: 0 };
      spare.status = String(params[2]);
      spare.failure_reason = params[3] === null ? null : String(params[3]);
      return { rows: [{ task_id: spare.task_id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

test("a consumer that reads the announce first cannot brand the spare row worker_lost", async () => {
  const spare: FakeRow = { task_id: "t-spare", status: "queued", failure_reason: null };
  timeline = [];
  published = [];
  stubDbWithSpare(spare, () => closeChatRun("s-1", CHAT_RUN.message_id, "failed", "worker_lost"));

  assert.equal(await reapLostLeases(), 1);
  assert.notEqual(spare.failure_reason, "worker_lost",
    "no worker ever held the spare row; the reason has to say what it was");
  assert.deepEqual(
    { status: spare.status, failure_reason: spare.failure_reason },
    { status: "failed", failure_reason: "dispatch_retried" },
  );
  assert.ok(published.some((e) => e.type === "exec_complete"),
    "and the turn was still announced -- the close is ordered in front of it, not instead of it");
});

test("a consumer arriving after the reap finds the spare row already accounted for", async () => {
  // The same event, delivered late, which is the ordinary case. It must be a
  // no-op on the spare row rather than a second verdict on it.
  const spare: FakeRow = { task_id: "t-spare", status: "queued", failure_reason: null };
  timeline = [];
  published = [];
  stubDbWithSpare(spare, async () => {});

  await reapLostLeases();
  await closeChatRun("s-1", CHAT_RUN.message_id, "failed", "worker_lost");

  assert.equal(spare.failure_reason, "dispatch_retried",
    "a terminal row is outside closeChatRun's open-status predicate, whenever the event lands");
});

/**
 * Read back what the sweeper's own logger actually emitted while `run` ran.
 *
 * The logger is a module-private pino instance writing to fd 1, so there is no
 * object to swap and nothing arrives at `process.stdout.write`. What can be
 * held is the sink underneath it: pino hands the serialized line to `fs.write`,
 * so borrowing that for the duration of the call leaves the real `logger.warn`
 * -- real serializers, real JSON -- on the path and reads the exact bytes the
 * process was about to emit. Swallowed rather than forwarded, so the captured
 * lines do not also land in the test output.
 *
 * `waitFor` is the `msg` the caller is after. The sink batches: if a write from
 * an earlier test is still in flight when this one is logged, the line is
 * buffered and handed over a tick or two later, so returning as soon as `run`
 * resolves reads an empty list about as often as not.
 */
async function captureLogLines(
  run: () => Promise<unknown>,
  waitFor: string,
): Promise<string[]> {
  const lines: string[] = [];
  const realWrite = fs.write as unknown as (...args: unknown[]) => unknown;
  const realWriteSync = fs.writeSync as unknown as (...args: unknown[]) => unknown;
  const take = (chunk: unknown) => {
    for (const line of String(chunk).split("\n")) if (line) lines.push(line);
  };
  fs.write = ((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return realWrite(fd, chunk, ...rest);
    take(chunk);
    // Reporting the full length matters: a short count reads as a partial
    // write and the sink reissues the rest, forever.
    const done = rest[rest.length - 1];
    if (typeof done === "function") done(null, Buffer.byteLength(String(chunk)), chunk);
    return undefined;
  }) as unknown as typeof fs.write;
  fs.writeSync = ((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return realWriteSync(fd, chunk, ...rest);
    take(chunk);
    return Buffer.byteLength(String(chunk));
  }) as unknown as typeof fs.writeSync;
  try {
    await run();
    const wanted = `"msg":${JSON.stringify(waitFor)}`;
    for (let i = 0; i < 500 && !lines.some((line) => line.includes(wanted)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  } finally {
    fs.write = realWrite as unknown as typeof fs.write;
    fs.writeSync = realWriteSync as unknown as typeof fs.writeSync;
  }
  return lines;
}

test("the reap log records the run without carrying its prompt", async () => {
  // Distinctive enough that a leak anywhere in the emitted line is unambiguous,
  // and long enough not to collide with a substring of anything else logged.
  const CANARY = "PROMPT-CANARY-6f2b91c4-a07d-4e33-9c5a-1d8ef0b73a52-never-log-me";
  stubDb([{ ...CHAT_RUN, prompt: CANARY }]);

  const lines = await captureLogLines(() => reapLostLeases(), "sweeper.reaped_lost_leases");
  const record = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.msg === "sweeper.reaped_lost_leases");
  assert.ok(record, "the reap logs one line per sweep; without it there is nothing to check");

  const logged = (record.rows as Array<Record<string, unknown>>)[0];
  // Absent, not blanked: an empty string is still a field a future change can
  // start filling in, and a redacted one still says how long the prompt was.
  assert.equal(Object.prototype.hasOwnProperty.call(logged, "prompt"), false,
    "the prompt is user input and has no business in an operational log line");
  assert.ok(!lines.some((line) => line.includes(CANARY)),
    "nor anywhere else in what the sweep emitted");

  // The drop is narrow: everything else the RETURNING produces is diagnostic
  // and is what makes the line worth having.
  assert.deepEqual(logged, {
    task_id: "t-1",
    session_id: "s-1",
    origin: "chat",
    lease_owner: "brain-a",
    message_id: "claw-pending-7",
    sandbox_workload_id: null,
    failure_reason: "worker_lost",
    user_id: "u-1",
  });
});
