// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A finish-only dispatch for an app run whose session was deleted.
//
// The sweeper hands an app run stuck in `finishing` back to a Brain as a
// dispatch with `app_finish_only`. That dispatch reports nothing to the session
// -- it ends the run row and revokes the run's grant -- and the common reason a
// run is stuck is that its session was deleted. The tombstone check at the top
// of `handleResolvedRequest` used to drop every request for a deleted session,
// this one included, so the finish was requeued and dropped again until the
// sweeper's requeue cap (`APP_FINISH_REQUEUE_MAX`) and the run stayed in
// `finishing` for good.
//
// The table pins both halves of the rule: a finish-only dispatch settles however
// the session stands, and every other request for a deleted session is still
// dropped without a runner, an event or a lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type JsMsg, type KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { AppRunner } from "../src/apps/app-runner.js";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";
import { handleTask, bindTaskDispatchKv, isAppFinishOnly } from "../src/tasks/dispatch.js";
import { bindTaskLockKv } from "../src/tasks/lock.js";
import { bindTaskRunnerDeps } from "../src/tasks/runner.js";
import { activeAbort } from "../src/tasks/abort-registry.js";

const sc = StringCodec();
const SESSION = "sess-finish-only";
const TASK = "t-app";

function fakeKv() {
  const store = new Map<string, Uint8Array>();
  const kv = {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value, operation: "PUT" } : null;
    },
    async create(key: string, value: Uint8Array) {
      if (store.has(key)) throw new Error("wrong last sequence: key exists");
      store.set(key, value);
      return 1;
    },
    async put(key: string, value: Uint8Array) { store.set(key, value); return 1; },
    async delete(key: string) { store.delete(key); },
  };
  return { kv: kv as unknown as KV, store };
}

/** Deliver one fat message for `request` against a session that is, or is not, deleted. */
async function deliver(request: Partial<ExecuteRequest>, deleted: boolean) {
  const { kv, store } = fakeKv();
  if (deleted) store.set(`deleted.${SESSION}`, sc.encode("1"));
  bindTaskDispatchKv(kv);
  bindTaskLockKv(kv);

  const verdicts: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const calls = { runners: 0, runs: 0, finishDone: 0, agentDone: 0, running: 0 };
  const sideEffects = {
    postAgentDone: (async () => { calls.agentDone++; }) as never,
    postTaskRunning: (async () => { calls.running++; }) as never,
    postAppFinishDone: (async () => { calls.finishDone++; return true; }) as never,
    postAppFinishHandOver: (async () => true) as never,
    settleRunAttempt: (async () => undefined) as never,
    reapPendingHands: (async () => undefined) as never,
    releaseTaskLock: (async () => undefined) as never,
    flushTranscript: (async () => undefined) as never,
    createAppRunner: (() => {
      calls.runners++;
      return {
        markEnded: async () => true,
        run: async () => { calls.runs++; return { kind: "ended", outcome: { success: false, reason: "app run ended: cancelled" } }; },
        finishNow: async () => ({ success: false, reason: "cancelled" }),
      } as unknown as AppRunner;
    }) as never,
  } as unknown as Partial<TaskRunnerSideEffects>;
  bindTaskRunnerDeps({
    kv,
    kvCkpt: kv,
    emitter: { async emit(_s: string, evt: Record<string, unknown>) { events.push(evt); } } as unknown as NatsEmitter,
    engine: { async execute() { throw new Error("engine must not run"); } } as Engine,
    sideEffects,
  });

  const full = {
    session_id: SESSION, message_id: TASK, task_id: TASK, prompt: "hi", user_id: "u1", platform_key: "pk",
    ...request,
  };
  const msg = {
    data: sc.encode(JSON.stringify(full)),
    redelivered: false,
    seq: 7,
    info: { deliveryCount: 1 },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  } as unknown as JsMsg;

  try {
    await handleTask(msg);
  } finally {
    activeAbort.delete(`app.${TASK}`);
  }
  return { verdicts, events, calls, store };
}

const cases: Array<{
  name: string;
  request: Partial<ExecuteRequest>;
  deleted: boolean;
  /** Whether the dispatch reaches the app runner and settles the finish. */
  settles: boolean;
}> = [
  { name: "deleted session + app finish-only: settles", request: { mode: "app", app_finish_only: true }, deleted: true, settles: true },
  { name: "live session + app finish-only: settles (control)", request: { mode: "app", app_finish_only: true }, deleted: false, settles: true },
  { name: "deleted session + app run that is not finish-only: dropped", request: { mode: "app" }, deleted: true, settles: false },
  { name: "deleted session + app_finish_only=false: dropped", request: { mode: "app", app_finish_only: false }, deleted: true, settles: false },
  { name: "deleted session + normal chat turn: dropped", request: {}, deleted: true, settles: false },
  { name: "deleted session + llm turn: dropped", request: { mode: "llm" }, deleted: true, settles: false },
  // The Brain reads the flag in `app` mode only, so on any other mode it is an
  // ordinary turn and the session being gone still ends it here.
  { name: "deleted session + finish-only flag on a non-app mode: dropped", request: { mode: "llm", app_finish_only: true }, deleted: true, settles: false },
  { name: "deleted session + finish-only flag with no mode: dropped", request: { app_finish_only: true }, deleted: true, settles: false },
];

for (const c of cases) {
  test(`dispatch: ${c.name}`, async () => {
    const r = await deliver(c.request, c.deleted);
    if (c.settles) {
      assert.equal(r.calls.runners, 1, "the finish reached the app runner");
      assert.equal(r.calls.runs, 1);
      assert.equal(r.calls.finishDone, 1, "the task is handed back to its terminal state once");
      assert.deepEqual(r.verdicts, ["ack"]);
    } else {
      assert.equal(r.calls.runners, 0, "a dropped request never reaches a runner");
      assert.equal(r.calls.finishDone, 0);
      assert.deepEqual(r.verdicts, ["ack"], "dropped means acked, not redelivered");
      assert.equal([...r.store.keys()].some((k) => k.startsWith("lock.")), false, "no lock is taken for a dropped request");
    }
    // Neither path speaks to the session: a finish reports nothing of its own, and a drop sends nothing.
    assert.equal(r.calls.agentDone, 0, "no agent_done to a deleted or already-closed task");
    assert.equal(r.calls.running, 0, "nothing says the run is running");
    assert.equal(r.events.filter((e) => e.type === "statusUpdate").length, 0);
  });
}

test("isAppFinishOnly is the app + flag pair, nothing looser", () => {
  assert.equal(isAppFinishOnly({ mode: "app", app_finish_only: true }), true);
  assert.equal(isAppFinishOnly({ mode: "app", app_finish_only: false }), false);
  assert.equal(isAppFinishOnly({ mode: "app" }), false);
  assert.equal(isAppFinishOnly({ mode: "llm", app_finish_only: true }), false);
  assert.equal(isAppFinishOnly({ mode: "script", app_finish_only: true }), false);
  assert.equal(isAppFinishOnly({ app_finish_only: true }), false);
});
