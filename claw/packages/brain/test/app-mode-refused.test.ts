// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A task of mode `app` is refused by this Brain rather than run as a chat turn.
 *
 * The AppRunner is a later change. Until it lands, the one thing that must not
 * happen is an `app` task reaching the LLM engine, which is what the `else`
 * after the `script` branch would do with it: the app's input would be answered
 * as a prompt and the run would report success.
 *
 *   A1 an app task is failed with a "not implemented" reason, the engine is
 *      never called, and the delivery is acked
 *   A2 llm, script and an omitted mode are not refused (the existing paths)
 *   A3 a mode this Brain has never heard of is refused the same way
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";

const { bindTaskRunnerDeps, runHandleTask, refuseUnsupportedMode } = await import("../src/tasks/runner.js");
const { activeAbort } = await import("../src/tasks/abort-registry.js");

function harness() {
  const done: ExecuteResult[] = [];
  let acked = 0;
  let released = 0;
  let engineCalls = 0;
  let sandboxCalls = 0;
  let reaps = 0;
  const kv = { async get() { return null; }, async put() { return 1; }, async delete() {} } as unknown as KV;
  const engine: Engine = {
    async execute(): Promise<ExecuteResult> { engineCalls++; throw new Error("engine must not run"); },
  };
  const sideEffects = {
    postAgentDone: (async (_r: unknown, result: ExecuteResult) => { done.push(result); }) as never,
    ensureHands: (async () => { sandboxCalls++; throw new Error("no sandbox for a refused task"); }) as never,
    reapPendingHands: (async () => { reaps++; }) as never,
    releaseTaskLock: (async () => { released++; }) as never,
    runScript: (async () => { engineCalls++; throw new Error("script must not run"); }) as never,
  } as unknown as Partial<TaskRunnerSideEffects>;
  bindTaskRunnerDeps({ kv, kvCkpt: kv, emitter: { async emit() {} } as unknown as NatsEmitter, engine, sideEffects });
  const msg = { info: { deliveryCount: 1 }, ack() { acked++; }, nak() {}, working() {}, term() {} } as unknown as JsMsg;
  return { msg, done, acked: () => acked, released: () => released, engineCalls: () => engineCalls, sandboxCalls: () => sandboxCalls, reaps: () => reaps };
}

const request = (mode: unknown): ExecuteRequest =>
  ({ session_id: "s-app", task_id: "t-app", prompt: "hi", user_id: "u1", platform_key: "pk", mode }) as ExecuteRequest;

test("A1 an app task is failed as not implemented and never reaches the engine", async () => {
  const h = harness();
  const abortCtrl = new AbortController();
  activeAbort.set("lock.s-app", abortCtrl);
  await runHandleTask(h.msg, request("app"), "s-app", "lock.s-app", "m1", "u1", abortCtrl);
  assert.equal(h.engineCalls(), 0);
  assert.equal(h.sandboxCalls(), 0, "a refused task must not provision a sandbox");
  assert.equal(h.reaps(), 0, "a refused task never becomes a TaskRunner run");
  assert.equal(h.done.length, 1);
  assert.equal(h.done[0]!.abortReason, "error");
  assert.match(h.done[0]!.failureReason ?? "", /"app" is not implemented/);
  assert.equal(h.acked(), 1);
  assert.equal(h.released(), 1);
  assert.equal(activeAbort.has("lock.s-app"), false);
});

test("A2 llm, script and an omitted mode are not refused", async () => {
  const h = harness();
  for (const mode of ["llm", "script", undefined]) {
    assert.equal(await refuseUnsupportedMode(h.msg, request(mode), "s-app", "lock.s-app"), false, String(mode));
  }
  assert.equal(h.done.length, 0);
  assert.equal(h.acked(), 0);
});

test("A3 an unknown mode is refused the same way", async () => {
  const h = harness();
  assert.equal(await refuseUnsupportedMode(h.msg, request("dag"), "s-app", "lock.s-app"), true);
  assert.equal(h.done.length, 1);
});
