// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reaching a run that is registered under something nobody publishes to.
 *
 * The gate key answers "which runs may overlap"; an interrupt subject carries
 * "which run do I mean". Those were the same string until the gate moved to
 * workspaces, and nothing failed when they stopped being -- a lookup that
 * misses is the normal case for a broadcast, so every interrupt in the system
 * went quiet at once: the stop button, cancelTask, the admin route and the
 * sweeper's backstop. No test caught it because each side was tested against
 * itself: the API asserts the subject it published, Brain asserts the key it
 * locked on, and the two were never compared.
 *
 * So these tests are written against the addresses publishers actually use,
 * not against the key of the day.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  abortSession,
  activeAbort,
  forgetRunAddresses,
  registerRunAddresses,
  resolveAbortTargets,
} from "../src/tasks/abort-registry.js";

const WS_KEY = "ws.kws_1";

let started: string[] = [];
beforeEach(() => {
  for (const lockKey of started) forgetRunAddresses(lockKey);
  started = [];
  activeAbort.clear();
});

/** Start a run the way task-dispatch does: controller under the gate key. */
function startRun(lockKey: string, addresses: Array<string | undefined>): AbortController {
  const ctrl = new AbortController();
  activeAbort.set(lockKey, ctrl);
  registerRunAddresses(lockKey, addresses);
  started.push(lockKey);
  return ctrl;
}

test("a run gated on its workspace is still reachable by its session", () => {
  const ctrl = startRun(WS_KEY, ["s-1", undefined]);

  assert.deepEqual(resolveAbortTargets("s-1"), [WS_KEY],
    "this is the subject the stop button publishes; missing it stops nothing");
  assert.equal(ctrl.signal.aborted, false);
  assert.equal(abortSession("s-1"), true);
  assert.equal(ctrl.signal.aborted, true);
});

test("a DAG node is reachable by its root and by its session", () => {
  // cancelTask addresses the root; sandbox-keepalive addresses the session,
  // which it could never reach before because the lookup was direct.
  startRun(WS_KEY, ["s-1", "kdag_1"]);

  assert.deepEqual(resolveAbortTargets("kdag_1"), [WS_KEY]);
  assert.deepEqual(resolveAbortTargets("s-1"), [WS_KEY]);
});

test("an address that is the gate key still resolves to itself", () => {
  // RUN_GATE_KEY=session is still a supported deployment, and it registers no
  // address at all: the key and the subject are already the same string.
  startRun("s-1", ["s-1"]);

  assert.deepEqual(resolveAbortTargets("s-1"), ["s-1"]);
});

test("an address does not make the gate look busy", () => {
  // task-dispatch refuses a second handler for a key already in flight, and
  // index.ts reports this map's size as the number of running tasks. An alias
  // stored in it would NAK a run that should have gone, and inflate the gauge.
  startRun(WS_KEY, ["s-1", "kdag_1"]);

  assert.equal(activeAbort.size, 1);
  assert.equal(activeAbort.has("s-1"), false);
  assert.equal(activeAbort.has("kdag_1"), false);
});

test("a finished run answers to nothing", () => {
  startRun(WS_KEY, ["s-1"]);
  activeAbort.delete(WS_KEY);
  forgetRunAddresses(WS_KEY);

  assert.deepEqual(resolveAbortTargets("s-1"), [],
    "a session's next turn must not be aborted by the interrupt of the last one");
  assert.equal(abortSession("s-1"), false);
});

test("an address outliving its run resolves to nothing", () => {
  // The controller is cleared on several paths inside a run; the addresses are
  // cleared on one. Resolution goes through the live map so the two cannot
  // disagree in the dangerous direction.
  startRun(WS_KEY, ["s-1"]);
  activeAbort.delete(WS_KEY);

  assert.deepEqual(resolveAbortTargets("s-1"), []);
});

test("one address can name every run under it", () => {
  // Not reachable today -- every run of a session binds that session's
  // workspace and queues on it -- but "stop this session" means all of them,
  // and a map that silently kept one would be the same class of bug again.
  const first = startRun("ws.kws_1", ["s-1"]);
  const second = startRun("ws.kws_2", ["s-1"]);

  assert.deepEqual(resolveAbortTargets("s-1").sort(), ["ws.kws_1", "ws.kws_2"]);
  abortSession("s-1");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
});
