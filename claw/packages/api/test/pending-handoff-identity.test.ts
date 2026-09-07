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

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { openDoorbellBarrier } from "./doorbell-barrier-stub.js";
import { db } from "../src/infra/db.js";
import { startHarness, seedSession, seedRun, type Harness } from "./scenario-harness.js";

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
): () => void {
  const publish = ports.publish;
  const bind = ports.bindWorkspace;
  const gate = ports.doorbellDispatch;
  // The identity these cases are about belongs to the doorbell hand-off, so the
  // barrier has to be open for the drain to reach it.
  ports.doorbellDispatch = openDoorbellBarrier;
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

test("a compensated dispatch is the one shape a retry may open again", async () => {
  // Terminal as dispatch_failed with no claim ever taken proves nothing
  // executed under that id, so the turn is still owed.
  const { dispatchPendingMessage, pendingDispatchPorts } =
    await import("../src/tasks/pending-dispatch.js");
  const published: unknown[] = [];
  const restore = stubPorts(pendingDispatchPorts, published);
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedPending(44);
    await seedRun(h, "ktsk_failed", "s1", { status: "failed", dispatch: "doorbell" });
    await h.sql(
      "UPDATE claw_tasks SET failure_reason = 'dispatch_failed' WHERE task_id = 'ktsk_failed'",
    );
    await h.sql("UPDATE claw_pending_messages SET dispatch_task_id = 'ktsk_failed' WHERE id = 44");

    await dispatchPendingMessage({
      sessionId: "s1", pendingId: 44, userId: "u-1", messageId: "claw-3",
      prompt: "hi", workspaceId: "kws_1",
      task: { session_id: "s1", prompt: "hi" } as Record<string, unknown>,
    });

    assert.equal(published.length, 1, "the turn is dispatched again, because nothing ran");
  } finally {
    restore();
  }
});
