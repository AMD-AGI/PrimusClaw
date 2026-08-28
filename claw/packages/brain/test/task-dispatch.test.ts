// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The poison guard's wiring, as opposed to its arithmetic.
//
// resolveTaskDeliveryBudget already pins TASK_POISON_DELIVERY_COUNT <
// TASK_MAX_DELIVER for every configured ceiling, but that only proves the
// numbers are ordered. It cannot prove handleTask actually branches on the
// threshold, nor that it picks the right reason once it does -- and both of
// those are invisible in production until they misfire:
//
//   * fire too late and the task is gone, session still marked running, with
//     no event for the user and nothing but a NATS advisory to notice by.
//   * classify wrongly and a task that never ran, because a sibling held its
//     lock for longer than the redelivery budget, is reported to the user and
//     to claw_brain_task_poison_discarded_total as one that kept failing --
//     pointing whoever investigates at the task instead of at the queue.
//   * give up on a task whose sibling released the lock during the last
//     backoff window -- about half the budget by wall clock -- and a task that
//     never ran and could now run is discarded a delivery before it would
//     have succeeded.
//   * settle a message whose executing handler still intends to ack it, or
//     resolve one whose holder is only unidentifiable because a pre-seq pod
//     wrote the lock, and a running task is reported failed under the exact
//     reading the recorded sequence was added to rule out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type JsMsg, type KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import { RUN_DOORBELL_KIND } from "@claw/protocol";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { handleTask, bindTaskDispatchKv } from "../src/tasks/dispatch.js";
import { bindTaskLockKv } from "../src/tasks/lock.js";
import { bindTaskRunnerDeps } from "../src/tasks/runner.js";
import { markRetryPending } from "../src/tasks/retry-pending.js";
import { activeAbort, resolveAbortTargets } from "../src/tasks/abort-registry.js";
import { TASK_MAX_DELIVER, TASK_POISON_DELIVERY_COUNT } from "../src/config.js";

const sc = StringCodec();
const SESSION = "sess-dispatch";
const MESSAGE = "msg-dispatch";
// Stream sequence, stable across redeliveries of the same message, which is
// what the lock records so a redelivery can recognise its own run.
const SEQ = 4242;

function fakeMsg(deliveryCount: number, request: Partial<ExecuteRequest>) {
  const verdicts: string[] = [];
  const msg = {
    data: sc.encode(JSON.stringify(request)),
    redelivered: deliveryCount > 1,
    seq: SEQ,
    info: { deliveryCount },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  };
  return { msg: msg as unknown as JsMsg, verdicts };
}

/**
 * Enough of the KV surface for the lock, lease and tombstone reads on this
 * path. `lockTaken` refuses the create while leaving the read a miss, which is
 * how a lock another pod grabbed between the probe and the create behaves.
 */
function fakeKv(lockTaken = false, lockProbeFails = false) {
  const store = new Map<string, Uint8Array>();
  const kv = {
    async get(key: string) {
      // Only the lock read fails. A blip that took the whole bucket with it
      // would also make hasFailedAttempt fail closed, which hides the branch
      // under test behind a second, unrelated fallback.
      if (lockProbeFails && key.startsWith("lock.")) throw new Error("kv unavailable");
      const value = store.get(key);
      return value ? { key, value, operation: "PUT" } : null;
    },
    async create(key: string, value: Uint8Array) {
      if (lockTaken || store.has(key)) throw new Error("wrong last sequence: key exists");
      store.set(key, value);
      return 1;
    },
    async put(key: string, value: Uint8Array) { store.set(key, value); return 1; },
    async delete(key: string) { store.delete(key); },
  };
  return { kv: kv as unknown as KV, store };
}

/**
 * Wire the module-level bindings handleTask reads through, and run one
 * delivery. `heldLock` seeds a live lock the way another pod holding it would;
 * `ranAs` seeds the retry-pending lease an attempt that ran and failed leaves
 * behind, written through the same function production writes it with.
 */
async function dispatch(opts: {
  deliveryCount: number;
  heldLock?: boolean;
  inProcess?: boolean;
  lockTaken?: boolean;
  ranAs?: string;
  deleted?: boolean;
  heldForSeq?: number;
  taskId?: string;
  postAgentDone?: () => Promise<void>;
  lockProbeFails?: boolean;
  /** What the dispatching API said about this run's files. */
  workspace?: { id?: string; required?: boolean };
  /** Carry one delivery's KV state into the next, for retry scenarios. */
  reuse?: ReturnType<typeof fakeKv>;
}) {
  const { kv, store } = opts.reuse ?? fakeKv(opts.lockTaken, opts.lockProbeFails);
  const lockKey = SESSION;
  if (opts.heldLock) {
    store.set(`lock.${lockKey}`, sc.encode(JSON.stringify({ holderId: "other-pod" })));
  }
  if (opts.heldForSeq !== undefined) {
    store.set(
      `lock.${lockKey}`,
      sc.encode(JSON.stringify({ holderId: "other-pod", seq: opts.heldForSeq })),
    );
  }
  if (opts.deleted) store.set(`deleted.${SESSION}`, sc.encode("1"));
  if (opts.ranAs !== undefined) {
    await markRetryPending(kv, {
      sessionId: SESSION,
      messageId: opts.ranAs,
      lockKey,
      createdAtMs: Date.now(),
      deadlineMs: Date.now() + 60_000,
      graceSec: 60,
    });
  }
  bindTaskDispatchKv(kv);
  bindTaskLockKv(kv);

  const events: Array<Record<string, unknown>> = [];
  bindTaskRunnerDeps({
    kv,
    kvCkpt: kv,
    emitter: {
      async emit(_s: string, evt: Record<string, unknown>) { events.push(evt); },
    } as unknown as NatsEmitter,
    engine: {} as Engine,
    sideEffects: { postAgentDone: (opts.postAgentDone ?? (async () => {})) as never },
  });

  const request = {
    session_id: SESSION, message_id: MESSAGE, prompt: "hi", user_id: "u1",
    ...(opts.taskId ? { task_id: opts.taskId } : {}),
    ...(opts.workspace?.id ? { files_workspace_id: opts.workspace.id } : {}),
    ...(opts.workspace?.required ? { files_workspace_required: true } : {}),
  };
  const { msg, verdicts } = fakeMsg(opts.deliveryCount, request);

  if (opts.inProcess) activeAbort.set(lockKey, new AbortController());
  try {
    await handleTask(msg);
  } finally {
    activeAbort.delete(lockKey);
  }

  return {
    verdicts,
    events,
    completion: events.find((e) => e.type === "exec_complete"),
  };
}

test("at the threshold a task that ran and failed on its own is reported as poisoned", async () => {
  const r = await dispatch({ deliveryCount: TASK_POISON_DELIVERY_COUNT, ranAs: MESSAGE });

  assert.equal(r.completion?.failure_reason, "max_retries_exceeded");
  assert.equal(r.completion?.failed, true);
  assert.match(String(r.completion?.final_text), /retry attempts/);
  assert.deepEqual(r.verdicts, ["ack"], "a resolved task is finished, not redelivered");
});

// The case the lock probe cannot see on its own: every redelivery was a
// contention nak, and the sibling let go during the last backoff window. The
// only observable at this level is what happens next -- the task goes for the
// lock instead of being resolved -- so the lock is taken out from under it
// between the probe and the create, which is a real interleaving and needs no
// engine to stand up.
test("a task that never ran gets one more attempt once its lock frees", async () => {
  const r = await dispatch({ deliveryCount: TASK_POISON_DELIVERY_COUNT, lockTaken: true });

  assert.equal(r.completion, undefined, "the guard must not resolve a task it is letting run");
  assert.match(r.verdicts[0] ?? "", /^nak:/, "it went for the lock rather than being discarded");
});

// The lease is keyed by session and lockKey, which a contending sibling shares
// by definition. Without the messageId comparison the sibling's failure would
// read as this task's own and cost it the attempt.
test("a sibling's failed attempt is not mistaken for this task's own", async () => {
  const r = await dispatch({
    deliveryCount: TASK_POISON_DELIVERY_COUNT,
    lockTaken: true,
    ranAs: "some-other-message",
  });

  assert.equal(r.completion, undefined);
  assert.match(r.verdicts[0] ?? "", /^nak:/);
});

// The attempt is affordable at the threshold and nowhere else. One delivery
// later there is nothing left to nak into, so letting the task run there would
// reintroduce exactly the silent drop this guard exists to prevent. The reason
// still has to come from the lease: a task whose last attempt could not get
// the lock either arrives here having never run, and asking the probe would
// blame it for retries it never spent.
test("past the threshold the task is resolved rather than given another attempt", async () => {
  const r = await dispatch({ deliveryCount: TASK_MAX_DELIVER, lockTaken: true });

  assert.deepEqual(r.verdicts, ["ack"]);
  assert.equal(r.completion?.failure_reason, "lock_contention_exhausted");
  assert.match(String(r.completion?.final_text), /waiting for an earlier task/);
});

// Every acquire on this path records msg.seq, so a held lock without one came
// from a pod that predates the field -- and for that lock the reading below
// and the one two tests down are indistinguishable. One of them is a pod
// running this very message, so with budget still left the guard waits rather
// than reporting a running task as failed. Costs the last-chance attempt,
// which is the cheaper of the two things at stake.
test("at the threshold a lock with no recorded sequence is waited on, not resolved", async () => {
  const r = await dispatch({ deliveryCount: TASK_POISON_DELIVERY_COUNT, heldLock: true });

  assert.equal(r.completion, undefined, "an unidentifiable holder may be this task's own run");
  assert.deepEqual(r.verdicts.length, 1);
  assert.match(r.verdicts[0]!, /^nak:/);
});

// Waiting only postpones the choice, and the postponement runs out. On the
// last delivery the guard has to commit, and contention is the reading that
// leaves the user with an explanation either way.
test("a lock with no recorded sequence is resolved once the budget runs out", async () => {
  const r = await dispatch({ deliveryCount: TASK_MAX_DELIVER, heldLock: true });

  assert.equal(r.completion?.failure_reason, "lock_contention_exhausted");
  assert.match(String(r.completion?.final_text), /waiting for an earlier task/);
  assert.deepEqual(r.verdicts, ["ack"]);
});

// The same unknown reached from the other direction, and the one nothing below
// this branch can see: a failed probe answers "not held", so the sequence
// comparison misses, `contended` stays false because activeAbort only covers
// this process, and every remaining test agrees the task is free to resolve --
// while another pod runs it. The read failing is not evidence about the lock.
test("a lock the probe could not read is waited on, not resolved", async () => {
  const r = await dispatch({
    deliveryCount: TASK_POISON_DELIVERY_COUNT,
    lockProbeFails: true,
  });

  assert.equal(r.completion, undefined, "a task that may be running must not be reported failed");
  assert.equal(r.verdicts.length, 1);
  assert.match(r.verdicts[0]!, /^nak:/);
});

// And the deliberate side of the trade. The guard cannot wait past the last
// delivery, and the alternative to committing is a message that disappears
// with its session still marked running -- the silent drop it exists to
// prevent. It resolves, having been unable to rule out a live run.
test("a lock the probe could not read is resolved once the budget runs out", async () => {
  const r = await dispatch({
    deliveryCount: TASK_MAX_DELIVER,
    lockProbeFails: true,
  });

  assert.equal(r.completion?.failure_reason, "lock_contention_exhausted");
  assert.deepEqual(r.verdicts, ["ack"]);
});

// A sibling running in this very process holds no KV lock of its own that the
// probe would find, so without the in-process registry this would be
// misreported as a task that kept failing.
test("a sibling running in this process also counts as contention", async () => {
  const r = await dispatch({ deliveryCount: TASK_POISON_DELIVERY_COUNT, inProcess: true });

  assert.equal(r.completion?.failure_reason, "lock_contention_exhausted");
});

// A deleted session has nobody left to report to, so the guard must not reach
// it first. Every delivery before the threshold passes the tombstone check on
// its way past, which leaves exactly one window where the ordering shows: a
// delete landing during the final backoff, minutes wide for a contended task.
// The live lock is what makes the guard want to resolve here -- without it the
// task would be let through for a last attempt and the ordering would not
// matter.
test("a deleted session is dropped rather than resolved at the threshold", async () => {
  const r = await dispatch({
    deliveryCount: TASK_POISON_DELIVERY_COUNT,
    deleted: true,
    heldLock: true,
  });

  assert.equal(r.completion, undefined, "a discarded session must not be sent a failure event");
  assert.deepEqual(r.verdicts, ["ack"]);
});

// A held lock reads two ways, and the guard resolves on one of them. When the
// run holding it is this very message's own, whoever is executing owns the ack
// and resolving here would emit a failure, fail the backend task row --
// cascading to every downstream DAG node -- and clear the callback out from
// under a run that finishes normally minutes later. Past the threshold on
// purpose: that is where the guard is most certain it should resolve, and
// where the last-chance branch leaves tasks, since one let through runs at the
// threshold with no margin and needs a single ack_wait lapse to come back.
test("a redelivery whose own run holds the lock is deferred, not resolved", async () => {
  const r = await dispatch({ deliveryCount: TASK_POISON_DELIVERY_COUNT, heldForSeq: SEQ });

  assert.equal(r.completion, undefined, "a task that is still running must not be reported failed");
  assert.match(r.verdicts[0] ?? "", /^nak:/, "the running handler keeps the ack");
  assert.equal(r.verdicts.length, 1);
});

// The deferral above is a nak, and a nak on the last delivery is not a wait.
// NATS declines the redelivery and terminates the message on the way out,
// which settles it out from under the handler that is still executing it and
// still expects its own ack to be the one that counts. Not acking either --
// that would report a task nobody has finished as done. The only verdict that
// leaves the ack where it belongs is no verdict.
test("on the last delivery a running task's message is left for its own handler to ack", async () => {
  const r = await dispatch({ deliveryCount: TASK_MAX_DELIVER, heldForSeq: SEQ });

  assert.equal(r.completion, undefined);
  assert.deepEqual(r.verdicts, [], "settling it any way at all takes the ack from the runner");
});

// The other reading, and the one the guard exists for. Inverting the
// comparison would turn every contended task into a deferral that never
// resolves, which is the silent drop again by a different route.
test("a lock held for a different message is still contention", async () => {
  const r = await dispatch({
    deliveryCount: TASK_POISON_DELIVERY_COUNT,
    heldForSeq: SEQ + 1,
  });

  assert.equal(r.completion?.failure_reason, "lock_contention_exhausted");
  assert.deepEqual(r.verdicts, ["ack"]);
});

// The boundary itself. One delivery earlier the guard must stay out of the
// way, or every contended task gets failed a retry before its budget is
// actually spent.
test("one delivery below the threshold the guard does not fire", async () => {
  const r = await dispatch({ deliveryCount: TASK_POISON_DELIVERY_COUNT - 1, heldLock: true });

  assert.equal(r.completion, undefined, "nothing is resolved while the budget still has room");
  assert.equal(r.verdicts.length, 1);
  assert.match(r.verdicts[0]!, /^nak:/, "a contended task waits for the lock instead");
});

// The resolve path naks when its handoff fails, and that redelivery re-enters
// the guard rather than runHandleTask -- so the outbox replay that makes every
// other terminal path idempotent is never reached, and each retry would tell
// the session its task had finished again.
test("a retried handoff does not emit a second terminal event", async () => {
  const shared = fakeKv();
  const taskId = "task-77";
  let posts = 0;
  const flaky = async () => {
    posts += 1;
    if (posts === 1) throw new Error("agent_done delivery exhausted");
  };

  const first = await dispatch({
    deliveryCount: TASK_POISON_DELIVERY_COUNT,
    ranAs: MESSAGE, taskId, reuse: shared, postAgentDone: flaky,
  });
  assert.equal(first.completion?.failure_reason, "max_retries_exceeded");
  assert.match(first.verdicts[0] ?? "", /^nak:/, "a failed handoff retries rather than acking");
  assert.ok(
    shared.store.has(`task-result.${taskId}`),
    "the outbox entry has to outlive the post that failed, or there is nothing to recognise",
  );

  const second = await dispatch({
    deliveryCount: TASK_MAX_DELIVER,
    taskId, reuse: shared, postAgentDone: flaky,
  });

  assert.equal(second.completion, undefined, "the session already has its terminal event");
  assert.deepEqual(second.verdicts, ["ack"]);
  assert.equal(posts, 2, "the callback still retries -- it is the event that is suppressed");
  assert.equal(shared.store.has(`task-result.${taskId}`), false, "a delivered result clears its outbox");
});

// The guard is only worth anything if it runs before NATS stops redelivering:
// its last chance to fire is the delivery before the budget is exhausted.
test("the guard fires with at least one delivery still left", () => {
  assert.ok(
    TASK_POISON_DELIVERY_COUNT < TASK_MAX_DELIVER,
    `guard at ${TASK_POISON_DELIVERY_COUNT} never runs before max_deliver=${TASK_MAX_DELIVER}`,
  );
});

// The gate can only serialise runs that declare which files they write. These
// three cases look identical on the wire apart from one flag, and the right
// response differs for each -- getting it wrong means either silent file loss
// or an outage during the rollout that introduces the flag.

test("a run the API promised to bind, and did not, is refused rather than run", async () => {
  // Executing it would take a lock keyed on the session while a sibling under
  // a different DAG root takes one keyed on its root, and the second of the
  // two to finish deletes the first one's files on sync. The user sees nothing
  // in that story; here they get a terminal event saying why.
  const r = await dispatch({
    deliveryCount: 1,
    workspace: { required: true },
  });

  assert.equal(r.completion?.failed, true);
  assert.equal(r.completion?.failure_reason, "workspace_unbound");
  assert.match(String(r.completion?.final_text), /workspace/i);
  assert.deepEqual(r.verdicts, ["ack"], "no redelivery will make the binding appear");
});

test("an unbound claimed doorbell fails the row, not just the session event", async () => {
  // Chat rows have no callback_url, so resolvePoisonedTask's agent_done is a
  // no-op. Without fail-claim the row stays preparing, the lease lapses, and
  // claim-next takes it until the retry budget is gone.
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.INTERNAL_BACKEND_URL;
  process.env.INTERNAL_BACKEND_URL = "http://api.example";
  const failBodies: Array<{ reason?: string }> = [];
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    if (path.endsWith("/claim")) {
      return new Response(JSON.stringify({
        ok: true,
        request: {
          session_id: SESSION,
          message_id: MESSAGE,
          prompt: "hi",
          user_id: "u1",
          task_id: "ktsk_1",
          files_workspace_required: true,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.endsWith("/fail-claim")) {
      failBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(path);
  }) as typeof fetch;

  const { kv } = fakeKv();
  bindTaskDispatchKv(kv);
  bindTaskLockKv(kv);
  const events: Array<Record<string, unknown>> = [];
  bindTaskRunnerDeps({
    kv,
    kvCkpt: kv,
    emitter: {
      async emit(_s: string, evt: Record<string, unknown>) { events.push(evt); },
    } as unknown as NatsEmitter,
    engine: {} as Engine,
    sideEffects: { postAgentDone: (async () => {}) as never },
  });

  const { msg, verdicts } = fakeMsg(1, {
    kind: RUN_DOORBELL_KIND,
    task_id: "ktsk_1",
    session_id: SESSION,
    claim_url: "http://evil.example/v1/internal/tasks/ktsk_1/claim",
  } as unknown as ExecuteRequest);

  try {
    await handleTask(msg);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.INTERNAL_BACKEND_URL;
    else process.env.INTERNAL_BACKEND_URL = originalUrl;
  }

  assert.equal(failBodies[0]?.reason, "workspace_unbound");
  assert.equal(events.find((e) => e.type === "exec_complete")?.failure_reason, "workspace_unbound");
  assert.deepEqual(verdicts, ["ack"]);
});

test("a message from an API too old to bind workspaces still runs", async () => {
  // The rollout case. Brain can be upgraded before the API, and every message
  // already on the queue was published by the old one. Refusing these would
  // turn a routine deploy into a total outage, and they are no worse off than
  // they were yesterday.
  //
  // These two get as far as the engine, which this harness does not provide,
  // so what is asserted is that the refusal was not the reason they stopped.
  const r = await dispatch({ deliveryCount: 1 });

  assert.notEqual(r.completion?.failure_reason, "workspace_unbound");
});

test("a properly bound run is not touched by the check", async () => {
  const r = await dispatch({
    deliveryCount: 1,
    workspace: { id: "kws_abc", required: true },
  });

  assert.notEqual(r.completion?.failure_reason, "workspace_unbound");
});

test("a run gated on its workspace is still addressable by its session", async () => {
  // Every interrupt in the system -- the stop button, cancelTask, the admin
  // route, the sweeper's backstop -- is published to a session or a DAG root.
  // Gating on the workspace changed what a run is registered under, and a
  // broadcast that finds nothing looks exactly like the pod that isn't running
  // the task, so all of them went quiet without a single error.
  let duringRun: string[] | undefined;
  await dispatch({
    deliveryCount: 1,
    workspace: { id: "kws_abc", required: true },
    postAgentDone: async () => { duringRun = resolveAbortTargets(SESSION); },
  });

  assert.deepEqual(duringRun, ["ws.kws_abc"],
    "the session has to reach the run while it is still running");
  assert.deepEqual(resolveAbortTargets(SESSION), [],
    "and stop reaching it afterwards, or the next turn gets the last one's interrupt");
});
