// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The measuring parts of the end-to-end script (`e2e/assistant-p1-lib.ts`): a receiver that verifies what it is
 * sent, and the arithmetic the verdict rests on. The scenario itself needs a deployment and a model; these do not.
 *
 *   B1  the receiver accepts a correctly signed delivery and records it, with the item snapshot
 *   B2  it refuses a bad signature, a stale timestamp, a header that disagrees with the body, and everything before it has a secret
 *   B3  while rejecting it answers 500 and records nothing as received, and takes deliveries again afterwards
 *   B4  an event accepted twice is reported as a duplicate, one accepted once is not
 *   B5  the percentile is nearest-rank; the table says which interjection was too slow and which got no answer
 *   B6  `until` returns what the probe found, null at the deadline, and never answers "found" for a probe that never did
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signPayload } from "../src/notifications/signing.js";
import { duplicateEventIds, latencyMs, percentile, renderTimings, startReceiver, until } from "./e2e/assistant-p1-lib.js";

const SECRET = "s".repeat(64);
const payload = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  event_id: id, type: "assistant.say", occurred_at: new Date().toISOString(), user_id: "u1", text: "hello",
  item: { item_id: "kwi_1", seq: 1, title: "t", board_state: "needs_you", result_version: 1, can_accept: true }, ...extra,
});
async function deliver(port: number, body: string, o: { secret?: string; ts?: number; eventId?: string; path?: string } = {}) {
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  return fetch(`http://127.0.0.1:${port}${o.path ?? "/hook"}`, {
    method: "POST",
    headers: {
      [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signPayload(o.secret ?? SECRET, ts, body),
      [EVENT_ID_HEADER]: o.eventId ?? JSON.parse(body).event_id, "content-type": "application/json",
    },
    body,
  });
}

test("B1 a correctly signed delivery is accepted and recorded", async () => {
  const r = await startReceiver(0, "127.0.0.1");
  try {
    r.setSecret(SECRET);
    const res = await deliver(r.port, payload("e1"));
    assert.equal(res.status, 200);
    assert.equal(r.received.length, 1);
    assert.deepEqual({ id: r.received[0].eventId, type: r.received[0].type, fallback: r.received[0].fallback, can: r.received[0].item?.can_accept }, { id: "e1", type: "assistant.say", fallback: false, can: true });
    assert.equal(r.received[0].verified, true);
    await deliver(r.port, payload("e2", { type: "work_item.needs_you", fallback: true }));
    assert.equal(r.received[1].fallback, true);
  } finally { await r.close(); }
});

test("B2 what is not signed for the subscription is refused", async () => {
  const r = await startReceiver(0, "127.0.0.1");
  try {
    assert.equal((await deliver(r.port, payload("e0"))).status, 401, "before it has a secret nothing verifies");
    r.setSecret(SECRET);
    assert.equal((await deliver(r.port, payload("e1"), { secret: "x".repeat(64) })).status, 401);
    assert.equal((await deliver(r.port, payload("e2"), { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
    assert.equal((await deliver(r.port, payload("e3"), { eventId: "another" })).status, 400);
    assert.equal((await deliver(r.port, "not json", { eventId: "x" })).status, 400);
    assert.equal((await deliver(r.port, payload("e4"), { path: "/elsewhere" })).status, 404);
    assert.equal(r.received.length, 0);
    assert.equal(r.refused.length, 6);
  } finally { await r.close(); }
});

test("B3 while rejecting it answers 500 and records nothing as received", async () => {
  const r = await startReceiver(0, "127.0.0.1");
  try {
    r.setSecret(SECRET);
    r.setRejecting(true);
    assert.equal((await deliver(r.port, payload("e1"))).status, 500);
    assert.equal(r.received.length, 0);
    r.setRejecting(false);
    assert.equal((await deliver(r.port, payload("e1"))).status, 200);
    assert.equal(r.received.length, 1, "the retry is received once");
  } finally { await r.close(); }
});

test("B4 an event accepted twice is a duplicate", () => {
  const at = Date.now();
  const mk = (eventId: string) => ({ at, eventId, type: "assistant.say", text: "", fallback: false, verified: true });
  assert.deepEqual(duplicateEventIds([mk("a"), mk("b"), mk("a"), mk("a")]), ["a"]);
  assert.deepEqual(duplicateEventIds([mk("a"), mk("b")]), []);
  assert.deepEqual(duplicateEventIds([]), []);
});

test("B5 the percentile is nearest-rank and the table names the slow and the missing", () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([5], 95), 5);
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
  assert.equal(percentile(twenty, 95), 1900);
  assert.equal(percentile(twenty, 100), 2000);
  assert.equal(percentile([300, 100, 200], 50), 200);
  const table = renderTimings([
    { label: "fast", sentAt: 1_000, answeredAt: 3_000 },
    { label: "slow", sentAt: 1_000, answeredAt: 11_000 },
    { label: "none", sentAt: 1_000, answeredAt: null },
  ], 10_000);
  assert.match(table, /fast .*2000ms\s+ok/);
  assert.match(table, /slow .*10000ms\s+TOO SLOW/);
  assert.match(table, /none .*NO ANSWER/);
  assert.equal(latencyMs({ label: "x", sentAt: 5, answeredAt: 9 }), 4);
  assert.equal(latencyMs({ label: "x", sentAt: 5, answeredAt: null }), null);
});

test("B6 until returns what was found, and null at the deadline", async () => {
  let calls = 0;
  assert.equal(await until(() => (++calls >= 3 ? "found" : undefined), Date.now() + 2000, 1), "found");
  assert.equal(calls, 3);
  const started = Date.now();
  assert.equal(await until(() => undefined, started + 60, 5), null);
  assert.ok(Date.now() - started >= 60, "it waited for the deadline");
  assert.equal(await until(() => false, Date.now() + 10, 1), false, "false is an answer: only undefined means not yet");
});
