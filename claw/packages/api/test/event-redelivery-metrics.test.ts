// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The event consumer's redeliveries (`events/redelivery.ts`): counted, and the message retried longest timed, so a message the
 * consumer cannot get past is an alert instead of a log line per retry.
 *
 *   E1  a nak starts the clock, later naks keep it, an ack stops it; the gauge is the oldest still being retried
 *   E2  a message no longer seen (another replica took it) is forgotten after FORGET_AFTER_MS
 *   E3  `trackDelivery` counts a redelivery, and passes ack and nak through to the message
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FORGET_AFTER_MS, RedeliveryTracker, trackDelivery } from "../src/events/redelivery.js";
import { registry } from "../src/infra/metrics.js";

test("E1 a nak starts the clock, an ack stops it, the gauge is the oldest still retried", () => {
  let now = 1_000_000;
  const t = new RedeliveryTracker(() => now);
  assert.equal(t.oldestAgeSeconds(), 0);
  t.nak(7);
  now += 30_000;
  t.nak(8);
  t.nak(7);
  now += 30_000;
  t.nak(7);
  assert.equal(t.oldestAgeSeconds(), 60, "from the first nak of 7, not its last");
  t.ack(7);
  assert.equal(t.oldestAgeSeconds(), 30);
  t.ack(8);
  assert.equal(t.oldestAgeSeconds(), 0);
});

test("E2 a message not seen again is forgotten", () => {
  let now = 0;
  const t = new RedeliveryTracker(() => now);
  t.nak(1);
  now += FORGET_AFTER_MS - 1;
  assert.ok(t.oldestAgeSeconds() > 0);
  now += 2;
  assert.equal(t.oldestAgeSeconds(), 0);
  assert.equal(t.size, 0);
});

test("E3 trackDelivery counts redeliveries and passes ack and nak through", async () => {
  const count = async () => Number(/^claw_api_event_redelivered_total\{service="claw-api"\} (\S+)$/m.exec(await registry.metrics())?.[1] ?? 0);
  const before = await count();
  let now = 0;
  const t = new RedeliveryTracker(() => now);
  const seen: string[] = [];
  const msg = (redeliveryCount: number) => ({
    subject: "events.s1", data: new Uint8Array(), seq: 42, redelivered: redeliveryCount > 1,
    info: { streamSequence: 42, redeliveryCount },
    ack: () => seen.push("ack"), nak: (ms?: number) => seen.push(`nak:${ms}`),
  });
  trackDelivery(msg(1), t).nak(5_000);
  now += 10_000;
  trackDelivery(msg(2), t).nak(5_000);
  now += 10_000;
  assert.equal(t.oldestAgeSeconds(), 20);
  trackDelivery(msg(3), t).ack();
  assert.equal(t.oldestAgeSeconds(), 0);
  assert.deepEqual(seen, ["nak:5000", "nak:5000", "ack"]);
  assert.equal(await count(), before + 2, "the second and third deliveries were redeliveries");
  const gauge = /^claw_api_event_redelivery_oldest_age_seconds\{service="claw-api"\} (\S+)$/m.exec(await registry.metrics());
  assert.ok(gauge, "the gauge is exported");
});
