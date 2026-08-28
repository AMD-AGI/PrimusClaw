// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The shared `brain-workers` durable, as a contract between the one process
// that writes it and the several that read it.
//
// The API owns this durable the same way it owns the stream underneath it, and
// for the same reason. When every brain pod reconciled it on start, the fleet's
// delivery ceiling was whichever pod restarted last: one configured lower
// silently lowered it for every replica already running under the higher value,
// and passed its own post-update check on the way, because that check only ever
// compared the durable against the pod that had just written it.
//
// One writer only works if the reader computes the same numbers from the same
// environment, so the resolution lives here rather than being mirrored in two
// config files that agree until one of them is edited.

/** JetStream stream carrying `tasks.execute`, provisioned by the API. */
export const TASK_STREAM_NAME = "PRIMUS_CLAW_TASKS";

/** Durable pull consumer shared by every brain pod. */
export const TASK_CONSUMER_NAME = "brain-workers";

/**
 * How long the server waits for an ack before redelivering, in nanoseconds.
 *
 * This is not the length of a task. A worker sends a progress ack every ten
 * seconds for as long as it holds a delivery -- while the message queues for
 * an execution slot, through the dispatch checks, and across the agent loop
 * -- and each one restarts this timer. So what the value actually sets is how
 * long after a pod stops answering the server waits before giving the message
 * to someone else.
 *
 * It was ten minutes, sized for a whole agent loop, from before the progress
 * acks covered everything a pod does with a message. The cost of that was
 * paid on the recovery path: a pod killed mid-run left its work untouched for
 * ten minutes, and the stream had to retain messages for hours because
 * retention was derived from this number. Two minutes is eleven missed
 * heartbeats -- comfortably more than a slow GC pause or a brief NATS
 * reconnect, and far less than the interval over which a human notices a
 * stuck conversation.
 *
 * The floor on shortening it further is that every legitimate way for a pod
 * to hold a message must be covered by a heartbeat. See keepDeliveryAlive in
 * brain's index.ts, which is what makes that true.
 */
export const TASK_CONSUMER_ACK_WAIT_NS = 2 * 60 * 1_000_000_000;

/**
 * The longest a redelivery caused by lock contention waits before it lands.
 *
 * Lives here, next to the retention it feeds, rather than in brain's config
 * where the backoff is applied: retention has to cover this delay, and the
 * two numbers drifting apart is what makes the stream drop messages the
 * durable is still entitled to redeliver. Brain's TASK_LOCK_NAK_MAX_MS reads
 * it from here, so there is one number.
 *
 * It is also the latency of picking a queued run up. Nothing wakes a waiting
 * message when the gate frees -- the only way it learns is by being redelivered
 * and trying again -- so a directory sits idle for up to this long between one
 * run releasing the lock and the next one taking it. Ten minutes made that the
 * dominant cost of queueing on a workspace where runs take minutes, which is
 * the common case. Five spends the same budget on more attempts instead, which
 * is what the budget is for.
 */
export const TASK_LOCK_NAK_CEILING_NS = 5 * 60 * 1_000_000_000;

/**
 * The smallest ceiling that can hold a guard strictly inside it while still
 * leaving one honest retry. Anything lower cannot satisfy both, and the
 * ordering is the constraint that must not bend -- so a ceiling below this is
 * raised to it rather than allowed to squeeze the guard out.
 */
const MIN_TASK_MAX_DELIVER = 3;

/**
 * Upper bound on the ceiling. A redelivery budget is only useful if it is
 * eventually exhausted, and `TASK_MAX_DELIVER=Infinity` used to fall through
 * the non-finite branch and collapse to the *minimum* — the opposite of what
 * was asked for.
 */
const MAX_TASK_MAX_DELIVER = 100;

/**
 * Deliveries a task gets before NATS would drop it, and the brain's poison
 * guard steps in.
 *
 * Sized by what the budget is mostly spent on, which is not failure. A run
 * waiting for the workspace gate spends one delivery per attempt, so this number
 * -- through the backoff curve -- is the real answer to "how long may a run
 * queue behind the runs sharing its directory before it is told to give up".
 *
 * At ten it was about fifteen minutes at the jitter floor, which was shorter
 * than the queue it had to cover: several DAG roots on one session serialise on
 * that session's workspace, so a fan-out of six three-minute roots already put
 * the tail past the budget, and the user saw a task that failed with "timed out
 * waiting for an earlier task" rather than one that was merely queued. Twenty
 * three spreads the curve over roughly eighty minutes nominal and sixty at the
 * jitter floor -- longer than any single run's deadline, so the budget is no
 * longer the thing that decides.
 *
 * What follows from raising it: the task stream's retention, which is derived
 * from it and moves on its own, and TASK_MAX_ACK_PENDING, which is not derived
 * and has to be raised with it because it depends on the deployment's replica
 * count -- see below. The deletion tombstone's TTL takes this only as a floor and
 * does not move with it at all: every value the clamp permits derives a window
 * shorter than the event stream's retention, and that retention is what decides
 * how long a deleted session stays marked.
 */
export const DEFAULT_TASK_MAX_DELIVER = 23;

/**
 * Default unacked ceiling for the durable, fleet-wide rather than per pod.
 *
 * It has to cover the tasks executing across every replica *and* the ones
 * nak'd and waiting on a lock, which NATS counts as outstanding for the whole
 * redelivery delay. See TASK_MAX_ACK_PENDING in brain's config for why the
 * previous replicas * MAX_CONCURRENT expression left no room for the second
 * set and turned a few lock-contended tasks into a fleet-wide stall.
 *
 * Raised with the redelivery budget, because the waiting set is what grew: runs
 * on one session now queue on that session's workspace instead of running
 * concurrently, and each one stays outstanding for as long as it waits. At 64,
 * one wide fan-out could hold every slot and stop delivery for the whole fleet
 * -- the failure this value exists to prevent, arrived at from the other side.
 * Spare slots cost nothing but bookkeeping: what runs is decided per pod by the
 * execution gate, not here.
 */
export const DEFAULT_TASK_MAX_ACK_PENDING = 256;

/**
 * Resolve the redelivery ceiling and the guard that must fire inside it.
 *
 * Once deliveryCount exceeds the consumer's max_deliver, NATS drops the task
 * without telling anyone: no event is emitted and the session stays 'running'
 * forever. The brain's poison guard has to fire strictly inside that budget so
 * the task is resolved with a user-visible exec_complete instead -- the
 * previous hard-coded 50 against a max_deliver of 10 was unreachable, and every
 * task that hit the retry ceiling vanished silently.
 *
 * The pair is only correct as a pair, and deriving it in one place keeps
 * `poison < ceiling` structurally true for every input rather than true for the
 * default and hoped for otherwise. Total by construction, so a misconfigured
 * `TASK_MAX_DELIVER=1` cannot reintroduce the unreachable guard this whole
 * mechanism exists to prevent.
 */
export function resolveTaskDeliveryBudget(configuredMaxDeliver: number): {
  maxDeliver: number;
  poisonDeliveryCount: number;
} {
  const floored = Math.floor(configuredMaxDeliver);
  // Unparseable input is the one case with no intent to honour, so it takes
  // the documented default. Infinity clamps to the ceiling like any other
  // oversized value.
  const maxDeliver = Number.isNaN(floored)
    ? DEFAULT_TASK_MAX_DELIVER
    : Math.min(MAX_TASK_MAX_DELIVER, Math.max(MIN_TASK_MAX_DELIVER, floored));
  return { maxDeliver, poisonDeliveryCount: maxDeliver - 1 };
}

/**
 * How long the task stream has to keep a message, in nanoseconds.
 *
 * Derived from the redelivery budget rather than chosen, because a retention
 * shorter than the budget makes the budget a fiction. `max_age` deletes on age
 * alone and does not consult consumer state, so the stream was dropping
 * messages the durable was still entitled to redeliver: at a one-hour retention
 * against ack_wait 10m x max_deliver 10, a task that kept losing its lock was
 * removed around delivery 6, and the poison guard that fires at
 * `maxDeliver - 1` — the thing that turns a doomed task into a user-visible
 * exec_complete — never got to run. The task simply disappeared, with the
 * session left at 'running'.
 *
 * The bound is the worst-case wall clock a message can legitimately occupy:
 * every delivery may burn a full ack_wait before the server takes it back, and
 * a redelivery caused by lock contention waits out its nak backoff on top of
 * that. So each delivery costs at most one of each, and the budget is
 * `maxDeliver * (ack_wait + nak ceiling)`.
 *
 * Written that way rather than as `2 * maxDeliver * ack_wait`, which was the
 * same number back when the nak ceiling and ack_wait were both ten minutes.
 * They are not any more: shortening ack_wait to two minutes under the old
 * expression would have cut retention to forty minutes while a contended task
 * can still spend twenty on backoff alone -- the stream would drop messages
 * the durable was still entitled to redeliver, which is the exact failure
 * this function was written to prevent.
 *
 * Retention past the bound is idle disk for small JSON payloads; retention
 * short of it is a task that disappears with its session left running.
 */
export function resolveTaskStreamMaxAgeNs(maxDeliver: number): number {
  return maxDeliver * (TASK_CONSUMER_ACK_WAIT_NS + TASK_LOCK_NAK_CEILING_NS);
}

/**
 * The shortest a session's deletion tombstone may live, in milliseconds.
 *
 * A lower bound, not the lifetime. A tombstone answers exactly one question --
 * "was this session deleted while this message was in flight?" -- so it has to
 * outlive anything that could still ask it, and this covers the one asker this
 * module knows about: a task the durable can still redeliver. Raising the bound
 * for the others belongs to the caller, because they are not this package's
 * numbers. The API consults the same mark for every event it takes off its own
 * event stream, whose retention owes nothing to this budget and outlasts it on
 * every configuration the clamp permits; see `tombstoneTtlMs` in the API's
 * infra/nats.ts, which keeps the larger of the two.
 *
 * The bound's old home was the registry bucket, whose five-minute TTL is chosen
 * for a different job entirely: `lock.<key>` wants to expire quickly so a dead
 * worker's claim is released. Sharing the bucket meant the tombstone inherited
 * that, and the gap was not small. A redelivery can arrive up to
 * `resolveTaskStreamMaxAgeNs` later -- two hours and forty-one minutes on the
 * default budget -- so the tombstone was gone for all but the first five minutes
 * of the window during which it was the only thing that would have stopped work
 * being dispatched into a deleted session.
 *
 * Derived from the same budget as the stream retention rather than picked, so
 * this bound and the window it answers for cannot drift apart: however late the
 * retention lets a redelivery arrive, the mark is still there to be asked.
 */
export function resolveTombstoneTtlMs(maxDeliver: number): number {
  return resolveTaskStreamMaxAgeNs(maxDeliver) / 1_000_000;
}
