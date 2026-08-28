// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A doorbell's liveness is the lease written at claim time. If that lease
 * expires before the deadline, the row must go back to `queued` so claim-next
 * can take it — failing it would drop work that only lost its worker.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import {
  reapExpiredDoorbellRuns, reapExpiredQueuedRuns, reapLostLeases, reapStuckSessions,
  requeueLostDoorbellLeases, sweeperPorts,
} from "../src/tasks/sweeper.js";

const originalQuery = db.query;
after(() => { db.query = originalQuery; });

function stubDb(returning: Array<Record<string, unknown>> = []): string[] {
  const seen: string[] = [];
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push(sql);
    return { rows: returning, rowCount: returning.length };
  }) as typeof db.query;
  return seen;
}

test("an expired doorbell lease is requeued, not failed", async () => {
  const seen = stubDb();
  assert.equal(await requeueLostDoorbellLeases(), 0);
  assert.match(seen[0], /SET status = 'queued'/);
  assert.match(seen[0], /origin = 'chat'/);
  assert.match(seen[0], /metadata->>'dispatch' = 'doorbell'/);
  assert.doesNotMatch(seen[0], /failure_reason/);
});

test("lost-lease reap leaves doorbell preparing/running to the requeue pass", async () => {
  const seen = stubDb();
  await reapLostLeases();
  assert.match(seen[0], /origin = 'chat'/);
  assert.match(seen[0], /metadata->>'dispatch' = 'doorbell'/);
  assert.match(seen[0], /status IN \('preparing','running'\)/);
});

test("a queued doorbell past its wait is failed as queue_timeout", async () => {
  const seen = stubDb([{ task_id: "ktsk_1", session_id: "s-1" }]);
  assert.equal(await reapExpiredQueuedRuns(), 1);
  assert.match(seen[0], /status = 'failed'/);
  assert.match(seen[0], /failure_reason = 'queue_timeout'/);
  assert.match(seen[0], /status = 'queued'/);
  assert.match(seen[0], /queued_at/);
  assert.doesNotMatch(seen[0], /deadline_at/);
  assert.ok(seen.some((sql) => /UPDATE claw_sessions/.test(sql)), "the session gate has to open again");
});

test("a session with a queued chat row is not released as stuck", async () => {
  const seen = stubDb();
  assert.equal(await reapStuckSessions(), 0);
  assert.match(seen[0], /agent_status = 'idle'/);
  assert.match(seen[0], /origin = 'chat'/);
  assert.match(seen[0], /status IN \('queued','preparing','running','cancelling'\)/);
});

const originalPublish = sweeperPorts.publishSessionEvent;
after(() => { sweeperPorts.publishSessionEvent = originalPublish; });

function captureEvents(): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  sweeperPorts.publishSessionEvent = async (_sessionId, event) => { events.push(event); };
  return events;
}

test("a queue timeout ends the turn on the stream, not only in the table", async () => {
  // Closing the row opened the gate and told the client nothing: the
  // UserMessage stayed on an open stream with no reply and no result.
  stubDb([{
    task_id: "ktsk_1", session_id: "s-1", prompt: "hello",
    claim_count: 0, message_id: "msg-1", user_id: "u-1",
  }]);
  const events = captureEvents();

  assert.equal(await reapExpiredQueuedRuns(), 1);
  assert.deepEqual(events.map((e) => e.type), ["AssistantMessage", "ResultMessage", "exec_complete"]);
  const done = events[2];
  assert.equal(done.failed, true);
  assert.equal(done.failure_reason, "queue_timeout");
  assert.equal(done.message_id, "msg-1");
  assert.equal(done.user_id, "u-1");
  assert.match(String(done.final_text), /Nothing ran/);
});

test("a run that lost a worker is not told that nothing ran", async () => {
  // requeueLostDoorbellLeases puts an executed run back at `queued`. Telling
  // its user it never started would be a claim the sweeper cannot make.
  stubDb([{
    task_id: "ktsk_2", session_id: "s-2", prompt: "hello",
    claim_count: 2, message_id: "msg-2", user_id: "u-2",
  }]);
  const events = captureEvents();

  assert.equal(await reapExpiredQueuedRuns(), 1);
  const done = events[2];
  assert.match(String(done.final_text), /lost its worker/);
  assert.doesNotMatch(String(done.final_text), /Nothing ran/);
});

test("the reap still closes the row when the stream cannot be reached", async () => {
  stubDb([{ task_id: "ktsk_3", session_id: "s-3", prompt: "", claim_count: 0, message_id: null, user_id: null }]);
  sweeperPorts.publishSessionEvent = async () => { throw new Error("nats down"); };
  assert.equal(await reapExpiredQueuedRuns(), 1, "an unreachable stream must not fail the tick");
});

test("the stuck-session release only defers to rows that actually occupy the session", async () => {
  const seen = stubDb();
  await reapStuckSessions();
  assert.match(seen[0], /t\.status = 'queued' OR t\.lease_expires_at > NOW\(\)/);
});

test("a requeue winds the attempt clocks back and leaves the turn's deadline alone", async () => {
  // started_at is per attempt; deadline_at is the turn's only absolute bound.
  // Clearing it handed every requeue a fresh budget, so a row could outlive
  // its two hours once per claim.
  const seen = stubDb();
  await requeueLostDoorbellLeases();
  assert.match(seen[0], /queued_at = NOW\(\)/);
  assert.match(seen[0], /started_at = NULL/);
  assert.doesNotMatch(seen[0], /deadline_at = NULL/);
});

test("a doorbell past its deadline is closed by a reaper of its own", async () => {
  // Every other reaper declines it: the requeue pass on deadline_at > NOW(),
  // reapLostLeases by leaving doorbell rows to that pass, reapStaleTasks by
  // skipping chat. Without this one the row never reaches a terminal state.
  const seen = stubDb([{
    task_id: "ktsk_9", session_id: "s-9", prompt: "hi",
    claim_count: 3, message_id: "m-9", user_id: "u-9",
  }]);
  const events = captureEvents();
  assert.equal(await reapExpiredDoorbellRuns(), 1);
  assert.match(seen[0], /failure_reason = 'run_budget_exhausted'/);
  assert.match(seen[0], /metadata->>'dispatch' = 'doorbell'/);
  assert.match(seen[0], /deadline_at < NOW\(\)/);
  assert.deepEqual(events.map((e) => e.type), ["AssistantMessage", "ResultMessage", "exec_complete"]);
  assert.equal(events[2].failure_reason, "run_budget_exhausted");
});
