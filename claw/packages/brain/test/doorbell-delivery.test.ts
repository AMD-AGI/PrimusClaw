// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * After a doorbell is claimed the JetStream message is already acked.
 * retry is unclaim after the same delay the fat path would have nacked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { claimedDoorbellMsg } from "../src/delivery/doorbell-delivery.js";

test("nak after a claimed doorbell unclaims after the delay, and does not ack again", async () => {
  const retries: string[] = [];
  const failed: string[] = [];
  const slept: number[] = [];
  const generations: Array<number | undefined> = [];
  const msg = claimedDoorbellMsg(
    { seq: 9, info: { deliveryCount: 1 } },
    "ktsk_1",
    4,
    {
      retryLater: async (taskId, claimCount) => { retries.push(taskId); generations.push(claimCount); },
      fail: async (taskId, claimCount) => { failed.push(taskId); generations.push(claimCount); },
      sleep: async (ms) => { slept.push(ms); },
    },
  );

  msg.nak(5_000);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(slept, [5_000]);
  assert.deepEqual(retries, ["ktsk_1"]);
  assert.deepEqual(failed, []);

  msg.ack();
  msg.term();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(failed, ["ktsk_1"]);
  // Both settlements carry the generation, so the API can refuse one that
  // arrives after the row has been claimed again.
  assert.deepEqual(generations, [4, 4]);
});

test("nak(0) unclaims immediately, matching a fat-path SIGTERM nak", async () => {
  const retries: string[] = [];
  const msg = claimedDoorbellMsg(
    { seq: 1, info: { deliveryCount: 1 } },
    "ktsk_sig",
    1,
    {
      retryLater: async (taskId) => { retries.push(taskId); },
      fail: async () => {},
      sleep: async () => { throw new Error("nak(0) must not wait"); },
    },
  );
  msg.nak(0);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(retries, ["ktsk_sig"]);
});

test("a shutdown releases rows still waiting out their backoff", async () => {
  // The wait is an unref'd timer, so without this the process exits holding
  // claims nobody else knows about and each row waits out its lease.
  const { flushPendingRetries } = await import("../src/delivery/doorbell-delivery.js");
  const released: Array<[string, number | undefined]> = [];
  let resolveSleep: (() => void) | null = null;
  const msg = claimedDoorbellMsg(
    { seq: 3, info: { deliveryCount: 2 } },
    "ktsk_drain",
    7,
    {
      retryLater: async (taskId, claimCount) => { released.push([taskId, claimCount]); },
      fail: async () => {},
      sleep: () => new Promise<void>((r) => { resolveSleep = r; }),
    },
  );
  msg.nak(300_000);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(released, [], "nothing released while the backoff is still running");

  const flushed = await flushPendingRetries(async (taskId, claimCount) => {
    released.push([taskId, claimCount]);
  });
  assert.equal(flushed, 1);
  assert.deepEqual(released, [["ktsk_drain", 7]]);
  resolveSleep?.();
});
