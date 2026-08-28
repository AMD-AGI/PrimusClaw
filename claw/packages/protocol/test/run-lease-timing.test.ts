// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reaper that declares a run dead must be slower than the redelivery that
 * would have resumed it.
 *
 * Only one of the two recovers anything: a redelivered run resumes from its
 * checkpoint, while a reaped row is closed and the worker that eventually takes
 * it over reads the terminal row and stands down. So the ordering is the whole
 * property, and it used to be recorded as a comment reading "lease TTL (45s)
 * plus this has to exceed ack_wait (2min)" -- true, and comparing against the
 * wrong number. What the takeover waits for is not ack_wait but `lock.<key>`,
 * which a dead worker holds for the registry bucket's five minutes; every
 * redelivery before that is refused and nak'd on a doubling backoff. Against
 * the real bound a verdict at 165s preempts a takeover not due until ~7
 * minutes, and the pod death that should have cost a resume costs the turn.
 *
 * These pin the ordering, and pin it as a relation: each factor can be
 * overridden on its own, so what is asserted is that they still agree.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BRAIN_REGISTRY_TTL_MS,
  DEFAULT_RUN_LEASE_HEARTBEAT_MS,
  DEFAULT_RUN_LEASE_TTL_MS,
  MAX_RUN_LEASE_TTL_MS,
  RUN_LEASE_HEARTBEATS_PER_TTL,
  TASK_CONSUMER_ACK_WAIT_MS,
  effectiveRunLeaseTtlMs,
  resolveLeaseReapGraceSec,
  resolveLockBlockedTakeover,
  runLeaseTimingProblems,
  worstLockBlockedTakeover,
  type RunLeaseTiming,
} from "../src/run-lease.js";
import { DEFAULT_TASK_MAX_DELIVER } from "../src/task-consumer.js";

const SWEEPER_TICK_MS = 60_000;

/** The shipped configuration, with a grace derived the way the API derives it. */
function shippedTiming(overrides: Partial<RunLeaseTiming> = {}): RunLeaseTiming {
  const base = {
    leaseTtlMs: DEFAULT_RUN_LEASE_TTL_MS,
    heartbeatMs: DEFAULT_RUN_LEASE_HEARTBEAT_MS,
    lockTtlMs: DEFAULT_BRAIN_REGISTRY_TTL_MS,
    sweeperTickMs: SWEEPER_TICK_MS,
    maxDeliver: DEFAULT_TASK_MAX_DELIVER,
    ...overrides,
  };
  return { ...base, graceSec: overrides.graceSec ?? resolveLeaseReapGraceSec(base) };
}

test("the shipped numbers hold the ordering", () => {
  assert.deepEqual(runLeaseTimingProblems(shippedTiming()), []);
});

test("a takeover waits for the lock, not for ack_wait", () => {
  const takeoverMs = resolveLockBlockedTakeover({
    lockTtlMs: DEFAULT_BRAIN_REGISTRY_TTL_MS,
    maxDeliver: DEFAULT_TASK_MAX_DELIVER,
  }).atMs;
  // The message comes back at ack_wait and is then refused the lock for as long
  // as its dead holder keeps it, so the resume lands a whole backoff step past
  // the expiry rather than at it.
  assert.ok(
    takeoverMs > DEFAULT_BRAIN_REGISTRY_TTL_MS,
    `a takeover cannot happen while the lock is held: ${takeoverMs}ms`,
  );
  assert.ok(
    takeoverMs > TASK_CONSUMER_ACK_WAIT_MS * 3,
    "ack_wait is not the bound; asserting it is what made the old comment wrong",
  );
});

test("the verdict the PR shipped with would have preempted that takeover", () => {
  // 45s lease + 120s grace: the arithmetic that read as safe against ack_wait.
  const problems = runLeaseTimingProblems(shippedTiming({ graceSec: 120 }));
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /preempts the takeover/);
});

test("the worker that died is not always the one holding the first delivery", () => {
  // A task is nak'd before it executes whenever its lock is held, and DAG
  // siblings share one lock key by design, so starting on a later delivery is
  // the ordinary case for fan-out. The backoff after the death continues from
  // wherever the count had reached, so a later start means larger steps -- and
  // a death whose backoff lands just under the lock's expiry has to take one
  // more of them, which by then is a step at the ceiling.
  const shared = { lockTtlMs: DEFAULT_BRAIN_REGISTRY_TTL_MS, maxDeliver: DEFAULT_TASK_MAX_DELIVER };
  const first = resolveLockBlockedTakeover({ ...shared, diedOnDelivery: 1 });
  const fifth = resolveLockBlockedTakeover({ ...shared, diedOnDelivery: 5 });

  assert.equal(first.atMs, 430_000);
  assert.equal(fifth.atMs, 580_000);
  assert.ok(first.reachable && fifth.reachable, "both are deaths a reaper could be judging");
});

test("the grace outlasts the last takeover, not the first", () => {
  // The curve is not monotonic in the delivery the worker died on -- 430s, then
  // 420s, 400s, 360s, 580s, and 420s for every death after that -- so the first
  // death is neither the earliest nor the latest case, and deriving the grace
  // from it left the reaper closing runs whose takeover was still minutes out:
  // the row goes worker_lost, the redelivery that arrives later finds a
  // terminal row and stands down, and a pod death that should have cost a
  // resume costs the whole turn.
  const timing = shippedTiming();
  const worst = worstLockBlockedTakeover(timing);
  assert.equal(worst.atMs, 580_000);

  const verdictMs = timing.leaseTtlMs + timing.graceSec * 1000 - timing.heartbeatMs;
  for (let diedOnDelivery = 1; diedOnDelivery <= 8; diedOnDelivery++) {
    const takeover = resolveLockBlockedTakeover({ ...timing, diedOnDelivery });
    if (!takeover.reachable) continue;
    assert.ok(
      verdictMs >= takeover.atMs + timing.sweeperTickMs,
      `a death on delivery ${diedOnDelivery} is taken over at ${takeover.atMs}ms, `
      + `and the verdict lands at ${verdictMs}ms`,
    );
  }
});

test("the verdict is measured from the death, like everything it is compared to", () => {
  // The lease expires leaseTtlMs after the last *renewal*, which was up to a
  // heartbeat before the death. Left out, the margin over the takeover is
  // `sweeperTick - heartbeat` rather than a tick, which makes the tick the
  // entire margin: at a tick shorter than the heartbeat the derivation used to
  // produce a grace whose real verdict landed before the takeover it was
  // derived to outlast, with startup validation passing.
  const timing = shippedTiming({ sweeperTickMs: 10_000 });
  const takeover = worstLockBlockedTakeover(timing);
  const verdictMs = timing.leaseTtlMs + timing.graceSec * 1000 - timing.heartbeatMs;

  assert.ok(
    verdictMs >= takeover.atMs,
    `a verdict at ${verdictMs}ms must not precede the takeover at ${takeover.atMs}ms`,
  );
  assert.deepEqual(runLeaseTimingProblems(timing), []);
});

test("shortening the lock's TTL pays twice, and the second time is the one", () => {
  // The follow-up this leaves room for is giving `lock.<key>` a bucket of its
  // own, and the corrected curve says how short that bucket has to be. Halving
  // the registry's five minutes buys the ceiling-sized step the worst death
  // would otherwise have had to take -- real, but bounded by the ceiling, which
  // does not care what the lock costs. Under ack_wait the message comes back to
  // an expired lock and waits out no backoff at all, which is where the bound
  // stops being a curve and becomes ack_wait itself.
  const shipped = shippedTiming();
  const halved = shippedTiming({ lockTtlMs: DEFAULT_RUN_LEASE_TTL_MS + 120_000 });
  const underAckWait = shippedTiming({ lockTtlMs: TASK_CONSUMER_ACK_WAIT_MS - 10_000 });

  assert.ok(
    halved.graceSec < shipped.graceSec,
    `dropping the last step is worth something: ${halved.graceSec}s against ${shipped.graceSec}s`,
  );
  // No backoff is waited out at all, so the grace is the redelivery itself plus
  // the two allowances every verdict carries, and nothing else.
  const noBackoffSec = (TASK_CONSUMER_ACK_WAIT_MS + SWEEPER_TICK_MS
    + DEFAULT_RUN_LEASE_HEARTBEAT_MS - DEFAULT_RUN_LEASE_TTL_MS) / 1000;
  assert.equal(underAckWait.graceSec, noBackoffSec,
    "under ack_wait the curve is gone, and this is what is left");
  assert.deepEqual(runLeaseTimingProblems(halved), []);
  assert.deepEqual(runLeaseTimingProblems(underAckWait), []);
});

test("a lease still outlasts the renewals it promises", () => {
  assert.ok(
    DEFAULT_RUN_LEASE_HEARTBEAT_MS * RUN_LEASE_HEARTBEATS_PER_TTL
      <= DEFAULT_RUN_LEASE_TTL_MS,
    "two missed renewals must not be a death",
  );
  const problems = runLeaseTimingProblems(
    shippedTiming({ heartbeatMs: DEFAULT_RUN_LEASE_TTL_MS }),
  );
  assert.ok(problems.some((p) => /renewals inside leaseTtlMs/.test(p)));
});

test("a grace that parsed to zero is a problem, not a default", () => {
  // `Number(process.env.LEASE_LOST_GRACE_SEC ?? 120)` on an env var set to the
  // empty string is 0, which removes the grace silently. NaN is worse: it
  // reaches the reap query as `$1::int` and throws on every tick, taking the
  // rest of the sweeper's pass with it.
  for (const graceSec of [0, -1, Number.NaN]) {
    const problems = runLeaseTimingProblems(shippedTiming({ graceSec }));
    assert.ok(
      problems.some((p) => /graceSec must be a positive number/.test(p)),
      `graceSec=${graceSec} must be rejected`,
    );
  }
});

test("a lock TTL raised past the reaper is caught", () => {
  // The drift the derivation cannot see on its own: an operator widening the
  // registry bucket's TTL while the grace stays where it was.
  const timing = shippedTiming();
  const problems = runLeaseTimingProblems({
    ...timing,
    lockTtlMs: timing.lockTtlMs * 4,
  });
  assert.ok(problems.some((p) => /preempts the takeover/.test(p)));
});

test("the takeover bound cannot exceed the redelivery budget", () => {
  // Past max_deliver there are no more attempts, so the bound stops climbing:
  // a lock TTL nothing can outlast is not a longer wait, it is a task that is
  // never taken over at all.
  const bounded = resolveLockBlockedTakeover({
    lockTtlMs: 24 * 60 * 60 * 1000,
    maxDeliver: 3,
  }).atMs;
  const unbounded = resolveLockBlockedTakeover({
    lockTtlMs: 24 * 60 * 60 * 1000,
    maxDeliver: DEFAULT_TASK_MAX_DELIVER,
  }).atMs;
  assert.ok(bounded < unbounded, "fewer deliveries cannot mean a later takeover");
});

test("a budget that stops climbing before the lock expires has no takeover", () => {
  // The number the bound returns when it runs out of deliveries is where the
  // budget ended, not a takeover -- and it is smaller, so treating it as one
  // makes every ordering check against it pass. That is how a deployment can
  // satisfy the reaper's ordering and still lose every run a dead pod was
  // holding: the resume it was ordered against never happens.
  const lockTtlMs = DEFAULT_BRAIN_REGISTRY_TTL_MS;
  const starved = resolveLockBlockedTakeover({ lockTtlMs, maxDeliver: 4 });

  assert.ok(starved.atMs < lockTtlMs, "the budget ran out while the lock was still held");
  assert.equal(starved.reachable, false);
  assert.deepEqual(runLeaseTimingProblems(shippedTiming({ maxDeliver: 4 })).length, 1);
  assert.match(
    runLeaseTimingProblems(shippedTiming({ maxDeliver: 4 }))[0]!,
    /leaves no delivery that can take a run over/,
  );
});

test("a takeover the poison guard resolves first does not count either", () => {
  // The guard fires one delivery before the budget ends, and it resolves a task
  // whose lock is still held rather than waiting again. So the attempt has to
  // arrive no later than that delivery: at maxDeliver=7 the lock outlives the
  // guard's delivery, the task is discarded as lock_contention_exhausted, and
  // the attempt the arithmetic counted on is never made.
  const lockTtlMs = DEFAULT_BRAIN_REGISTRY_TTL_MS;
  const discarded = resolveLockBlockedTakeover({ lockTtlMs, maxDeliver: 7 });

  assert.ok(discarded.atMs >= lockTtlMs, "the wait does outlast the lock here");
  assert.equal(discarded.delivery, 7);
  assert.equal(discarded.reachable, false, "but delivery 7 is past the guard at 6");
  assert.ok(
    runLeaseTimingProblems(shippedTiming({ maxDeliver: 7 }))
      .some((p) => /poison guard resolves the task on delivery 6/.test(p)),
  );

  // One more delivery is all it takes: the attempt lands on the guard's own
  // delivery, which is the one it leaves usable.
  assert.equal(resolveLockBlockedTakeover({ lockTtlMs, maxDeliver: 8 }).reachable, true);
  assert.deepEqual(runLeaseTimingProblems(shippedTiming({ maxDeliver: 8 })), []);
});

test("a lease wider than the endpoint grants is judged by what a row can hold", () => {
  // The renewal endpoint caps what it writes, so a configured TTL above the cap
  // is not the TTL any row carries. Deriving the grace from the configured
  // value describes a verdict that arrives later than the real one, and the
  // ordering then holds only on paper: the row's lease expires at the cap, the
  // reaper fires a full cap earlier than it thinks, and it lands before the
  // takeover.
  const configured = MAX_RUN_LEASE_TTL_MS + 100_000;
  const timing = shippedTiming({ leaseTtlMs: configured });
  const takeover = resolveLockBlockedTakeover(timing);

  assert.deepEqual(runLeaseTimingProblems(timing), []);
  const realVerdictMs = effectiveRunLeaseTtlMs(configured) + timing.graceSec * 1000;
  assert.ok(
    realVerdictMs >= takeover.atMs + timing.sweeperTickMs,
    `a row's lease is capped at ${MAX_RUN_LEASE_TTL_MS}ms, so the verdict lands at `
    + `${realVerdictMs}ms and must still not preempt the takeover at ${takeover.atMs}ms`,
  );
});

test("the cap is the endpoint's, not a second copy of it", () => {
  // Both sides of the truncation have to be the same number: the endpoint that
  // writes the lease and the derivation that waits it out.
  assert.equal(effectiveRunLeaseTtlMs(MAX_RUN_LEASE_TTL_MS + 1), MAX_RUN_LEASE_TTL_MS);
  assert.equal(effectiveRunLeaseTtlMs(DEFAULT_RUN_LEASE_TTL_MS), DEFAULT_RUN_LEASE_TTL_MS);
});
