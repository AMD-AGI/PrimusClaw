// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// task-lock-contention.test.ts
//
// Pins the two behaviours that let a task queued behind a long-running sibling
// survive, and that keep the release path from crying wolf.
//
// Both were live defects: a flat 3s nak spent the whole TASK_MAX_DELIVER budget
// in ~30s and NATS then dropped the task with no event at all, and every
// replica logged hundreds of `legacy_value_format_skip` warnings for locks it
// had just deleted correctly, because NATS KV answers a deleted key with an
// empty-payload tombstone rather than a miss.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lockContentionNakMs } from "../src/tasks/lock.js";
import { retryBase } from "../src/tasks/dispatch.js";
import {
  TASK_LOCK_NAK_BASE_MS,
  TASK_LOCK_NAK_MAX_MS,
  TASK_MAX_DELIVER,
  TASK_POISON_DELIVERY_COUNT,
  resolveTaskDeliveryBudget,
} from "../src/config.js";
import {
  DEFAULT_TASK_MAX_DELIVER,
  TASK_CONSUMER_ACK_WAIT_NS,
  TASK_LOCK_NAK_CEILING_NS, resolveTaskStreamMaxAgeNs,
} from "@claw/protocol";

// Pin the jitter so the assertions describe the curve, not the dice.
const noJitter = () => 1;

test("lock-contention backoff grows and is capped", () => {
  assert.equal(lockContentionNakMs(1, noJitter), TASK_LOCK_NAK_BASE_MS);
  assert.equal(lockContentionNakMs(2, noJitter), TASK_LOCK_NAK_BASE_MS * 2);
  assert.equal(lockContentionNakMs(3, noJitter), TASK_LOCK_NAK_BASE_MS * 4);

  for (const delivery of [20, 100, 10_000]) {
    assert.equal(lockContentionNakMs(delivery, noJitter), TASK_LOCK_NAK_MAX_MS);
  }
});

test("jitter stays under the nominal delay and never reaches zero", () => {
  for (const random of [() => 0, () => 0.5, () => 0.999]) {
    const ms = lockContentionNakMs(3, random);
    assert.ok(ms > 0, `expected a positive delay, got ${ms}`);
    assert.ok(
      ms <= TASK_LOCK_NAK_BASE_MS * 4,
      `jitter must not exceed the nominal delay, got ${ms}`,
    );
  }
});

test("a contended task gets ~60min of retries before the guard resolves it", () => {
  // The whole point of the backoff: the redelivery budget has to outlast the
  // runs queued in front of this one, not evaporate in half a minute.
  //
  // Only deliveries 1..POISON-1 actually nak — the poison guard resolves the
  // task on delivery POISON, so summing all the way to TASK_MAX_DELIVER
  // credits the backoff with two redeliveries that can never happen. The
  // honest figure is ~80min nominal and ~60min once jitter sits at its 0.75
  // floor, which is the number an operator should hold this to.
  //
  // Sixty rather than the fifteen this used to assert because the gate now keys
  // on the workspace: several DAG roots on one session serialise on one
  // directory, and a fan-out of six three-minute roots already put the tail
  // past a fifteen-minute budget. What the user saw then was not a queued task
  // but a failed one.
  const worstCaseJitter = () => 0;
  let nominal = 0;
  let worstCase = 0;
  for (let delivery = 1; delivery < TASK_POISON_DELIVERY_COUNT; delivery++) {
    nominal += lockContentionNakMs(delivery, noJitter);
    worstCase += lockContentionNakMs(delivery, worstCaseJitter);
  }

  assert.ok(
    worstCase >= 60 * 60_000,
    `redelivery budget spans only ${Math.round(worstCase / 60_000)}min at worst-case jitter; a queued task would be dropped`,
  );
  assert.ok(
    nominal <= TASK_MAX_DELIVER * TASK_LOCK_NAK_MAX_MS,
    "sanity: the budget cannot exceed the ceiling times the deliveries",
  );
});

test("the poison guard fires before NATS drops the task", () => {
  // If this inverts, a task that exhausts its retries vanishes with no
  // exec_complete and its session stays 'running' forever.
  assert.ok(
    TASK_POISON_DELIVERY_COUNT < TASK_MAX_DELIVER,
    `poison guard at ${TASK_POISON_DELIVERY_COUNT} is unreachable with max_deliver=${TASK_MAX_DELIVER}`,
  );
  assert.ok(TASK_POISON_DELIVERY_COUNT >= 2, "must allow at least one honest retry");
});

// The ordering has to survive whatever an operator puts in TASK_MAX_DELIVER,
// not just the default. A ceiling of 1 or 2 used to push the guard to or past
// it, which is the unreachable-guard bug this pair exists to prevent.
test("the ordering holds for every configured ceiling", () => {
  const configured = [
    Number.NaN, Number.POSITIVE_INFINITY, -10, 0, 1, 2, 3, 4, 9, 10, 50, 7.9,
  ];
  for (const value of configured) {
    const { maxDeliver, poisonDeliveryCount } = resolveTaskDeliveryBudget(value);
    assert.ok(
      poisonDeliveryCount < maxDeliver,
      `TASK_MAX_DELIVER=${value} yielded guard ${poisonDeliveryCount} >= ceiling ${maxDeliver}`,
    );
    assert.ok(
      poisonDeliveryCount >= 2,
      `TASK_MAX_DELIVER=${value} left no room for an honest retry`,
    );
  }
});

test("a usable ceiling is passed through untouched", () => {
  // Clamping is a floor, not a policy: it must not quietly rewrite a sane value.
  assert.deepEqual(resolveTaskDeliveryBudget(10), { maxDeliver: 10, poisonDeliveryCount: 9 });
  assert.deepEqual(resolveTaskDeliveryBudget(3), { maxDeliver: 3, poisonDeliveryCount: 2 });
});

// Retention is the other half of guard reachability, and the half that used to
// be a round number picked independently. `max_age` deletes on age alone, so a
// stream that expires a message before the durable has spent its budget removes
// the task while it is still entitled to retry -- and the guard whose whole
// purpose is to report a doomed task never runs.
test("the stream outlives the redelivery budget for every configured ceiling", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1, 3, 10, 50]) {
    const { maxDeliver, poisonDeliveryCount } = resolveTaskDeliveryBudget(value);
    const retentionNs = resolveTaskStreamMaxAgeNs(maxDeliver);
    // Each delivery can spend a whole ack_wait waiting to be taken back, and a
    // lock-contended redelivery waits out its nak backoff on top of that. Both
    // terms matter: they used to be the same number, so an expression that
    // dropped one still gave the right answer, and stopped doing so the moment
    // ack_wait was shortened.
    const perDeliveryNs = TASK_CONSUMER_ACK_WAIT_NS + TASK_LOCK_NAK_CEILING_NS;
    assert.ok(
      retentionNs >= maxDeliver * perDeliveryNs,
      `TASK_MAX_DELIVER=${value}: retention ${retentionNs}ns expires inside the budget`,
    );
    // The guard fires one delivery early, so it has to land well inside.
    assert.ok(
      retentionNs > poisonDeliveryCount * perDeliveryNs,
      `TASK_MAX_DELIVER=${value}: the poison guard at delivery ${poisonDeliveryCount} is past retention`,
    );
  }
});

test("the previous flat one-hour retention would not have held the default budget", () => {
  // Pins the actual regression rather than only the new invariant: this is the
  // arithmetic that was silently dropping tasks.
  const ONE_HOUR_NS = 60 * 60 * 1_000_000_000;
  const { maxDeliver } = resolveTaskDeliveryBudget(DEFAULT_TASK_MAX_DELIVER);
  const budgetNs = maxDeliver * (TASK_CONSUMER_ACK_WAIT_NS + TASK_LOCK_NAK_CEILING_NS);
  assert.ok(budgetNs > ONE_HOUR_NS,
    "the budget outlasting one hour is the premise of the fix");
  assert.ok(resolveTaskStreamMaxAgeNs(maxDeliver) > ONE_HOUR_NS,
    "so retention has to be longer than the hour it used to be");
});

test("retention still covers the budget after ack_wait was shortened", () => {
  // Shortening ack_wait to two minutes was safe only because retention stopped
  // being a multiple of it. Under the old `2 x maxDeliver x ack_wait` the same
  // change would have cut the stream to forty minutes, against a chain of nak
  // backoffs that alone can run past twenty before the poison guard fires --
  // messages deleted mid-budget, tasks gone with their sessions left running.
  const { maxDeliver } = resolveTaskDeliveryBudget(DEFAULT_TASK_MAX_DELIVER);
  const worstCaseNs = maxDeliver * (TASK_CONSUMER_ACK_WAIT_NS + TASK_LOCK_NAK_CEILING_NS);
  const oldExpressionNs = 2 * maxDeliver * TASK_CONSUMER_ACK_WAIT_NS;
  assert.ok(
    oldExpressionNs < worstCaseNs,
    `the old expression gives ${oldExpressionNs}ns against a ${worstCaseNs}ns budget`,
  );
  assert.equal(resolveTaskStreamMaxAgeNs(maxDeliver), worstCaseNs);
});

test("an unbounded ceiling clamps to the maximum, not the minimum", () => {
  // Infinity used to fall through the non-finite branch and land on the
  // *smallest* allowed budget -- the opposite of what was configured.
  const { maxDeliver } = resolveTaskDeliveryBudget(Number.POSITIVE_INFINITY);
  assert.ok(
    maxDeliver > DEFAULT_TASK_MAX_DELIVER,
    `asking for no ceiling yielded ${maxDeliver}`,
  );
  assert.deepEqual(resolveTaskDeliveryBudget(1_000_000), resolveTaskDeliveryBudget(Number.POSITIVE_INFINITY));

  // Unparseable input has no intent to honour, so it takes the default.
  assert.deepEqual(
    resolveTaskDeliveryBudget(Number.NaN),
    { maxDeliver: DEFAULT_TASK_MAX_DELIVER, poisonDeliveryCount: DEFAULT_TASK_MAX_DELIVER - 1 },
  );
});

// The backoff is the only thing keeping a contended task from spending its
// whole budget at once. It is a constant rather than a knob precisely so a
// base of 0 cannot nak(0) in a hot loop, but the property still has to hold.
test("the backoff can never redeliver immediately", () => {
  for (const delivery of [1, 2, 5, 50]) {
    for (const random of [() => 0, () => 0.5, () => 1]) {
      assert.ok(
        lockContentionNakMs(delivery, random) > 0,
        `delivery ${delivery} produced a non-positive delay`,
      );
    }
  }
  assert.ok(TASK_LOCK_NAK_MAX_MS >= TASK_LOCK_NAK_BASE_MS, "ceiling must not sit below the base");
});

test("a claimed doorbell's backoff grows with the row's claim count", () => {
  // The defect this pins: handleClaimedRequest used to build its stub with a
  // hardcoded deliveryCount of 1, so every claim-next cycle asked for the
  // first delay again while claim_count climbed to the poison ceiling. Twenty
  // two claims at five seconds is about two minutes; the fat path rides the
  // same contention out for the best part of an hour.
  const at = (n: number): number => lockContentionNakMs(n, () => 1);
  assert.equal(at(1), TASK_LOCK_NAK_BASE_MS);
  assert.ok(at(4) > at(2) && at(2) > at(1), "each claim waits longer than the last");
  assert.equal(at(30), TASK_LOCK_NAK_MAX_MS, "and it stops at the ceiling");

  // Total tolerated contention, which is the number that has to match the fat
  // path rather than the per-attempt delay.
  let total = 0;
  for (let n = 1; n <= 22; n++) total += at(n);
  assert.ok(total > 30 * 60_000, `22 claims should cover well over 30min, got ${Math.round(total / 60_000)}min`);
});

test("a claimed doorbell's delay is driven by the row's claim count, not a constant", () => {
  // The test above only exercises lockContentionNakMs, which this PR did not
  // change -- revert the stub back to a hardcoded delivery count of 1 and it
  // stays green. This one drives retryBase, which is where the defect was.
  const delayAt = (claimCount: number): number =>
    lockContentionNakMs(retryBase(0, 1, claimCount).info.deliveryCount, () => 1);

  assert.equal(delayAt(1), TASK_LOCK_NAK_BASE_MS);
  assert.ok(delayAt(8) > delayAt(4), "the eighth claim waits longer than the fourth");
  assert.ok(delayAt(4) > delayAt(1));
  assert.equal(delayAt(40), TASK_LOCK_NAK_MAX_MS, "and it still stops at the ceiling");
});

test("a genuine redelivery still wins when it is the larger of the two", () => {
  // retryBase takes the max so a fat redelivery is not ignored, while the
  // generation the settle path sends is carried separately -- the two used to
  // be the same field, which made every settle from a redelivered wakeup stale.
  assert.equal(retryBase(0, 9, 2).info.deliveryCount, 9);
  assert.equal(retryBase(0, 1, 6).info.deliveryCount, 6);
  assert.equal(retryBase(0, 0, 0).info.deliveryCount, 1, "never zero");
});
