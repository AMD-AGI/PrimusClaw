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
  const settled: string[] = [];
  const slept: number[] = [];
  const generations: Array<number | undefined> = [];
  const msg = claimedDoorbellMsg(
    { seq: 9, info: { deliveryCount: 1 } },
    "ktsk_1",
    4,
    {
      retryLater: async (taskId, claimCount) => { retries.push(taskId); generations.push(claimCount); },
      fail: async (taskId, claimCount) => { failed.push(taskId); generations.push(claimCount); },
      settle: async (taskId, claimCount) => { settled.push(taskId); generations.push(claimCount); },
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
  assert.deepEqual(settled, ["ktsk_1"], "the ack ends the attempt without moving the row");
  assert.deepEqual(failed, ["ktsk_1"]);
  // Every settlement carries the generation, so the API can refuse one that
  // arrives after the row has been claimed again.
  assert.deepEqual(generations, [4, 4, 4]);
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
      settle: async () => {},
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
      settle: async () => {},
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

test("the attempt's final coverage travels with the release the nak triggers", async () => {
  // `TaskRunner` naks the claimed wrapper and the delivery loop issues the
  // release; the two know nothing about each other, so without this handoff the
  // attempt ends with its record open and its last interval unbanked.
  const { declareFinalReport } = await import("../src/delivery/doorbell-delivery.js");
  const report = {
    key: "ktsk_h", attemptId: "att-1", claimCount: 2, deliverySeq: 0, deliveryCount: 0,
    basis: { kind: "same_domain", domain: "brain" },
    cumulativeStateMs: { executing: 120 },
  } as unknown as Parameters<typeof declareFinalReport>[1];

  const released: unknown[] = [];
  const msg = claimedDoorbellMsg({ seq: 3, info: { deliveryCount: 1 } }, "ktsk_h", 2, {
    retryLater: async (_id, _count, _reason, runTime) => { released.push(runTime); },
    fail: async () => {},
    settle: async () => {},
    sleep: async () => {},
  });

  declareFinalReport("ktsk_h", report);
  msg.nak(0);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(released.length, 1);
  assert.deepEqual(released[0], report, "the release carries what the attempt measured");
});

test("a release for an attempt that declared nothing carries nothing", async () => {
  // And the declaration is taken once: a later attempt must not release under
  // its predecessor's coverage.
  const { declareFinalReport } = await import("../src/delivery/doorbell-delivery.js");
  const report = {
    key: "ktsk_i", attemptId: "att-1", claimCount: 1, deliverySeq: 0, deliveryCount: 0,
    basis: { kind: "same_domain", domain: "brain" },
    cumulativeStateMs: { executing: 10 },
  } as unknown as Parameters<typeof declareFinalReport>[1];

  const seen: unknown[] = [];
  const actions = {
    retryLater: async (_id: string, _c?: number, _r?: unknown, runTime?: unknown) => {
      seen.push(runTime);
    },
    fail: async () => {},
    settle: async () => {},
    sleep: async () => {},
  };

  declareFinalReport("ktsk_i", report);
  claimedDoorbellMsg({ seq: 1, info: { deliveryCount: 1 } }, "ktsk_i", 1, actions as never).nak(0);
  await new Promise((r) => setTimeout(r, 0));
  claimedDoorbellMsg({ seq: 1, info: { deliveryCount: 2 } }, "ktsk_i", 2, actions as never).nak(0);
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(seen, [report, undefined]);
});

test("the claim client puts the final report on the release wire", async () => {
  // The other half of the handoff: what the delivery loop hands to the client
  // has to reach the endpoint, or the API settles without it.
  const { unclaimRun, failClaimedRun, settleClaimedRun } = await import("../src/clients/run-claim.js");
  const originalBase = process.env.INTERNAL_BACKEND_URL;
  process.env.INTERNAL_BACKEND_URL = "http://api.test";
  const bodies: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    urls.push(url);
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, async json() { return {}; } };
  }) as unknown as typeof fetch;
  const report = {
    key: "ktsk_j", attemptId: "att-9", claimCount: 1, deliverySeq: 0, deliveryCount: 0,
    basis: { kind: "same_domain", domain: "brain" },
    cumulativeStateMs: { executing: 55 },
  } as never;
  try {
    await unclaimRun("ktsk_j", 1, "retry", report);
    await failClaimedRun("ktsk_j", "claim_abandoned", 1, report);
    await settleClaimedRun("ktsk_j", 1, report);
  } finally {
    globalThis.fetch = realFetch;
    if (originalBase === undefined) delete process.env.INTERNAL_BACKEND_URL;
    else process.env.INTERNAL_BACKEND_URL = originalBase;
  }

  assert.equal(bodies.length, 3, "every settle route was called");
  assert.deepEqual(urls.map((u) => u.split("/").pop()), ["unclaim", "fail-claim", "settle-attempt"]);
  for (const body of bodies) {
    assert.deepEqual(body.run_time, report, "the report reaches the endpoint that settles");
    assert.equal(body.claim_count, 1, "fenced on the generation this holder took");
  }
});
