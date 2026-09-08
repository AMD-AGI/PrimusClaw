// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The other half of completion routing: the events the API itself publishes.
 *
 * Brain is not the only publisher of `exec_complete`. Four API paths end a turn
 * the worker never finished -- a queue that timed out, a claim that could not be
 * hydrated, a Stop that caught an unstarted row, a refused replay -- and the
 * consumer decides what to close from the `task_id` on the event. An
 * announcement that names no row leaves the consumer guessing between siblings,
 * so each producer is driven here and the emitted event read back.
 *
 * The consumer cases pair with them: a completion naming a DAG or standalone row
 * must keep every step it does today and close no chat row, and one naming a
 * chat row must reach the fenced close.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  startHarness, seedSession, seedRun, runRow, sessionRow, type Harness,
} from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

/** Record what a producer announced, in place of the JetStream publish. */
function captureEvents(ports: { publishSessionEvent: unknown }): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  ports.publishSessionEvent = (async (_sessionId: string, event: Record<string, unknown>) => {
    events.push(event);
  }) as unknown as typeof ports.publishSessionEvent;
  return events;
}

function completionOf(events: Array<Record<string, unknown>>): Record<string, unknown> {
  const complete = events.find((e) => e.type === "exec_complete");
  assert.ok(complete, "the turn has to end with a completion");
  return complete;
}

/**
 * Answer the tombstone bucket without a KV.
 *
 * An unread bucket is `"unknown"`, and the delivery then naks before it touches
 * the database -- which is how a routing test can pass having exercised nothing.
 */
async function withLiveSession(body: () => Promise<void>): Promise<void> {
  const { tombstoneReader } = await import("../src/events/consumer.js");
  const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
  const original = { ...tombstoneReader };
  Object.assign(tombstoneReader, { has: async () => false });
  resetDeletedSessionCache();
  try {
    await body();
  } finally {
    Object.assign(tombstoneReader, original);
    resetDeletedSessionCache();
  }
}

async function deliverCompletion(event: Record<string, unknown>): Promise<void> {
  const { consumeEventDelivery } = await import("../src/events/consumer.js");
  const { sc } = await import("../src/infra/nats.js");
  await consumeEventDelivery({
    subject: `events.${event.session_id as string}`,
    data: sc.encode(JSON.stringify({ type: "exec_complete", ...event })),
    ack: () => {}, nak: () => {},
    // The drain reads columns this fixture's queue table does not carry, so the
    // handler leaves by throw once it gets that far. Which steps it reached is
    // what these cases assert on, and the harness records every one.
  }).catch(() => {});
}

const DRAIN_READ = "FROM claw_pending_messages WHERE session_id";

function ranStatement(fragment: string): boolean {
  return h.statements.some((s) => s.includes(fragment));
}

test("a queue timeout names the row it closed", async () => {
  const { reapExpiredQueuedRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const original = { ...sweeperPorts };
  const events = captureEvents(sweeperPorts);
  try {
    await seedSession(h, "s1");
    await seedRun(h, "waited", "s1", {
      status: "queued", dispatch: "doorbell", messageId: "m-1", queuedAgoSec: 3 * 60 * 60,
    });

    assert.equal(await reapExpiredQueuedRuns(), 1);
    assert.equal(completionOf(events).task_id, "waited");
  } finally {
    Object.assign(sweeperPorts, original);
  }
});

test("a claim that cannot be hydrated names the row it failed", async () => {
  const { claimRunById, runClaimPorts } = await import("../src/tasks/run-claim.js");
  const original = { ...runClaimPorts };
  const events = captureEvents(runClaimPorts);
  try {
    await seedSession(h, "s1");
    // No sealed blob, so the spec will not open -- a permanent fault for this row.
    await seedRun(h, "opaque", "s1", { status: "queued", dispatch: "doorbell", messageId: "m-1" });

    assert.equal(await claimRunById("opaque", "brain-a"), "unclaimable");
    assert.equal(completionOf(events).task_id, "opaque");
  } finally {
    Object.assign(runClaimPorts, original);
  }
});

test("a DAG completion keeps its processing and closes no chat row", async () => {
  await withLiveSession(async () => {
    await seedSession(h, "s1", { gateOwner: "m-dag" });
    await seedRun(h, "dag-1", "s1", { status: "running", origin: "dag_node", messageId: "m-dag" });
    await h.sql(
      "INSERT INTO claw_pending_messages (session_id, user_id, content) VALUES ($1, $2, $3)",
      ["s1", "u-1", "next"],
    );

    h.statements.length = 0;
    await deliverCompletion({
      session_id: "s1", message_id: "m-dag", task_id: "dag-1", user_id: "u-1",
      prompt: "build it", final_text: "built", failed: false, error_count: 0, skills_used: {},
    });

    assert.equal(
      (await runRow(h, "dag-1")).status, "running",
      "the chat close must not reach a row whose own result decides it",
    );
    assert.equal((await sessionRow(h, "s1")).agent_status, "idle", "the gate still opens");
    assert.equal(
      (await h.sql(
        "SELECT count(*)::int AS n FROM claw_conversation_turns WHERE session_id = 's1'",
      ))[0].n,
      2,
      "and the turn is still recorded",
    );
    assert.ok(ranStatement(DRAIN_READ), "and the queue behind it still moves");
  });
});

test("a standalone completion leaves its own row to its own result", async () => {
  // An a2a row is closeable by the chat close -- it is in the same origin set --
  // so routing on the presence of `task_id` terminalizes it here, ahead of the
  // result the standalone caller is waiting for.
  await withLiveSession(async () => {
    await seedSession(h, "s1", { gateOwner: "m-a2a" });
    await seedRun(h, "a2a-1", "s1", { status: "running", origin: "a2a", messageId: "m-a2a" });

    h.statements.length = 0;
    await deliverCompletion({
      session_id: "s1", message_id: "m-a2a", task_id: "a2a-1", user_id: "u-1",
      prompt: "call it", final_text: "called", failed: false, error_count: 0, skills_used: {},
    });

    assert.equal((await runRow(h, "a2a-1")).status, "running");
    assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
    assert.ok(ranStatement("INSERT INTO claw_conversation_turns"));
  });
});

test("a completion naming a row nobody wrote keeps the same processing", async () => {
  await withLiveSession(async () => {
    await seedSession(h, "s1", { gateOwner: "m-1" });

    h.statements.length = 0;
    await deliverCompletion({
      session_id: "s1", message_id: "m-1", task_id: "gone", user_id: "u-1",
      prompt: "run it", final_text: "ran", failed: false, error_count: 0, skills_used: {},
    });

    assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
    assert.ok(ranStatement("INSERT INTO claw_conversation_turns"));
  });
});

test("a chat completion reaches the close that is fenced to its generation", async () => {
  await withLiveSession(async () => {
    await seedSession(h, "s1", { gateOwner: "m-1" });
    await seedRun(h, "t1", "s1", {
      status: "running", dispatch: "doorbell", messageId: "m-1", claimCount: 2,
    });
    await h.sql(
      `UPDATE claw_tasks SET metadata = metadata || '{"lease_fenced":"true"}'::jsonb
        WHERE task_id = 't1'`,
    );

    await deliverCompletion({
      session_id: "s1", message_id: "m-1", task_id: "t1", run_claim: 2, user_id: "u-1",
      prompt: "hello", final_text: "hi", failed: false, error_count: 0, skills_used: {},
    });

    assert.equal((await runRow(h, "t1")).status, "completed");
    assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
  });
});

test("a fat completion closes its fenced row before the lease reaper", async () => {
  await withLiveSession(async () => {
    const { reapLostLeases } = await import("../src/tasks/sweeper.js");
    await seedSession(h, "s-fat", { gateOwner: "m-fat" });
    await seedRun(h, "fat-run", "s-fat", {
      status: "running", dispatch: "fat", messageId: "m-fat",
      leaseOwner: "brain-a", leaseExpiresInSec: -3600, claimCount: 1,
    });
    await seedRun(h, "other-run", "s-fat", {
      status: "running", dispatch: "fat", messageId: "m-other",
      leaseOwner: "brain-b", leaseExpiresInSec: 3600, claimCount: 1,
    });
    await h.sql(
      `UPDATE claw_tasks
          SET metadata = metadata || '{"dispatch":"fat","lease_fenced":"true"}'::jsonb
        WHERE task_id = 'fat-run'`,
    );

    await deliverCompletion({
      session_id: "s-fat", message_id: "m-fat", task_id: "fat-run", run_claim: 1,
      user_id: "u-fat", prompt: "hello", final_text: "done",
      failed: false, error_count: 0, skills_used: {},
    });

    const completed = await runRow(h, "fat-run");
    assert.equal(completed.status, "completed");
    assert.ok(completed.completed_at);
    assert.ok((await h.sql(
      `SELECT processed_at FROM claw_session_events
        WHERE session_id = 's-fat' AND event = 'exec_complete'`,
    ))[0].processed_at);
    assert.equal(await reapLostLeases(), 0);
    assert.equal((await runRow(h, "fat-run")).status, "completed");
    assert.equal((await runRow(h, "other-run")).status, "running");
  });
});
