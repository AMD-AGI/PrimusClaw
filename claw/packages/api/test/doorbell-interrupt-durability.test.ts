// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a Stop reaches, and what each terminal event it announces names.
 *
 * A fat row spends the whole of delivery, the workspace gate and the lock wait
 * with null holder columns, so the doorbell-only interrupt walked past it and
 * the turn stayed live under a user who had stopped it. And the events that end
 * an interrupted turn have to name the row they end: a consumer routing by task
 * cannot close a run from an event that names none.
 */

import "./reconcile-on-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, runRow, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

async function captureInterruptEvents(
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const { chatRunPorts, interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  const seen: Array<Record<string, unknown>> = [];
  const original = chatRunPorts.publishSessionEvent;
  chatRunPorts.publishSessionEvent = async (_s: string, event: Record<string, unknown>) => {
    seen.push(event);
  };
  try {
    await interruptSessionRuns(sessionId);
  } finally {
    chatRunPorts.publishSessionEvent = original;
  }
  return seen;
}

test("every event ending an interrupted turn names the row it ended", async () => {
  await seedSession(h, "s1");
  await seedRun(h, "unstarted", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-1",
  });

  const events = await captureInterruptEvents("s1");
  assert.deepEqual(
    events.map((e) => e.type),
    ["AssistantMessage", "ResultMessage", "exec_complete"],
  );
  for (const event of events) {
    assert.equal(event.task_id, "unstarted", `${event.type as string} names no row`);
  }
});

test("a fat row nobody holds is terminalized by the same Stop", async () => {
  const { interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "fat", "s1", {
    status: "preparing", dispatch: "fat", leaseOwner: null, messageId: "m-1",
  });

  assert.equal(await interruptSessionRuns("s1"), 1);
  const row = await runRow(h, "fat");
  assert.equal(row.status, "cancelled");
  assert.equal(row.failure_reason, "cancelled_before_dispatch_confirmed");
  assert.equal(
    ((row.metadata as Record<string, Record<string, unknown>>).dispatch_compensation).state,
    "terminal",
    "and it carries the receipt every terminal fat row owes",
  );
});

test("a fat row a worker holds keeps the handshake it can answer", async () => {
  const { interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "running", dispatch: "fat", messageId: "m-1",
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });

  assert.equal(await interruptSessionRuns("s1"), 0);
  assert.equal((await runRow(h, "held")).status, "cancelling");
});

test("cancelling one fat row by name terminalizes it rather than parking it", async () => {
  // The `cancelling` branch waits for an acknowledgement from a holder that
  // does not exist, so the row sat there until a sweeper tick found it.
  const { cancelTask } = await import("../src/tasks/lifecycle.js");
  await seedSession(h, "s1");
  await seedRun(h, "fat", "s1", {
    status: "preparing", dispatch: "fat", leaseOwner: null, messageId: "m-1",
  });

  assert.deepEqual(
    await cancelTask("fat"),
    { ok: true, cancelled: 1, interrupt_key: "s1" },
  );
  assert.equal((await runRow(h, "fat")).status, "cancelled");
});

test("and a held one still goes through the handshake", async () => {
  const { cancelTask } = await import("../src/tasks/lifecycle.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "running", dispatch: "fat", messageId: "m-1",
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });

  await cancelTask("held");
  assert.equal((await runRow(h, "held")).status, "cancelling");
});
