// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Row-level scenarios for the run-doorbell fixes, against a real Postgres.
 *
 * Each of these failed before the fix beside it and passes after. They are
 * written as row states rather than as SQL text because that is the whole
 * point: every one of these predicates was already present and already matched
 * the regex the unit tests assert on. What was wrong was which rows they
 * matched. See README.md.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, seedTurn, runRow, sessionRow, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

// ── #1 Stop must not close a run that is about to execute ─────────────────

test("#1 Stop leaves a fat run that no worker has leased yet", async () => {
  const { interruptUnstartedChatRuns } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  // What openChatRun writes on the fat path, in the window before the worker's
  // first lease renewal: preparing, no owner, and its JetStream message live.
  await seedRun(h, "fat", "s1", { status: "preparing", dispatch: "fat", leaseOwner: null });

  assert.equal(await interruptUnstartedChatRuns("s1"), 0);
  assert.equal((await runRow(h, "fat")).status, "preparing", "the run is still going to execute");
  assert.equal((await sessionRow(h, "s1")).agent_status, "running", "and still occupies the session");
});

test("#1 Stop still cancels the doorbell rows it exists for", async () => {
  const { interruptUnstartedChatRuns } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "queued", "s1", { status: "queued", dispatch: "doorbell" });
  await seedRun(h, "unclaimed", "s1", { status: "preparing", dispatch: "doorbell", leaseOwner: null });

  assert.equal(await interruptUnstartedChatRuns("s1"), 2);
  assert.equal((await runRow(h, "queued")).status, "cancelled");
  assert.equal((await runRow(h, "unclaimed")).status, "cancelled");
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});

test("#1 a leased doorbell is left to the NATS interrupt", async () => {
  const { interruptUnstartedChatRuns } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-1", leaseExpiresInSec: 60,
  });

  assert.equal(await interruptUnstartedChatRuns("s1"), 0);
  assert.equal((await runRow(h, "held")).status, "running");
});

test("#1 a cancelled doorbell does not idle a session that still holds a live fat run", async () => {
  const { interruptUnstartedChatRuns } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "db", "s1", { status: "queued", dispatch: "doorbell" });
  await seedRun(h, "fat", "s1", { status: "preparing", dispatch: "fat", leaseOwner: null });

  assert.equal(await interruptUnstartedChatRuns("s1"), 1);
  assert.equal((await runRow(h, "db")).status, "cancelled");
  assert.equal(
    (await sessionRow(h, "s1")).agent_status,
    "running",
    "idling here would let the next message dispatch on top of the fat run",
  );
});

// ── #2 the gate release has to stay reachable ─────────────────────────────

const WEEK = 7 * 24 * 3600;

test("#2 a wedged fat row no longer blocks the last-resort gate release", async () => {
  const { reapStuckSessions } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1", { updatedAgoSec: WEEK });
  // Reapable by nothing: chat is exempt from reapStaleTasks without
  // RUN_ROWS_SWEEPABLE, and reapLostLeases needs a lease that was written.
  await seedRun(h, "fat", "s1", { status: "preparing", dispatch: "fat", leaseOwner: null });

  assert.equal(await reapStuckSessions(), 1);
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});

test("#2 a doorbell whose lease lapsed after its deadline is releasable too", async () => {
  const { reapStuckSessions } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1", { updatedAgoSec: WEEK });
  // requeueLostDoorbellLeases declines this row on `deadline_at > NOW()`,
  // reapLostLeases leaves doorbell preparing/running to that pass, and
  // reapStaleTasks skips chat -- so nothing else will ever close it.
  await seedRun(h, "db", "s1", {
    status: "preparing", dispatch: "doorbell",
    leaseOwner: "brain-1", leaseExpiresInSec: -600, deadlineInSec: -300,
  });

  assert.equal(await reapStuckSessions(), 1);
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});

test("#2 a queued doorbell still holds the gate: its own reaper owns the timeout", async () => {
  const { reapStuckSessions } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1", { updatedAgoSec: WEEK });
  await seedRun(h, "db", "s1", { status: "queued", dispatch: "doorbell", queuedAgoSec: 60 });

  assert.equal(await reapStuckSessions(), 0);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});

test("#2 a live lease holds the gate", async () => {
  const { reapStuckSessions } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1", { updatedAgoSec: WEEK });
  await seedRun(h, "db", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-1", leaseExpiresInSec: 60,
  });

  assert.equal(await reapStuckSessions(), 0);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});

// ── #5/#7 a requeue winds the clocks back ─────────────────────────────────

test("#5 a requeued run is not failed as a queue timeout in the same tick", async () => {
  const sweeper = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  // Enqueued three hours ago -- past the two-hour RUN_QUEUE_MAX_SEC -- claimed,
  // executed, and then its worker died. This is a recoverable loss.
  await seedRun(h, "lost", "s1", {
    status: "running", dispatch: "doorbell",
    queuedAgoSec: 3 * 3600, startedAgoSec: 3 * 3600,
    leaseOwner: "brain-dead", leaseExpiresInSec: -3600,
    deadlineInSec: 3600, claimCount: 1,
  });

  assert.equal(await sweeper.requeueLostDoorbellLeases(), 1);
  const requeued = await runRow(h, "lost");
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.started_at, null, "the attempt clock restarts");
  assert.notEqual(requeued.deadline_at, null, "the turn's absolute budget is not reissued");

  // The tick runs the queue reaper right after the requeue pass. Before the
  // clock reset, the original queued_at made this row instantly expired.
  assert.equal(await sweeper.reapExpiredQueuedRuns(), 0);
  assert.equal((await runRow(h, "lost")).status, "queued", "still claimable");
});

test("#5 releasing a claim also winds the clocks back", async () => {
  const { releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "preparing", dispatch: "doorbell",
    queuedAgoSec: 3 * 3600, startedAgoSec: 600,
    leaseOwner: "brain-1", leaseExpiresInSec: 60, deadlineInSec: 3600,
  });

  assert.equal(await releaseClaim("held", "brain-1", 0), true);
  const row = await runRow(h, "held");
  assert.equal(row.status, "queued");
  assert.equal(row.started_at, null);
  assert.notEqual(row.deadline_at, null, "one turn keeps one deadline across retries");
  assert.ok(
    (row.queued_at as Date).getTime() > Date.now() - 60_000,
    "queued_at is the wait this row is about to begin, not the one it finished",
  );
});

test("#5 a genuinely stale queue entry is still failed", async () => {
  const { reapExpiredQueuedRuns } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "old", "s1", {
    status: "queued", dispatch: "doorbell", queuedAgoSec: 3 * 3600,
  });

  assert.equal(await reapExpiredQueuedRuns(), 1);
  const row = await runRow(h, "old");
  assert.equal(row.status, "failed");
  assert.equal(row.failure_reason, "queue_timeout");
});

// ── #1 follow-up: the gate must not open over a run that is still going ───

test("#1f cancelling a doorbell does not hand back a session a fat run still holds", async () => {
  // Reproduces what the live Stop test found. The Stop statement leaves the
  // fat row alone now, but the cancelled doorbell row publishes its own
  // terminal event, and the consumer used to clear the gate on any of those.
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1");
  await seedRun(h, "fat", "s1", { status: "preparing", dispatch: "fat", leaseOwner: null, messageId: "m-fat" });
  await seedRun(h, "db", "s1", { status: "cancelled", dispatch: "doorbell", messageId: "m-db" });

  await releaseSessionGateIfLastRun("s1", "m-db", false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});

test("#1f the gate opens once nothing is left occupying the session", async () => {
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1");
  await seedRun(h, "only", "s1", { status: "completed", dispatch: "doorbell", messageId: "m-only" });

  await releaseSessionGateIfLastRun("s1", "m-only", false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});

test("#1f a turn whose own row was never closed still releases its gate", async () => {
  // The belt-and-braces half: if closeChatRun matched nothing, the row for
  // this very turn is still open. Trusting row state alone would gate the
  // session for ever, so the statement excludes this turn's message id.
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1");
  await seedRun(h, "mine", "s1", { status: "running", dispatch: "doorbell", messageId: "m-mine" });

  await releaseSessionGateIfLastRun("s1", "m-mine", false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});

test("#1f a queued sibling keeps the gate shut, and a failure still reports failed", async () => {
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1");
  await seedRun(h, "done", "s1", { status: "completed", dispatch: "doorbell", messageId: "m-done" });
  await seedRun(h, "next", "s1", { status: "queued", dispatch: "doorbell", messageId: "m-next" });
  await releaseSessionGateIfLastRun("s1", "m-done", false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running", "the waiting turn still owns the session");

  await h.sql(`UPDATE claw_tasks SET status = 'cancelled' WHERE task_id = 'next'`);
  await releaseSessionGateIfLastRun("s1", "m-done", true);
  assert.equal((await sessionRow(h, "s1")).agent_status, "failed");
});

// ── H1 a release must name the claim it is releasing ──────────────────────

test("H1 a release that arrives after the row was reclaimed is refused", async () => {
  // The window the escalating contention backoff opened: the retry timer can
  // sleep for five minutes against a forty-five second lease, so by the time
  // it fires the row has lapsed, been requeued and been taken again -- often
  // by this same pod, since BRAIN_ID is the pod name and does not change.
  const { releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "row", "s1", {
    status: "running", dispatch: "doorbell",
    leaseOwner: "brain-1", leaseExpiresInSec: 60, claimCount: 5,
  });

  assert.equal(await releaseClaim("row", "brain-1", 4), false, "generation 4 no longer holds it");
  assert.equal((await runRow(h, "row")).status, "running", "the run in flight is untouched");

  assert.equal(await releaseClaim("row", "brain-1", 5), true, "the current holder may still release");
  assert.equal((await runRow(h, "row")).status, "queued");
});

test("H1 a worker that reports no generation keeps the old behaviour", async () => {
  const { releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "row", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-1", leaseExpiresInSec: 60, claimCount: 9,
  });
  assert.equal(await releaseClaim("row", "brain-1"), true);
});

// ── N1 one message id, one execution ──────────────────────────────────────

test("N1 a duplicate row for the same message is not claimed while its sibling runs", async () => {
  // A retried drain opens a second row for one message_id. The fat path was
  // protected by the stream's duplicate window; claim-next never sees the
  // stream, so without this the turn runs twice.
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "first", "s1", {
    status: "running", dispatch: "doorbell", messageId: "m-dup",
    leaseOwner: "brain-1", leaseExpiresInSec: 60,
  });
  await seedRun(h, "spare", "s1", { status: "queued", dispatch: "doorbell", messageId: "m-dup" });

  assert.equal(await claimRunById("spare", "brain-2"), "busy");
  assert.equal((await runRow(h, "spare")).status, "queued", "the spare stays put");
});

test("N1 a different message on the same session is still claimable", async () => {
  // Asserting only "not busy" passed on an outcome where the row had been
  // failed as unclaimable for want of credentials -- the sibling guard was
  // never the thing being measured. Seed a row a claim can hydrate and assert
  // the claim itself.
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "busy", "s1", {
    status: "running", dispatch: "doorbell", messageId: "m-a",
    leaseOwner: "brain-1", leaseExpiresInSec: 60,
  });
  await seedRun(h, "other", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-b", claimable: true,
  });

  const taken = await claimRunById("other", "brain-2");
  assert.ok(typeof taken !== "string" && !("kind" in taken), `expected a claim, got ${JSON.stringify(taken)}`);
  assert.equal((taken as { request: { task_id?: string } }).request.task_id, "other");
  assert.equal((await runRow(h, "other")).status, "preparing");
});

// ── N the admission SQL itself, not a hand-built usage object ─────────────

test("loadUsage counts a queued sandbox for the hard ceiling and not the soft one", async () => {
  // The two admission tests named for this fix run on literals, so reverting
  // the FILTER clauses in the SQL leaves them green. This runs the statement.
  const { loadUsage } = await import("../src/tasks/admission.js");
  await seedSession(h, "s1");
  await seedRun(h, "queued-sbx", "s1", { status: "queued", dispatch: "doorbell" });
  await h.sql(`UPDATE claw_tasks SET metadata = metadata || '{"sandbox_image":"img:1"}'::jsonb WHERE task_id = 'queued-sbx'`);

  const usage = await loadUsage();
  assert.equal(usage.sandboxes, 1, "committed to, so the hard ceiling sees it");
  assert.equal(usage.executingSandboxes, 0, "not running, so the soft ceiling does not");
  assert.equal(usage.runRoots, 1);
  assert.equal(usage.executingRoots, 0);
});

test("loadUsage counts an executing sandbox on both halves", async () => {
  const { loadUsage } = await import("../src/tasks/admission.js");
  await seedSession(h, "s1");
  await seedRun(h, "run-sbx", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "b1", leaseExpiresInSec: 60,
  });
  await h.sql(`UPDATE claw_tasks SET metadata = metadata || '{"sandbox_image":"img:1"}'::jsonb WHERE task_id = 'run-sbx'`);

  const usage = await loadUsage();
  assert.equal(usage.sandboxes, 1);
  assert.equal(usage.executingSandboxes, 1);
});

// ── E the unnamed close must not guess at a queued turn ───────────────────

test("E an exec_complete with no message id does not close a queued turn", async () => {
  // The fallback closes "the only open row". A queued row is the one state
  // where that inference is wrong: it is a turn that has not run, and the
  // event in hand belongs to a different one.
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "waiting", "s1", { status: "queued", dispatch: "doorbell", messageId: "m-next" });

  await closeChatRun("s1", undefined, "completed");
  assert.equal((await runRow(h, "waiting")).status, "queued", "the user's message survives");
});

test("E a named close still reaches a requeued row", async () => {
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "mine", "s1", { status: "queued", dispatch: "doorbell", messageId: "m-mine" });

  await closeChatRun("s1", "m-mine", "completed");
  assert.equal((await runRow(h, "mine")).status, "completed");
});

// ── H3 a run past its deadline reaches a terminal state ───────────────────

test("H3 a doorbell past its deadline is closed instead of leaking", async () => {
  const sweeper = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "spent", "s1", {
    status: "running", dispatch: "doorbell",
    startedAgoSec: 3 * 3600, deadlineInSec: -3600,
    leaseOwner: "brain-gone", leaseExpiresInSec: -600, claimCount: 2,
  });

  assert.equal(await sweeper.requeueLostDoorbellLeases(), 0, "the requeue pass declines it");
  assert.equal(await sweeper.reapExpiredDoorbellRuns(), 1);
  const row = await runRow(h, "spent");
  assert.equal(row.status, "failed");
  assert.equal(row.failure_reason, "run_budget_exhausted");
});

test("H3 a run still inside its deadline is left to the requeue pass", async () => {
  const sweeper = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "live", "s1", {
    status: "running", dispatch: "doorbell",
    // Past LEASE_LOST_GRACE_SEC, so the requeue pass is genuinely eligible.
    deadlineInSec: 3600, leaseOwner: "brain-gone", leaseExpiresInSec: -1200,
  });
  assert.equal(await sweeper.reapExpiredDoorbellRuns(), 0);
  assert.equal(await sweeper.requeueLostDoorbellLeases(), 1);
  assert.equal((await runRow(h, "live")).status, "queued");
});

// ── H4 a completion closes the row even after a requeue ───────────────────

test("H4 a completion closes a row that a lost lease put back on the queue", async () => {
  // The lease was judged lost while the worker was still finishing. The row
  // went back to queued; the exec_complete that followed found nothing to
  // close, so the row kept its workspace reference and its slice of the
  // admission count until the queue reaper archived a completed run as a
  // timeout two hours later.
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "requeued", "s1", { status: "queued", dispatch: "doorbell", messageId: "m-1" });

  await closeChatRun("s1", "m-1", "completed");
  assert.equal((await runRow(h, "requeued")).status, "completed");
});

// ── the ordinal post-insert recheck, against the real statement ───────────

test("loadUsageAhead counts only what was already there, and the statement parses", async () => {
  // Producer-side coverage. The only test that touched this path stubbed
  // `hardAfterInsert`, so nothing ever executed the SQL -- which carried an
  // unreferenced `$2` and failed at parse time on every call. With the throw
  // guard around the recheck, that turned into a 503 on every dispatch as soon
  // as a hard ceiling was set. A test that runs the statement catches it.
  const { loadUsageAhead } = await import("../src/tasks/admission.js");
  await seedSession(h, "s1");
  await seedRun(h, "first", "s1", { status: "running", dispatch: "doorbell" });
  await seedRun(h, "second", "s1", { status: "queued", dispatch: "doorbell" });
  await seedRun(h, "third", "s1", { status: "queued", dispatch: "doorbell" });

  assert.deepEqual(await loadUsageAhead("first"), { runRoots: 0, sandboxes: 0, gpuNodes: 0 });
  assert.equal((await loadUsageAhead("second"))?.runRoots, 1);
  assert.equal((await loadUsageAhead("third"))?.runRoots, 2);
  // A row somebody else already closed: the CTE is empty, the counts come back
  // at zero, and zero ahead refuses nothing.
  assert.deepEqual(await loadUsageAhead("no-such-row"), { runRoots: 0, sandboxes: 0, gpuNodes: 0 });
});

test("the ordinal recheck sheds the excess rather than every racer", async () => {
  const { firstAheadRefusal } = await import("../src/tasks/admission.js");
  const limits = {
    softRuns: 0, hardRuns: 2, softSandboxes: 0, hardSandboxes: 0,
    softGpuNodes: 0, hardGpuNodes: 0, treeMaxNodes: 0, treeMaxDepth: 0,
  };
  const ask = { origin: "chat" as const, wantsSandbox: false, gpuNodes: 0 };
  // Two creates race the last slot with one run already occupying. Comparing
  // totals refused both; counting what came first keeps the one inside the
  // ceiling and sheds only the one past it.
  assert.equal(firstAheadRefusal({ runRoots: 1, sandboxes: 0, gpuNodes: 0 }, ask, limits), null);
  assert.equal(firstAheadRefusal({ runRoots: 2, sandboxes: 0, gpuNodes: 0 }, ask, limits), "runs_hard_limit");
});

// ── producers with no other test between them and production ──────────────

test("releaseClaim records why the row came back, which the poison guard reads", async () => {
  // metadata.last_release had no writer under test at all, so the whole chain
  // -- brain declares a reason, the route allows it, releaseClaim stores it,
  // failExhaustedClaim reads it -- rested on one unexercised UPDATE arm.
  const { releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "preparing", dispatch: "doorbell",
    leaseOwner: "brain-1", leaseExpiresInSec: 60, claimCount: 2,
  });

  assert.equal(await releaseClaim("held", "brain-1", 2, "lock_contention"), true);
  const row = await runRow(h, "held");
  assert.equal((row.metadata as { last_release?: string }).last_release, "lock_contention");
  assert.equal((row.metadata as { message_id?: string }).message_id, "msg-held",
    "and the rest of the metadata survives the merge");
});

test("a release with no reason leaves the previous verdict untouched", async () => {
  const { releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "preparing", dispatch: "doorbell",
    leaseOwner: "brain-1", leaseExpiresInSec: 60, claimCount: 1,
  });
  assert.equal(await releaseClaim("held", "brain-1", 1), true);
  assert.equal((await runRow(h, "held")).metadata &&
    ((await runRow(h, "held")).metadata as { last_release?: string }).last_release, undefined);
});

test("reapExpiredDoorbellRuns declines a row a Brain still holds", async () => {
  // The predicate's live-lease arm: a run past its deadline that is still
  // renewing is stopping itself (the runner enforces deadline_at), and closing
  // it from here would archive a run that is mid-turn.
  const { reapExpiredDoorbellRuns } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "alive", "s1", {
    status: "running", dispatch: "doorbell",
    deadlineInSec: -3600, leaseOwner: "brain-1", leaseExpiresInSec: 60,
  });
  assert.equal(await reapExpiredDoorbellRuns(), 0);
  assert.equal((await runRow(h, "alive")).status, "running");
});

test("reapExpiredDoorbellRuns leaves a fat row alone", async () => {
  const { reapExpiredDoorbellRuns } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "fat", "s1", { status: "running", dispatch: "fat", deadlineInSec: -3600 });
  assert.equal(await reapExpiredDoorbellRuns(), 0);
});

test("loadUsage counts GPU nodes from the topology on the spec", async () => {
  // The two gpu aggregates were the only pair in loadUsage with no test that
  // executed them; both could be deleted and the suite stayed green.
  const { loadUsage } = await import("../src/tasks/admission.js");
  await seedSession(h, "s1");
  await seedRun(h, "queued-gpu", "s1", { status: "queued", dispatch: "doorbell" });
  await seedRun(h, "running-gpu", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "b1", leaseExpiresInSec: 60,
  });
  await h.sql(`UPDATE claw_tasks SET input = jsonb_build_object('topology', jsonb_build_object('nodes', 4))
                WHERE task_id IN ('queued-gpu','running-gpu')`);

  const usage = await loadUsage();
  assert.equal(usage.gpuNodes, 8, "both, because a queued run's nodes are committed to");
  assert.equal(usage.executingGpuNodes, 4, "only the one that is running");
});

// ── the last-resort gate break, which must not break a live turn ──────────

test("forceIdleAfterInterrupt declines while a worker is still renewing", async () => {
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "live", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-1", leaseExpiresInSec: 60,
  });

  assert.equal(await forceIdleAfterInterrupt("s1"), false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running",
    "the next message must not dispatch alongside a run that is mid-turn");
});

test("forceIdleAfterInterrupt breaks a gate whose lease has lapsed", async () => {
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "dead", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-gone", leaseExpiresInSec: -60,
  });

  assert.equal(await forceIdleAfterInterrupt("s1"), true);
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});

test("forceIdleAfterInterrupt breaks a gate held by a row that never took a lease", async () => {
  // The commonest stuck shape: a row nothing ever claimed, so there is no
  // lease to have lapsed. This is what the timer exists for.
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "orphan", "s1", { status: "preparing", dispatch: "fat", leaseOwner: null });

  assert.equal(await forceIdleAfterInterrupt("s1"), true);
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});

// ── admission must survive JSON it did not write ──────────────────────────

test("a task carrying a non-numeric topology does not abort the fleet scan", async () => {
  // `claw_tasks.input` is not all ours -- routes/tasks.ts writes a caller's
  // JSON into it verbatim -- and these aggregates scan every executor='brain'
  // row whatever its origin. Casting blindly meant one such row aborted the
  // statement, and admission runs before the insert on every chat dispatch, so
  // one row refused every turn in the fleet while it stayed queued.
  const { loadUsage, loadUsageAhead } = await import("../src/tasks/admission.js");
  await seedSession(h, "s1");
  await seedRun(h, "mine", "s1", { status: "queued", dispatch: "doorbell" });
  await h.sql(`INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, input)
               VALUES ('poison','s1','t','queued','task','brain','{"topology":{"nodes":"not-a-number"}}'::jsonb)`);

  const usage = await loadUsage();
  assert.equal(usage.gpuNodes, 0, "uncountable topology counts as nothing, not as a crash");
  assert.equal(usage.runRoots, 2);
  // The poisoned row was written after "mine", so nothing is ahead of it --
  // what matters is that the ordinal statement completes at all.
  assert.deepEqual(await loadUsageAhead("mine"), { runRoots: 0, sandboxes: 0, gpuNodes: 0 });
  assert.deepEqual(await loadUsageAhead("poison"), { runRoots: 1, sandboxes: 0, gpuNodes: 0 });
});

test("a well-formed topology is still counted", async () => {
  const { loadUsage } = await import("../src/tasks/admission.js");
  await seedSession(h, "s1");
  await seedRun(h, "gpu", "s1", { status: "queued", dispatch: "doorbell" });
  await h.sql(`UPDATE claw_tasks SET input = '{"topology":{"nodes":4}}'::jsonb WHERE task_id='gpu'`);
  assert.equal((await loadUsage()).gpuNodes, 4);
});

// ── B1 History is rebuilt at claim time, not carried on the row ────────────
//
// The spec no longer persists `history`; `claw_conversation_turns` owns the
// conversation and the claim reassembles from it. These pin both halves: that
// nothing is stored, and that what comes back is the same context the sender
// would have assembled.

test("B1 a claimed run carries the conversation, rebuilt from the turns table", async () => {
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedTurn(h, "s1", 1, "user", "how do I list pods");
  await seedTurn(h, "s1", 2, "assistant", "kubectl get pods");
  await seedRun(h, "t1", "s1", { claimable: true, prompt: "and the nodes?" });

  const claimed = await claimRunById("t1", "brain-1");
  assert.ok(typeof claimed === "object" && "request" in claimed, "the row was claimed");
  const history = claimed.request.history ?? [];

  assert.deepEqual(
    history.map((m) => [m.role, m.content]),
    [
      ["user", "how do I list pods"],
      ["assistant", "kubectl get pods"],
      ["user", "and the nodes?"],
    ],
    "both stored turns, in order, then this turn's prompt",
  );
});

test("B1 the row a real dispatch writes stores no conversation content", async () => {
  // Through persistableSpec, not a hand-built spec: the point is what the
  // producer writes, and a fixture that never calls it cannot fail.
  const { persistableSpec } = await import("../src/tasks/run-dispatch.js");
  const spec = persistableSpec({
    prompt: "next",
    session_id: "s1",
    history: [{ role: "user", content: "a-secret-the-row-must-not-keep" }],
  });

  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { claimable: true, prompt: "next", spec });

  const stored = JSON.stringify((await runRow(h, "t1")).input);
  assert.ok(!stored.includes("a-secret-the-row-must-not-keep"), "no turn text on the row");
  assert.ok(!stored.includes('"history"'), "and no history field at all");
});

test("B1 a turn the session teardown soft-deleted stays out of the rebuild", async () => {
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedTurn(h, "s1", 1, "user", "erased", { deleted: true });
  await seedTurn(h, "s1", 2, "user", "kept");
  await seedRun(h, "t1", "s1", { claimable: true, prompt: "now" });

  const claimed = await claimRunById("t1", "brain-1");
  assert.ok(typeof claimed === "object" && "request" in claimed);
  const text = (claimed.request.history ?? []).map((m) => m.content).join("|");
  assert.ok(!text.includes("erased"), "a deleted turn is gone for good, not just hidden");
  assert.ok(text.includes("kept"));
});

test("B1 another session's turns never leak into this run", async () => {
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedSession(h, "s2");
  await seedTurn(h, "s2", 1, "user", "someone-elses-conversation");
  await seedRun(h, "t1", "s1", { claimable: true, prompt: "mine" });

  const claimed = await claimRunById("t1", "brain-1");
  assert.ok(typeof claimed === "object" && "request" in claimed);
  assert.deepEqual(
    (claimed.request.history ?? []).map((m) => m.content),
    ["mine"],
    "only this session's history, plus this turn",
  );
});


// ── G The gate release and the pending drain must agree ───────────────────
//
// Two steps of one completion handler. The release became conditional in this
// change -- a session can now carry more than one run -- and the drain did
// not, so a completion that correctly refused to open the gate went on to
// dispatch the next parked message anyway.

test("G the gate release refuses while another run still occupies the session", async () => {
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1");
  await seedRun(h, "fat", "s1", { status: "preparing", dispatch: "fat", leaseOwner: null, messageId: "m-fat" });
  await seedRun(h, "db", "s1", { status: "cancelled", dispatch: "doorbell", messageId: "m-db" });

  assert.equal(
    await releaseSessionGateIfLastRun("s1", "m-db", false),
    false,
    "it says so, rather than only declining silently -- the drain reads this",
  );
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});

test("G the gate release reports the open when nothing else is left", async () => {
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1");
  await seedRun(h, "only", "s1", { status: "completed", dispatch: "doorbell", messageId: "m-only" });

  assert.equal(await releaseSessionGateIfLastRun("s1", "m-only", false), true);
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});

test("G a completion that cannot open the gate does not drain the queue", async () => {
  const { consumeEventDelivery, tombstoneReader } = await import("../src/events/consumer.js");
  const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
  const { sc } = await import("../src/infra/nats.js");
  // Without a KV the tombstone read is "unknown" and the delivery naks before
  // touching the database at all -- which is how the first draft of this test
  // passed against the bug it was written for.
  const originalTombstone = { ...tombstoneReader };
  Object.assign(tombstoneReader, { has: async () => false });
  resetDeletedSessionCache();
  await seedSession(h, "s1");
  await seedRun(h, "fat", "s1", { status: "running", dispatch: "fat", leaseOwner: "brain-1", leaseExpiresInSec: 60, messageId: "m-fat" });
  await seedRun(h, "db", "s1", { status: "cancelled", dispatch: "doorbell", messageId: "m-db" });
  await h.sql(
    "INSERT INTO claw_pending_messages (session_id, content) VALUES ($1, $2)",
    ["s1", "the message parked behind the fat run"],
  );

  h.statements.length = 0;
  await consumeEventDelivery({
    subject: "events.s1",
    data: sc.encode(JSON.stringify({
      type: "exec_complete", session_id: "s1", message_id: "m-db",
      user_id: "u-1", prompt: "cancelled", final_text: "", failed: true,
      failure_reason: "interrupted", error_count: 0, skills_used: {},
    })),
    ack: () => {}, nak: () => {},
  }).catch(() => {});

  // Positive control first: without it, a handler that bailed before step 5
  // for an unrelated reason looks exactly like the guard working.
  assert.ok(
    h.statements.some((s) => s.includes("INSERT INTO claw_session_events")),
    "the completion actually reached the handler",
  );
  assert.ok(
    h.statements.some((s) => s.includes("UPDATE claw_sessions SET agent_status")),
    "and reached the gate release, which is the step before the drain",
  );
  assert.equal(
    h.statements.some((s) => s.includes("FROM claw_pending_messages WHERE session_id")),
    false,
    "the queue was not even read, let alone dispatched, while the fat run is live",
  );
  assert.equal(
    (await h.sql("SELECT count(*)::int AS n FROM claw_pending_messages WHERE session_id = $1", ["s1"]))[0].n,
    1,
    "and the message is still parked, not started on top of the run",
  );
  Object.assign(tombstoneReader, originalTombstone);
  resetDeletedSessionCache();
});


// ── H The compensation's verdict has to reach the caller ──────────────────
//
// `peekNextQueued` matches the row the instant it commits, so claim-next can
// be running the turn before the dispatch finishes deciding. The compensation
// was made holder-safe for that; what it reported was not.

test("H failChatRunDispatch says held when a worker already has the row", async () => {
  const { failChatRunDispatch } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "preparing", dispatch: "doorbell", leaseOwner: "brain-1", leaseExpiresInSec: 60,
  });

  assert.equal(await failChatRunDispatch("held", "over the hard ceiling", "admission"), "held");
  assert.equal((await runRow(h, "held")).status, "preparing", "and the live run is untouched");
});

test("H it says closed for a row nobody has taken, and closes it", async () => {
  const { failChatRunDispatch } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "free", "s1", { status: "queued", dispatch: "doorbell", leaseOwner: null });

  assert.equal(await failChatRunDispatch("free", "over the hard ceiling", "admission"), "closed");
  assert.equal((await runRow(h, "free")).status, "failed");
});

// ── J A doorbell spare has to be closed with the row it duplicates ────────

test("J reaping a lost lease closes the queued doorbell spare beside it", async () => {
  const { reapLostLeases } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  // A fat row whose worker is gone: its lease lapsed well past the grace.
  await seedRun(h, "lost", "s1", {
    status: "running", dispatch: "fat", messageId: "m-dup",
    leaseOwner: "brain-dead", leaseExpiresInSec: -3600,
  });
  // The spare a retried dispatch opened for the same message.
  await seedRun(h, "spare", "s1", { status: "queued", dispatch: "doorbell", messageId: "m-dup" });

  const n = await reapLostLeases();
  console.log("DBGJ reaped=", n, JSON.stringify(await h.sql("SELECT task_id,status,failure_reason FROM claw_tasks ORDER BY task_id")));

  const spare = await runRow(h, "spare");
  assert.equal(spare.status, "failed", "queued is the shape a doorbell retry leaves");
  assert.equal(spare.failure_reason, "dispatch_retried");
});

test("J a spare a worker is holding is left alone", async () => {
  const { reapLostLeases } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "lost", "s1", {
    status: "running", dispatch: "fat", messageId: "m-dup",
    leaseOwner: "brain-dead", leaseExpiresInSec: -3600,
  });
  await seedRun(h, "live", "s1", {
    status: "running", dispatch: "doorbell", messageId: "m-dup",
    leaseOwner: "brain-1", leaseExpiresInSec: 60,
  });

  await reapLostLeases();
  assert.equal((await runRow(h, "live")).status, "running");
});

test("J a row the requeue pass just handed back is not closed as a duplicate", async () => {
  // requeueLostDoorbellLeases runs one step before reapLostLeases in the same
  // tick and leaves its row queued with no lease -- the same shape as a spare.
  // claim_count is what tells them apart, and the requeue deliberately does
  // not reset it.
  const { reapLostLeases } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "lost", "s1", {
    status: "running", dispatch: "fat", messageId: "m-dup",
    leaseOwner: "brain-dead", leaseExpiresInSec: -3600,
  });
  await seedRun(h, "requeued", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-dup", claimCount: 1,
  });

  await reapLostLeases();

  assert.equal(
    (await runRow(h, "requeued")).status,
    "queued",
    "it is waiting for another attempt, not a leftover of a retried dispatch",
  );
});

// ── K claim-next survives a run it cannot hydrate ─────────────────────────

test("K a rebuild that throws does not turn the whole cycle into an error", async () => {
  const { claimNextRun } = await import("../src/tasks/run-claim.js");
  const { db } = await import("../src/infra/db.js");
  await seedSession(h, "s1");
  await seedSession(h, "s2");
  await seedRun(h, "bad", "s1", { claimable: true, prompt: "bad", queuedAgoSec: 100 });
  await seedRun(h, "good", "s2", { claimable: true, prompt: "good", queuedAgoSec: 50 });

  // Since B1 the claim rebuilds history, and nothing in buildMessages catches,
  // so an ordinary database blip lands in claimRunById's rethrow.
  const real = db.query;
  db.query = (async (t: string, p?: unknown[]) => {
    if (/claw_conversation_turns/.test(t) && (p as string[])?.[0] === "s1") throw new Error("db blip");
    return (real as never as (a: string, b?: unknown[]) => Promise<unknown>)(t, p);
  }) as typeof db.query;

  let claimed;
  try { claimed = await claimNextRun("brain-1"); } finally { db.query = real; }

  assert.ok(claimed && "request" in claimed, "the cycle answers with work, not a 500");
  assert.equal(claimed.request.task_id, "good", "the row it could not open is passed over");
});

// ── L A run whose budget is already gone is not handed out ────────────────

test("L claim-next declines a queued run past its deadline", async () => {
  const { claimNextRun } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "spent", "s1", { claimable: true, prompt: "spent" });
  await h.sql("UPDATE claw_tasks SET deadline_at = NOW() - INTERVAL '5 minutes' WHERE task_id = 'spent'");

  assert.equal(await claimNextRun("brain-1"), null, "no workspace, no sandbox, no lease");
  assert.equal((await runRow(h, "spent")).status, "queued", "left for the reaper that closes it");
});

test("L a run still inside its budget is handed out as before", async () => {
  const { claimNextRun } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "live", "s1", { claimable: true, prompt: "live", deadlineInSec: 600 });

  const claimed = await claimNextRun("brain-1");
  assert.ok(claimed && "request" in claimed);
  assert.equal(claimed.request.task_id, "live");
});

// ── M A queued run reaped for timing out gives its workspace back ─────────

test("M reaping a queued run releases its workspace reference", async () => {
  const { reapExpiredQueuedRuns } = await import("../src/tasks/sweeper.js");
  const { db } = await import("../src/infra/db.js");
  await seedSession(h, "s1");
  await seedRun(h, "old", "s1", { status: "queued", dispatch: "doorbell", queuedAgoSec: 60 * 60 * 24 });

  const released: Array<[string, unknown]> = [];
  const real = db.query;
  db.query = (async (t: string, p?: unknown[]) => {
    if (/claw_workspace_refs/.test(t) && /DELETE|released_at/i.test(t)) {
      released.push([t.replace(/\s+/g, " ").trim().slice(0, 40), (p as unknown[])?.[0]]);
    }
    return (real as never as (a: string, b?: unknown[]) => Promise<unknown>)(t, p);
  }) as typeof db.query;
  try { await reapExpiredQueuedRuns(); } finally { db.query = real; }

  assert.equal((await runRow(h, "old")).status, "failed");
  assert.ok(released.length > 0, "the reference is handed back here, as the other two reapers do");
});

test("H a statement that could not run says unknown, not held", async () => {
  // The distinction this whole verdict exists for. Reporting "held" here says
  // a worker is running the turn, which nothing established -- and on the fat
  // path that answer skips the rollback and leaves a row at `preparing` with
  // no lease, which no reaper can see and which occupies an admission slot for
  // the life of the deployment.
  const { failChatRunDispatch } = await import("../src/tasks/chat-run.js");
  const { db } = await import("../src/infra/db.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "preparing", dispatch: "fat", leaseOwner: null });

  const real = db.query;
  db.query = (async (t: string, p?: unknown[]) => {
    if (/SET status = 'failed'/.test(t)) throw new Error("connection refused");
    return (real as never as (a: string, b?: unknown[]) => Promise<unknown>)(t, p);
  }) as typeof db.query;
  let verdict;
  try {
    verdict = await failChatRunDispatch("t1", "boom", "dispatch_failed");
  } finally { db.query = real; }

  assert.equal(verdict, "unknown");
  assert.equal((await runRow(h, "t1")).status, "preparing", "and the row really is still open");
});

// ── N What a close that matched nothing actually establishes ──────────────

test("N a row this call already closed reads as closed, not held", async () => {
  // The second compensation on one row. handOffAssembledRun throws after a
  // successful close, the outer catch compensates again on the id its own
  // failRun wrapper remembered, and this used to answer "a worker has it".
  const { failChatRunDispatch } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "queued", dispatch: "doorbell", leaseOwner: null });

  assert.equal(await failChatRunDispatch("t1", "boom"), "closed");
  assert.equal(
    await failChatRunDispatch("t1", "boom"),
    "closed",
    "the row is terminal; nothing is going to execute it, which is what closed means",
  );
});

test("N a row that is gone reads as closed", async () => {
  const { failChatRunDispatch } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  assert.equal(await failChatRunDispatch("never-existed", "boom"), "closed");
});

test("N an open row a worker holds still reads as held", async () => {
  const { failChatRunDispatch } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", {
    status: "preparing", dispatch: "doorbell", leaseOwner: "brain-1", leaseExpiresInSec: 60,
  });
  assert.equal(await failChatRunDispatch("t1", "boom"), "held");
  assert.equal((await runRow(h, "t1")).status, "preparing");
});

// ── O The external-call budget starts when the run parks ──────────────────

test("O parking into waiting_external restamps the wait clock", async () => {
  const { transitionStatus } = await import("../src/tasks/db.js");
  const { reapWaitExternal } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  // Created long ago and running ever since -- the shape of a task that works
  // for forty minutes before it makes its first external call.
  await seedRun(h, "long", "s1", { status: "running", dispatch: "fat", leaseOwner: "brain-1", leaseExpiresInSec: 60 });
  await h.sql("UPDATE claw_tasks SET queued_at = NOW() - INTERVAL '45 minutes', created_at = NOW() - INTERVAL '45 minutes' WHERE task_id = 'long'");

  await transitionStatus("long", ["running"], "waiting_external");
  await reapWaitExternal();

  assert.equal(
    (await runRow(h, "long")).status,
    "waiting_external",
    "it has waited seconds, not forty-five minutes",
  );
});

test("O a run that really has waited past its budget is still reaped", async () => {
  const { reapWaitExternal } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "stuck", "s1", { status: "running", dispatch: "fat", leaseOwner: "brain-1", leaseExpiresInSec: 60 });
  await h.sql(
    "UPDATE claw_tasks SET status = 'waiting_external', queued_at = NOW() - INTERVAL '10 hours' WHERE task_id = 'stuck'",
  );

  await reapWaitExternal();
  assert.equal((await runRow(h, "stuck")).status, "failed");
});

test("N an open row the settle could not match establishes nothing", async () => {
  // Open, unheld, and yet the UPDATE matched no row -- something moved under
  // the statement. The one answer that is not a guess is `unknown`, and the
  // caller rolls back on it.
  const { failChatRunDispatch } = await import("../src/tasks/chat-run.js");
  const { db } = await import("../src/infra/db.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "queued", dispatch: "doorbell", leaseOwner: null });

  const real = db.query;
  db.query = (async (t: string, p?: unknown[]) => {
    // The settle finds nothing; the row it names is still open and unheld.
    if (/SET status = 'failed'/.test(t)) return { rows: [], rowCount: 0 };
    return (real as never as (a: string, b?: unknown[]) => Promise<unknown>)(t, p);
  }) as typeof db.query;
  let verdict;
  try { verdict = await failChatRunDispatch("t1", "boom"); } finally { db.query = real; }

  assert.equal(verdict, "unknown");
});

test("N the settle and the check read the same list of open states", async () => {
  // They drifted once: the statement closed from three states and the check
  // recognised four, so a `cancelling` row came back as "a worker has it".
  const { failChatRunDispatch } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "cancelling", dispatch: "doorbell", leaseOwner: null });

  assert.equal(
    await failChatRunDispatch("t1", "boom"),
    "closed",
    "a state the settle will not close from is not an open state to the check either",
  );
});
