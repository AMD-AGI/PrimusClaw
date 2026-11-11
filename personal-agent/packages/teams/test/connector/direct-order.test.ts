// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Direct delivery to the Bot Connector (port of test_direct_connector.py, second half): the token goes to Microsoft
 * hosts only, one send cannot hold the line, order, what is logged, and deletes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { UnaddressableError } from "../../src/connector/errors.js";
import { DEFAULT_LIMITS } from "../../src/connector/limits.js";
import { buildRequest } from "../../src/connector/request.js";
import { DeleteUnsupportedError, type TeamsEnvelope } from "../../src/outbound/outbox.js";
import { FakeClock } from "../../../../test-support/clock.js";
import {
  build,
  deleteEnvelope,
  empty,
  envelope,
  FakeTeams,
  json,
  reference,
  SECRET_TEXT,
  SERVICE_URL,
  settle,
} from "./fakes.js";

const STICKY_MS = DEFAULT_LIMITS.queueStickyMs;

function teams(): FakeTeams {
  return new FakeTeams(new FakeClock());
}

// --- the token goes to Microsoft hosts only ---

for (const serviceUrl of [
  "https://evil.example/amer/",
  "https://attacker.trafficmanager.net/amer/",
  "https://trafficmanager.net/",
  "https://smba.trafficmanager.net.evil.example/",
  "https://evilbotframework.com/",
  "http://smba.trafficmanager.net/amer/",
  "https://smba.trafficmanager.net@evil.example/",
  "https://user:pw@smba.trafficmanager.net/",
  "https://smba.trafficmanager.net:8443/",
]) {
  test(`a service url that is not a connector host never receives the token: ${serviceUrl}`, async () => {
    const b = build();
    const result = await settle(b.clock, b.outbox.publish(envelope("hi", { ref: reference(undefined, serviceUrl) })));
    assert.equal(result, undefined);
    assert.equal(b.queue.sent.length, 1); // the relay Function handles it as it always did
    assert.deepEqual(b.teams.calls, []);
    assert.deepEqual(b.teams.imds, []);
  });
}

for (const serviceUrl of [
  "https://smba.trafficmanager.net/emea/",
  "https://api.botframework.com/",
  "https://smba.infra.gcc.teams.microsoft.com/teams/",
]) {
  test(`the known connector hosts are sent to: ${serviceUrl}`, () => {
    const request = buildRequest(envelope("hi", { ref: reference(undefined, serviceUrl) }));
    assert.ok(request.url.startsWith(`${serviceUrl.replace(/\/+$/, "")}/v3/`));
  });
}

test("a conversation id cannot change the path", () => {
  const request = buildRequest(envelope("hi", { ref: reference("19:x/../../v3/other?q=1#f") }));
  // a "/", "?" or "#" in an id is data, not path or query (";" and "=" stay: channel threads are ...;messageid=123)
  assert.equal(
    request.url,
    "https://smba.trafficmanager.net/amer/v3/conversations/19:x%2F..%2F..%2Fv3%2Fother%3Fq=1%23f/activities",
  );
  const thread = buildRequest(envelope("hi", { ref: reference("19:t@thread.tacv2;messageid=1700") }));
  assert.ok(thread.url.endsWith("/conversations/19:t@thread.tacv2;messageid=1700/activities"));
});

// --- one send cannot hold the line ---

test("a connector that never finishes answering is cut off at the deadline and the queue takes the message", async () => {
  const t = teams();
  t.delayMs = () => 30_000;
  const b = build({ teams: t, limits: { sendDeadlineMs: 200 } });
  const started = b.clock.monotonicMs();
  const first = await settle(b.clock, b.outbox.publish(envelope("one")), 10);
  assert.equal(first, undefined);
  assert.equal(b.queue.sent.length, 1);
  assert.ok(b.clock.monotonicMs() - started < 3000);
  assert.equal(b.outbox.lanesInUse, 0); // the line is free again
});

test("a connector that ignores the abort is still cut off at the deadline", async () => {
  const t = teams();
  // a body that never ends, from a response that does not listen to the request's signal
  t.answers = [() => new Response(new ReadableStream({ start: () => undefined }), { status: 201 })];
  const b = build({ teams: t, limits: { sendDeadlineMs: 200 } });
  const started = b.clock.monotonicMs();
  const result = await settle(b.clock, b.outbox.publish(envelope("one")), 10);
  assert.equal(result, undefined);
  assert.equal(b.queue.sent.length, 1);
  assert.ok(b.clock.monotonicMs() - started < 3000);
  assert.equal(b.outbox.lanesInUse, 0);
});

test("an imds that hangs is cut off at the deadline too", async () => {
  const t = teams();
  t.imdsDelayMs = 30_000;
  const b = build({ teams: t, limits: { sendDeadlineMs: 200 } });
  const started = b.clock.monotonicMs();
  const result = await settle(b.clock, b.outbox.publish(envelope("one")), 10);
  assert.equal(result, undefined);
  assert.equal(b.queue.sent.length, 1);
  assert.deepEqual(t.calls, []);
  assert.ok(b.clock.monotonicMs() - started < 3000);
});

test("a typing indicator is cut off at its own short deadline", async () => {
  const t = teams();
  t.delayMs = () => 30_000;
  const b = build({ teams: t, limits: { typingTimeoutMs: 200 } });
  const started = b.clock.monotonicMs();
  const typing = b.outbox.publish({ operation: "send", reference: reference(), activity: { type: "typing" } });
  await settle(b.clock, typing, 10);
  assert.deepEqual(b.queue.sent, []);
  assert.ok(b.clock.monotonicMs() - started < 3000);
});

// --- order ---

test("the sends of one conversation leave in the order they were made even when the first is slowest", async () => {
  const t = teams();
  t.delayMs = (call) => ((JSON.parse(call.body) as { text: string }).text === "m0" ? 50 : 0); // m0 is the slow one
  const b = build({ teams: t });
  const sends = [0, 1, 2, 3, 4].map((i) => b.outbox.publish(envelope(`m${String(i)}`))); // made in order
  await settle(b.clock, Promise.all(sends), 10);
  assert.deepEqual(t.committed, ["m0", "m1", "m2", "m3", "m4"]); // as Teams ends up showing them
});

test("a retry keeps its place in line", async () => {
  const t = teams();
  t.answers = [empty(503), json(201, { id: "t" })];
  const b = build({ teams: t });
  const first = b.outbox.publish(envelope("first"));
  const second = b.outbox.publish(envelope("second"));
  await settle(b.clock, Promise.all([first, second]));
  assert.deepEqual(t.committed, ["first", "first", "second"]); // 503, the retry, then the next message
});

test("one slow conversation does not hold up another", async () => {
  const t = teams();
  t.delayMs = (call) => (call.url.includes("slow") ? 200 : 0);
  const b = build({ teams: t });
  let slowDone = false;
  const slow = b.outbox.publish(envelope("s", { ref: reference("19:slow@thread.v2") })).then(() => (slowDone = true));
  await settle(b.clock, b.outbox.publish(envelope("f", { ref: reference("19:fast@thread.v2") })), 10);
  assert.equal(slowDone, false); // the fast conversation finished while the slow one was still waiting
  await settle(b.clock, slow);
});

test("the conversation locks are released", async () => {
  const b = build();
  for (const i of [0, 1, 2])
    await settle(b.clock, b.outbox.publish(envelope("hi", { ref: reference(`c${String(i)}`) })));
  assert.equal(b.outbox.lanesInUse, 0);
});

// --- what is logged ---

test("every direct send logs one line with its latency and never the text or the token", async () => {
  const t = teams();
  t.answers = [empty(429, { "Retry-After": "1" }), json(201, { id: "teams-7" }), empty(503)];
  const b = build({ teams: t });
  await settle(b.clock, b.outbox.publish(envelope(SECRET_TEXT))); // a 429, then delivered
  await settle(b.clock, b.outbox.publish(envelope(SECRET_TEXT, { ref: reference("c2") }))); // 503s: falls back
  const sends = b.logger.records.filter((r) => r.message === "direct send delivered");
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.fields["operation"], "send");
  assert.equal(sends[0].fields["kind"], "message");
  assert.equal(sends[0].fields["attempts"], 2);
  assert.equal(typeof sends[0].fields["tookMs"], "number");
  assert.equal(sends[0].fields["activityId"], "teams-7");
  assert.ok(b.logger.records.some((r) => r.message === "direct send not delivered, handing it to the queue"));
  const text = b.logger.text();
  assert.ok(!text.includes(SECRET_TEXT) && !text.includes("token-1") && !text.includes("Bearer"));
});

test("every direct line names the target conversation and whether it is a card, a message or typing", async () => {
  const t = teams();
  t.answers = [json(201, { id: "teams-1" }), json(201, { id: "teams-2" }), json(201, {}), json(201, { id: "s-1" })];
  const b = build({ teams: t });
  const target = reference("a:1target-conversation");
  const card: TeamsEnvelope = {
    operation: "send",
    reference: target,
    activity: {
      type: "message",
      attachments: [
        { contentType: "application/vnd.microsoft.card.adaptive", content: { body: [{ text: SECRET_TEXT }] } },
      ],
    },
  };
  await settle(b.clock, b.outbox.publish(card));
  await settle(b.clock, b.outbox.publish(envelope(SECRET_TEXT, { ref: target })));
  await settle(b.clock, b.outbox.publish({ operation: "send", reference: target, activity: { type: "typing" } }));
  await settle(b.clock, b.outbox.publishStream(envelope(SECRET_TEXT, { ref: reference("19:group@thread.v2") })));
  const lines = b.logger.records.filter((r) => r.message.startsWith("direct "));
  assert.deepEqual(
    lines.map((r) => [r.message, r.fields["kind"], r.fields["content"], r.fields["conversation"]]),
    [
      ["direct send delivered", "message", "card", "a:1target-conversation"],
      ["direct send delivered", "message", "message", "a:1target-conversation"],
      ["direct send delivered", "typing", "typing", "a:1target-conversation"],
      ["direct stream delivered", "message", "message", "19:group@thread.v2"],
    ],
  );
  // the value is the conversation the request went to
  assert.ok(t.calls[0]?.url.includes("/v3/conversations/a:1target-conversation/activities"));
  const text = b.logger.text();
  assert.ok(!text.includes(SECRET_TEXT) && !text.includes("29:user") && !text.includes("aad-1")); // no text, no person
});

test("a send handed to the queue names its conversation, and one without a conversation says -", async () => {
  const t = teams();
  t.answers = [empty(503)];
  const b = build({ teams: t });
  await settle(b.clock, b.outbox.publish(envelope(SECRET_TEXT, { ref: reference("19:busy@thread.v2") })));
  await settle(b.clock, b.outbox.publish(envelope(SECRET_TEXT, { ref: reference("19:busy@thread.v2") })));
  await settle(b.clock, b.outbox.publish(envelope(SECRET_TEXT, { ref: { serviceUrl: SERVICE_URL } })));
  const named = (message: string) => b.logger.records.find((r) => r.message.startsWith(message))?.fields;
  assert.equal(named("direct send not delivered")?.["conversation"], "19:busy@thread.v2");
  assert.equal(named("direct send not delivered")?.["content"], "message");
  assert.equal(named("direct send skipped")?.["conversation"], "19:busy@thread.v2");
  const unaddressable = b.logger.records.filter((r) => r.message.startsWith("direct send not delivered")).at(-1);
  assert.equal(unaddressable?.fields["conversation"], "-");
  assert.equal(b.queue.sent.length, 3);
  assert.ok(!b.logger.text().includes(SECRET_TEXT));
});

// --- deleting a message ---

test("a delete is a bodiless delete request to the activity and never touches the queue", async () => {
  const b = build();
  await settle(b.clock, b.outbox.publish(deleteEnvelope(reference(), "teams-9")));
  const [call, ...rest] = b.teams.calls;
  assert.equal(rest.length, 0);
  assert.equal(call?.method, "DELETE");
  assert.equal(call.url, "https://smba.trafficmanager.net/amer/v3/conversations/19:abc@thread.v2/activities/teams-9");
  assert.equal(call.headers["authorization"], "Bearer token-1");
  assert.equal(call.body, "");
  assert.deepEqual(b.queue.sent, []);
});

test("a delete needs an activity id and never sends the token to a host that is not the connector", () => {
  assert.throws(() => buildRequest(deleteEnvelope(reference(), "")), /activity id/);
  assert.throws(
    () => buildRequest(deleteEnvelope(reference(undefined, "https://evil.example/"), "teams-9")),
    (error: unknown) => error instanceof UnaddressableError && /not a Bot Connector host/.test(error.message),
  );
});

test("a delete that teams refuses is not handed to the queue and the conversation stays direct", async () => {
  const t = teams();
  t.answers = [json(404, { error: { code: "ActivityNotFound" } }), json(201, { id: "teams-3" })];
  const b = build({ teams: t });
  await assert.rejects(
    settle(b.clock, b.outbox.publish(deleteEnvelope(reference(), "teams-9"))),
    DeleteUnsupportedError,
  );
  const later = await settle(b.clock, b.outbox.publish(envelope("next"))); // a refused delete kept the conversation direct
  assert.deepEqual(b.queue.sent, []);
  assert.deepEqual(later, { activityId: "teams-3" });
});

test("a delete on a conversation that is on the queue is refused and does not extend the queue window", async () => {
  const t = teams();
  t.imdsStatus = 403; // the bot's identity is not here: this send goes to the queue
  const b = build({ teams: t });
  await settle(b.clock, b.outbox.publish(envelope("one")));
  await b.clock.advance(STICKY_MS - 10_000);
  await assert.rejects(
    settle(b.clock, b.outbox.publish(deleteEnvelope(reference(), "teams-9"))),
    DeleteUnsupportedError,
  );
  await b.clock.advance(11_000); // 61 s after the queued message, 51 s after the delete
  t.imdsStatus = 200;
  const later = await settle(b.clock, b.outbox.publish(envelope("two")));
  assert.deepEqual(
    b.queue.sent.map((e) => e.operation),
    ["send"],
  );
  assert.deepEqual(later, { activityId: "teams-1" });
});

test("the service url is stripped before it is checked and addressed", () => {
  const request = buildRequest(envelope("hi", { ref: reference(undefined, `  ${SERVICE_URL}  `) }));
  assert.equal(request.url, "https://smba.trafficmanager.net/amer/v3/conversations/19:abc@thread.v2/activities");
});
