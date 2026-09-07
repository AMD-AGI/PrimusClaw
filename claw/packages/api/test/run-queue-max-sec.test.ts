// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The queue ceiling at its boundary, and the headroom a drain has to measure.
 *
 * Queue time is judged from `queued_at` rather than from the start of a drain,
 * so the configuration-level inequality -- ceiling comfortably above the drain
 * -- says nothing about a row that has already spent most of its budget. What
 * decides whether a drain is safe to begin is the remaining budget of the
 * oldest outstanding row, measured before the drain starts.
 *
 * Every row age here is derived from the imported constant rather than written
 * as a literal: `sweeper.ts` closes over the value frozen at its own import, so
 * an env override cannot move the ceiling these cases run against.
 */

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { envSettingProblems } from "../src/config.js";
import { metrics, registry } from "../src/infra/metrics.js";
import { RUN_QUEUE_MAX_SEC } from "../src/tasks/run-budget.js";
import { startHarness, seedSession, seedRun, runRow, type Harness } from "./scenario-harness.js";

const MAX = RUN_QUEUE_MAX_SEC;
// The reaper's predicate is `queued_at < NOW() - RUN_QUEUE_MAX_SEC`, a strict
// inequality. A row seeded at exactly the ceiling therefore expires only once
// the clock has moved past the seed, which under PGlite is a millisecond that
// may not have elapsed. One second over is the smallest age the boundary can be
// asserted at as a fact about the predicate rather than about seeding latency.
const SPENT = MAX + 1;
const TIMEOUT_MESSAGE = "queued past RUN_QUEUE_MAX_SEC without a worker claiming the run";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); await seedSession(h, "s1"); });
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

test("a row two minutes short of the queue ceiling is left alone", async () => {
  const { reapExpiredQueuedRuns } = await import("../src/tasks/sweeper.js");
  await seedRun(h, "fresh", "s1", { status: "queued", dispatch: "doorbell", queuedAgoSec: MAX - 120 });

  assert.equal(await reapExpiredQueuedRuns(), 0);
  const row = await runRow(h, "fresh");
  assert.equal(row.status, "queued");
  assert.equal(row.failure_reason, null);
  assert.equal(row.completed_at, null);
});

test("a row that has spent its queue budget is reaped", async () => {
  const { reapExpiredQueuedRuns } = await import("../src/tasks/sweeper.js");
  await seedRun(h, "spent", "s1", {
    status: "queued", dispatch: "doorbell", queuedAgoSec: SPENT, prompt: "summarise",
  });

  assert.equal(await reapExpiredQueuedRuns(), 1);
  const row = await runRow(h, "spent");
  assert.equal(row.status, "failed");
  assert.equal(row.failure_reason, "queue_timeout");
  assert.equal(row.error_message, TIMEOUT_MESSAGE);
  assert.notEqual(row.completed_at, null);
});

test("a row two minutes past the ceiling is reaped", async () => {
  const { reapExpiredQueuedRuns } = await import("../src/tasks/sweeper.js");
  await seedRun(h, "over", "s1", {
    status: "queued", dispatch: "doorbell", queuedAgoSec: MAX + 120, prompt: "summarise",
  });

  assert.equal(await reapExpiredQueuedRuns(), 1);
  const row = await runRow(h, "over");
  assert.equal(row.status, "failed");
  assert.equal(row.failure_reason, "queue_timeout");
  assert.equal(row.error_message, TIMEOUT_MESSAGE);
  assert.notEqual(row.completed_at, null);
});

test("the ceiling is judged per row, so one expiry does not take its neighbours", async () => {
  const { reapExpiredQueuedRuns } = await import("../src/tasks/sweeper.js");
  await seedRun(h, "under", "s1", { status: "queued", queuedAgoSec: MAX - 120 });
  await seedRun(h, "at", "s1", { status: "queued", queuedAgoSec: SPENT });
  await seedRun(h, "over", "s1", { status: "queued", queuedAgoSec: MAX + 3600 });

  assert.equal(await reapExpiredQueuedRuns(), 2);
  assert.equal((await runRow(h, "under")).status, "queued");
  assert.equal((await runRow(h, "at")).status, "failed");
  assert.equal((await runRow(h, "over")).status, "failed");
  assert.equal((await runRow(h, "at")).failure_reason, "queue_timeout");
  assert.equal((await runRow(h, "over")).failure_reason, "queue_timeout");
});

test("a per-row headroom short of the drain predicts the reap the config inequality misses", async () => {
  const { reapExpiredQueuedRuns } = await import("../src/tasks/sweeper.js");
  const DRAIN_SEC = 15 * 60;
  const CLAIM_NEXT_IDLE_SEC = 2;
  const headroom = (agedSec: number) => MAX - agedSec;
  const OLD_AGE = MAX - DRAIN_SEC + 60;

  await seedRun(h, "old", "s1", { status: "queued", queuedAgoSec: OLD_AGE });
  await seedRun(h, "young", "s1", { status: "queued", queuedAgoSec: 60 });

  // PGlite has no time travel, so the drain advances the rows instead of the clock.
  await h.sql(
    "UPDATE claw_tasks SET queued_at = queued_at - ($1::int * INTERVAL '1 second')",
    [DRAIN_SEC],
  );

  assert.equal(await reapExpiredQueuedRuns(), 1);
  const old = await runRow(h, "old");
  assert.equal(old.status, "failed", "a turn that was admitted, acknowledged and never run");
  assert.equal(old.failure_reason, "queue_timeout");
  assert.equal((await runRow(h, "young")).status, "queued");

  assert.ok(headroom(OLD_AGE) < DRAIN_SEC + CLAIM_NEXT_IDLE_SEC,
    "the per-row measurement is what says this drain is unsafe to start now");
  assert.ok(MAX > DRAIN_SEC + CLAIM_NEXT_IDLE_SEC,
    "and the config-level inequality says it is safe, which is the point");
});

test("the queue ceiling is its own setting, and a zero is refused rather than taken", async () => {
  const before = process.env.RUN_QUEUE_MAX_SEC;
  try {
    process.env.RUN_QUEUE_MAX_SEC = "600";
    const configured = await import("../src/tasks/run-budget.js?queue-max");
    assert.equal(configured.RUN_QUEUE_MAX_SEC, 600);
    assert.equal(configured.RUN_BUDGET_DEFAULT_SEC.chat, 48 * 60 * 60,
      "the wait ceiling and the execution budget were one number once");

    process.env.RUN_QUEUE_MAX_SEC = "0";
    const zeroed = await import("../src/tasks/run-budget.js?queue-zero");
    assert.equal(zeroed.RUN_QUEUE_MAX_SEC, 2 * 60 * 60);
    assert.ok(
      envSettingProblems().some((p) => p.startsWith("RUN_QUEUE_MAX_SEC=0")),
      "a ceiling that fails every row the instant it is enqueued is refused loudly",
    );
  } finally {
    if (before === undefined) delete process.env.RUN_QUEUE_MAX_SEC;
    else process.env.RUN_QUEUE_MAX_SEC = before;
  }
});

test("the queue-wait histogram's top finite bucket is the queue ceiling", async () => {
  // The buckets are only rendered once the series has an observation.
  metrics.observeQueueExit("chat", new Date(Date.now() - 1000).toISOString(), "timed_out");
  const text = await registry.metrics();
  const bounds = text.split("\n")
    .filter((line) => line.startsWith("claw_api_run_queue_wait_seconds_bucket{"))
    .map((line) => /le="([^"]+)"/.exec(line)?.[1])
    .filter((le): le is string => le !== undefined && le !== "+Inf")
    .map(Number);

  assert.ok(bounds.length > 0, "the histogram has to have been observed for its buckets to render");
  assert.equal(Math.max(...bounds), MAX,
    "a sojourn that reached the timeout belongs in the top bucket, not the overflow");
});

test("a requeue does not shorten the exposure it already spent", async () => {
  const sweeper = await import("../src/tasks/sweeper.js");
  await seedRun(h, "lost", "s1", {
    status: "running", dispatch: "doorbell",
    queuedAgoSec: MAX + 3600, startedAgoSec: MAX + 3600,
    leaseOwner: "brain-dead", leaseExpiresInSec: -3600,
    deadlineInSec: 3600, claimCount: 1,
  });

  assert.equal(await sweeper.requeueLostDoorbellLeases(), 1);
  assert.equal(await sweeper.reapExpiredQueuedRuns(), 0);
  const row = await runRow(h, "lost");
  assert.equal(row.status, "queued");
  assert.notEqual(row.deadline_at, null, "the turn's absolute budget is not reissued");
});

test("only a chat doorbell row is subject to the queue ceiling", async () => {
  const { reapExpiredQueuedRuns } = await import("../src/tasks/sweeper.js");
  await seedRun(h, "fat", "s1", { status: "queued", dispatch: "fat", queuedAgoSec: MAX + 3600 });
  await seedRun(h, "task", "s1", { status: "queued", origin: "task", queuedAgoSec: MAX + 3600 });
  await seedRun(h, "chat", "s1", { status: "queued", queuedAgoSec: MAX + 3600 });

  assert.equal(await reapExpiredQueuedRuns(), 1);
  assert.equal((await runRow(h, "chat")).status, "failed");
  for (const id of ["fat", "task"]) {
    const row = await runRow(h, id);
    assert.equal(row.status, "queued");
    assert.equal(row.failure_reason, null);
  }
});

test("a reaped queue timeout is counted as one, split by whether a worker ever held it", async () => {
  const { reapExpiredQueuedRuns } = await import("../src/tasks/sweeper.js");
  await seedRun(h, "never", "s1", { status: "queued", queuedAgoSec: MAX + 60, claimCount: 0 });
  await seedRun(h, "held", "s1", { status: "queued", queuedAgoSec: MAX + 60, claimCount: 2 });

  const TIMEOUTS = "claw_api_run_queue_timeout_total";
  const EXITED = "claw_api_run_queue_exited_total";
  const before = await registry.metrics();
  assert.equal(await reapExpiredQueuedRuns(), 2);
  const after = await registry.metrics();

  const moved = (name: string, labels: Record<string, string>) =>
    sample(after, name, labels) - sample(before, name, labels);
  assert.equal(moved(TIMEOUTS, { ever_held: "false" }), 1);
  assert.equal(moved(TIMEOUTS, { ever_held: "true" }), 1);
  assert.equal(moved(EXITED, { outcome: "timed_out" }), 2);
});
