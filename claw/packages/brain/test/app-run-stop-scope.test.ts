// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A foreground Stop reaches the conversation's turns and not the application
 * running beside them; deleting the session still stops the application.
 *
 * Stop is `interrupt.<sessionId>`. A run is registered under the names it can be
 * reached by (tasks/abort-registry.ts), and an app run used to be registered
 * under its session like a chat turn, so the same message that stops a turn also
 * aborted the AppRunner, which then ends the run (`finishNow("cancelled")`).
 * An app run is now addressed by its own task id for interrupts (the API's
 * cancel publishes that), and answers to its session only when the session ends.
 *
 * The runner is the real AppRunner over the fake world; the registration is the
 * one dispatch makes (`registerRunAddressesFor`), and the delivery is the one the
 * interrupt subscriber and the session cleanup make (tasks/interrupt.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";
import { AppRunner } from "../src/apps/app-runner.js";
import { activeAbort, forgetRunAddresses, registerRunAddressesFor } from "../src/tasks/abort-registry.js";
import { abortRunsOfDeletedSession, interruptRunsAt } from "../src/tasks/interrupt.js";
import { bindTaskLockKv } from "../src/tasks/lock.js";
import { World, MANIFEST, RUN_ID } from "./support/app-runner-world.js";

const SESSION = "sess-1";
bindTaskLockKv({ get: async () => null } as never);

function rig() {
  const world = new World(MANIFEST);
  const runner = new AppRunner(RUN_ID, "pk", {
    store: world.store, sandbox: world.sandbox, now: world.now, sleep: world.sleep, tickMs: 5000,
  });
  return { world, runner };
}
async function toRunning(r: ReturnType<typeof rig>) {
  for (let i = 0; i < 12 && r.world.rec.state !== "running"; i++) await r.runner.reconcile();
  assert.equal(r.world.rec.state, "running");
}
const appRequest = { mode: "app", task_id: RUN_ID, session_id: SESSION } as unknown as ExecuteRequest;
const chatRequest = { task_id: "chat-1", session_id: SESSION, files_workspace_id: "kws_1" } as unknown as ExecuteRequest;

/** What dispatch does when it starts a run: the controller under its gate key, and its addresses. */
function startRun(lockKey: string, request: ExecuteRequest): AbortController {
  const ctrl = new AbortController();
  activeAbort.set(lockKey, ctrl);
  registerRunAddressesFor(lockKey, request);
  return ctrl;
}
function stopRun(lockKey: string) { activeAbort.delete(lockKey); forgetRunAddresses(lockKey); }

test("a foreground Stop aborts the chat turn and leaves the app run running", async () => {
  const r = rig();
  await toRunning(r);
  const appCtrl = startRun(`app.${RUN_ID}`, appRequest);
  const chatCtrl = startRun("ws.kws_1", chatRequest);
  try {
    const looping = r.runner.run(appCtrl.signal);
    const aborted = interruptRunsAt(SESSION);
    assert.deepEqual(aborted, ["ws.kws_1"], "Stop names the conversation's turn only");
    assert.equal(chatCtrl.signal.aborted, true);
    assert.equal(appCtrl.signal.aborted, false, "the application's controller is untouched");
    // And the runner, which only ends on its signal, keeps going.
    await r.runner.reconcile();
    assert.equal(r.world.rec.state, "running");
    appCtrl.abort();
    assert.deepEqual(await looping, { kind: "aborted" });
  } finally { stopRun(`app.${RUN_ID}`); stopRun("ws.kws_1"); }
});

test("an interrupt addressed to the app run's own id stops it (the API's cancel)", async () => {
  const appCtrl = startRun(`app.${RUN_ID}`, appRequest);
  try {
    assert.deepEqual(interruptRunsAt(RUN_ID), [`app.${RUN_ID}`]);
    assert.equal(appCtrl.signal.aborted, true);
  } finally { stopRun(`app.${RUN_ID}`); }
});

test("deleting the session still stops the app run, and the chat turn", async () => {
  const appCtrl = startRun(`app.${RUN_ID}`, appRequest);
  const chatCtrl = startRun("ws.kws_1", chatRequest);
  try {
    await abortRunsOfDeletedSession(SESSION).catch(() => { /* the lock bucket is not bound here */ });
    assert.equal(appCtrl.signal.aborted, true, "the application ends with its session");
    assert.equal(chatCtrl.signal.aborted, true);
  } finally { stopRun(`app.${RUN_ID}`); stopRun("ws.kws_1"); }
});
