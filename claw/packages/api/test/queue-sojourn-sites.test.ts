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

import { db } from "../src/infra/db.js";
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

test("a release that closes a stopped row books no re-entry to the queue", async () => {
  // The release has two outcomes and only one of them is a requeue. Counting
  // both would report a queue the row never rejoined, and the gap is silent:
  // the counter is what the queue's depth is reconciled against.
  const { interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  const { releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "stopped", "s1", {
    status: "preparing", dispatch: "doorbell", prompt: "hello", claimable: true,
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });
  await interruptSessionRuns("s1");

  const moved = await delta(
    () => releaseClaim("stopped", "brain-a", 1, "lock_contention"),
    ENTERED, { cause: "requeue" },
  );

  assert.equal(moved, 0);
  assert.equal((await runRow(h, "stopped")).status, "cancelled");
});

test("and an ordinary release still books one", async () => {
  const { releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "cycled", "s1", {
    status: "preparing", dispatch: "doorbell", prompt: "hello", claimable: true,
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });

  const moved = await delta(
    () => releaseClaim("cycled", "brain-a", 1, "lock_contention"),
    ENTERED, { cause: "requeue" },
  );

  assert.equal(moved, 1);
  assert.equal((await runRow(h, "cycled")).status, "queued");
});

test("a Stop counts every row a claim took between the status read and the write", async () => {
  // The read that captures each row's prior status is its own statement, so
  // the `FOR UPDATE` it takes is gone before the write runs. A claim landing
  // in that window leaves a row whose Stop is still a queue exit, and one
  // increment for the whole batch loses every row after the first.
  const { interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "raced-1", "s1", { status: "queued", dispatch: "fat", messageId: "m-1" });
  await seedRun(h, "raced-2", "s1", { status: "queued", dispatch: "fat", messageId: "m-2" });

  const inner = db.query;
  db.query = (async (text: string, params?: unknown[]) => {
    const r = await inner(text, params);
    if (/status AS prior_status\s+FROM claw_tasks/.test(text)) {
      await h.sql(
        `UPDATE claw_tasks
            SET status = 'preparing', lease_owner = 'brain-a', claim_count = 1,
                lease_expires_at = NOW() + INTERVAL '60 seconds'
          WHERE session_id = 's1' AND status = 'queued'`,
      );
    }
    return r;
  }) as typeof db.query;

  try {
    assert.equal(
      await delta(() => interruptSessionRuns("s1"), EXITED, { outcome: "cancelled" }),
      2,
      "both rows were on the queue when the Stop read them",
    );
  } finally {
    db.query = inner;
  }
  assert.equal((await runRow(h, "raced-1")).status, "cancelling");
  assert.equal((await runRow(h, "raced-2")).status, "cancelling");
});

test("a requeued row waits again from the requeue, not from its first entry", async () => {
  // Three trips round the loop are three waits. A marker left at the first
  // entry reports one that only grows, so the queue-wait percentiles and any
  // timeout keyed on it are wrong for every run that was ever retried.
  const { claimRunById, releaseClaim } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "recycled", "s1", {
    status: "preparing", dispatch: "doorbell", prompt: "hello", claimable: true,
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });
  await h.sql(
    `UPDATE claw_tasks
        SET metadata = jsonb_set(metadata, '{queued_since}',
              to_jsonb((NOW() - INTERVAL '600 seconds')::text))
      WHERE task_id = 'recycled'`,
  );

  await releaseClaim("recycled", "brain-a", 1, "lock_contention");
  const waited = await delta(
    () => claimRunById("recycled", "brain-b", 1),
    "claw_api_run_queue_wait_seconds_sum", { origin: "chat", outcome: "claimed" },
  );

  assert.ok(
    waited < 5,
    `the second sojourn began at the requeue, so it is seconds and not minutes; got ${waited}`,
  );
  assert.equal((await runRow(h, "recycled")).status, "preparing");
});

test("a requeued lost lease is measured as a fresh wait, not one that keeps growing", async () => {
  // The row has already served a wait, been claimed, and lost its lease. If the
  // requeue leaves the old marker in place, the next exit reports the whole
  // time since the row first queued rather than the trip that just ended, and a
  // p99 gate on bounded waits can never come down however fast each trip is
  // served.
  const { requeueLostDoorbellLeases } = await import("../src/tasks/sweeper.js");
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "recycled", "s1", {
    status: "running", dispatch: "doorbell", messageId: "m-recycled",
    prompt: "hello", claimable: true,
    leaseOwner: "brain-a", leaseExpiresInSec: -3_600, claimCount: 1,
  });
  await h.sql(
    `UPDATE claw_tasks
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb), '{queued_since}', to_jsonb($2::text)
            )
      WHERE task_id = $1`,
    ["recycled", new Date(Date.now() - 3_600_000).toISOString()],
  );

  assert.equal(await requeueLostDoorbellLeases(), 1);

  const waited = await delta(
    () => claimRunById("recycled", "brain-b"),
    "claw_api_run_queue_wait_seconds_sum", { origin: "chat", outcome: "claimed" },
  );
  assert.equal((await runRow(h, "recycled")).status, "preparing");
  assert.ok(
    waited < 60,
    `the exit measures the trip that just ended, not the hour before it (got ${waited}s)`,
  );
});
