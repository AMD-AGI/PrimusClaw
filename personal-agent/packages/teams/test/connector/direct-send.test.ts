// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Direct delivery to the Bot Connector (port of the Python worker's test_direct_connector.py, first half): the id comes
 * back with the send, the IMDS token, throttling and outages, and the queue as the fallback. A fake IMDS and a fake
 * Connector behind one injected fetch; the clock is a fake, so retries are exact and instant.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LIMITS } from "../../src/connector/limits.js";
import { build, CLIENT_ID, empty, envelope, FakeTeams, json, Queue, reference, settle } from "./fakes.js";
import { FakeClock } from "../../../../test-support/clock.js";

const MAX_ATTEMPTS = DEFAULT_LIMITS.maxAttempts;
const STICKY_MS = DEFAULT_LIMITS.queueStickyMs;

function teams(): FakeTeams {
  return new FakeTeams(new FakeClock());
}

// --- the id comes back with the send ---

test("a post returns the activity id synchronously and never touches the queue", async () => {
  const b = build();
  // what Messenger.post publishes: a send that asks for an ack, which a direct send never needs
  const delivered = await settle(b.clock, b.outbox.publish(envelope("Working on it...", { ack: "ack-1" })));
  assert.deepEqual(delivered, { activityId: "teams-1" });
  assert.deepEqual(b.queue.sent, []);
  const [call, ...rest] = b.teams.calls;
  assert.equal(rest.length, 0);
  assert.equal(call?.method, "POST");
  assert.equal(call.url, "https://smba.trafficmanager.net/amer/v3/conversations/19:abc@thread.v2/activities");
  assert.equal(call.headers["authorization"], "Bearer token-1");
  const body = b.teams.bodies()[0] ?? {};
  assert.equal(body["type"], "message");
  assert.deepEqual(body["from"], { id: "28:bot" });
  assert.deepEqual((body["recipient"] as { id: string }).id, "29:user");
  assert.deepEqual(body["conversation"], { id: "19:abc@thread.v2" });
  assert.equal(body["channelId"], "msteams");
  assert.ok(!("ack" in body) && !("operation" in body)); // the envelope is ours, the activity is Teams'
});

test("an update is a put over the activity and a typing indicator is a plain send", async () => {
  const b = build();
  await settle(b.clock, b.outbox.publish(envelope("edited", { operation: "update", activityId: "teams-9" })));
  await settle(b.clock, b.outbox.publish({ operation: "send", reference: reference(), activity: { type: "typing" } }));
  const [update, typing] = b.teams.calls;
  assert.equal(update?.method, "PUT");
  assert.ok(new URL(update.url).pathname.endsWith("/activities/teams-9"));
  assert.equal(b.teams.bodies()[0]?.["id"], "teams-9");
  assert.equal(b.teams.bodies()[0]?.["text"], "edited");
  assert.equal(typing?.method, "POST");
  assert.equal(b.teams.bodies()[1]?.["type"], "typing");
  assert.deepEqual(b.queue.sent, []);
});

test("a connector answer without an id is delivered without one and not waited for", async () => {
  const t = teams();
  t.answers = [json(200, {})];
  const b = build({ teams: t });
  assert.deepEqual(await settle(b.clock, b.outbox.publish(envelope("x"))), { activityId: undefined });
  assert.deepEqual(b.queue.sent, []);
});

// --- the token ---

test("the token comes from imds for the bot identity and is cached until five minutes before it expires", async () => {
  const b = build();
  await settle(b.clock, b.outbox.publish(envelope("one")));
  await settle(b.clock, b.outbox.publish(envelope("two")));
  assert.equal(b.teams.imds.length, 1); // cached
  await b.clock.advance((86399 - 301) * 1000); // one second short of the refresh margin
  await settle(b.clock, b.outbox.publish(envelope("three")));
  assert.equal(b.teams.imds.length, 1);
  await b.clock.advance(2000); // inside the margin: replaced before it can expire mid-send
  await settle(b.clock, b.outbox.publish(envelope("four")));
  assert.equal(b.teams.imds.length, 2);
  const first = b.teams.imds[0];
  assert.equal(first?.headers["metadata"], "true");
  const params = new URL(first.url).searchParams;
  assert.equal(params.get("resource"), "https://api.botframework.com");
  assert.equal(params.get("client_id"), CLIENT_ID);
  assert.deepEqual(
    b.teams.calls.map((c) => c.headers["authorization"]),
    ["Bearer token-1", "Bearer token-1", "Bearer token-1", "Bearer token-2"],
  );
});

test("concurrent sends share one token fetch", async () => {
  const b = build();
  const sends = [0, 1, 2, 3, 4].map((i) => b.outbox.publish(envelope(String(i), { ref: reference(`c${String(i)}`) })));
  await settle(b.clock, Promise.all(sends));
  assert.equal(b.teams.imds.length, 1);
});

test("a 401 refreshes the token once and resends", async () => {
  const t = teams();
  t.answers = [empty(401), json(201, { id: "teams-5" })];
  const b = build({ teams: t });
  assert.deepEqual(await settle(b.clock, b.outbox.publish(envelope())), { activityId: "teams-5" });
  assert.deepEqual(b.queue.sent, []);
  assert.deepEqual(
    t.calls.map((c) => c.headers["authorization"]),
    ["Bearer token-1", "Bearer token-2"],
  );
  assert.equal(t.imds.length, 2);
});

test("a 401 that survives the refresh goes to the queue and is not retried again", async () => {
  const t = teams();
  t.answers = [empty(401)];
  const b = build({ teams: t });
  assert.equal(await settle(b.clock, b.outbox.publish(envelope())), undefined);
  assert.equal(b.queue.sent.length, 1);
  assert.equal(t.calls.length, 2); // the send and one resend with the fresh token
});

test("an identity that is not on this node goes to the queue without calling the connector", async () => {
  // IMDS answers 400 until the identity is attached to the VM: the worker must keep working through the queue
  const t = teams();
  t.imdsStatus = 400;
  const b = build({ teams: t });
  assert.equal(await settle(b.clock, b.outbox.publish(envelope("one"))), undefined);
  assert.deepEqual(b.queue.texts(), ["one"]);
  assert.deepEqual(t.calls, []);
  assert.deepEqual(b.slept, []); // nothing to retry: the refusal is final
});

test("a busy imds is retried before giving up", async () => {
  const t = teams();
  t.imdsStatuses = [429, 503, 200];
  const b = build({ teams: t });
  assert.deepEqual(await settle(b.clock, b.outbox.publish(envelope())), { activityId: "teams-1" });
  assert.deepEqual(b.queue.sent, []);
  assert.deepEqual(b.slept, [0.5, 1.0]);
});

// --- throttling and outages ---

test("a 429 waits for retry after and then delivers", async () => {
  const t = teams();
  t.answers = [empty(429, { "Retry-After": "3" }), json(201, { id: "teams-2" })];
  const b = build({ teams: t });
  assert.deepEqual(await settle(b.clock, b.outbox.publish(envelope())), { activityId: "teams-2" });
  assert.deepEqual(b.queue.sent, []);
  assert.deepEqual(b.slept, [3.0]); // the server's wait, longer than the 0.5 s backoff
  assert.equal(t.calls.length, 2);
});

test("a retry after longer than we are willing to wait hands the message to the queue at once", async () => {
  const t = teams();
  t.answers = [empty(429, { "Retry-After": "120" })];
  const b = build({ teams: t });
  assert.equal(await settle(b.clock, b.outbox.publish(envelope())), undefined);
  assert.equal(b.queue.sent.length, 1);
  assert.deepEqual(b.slept, []);
  assert.equal(t.calls.length, 1);
});

test("a persistent 503 is retried with backoff and then falls back to the queue which acks the post", async () => {
  // The relay's ack giving Messenger.post its id ("queued-1") is Messenger's half of the Python test (W3's messenger
  // tests); here: the retries, and the envelope the queue gets, ack request included.
  const t = teams();
  t.answers = [empty(503)];
  const b = build({ teams: t });
  const result = await settle(b.clock, b.outbox.publish(envelope("Working on it...", { ack: "ack-1" })));
  assert.equal(result, undefined);
  assert.equal(t.calls.length, MAX_ATTEMPTS);
  assert.deepEqual(b.slept, [0.5, 1.0, 2.0]); // doubled each time
  assert.equal(b.queue.sent.length, 1);
  assert.equal(b.queue.sent[0]?.activity["text"], "Working on it...");
  assert.equal(b.queue.sent[0].ack, "ack-1");
});

test("network errors are retried like a 503", async () => {
  const t = teams();
  const boom = (): Response => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("no route"), { name: "ConnectError" }) });
  };
  t.answers = [boom, boom, json(201, { id: "teams-3" })];
  const b = build({ teams: t });
  assert.deepEqual(await settle(b.clock, b.outbox.publish(envelope())), { activityId: "teams-3" });
  assert.deepEqual(b.queue.sent, []);
  assert.deepEqual(b.slept, [0.5, 1.0]);
  assert.ok(b.logger.records.some((r) => r.fields["reason"] === "network: ConnectError"));
});

test("a refusal goes to the queue without retries and the conversation stays there", async () => {
  // The relay will most likely be refused too, but whatever is on the queue must not be overtaken by a direct send.
  const t = teams();
  t.answers = [
    json(403, { error: { code: "BotNotInConversationRoster", message: "the user's private question" } }),
    json(201, { id: "teams-4" }),
  ];
  const b = build({ teams: t });
  assert.equal(await settle(b.clock, b.outbox.publish(envelope("one"))), undefined);
  assert.equal(await settle(b.clock, b.outbox.publish(envelope("two"))), undefined);
  assert.deepEqual(b.slept, []);
  assert.deepEqual(b.queue.texts(), ["one", "two"]);
  assert.equal(t.calls.length, 1);
});

test("after a fallback the conversation stays on the queue so a later message cannot overtake it", async () => {
  const t = teams();
  t.answers = [...Array.from({ length: MAX_ATTEMPTS }, () => empty(503)), json(201, { id: "teams-6" })];
  const b = build({ teams: t });
  await settle(b.clock, b.outbox.publish(envelope("one"))); // falls back
  const callsAfterFallback = t.calls.length;
  await settle(b.clock, b.outbox.publish(envelope("two"))); // same conversation, soon after: the queue again
  const other = await settle(b.clock, b.outbox.publish(envelope("three", { ref: reference("19:other@thread.v2") })));
  await b.clock.advance(STICKY_MS + 1000);
  const later = await settle(b.clock, b.outbox.publish(envelope("four"))); // the relay has long delivered: direct again
  assert.deepEqual(b.queue.texts(), ["one", "two"]);
  assert.equal(t.calls.length, callsAfterFallback + 2);
  assert.deepEqual(other, { activityId: "teams-6" });
  assert.deepEqual(later, { activityId: "teams-6" });
});

test("the queue window restarts with every message that goes to the queue", async () => {
  // A message queued 50 s into the window is as slow to deliver as the first: direct sends wait for a quiet spell.
  const t = teams();
  t.answers = [...Array.from({ length: MAX_ATTEMPTS }, () => empty(503)), json(201, { id: "teams-8" })];
  const b = build({ teams: t });
  const start = b.clock.monotonicMs();
  await settle(b.clock, b.outbox.publish(envelope("one"))); // falls back at t0 (after its retries)
  const fellBack = b.clock.monotonicMs();
  await b.clock.advance(STICKY_MS - 10_000);
  await settle(b.clock, b.outbox.publish(envelope("two"))); // still inside the window: queued, and the window restarts
  await b.clock.advance(STICKY_MS - 10_000); // 100 s after "one" (past its own window), 50 s after "two"
  const three = await settle(b.clock, b.outbox.publish(envelope("three"))); // queued: "two" restarted the window
  await b.clock.advance(STICKY_MS + 1000); // a quiet spell after "three"
  const four = await settle(b.clock, b.outbox.publish(envelope("four")));
  assert.ok(fellBack - start < 10_000);
  assert.equal(three, undefined);
  assert.deepEqual(b.queue.texts(), ["one", "two", "three"]);
  assert.deepEqual(four, { activityId: "teams-8" });
});

test("a typing indicator that fails is dropped not retried and not queued", async () => {
  const t = teams();
  t.answers = [empty(503)];
  const b = build({ teams: t });
  const typing = b.outbox.publish({ operation: "send", reference: reference(), activity: { type: "typing" } });
  assert.equal(await settle(b.clock, typing), undefined);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(b.queue.sent, []);
  assert.deepEqual(b.slept, []);
});

test("a failing fallback is the callers error as it is today", async () => {
  const t = teams();
  t.answers = [empty(503)];
  const b = build({ teams: t, queue: new Queue(true) });
  await assert.rejects(settle(b.clock, b.outbox.publish(envelope())), /the queue refused/);
});
