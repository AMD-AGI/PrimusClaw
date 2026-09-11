// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The queue metrics, read from the product paths that move them.
 *
 * A counter proven only against its own helper says nothing about whether any
 * caller reaches it, and a sojourn is only meaningful if the marker was stamped
 * by the write that put the row on the queue. Each case here drives a real
 * entry, claim, close or interrupt and reads the rendered exposition.
 */

import "./reconcile-on-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, runRow, type Harness } from "./scenario-harness.js";
import { registry } from "../src/infra/metrics.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

function sample(text: string, name: string, labels: Record<string, string>): number {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    const head = line.slice(0, line.lastIndexOf(" "));
    if (!wanted.every((pair) => head.includes(pair))) continue;
    return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return 0;
}

/** What one product action moved on a series, as a reader of `/metrics` sees it. */
async function delta(
  act: () => Promise<unknown>,
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const before = sample(await registry.metrics(), name, labels);
  await act();
  return sample(await registry.metrics(), name, labels) - before;
}

const ENTERED = "claw_api_run_queue_entered_total";
const EXITED = "claw_api_run_queue_exited_total";

function openInput(taskId: string, cause?: "direct" | "admission"): Record<string, unknown> {
  return {
    sessionId: "s1", userId: "u-1", dispatch: "doorbell", taskId,
    messageId: `m-${taskId}`, prompt: "hello", status: "queued",
    recordWorkspaceUse: false, ...(cause ? { queueEntryCause: cause } : {}),
  };
}

test("a run held back by a ceiling enters as an admission wait and carries its marker", async () => {
  const { openChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");

  const moved = await delta(
    () => openChatRun(openInput("held", "admission") as never),
    ENTERED, { cause: "admission" },
  );
  assert.equal(moved, 1);
  assert.equal(
    typeof (await runRow(h, "held")).metadata.queued_since, "string",
    "the write that queued the row is what stamps the marker",
  );
});

test("a run merely in transit enters as direct and is not given a wait to measure", async () => {
  const { openChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");

  const moved = await delta(
    () => openChatRun(openInput("transit") as never),
    ENTERED, { cause: "direct" },
  );
  assert.equal(moved, 1);
  assert.equal((await runRow(h, "transit")).metadata.queued_since, undefined);
});

test("the claim that takes a queued row records the exit that ends its wait", async () => {
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "waiting", "s1", { claimable: true, prompt: "hello" });

  const moved = await delta(
    () => claimRunById("waiting", "brain-a", 1), EXITED, { outcome: "claimed" },
  );
  assert.equal(moved, 1);
  assert.equal((await runRow(h, "waiting")).status, "preparing");
});

test("a completion closing a queued row records that exit too", async () => {
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "queued", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-q",
  });

  assert.equal(
    await delta(
      () => closeChatRun("s1", "m-q", "completed"), EXITED, { outcome: "chat_closed" },
    ),
    1,
  );
});

test("a Stop records the rows it took off the queue", async () => {
  const { interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "unstarted", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-u",
  });

  assert.equal(
    await delta(() => interruptSessionRuns("s1"), EXITED, { outcome: "cancelled" }),
    1,
  );
});

test("a task cancellation records a queued doorbell leaving the queue", async () => {
  const { cancelTask } = await import("../src/tasks/lifecycle.js");
  await seedSession(h, "s1");
  await seedRun(h, "cancelled-by-id", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-cancelled-by-id",
  });

  assert.equal(
    await delta(() => cancelTask("cancelled-by-id"), EXITED, { outcome: "cancelled" }),
    1,
  );
});

test("a dispatch that fails before execution records its own exit", async () => {
  const { failChatRunDispatch } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "doomed", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-d",
  });

  assert.equal(
    await delta(
      () => failChatRunDispatch("doomed", "publish_failed", "the stream refused it"),
      EXITED, { outcome: "dispatch_failed" },
    ),
    1,
  );
});

test("a replayed dispatch's spare row is recorded as the duplicate exit it is", async () => {
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "real", "s1", {
    status: "running", dispatch: "doorbell", messageId: "m-1", claimCount: 1,
  });
  await seedRun(h, "spare", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-1",
  });

  assert.equal(
    await delta(
      () => closeChatRun("s1", "m-1", "completed", undefined, { taskId: "real" }),
      EXITED, { outcome: "duplicate_closed" },
    ),
    1,
  );
  assert.equal((await runRow(h, "spare")).failure_reason, "duplicate_dispatch_row");
});

test("the budget sweep counts only the rows it took off the queue", async () => {
  // `queuedExits` reads `prior_status`, and `claw_tasks` has no such column:
  // fed the rows an UPDATE returned it matches none of them and the exit
  // counter never moves, while the entry counter does. The rollout gate
  // balances one against the other, so a counter frozen at zero reads as a
  // queue that keeps filling and never drains.
  const { reapExpiredDoorbellRuns } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "budget-queued", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-q",
    deadlineInSec: -3600, queuedAgoSec: 30,
  });
  // Beside it, one the sweep also closes but which was never waiting: the
  // count has to be 1, not 2, or "how many left the queue" means nothing.
  await seedRun(h, "budget-running", "s1", {
    status: "running", dispatch: "doorbell", messageId: "m-r",
    deadlineInSec: -3600, claimCount: 1,
  });

  assert.equal(
    await delta(() => reapExpiredDoorbellRuns(), EXITED, { outcome: "budget_exhausted" }),
    1,
    "one of the two rows was on the queue",
  );
  assert.equal((await runRow(h, "budget-queued")).failure_reason, "run_budget_exhausted");
  assert.equal((await runRow(h, "budget-running")).failure_reason, "run_budget_exhausted");
});

test("the sibling sweep counts only the spare that was still queued", async () => {
  // Driven through `reapLostLeases`, which is the only way in: a reaped chat
  // row hands its message id to the sibling close, and the spare that was
  // still waiting is the one that left the queue.
  const { reapLostLeases } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "sib-lost", "s1", {
    status: "running", dispatch: "fat", messageId: "m-1",
    leaseOwner: "brain-9", leaseExpiresInSec: -3600, claimCount: 1,
  });
  await seedRun(h, "sib-spare", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-1", queuedAgoSec: 20,
  });

  assert.equal(
    await delta(() => reapLostLeases(), EXITED, { outcome: "duplicate_closed" }),
    1,
    "the spare was on the queue; the row that lost its lease was not",
  );
  assert.equal((await runRow(h, "sib-spare")).failure_reason, "dispatch_retried");
});
