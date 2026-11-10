// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stream request whose caller gives it up (the assistant's receipt was dropped as the worker stops): it ends at once with
 * the caller's reason, whether Teams has not answered yet or the token it needs is still being fetched; it is not retried,
 * not queued, and the conversation's line is free again. The fake clock is never moved: nothing waits for a timeout.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { build, envelope, FakeTeams, json } from "./fakes.js";

/** Whether `work` has settled after the microtasks run out, with the clock left where it is. */
async function settledAtOnce(work: Promise<unknown>): Promise<boolean> {
  const state = { done: false };
  work.then(
    () => (state.done = true),
    () => (state.done = true),
  );
  for (let i = 0; i < 50 && !state.done; i++) await flushMicrotasks();
  return state.done;
}

test("a stream request given up while Teams has not answered ends at once with the caller's reason", async () => {
  const t = new FakeTeams(new FakeClock());
  t.delayMs = () => 60_000;
  t.answers = [json(201, { id: "teams-1" })];
  const b = build({ teams: t });
  const controller = new AbortController();
  const sent = b.outbox.publishStream(envelope("update"), { signal: controller.signal });
  for (let i = 0; i < 50 && t.calls.length === 0; i++) await flushMicrotasks();
  assert.equal(t.calls.length, 1);
  controller.abort(new Error("the receipt was dropped"));
  assert.ok(await settledAtOnce(sent), "still waiting for Teams after it was given up");
  await assert.rejects(sent, /the receipt was dropped/);
  assert.deepEqual([t.calls.length, b.queue.sent.length, b.outbox.lanesInUse], [1, 0, 0]);
});

test("a stream request given up while its token is still being fetched ends at once and reaches no one", async () => {
  const t = new FakeTeams(new FakeClock());
  t.imdsDelayMs = 60_000;
  const b = build({ teams: t });
  const controller = new AbortController();
  const sent = b.outbox.publishStream(envelope("update"), { signal: controller.signal });
  for (let i = 0; i < 50 && t.imds.length === 0; i++) await flushMicrotasks();
  assert.equal(t.imds.length, 1);
  controller.abort(new Error("the receipt was dropped"));
  assert.ok(await settledAtOnce(sent), "still waiting for the token after it was given up");
  await assert.rejects(sent, /the receipt was dropped/);
  assert.deepEqual([t.calls.length, b.queue.sent.length, b.outbox.lanesInUse], [0, 0, 0]);
});

test("a stream request given up before its turn in the conversation's line sends nothing", async () => {
  const t = new FakeTeams(new FakeClock());
  t.delayMs = () => 60_000;
  const b = build({ teams: t });
  const first = b.outbox.publishStream(envelope("first"));
  const controller = new AbortController();
  const behind = b.outbox.publishStream(envelope("behind"), { signal: controller.signal });
  for (let i = 0; i < 50 && t.calls.length === 0; i++) await flushMicrotasks();
  controller.abort(new Error("the receipt was dropped"));
  assert.ok(await settledAtOnce(behind));
  await assert.rejects(behind, /the receipt was dropped/);
  assert.equal(t.calls.length, 1);
  first.catch(() => undefined);
});
