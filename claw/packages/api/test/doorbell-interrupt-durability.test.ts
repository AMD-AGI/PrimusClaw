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

/**
 * The doorbell half of the same question, which had the opposite shape.
 *
 * A claimed doorbell row is `preparing` or `running` with a lease, so the
 * queued pass steps over it, and the dispatch test on the unheld pass used to
 * step over it too: a Stop landing there wrote nothing at all and the wire
 * interrupt was the whole of it. Every Brain drops an interrupt for an address
 * with no abort registered, and there is a window with none -- the claim writes
 * the lease, `activeAbort.set` happens two KV round trips later, and the
 * lock-contention arm never gets there at all before naking for a backoff that
 * climbs to five minutes.
 *
 * What made that silence destructive rather than late is where it left the row.
 * `preparing` is claimable, so the holder's eventual unclaim returned it to
 * `queued` and the next replica ran the turn the user had stopped -- with
 * nothing written anywhere for `peekNextQueued` to consult.
 */
test("a doorbell row a worker holds is parked where a re-claim cannot reach it", async () => {
  const { interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  const { claimNextRun } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "preparing", dispatch: "doorbell", messageId: "m-1", claimable: true,
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });

  await interruptSessionRuns("s1");

  assert.equal((await runRow(h, "held")).status, "cancelling");
  assert.equal(await claimNextRun("brain-b"), null, "and no replica can take it");
});

test("the holder's own release closes a stopped doorbell row rather than requeueing it", async () => {
  const { interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  const { claimNextRun, releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "preparing", dispatch: "doorbell", messageId: "m-1", claimable: true,
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });

  await interruptSessionRuns("s1");
  // What the claimed wrapper does when its lock-contention backoff finally
  // fires. Putting the row back here is what erased the Stop.
  assert.equal(await releaseClaim("held", "brain-a", 1, "lock_contention"), true);

  const row = await runRow(h, "held");
  assert.equal(row.status, "cancelled");
  assert.equal(row.failure_reason, "cancelled");
  assert.equal(await claimNextRun("brain-b"), null, "the turn the user stopped stays stopped");
});

test("the same row with no Stop on it is claimed by the next replica", async () => {
  // The negative control for both tests above: without it they would hold just
  // as well against a claim-next that can never return anything at all.
  const { claimNextRun, releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "preparing", dispatch: "doorbell", messageId: "m-1", claimable: true,
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });

  assert.equal(await releaseClaim("held", "brain-a", 1, "lock_contention"), true);

  assert.equal((await runRow(h, "held")).status, "queued");
  const claimed = await claimNextRun("brain-b");
  assert.ok(claimed && "request" in claimed, "this fixture is claimable");
  assert.equal(claimed.request.task_id, "held");
});

async function gateOf(sessionId: string): Promise<string> {
  const rows = await h.sql(
    "SELECT agent_status FROM claw_sessions WHERE session_id = $1", [sessionId],
  );
  return String(rows[0]?.agent_status);
}

test("the release that closes a stopped row hands the session back", async () => {
  const { interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  const { releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1", { agentStatus: "running", gateOwner: "m-1" });
  await seedRun(h, "held", "s1", {
    status: "preparing", dispatch: "doorbell", messageId: "m-1", claimable: true,
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });

  await interruptSessionRuns("s1");
  // Still shut, and deliberately: the turn is winding down, not over.
  assert.equal(await gateOf("s1"), "running");

  await releaseClaim("held", "brain-a", 1, "lock_contention");

  // Without this the session waits out `reapStuckSessions` -- a whole task
  // timeout -- with every later message parked behind it.
  assert.equal(await gateOf("s1"), "idle");
});

test("but a stopped row is not the whole session, and a live sibling keeps it shut", async () => {
  const { interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  const { releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1", { agentStatus: "running", gateOwner: "m-1" });
  await seedRun(h, "held", "s1", {
    status: "preparing", dispatch: "doorbell", messageId: "m-1", claimable: true,
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });
  await seedRun(h, "sibling", "s1", {
    status: "running", dispatch: "doorbell", messageId: "m-2",
    leaseOwner: "brain-b", leaseExpiresInSec: 600, claimCount: 1,
  });

  await interruptSessionRuns("s1");
  await releaseClaim("held", "brain-a", 1, "lock_contention");

  assert.equal(await gateOf("s1"), "running", "idling here would dispatch on top of a live run");
});
