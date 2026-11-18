// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the direct outbox does beyond the ported Python tests: a publish its caller cancels, the plain retry after a 400,
 * stream requests, opening a 1:1 conversation, listing a chat's members, the queue options and close.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TokenError, UndeliverableError, UnaddressableError } from "../../src/connector/errors.js";
import { ConversationNotOpenedError, StreamRefusedError } from "../../src/outbound/outbox.js";
import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { build, empty, envelope, FakeTeams, json, reference, settle, SERVICE_URL } from "./fakes.js";

function teams(): FakeTeams {
  return new FakeTeams(new FakeClock());
}

const ROOT = { type: "https://schema.org/Message", "@type": "Message", additionalType: ["AIGeneratedContent"] };

// --- a publish its caller cancels ---

test("an update waiting behind the conversation's line and cancelled before its turn sends nothing", async () => {
  const t = teams();
  t.delayMs = () => 100;
  const b = build({ teams: t });
  const first = b.outbox.publish(envelope("first"));
  const controller = new AbortController();
  const update = b.outbox.publish(envelope("edited", { operation: "update", activityId: "teams-1" }), {
    signal: controller.signal,
  });
  await flushMicrotasks();
  controller.abort(new Error("the turn was cancelled"));
  await assert.rejects(settle(b.clock, update), /the turn was cancelled/);
  await settle(b.clock, first);
  assert.deepEqual(t.committed, ["first"]);
  assert.deepEqual(b.queue.sent, []);
  assert.equal(b.outbox.lanesInUse, 0);
});

test("a publish whose signal is already aborted sends nothing and does not go to the queue", async () => {
  const b = build();
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(b.outbox.publish(envelope(), { signal: controller.signal }), /cancelled/);
  assert.deepEqual([b.teams.calls, b.teams.imds, b.queue.sent], [[], [], []]);
});

test("a send cancelled mid-request is not retried, not queued, and leaves the conversation direct", async () => {
  const t = teams();
  t.delayMs = () => 5_000;
  t.answers = [empty(503), json(201, { id: "teams-2" })];
  const b = build({ teams: t });
  const controller = new AbortController();
  const sent = b.outbox.publish(envelope("one"), { signal: controller.signal });
  await settle(b.clock, new Promise<void>((resolve) => setImmediate(resolve)));
  assert.equal(t.calls.length, 1);
  controller.abort(new Error("cancelled mid-send"));
  await assert.rejects(settle(b.clock, sent), /cancelled mid-send/);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(b.queue.sent, []);
  t.delayMs = () => 0;
  assert.deepEqual(await settle(b.clock, b.outbox.publish(envelope("two"))), { activityId: "teams-2" });
});

test("a send cancelled during its backoff is not retried", async () => {
  const t = teams();
  t.answers = [empty(503)];
  const b = build({ teams: t });
  const controller = new AbortController();
  const sent = b.outbox.publish(envelope("one"), { signal: controller.signal });
  await flushMicrotasks();
  assert.deepEqual(b.slept, [0.5]);
  controller.abort(new Error("cancelled in backoff"));
  await assert.rejects(settle(b.clock, sent), /cancelled in backoff/);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(b.queue.sent, []);
});

test("a conversation on the queue hands the caller's options to the queue", async () => {
  const t = teams();
  t.imdsStatus = 400;
  const b = build({ teams: t });
  await settle(b.clock, b.outbox.publish(envelope("one")));
  const options = { signal: new AbortController().signal };
  await settle(b.clock, b.outbox.publish(envelope("two"), options));
  assert.equal(b.queue.options[1], options);
  // a typing indicator while on the queue goes there too, without restarting the window
  const typing = b.outbox.publish({ operation: "send", reference: reference(), activity: { type: "typing" } });
  assert.equal(await settle(b.clock, typing), undefined);
  assert.equal(b.queue.sent.length, 3);
});

// --- the plain retry after a 400 ---

test("a 400 for the reply style's extras is sent again without them, and that is what the queue gets if it fails", async () => {
  const t = teams();
  t.answers = [json(400, { error: { code: "BadRequest" } }), json(201, { id: "teams-2" })];
  const b = build({ teams: t });
  const decorated = envelope("answer");
  decorated.activity = {
    ...decorated.activity,
    entities: [ROOT, { type: "mention" }],
    suggestedActions: { actions: [] },
  };
  assert.deepEqual(await settle(b.clock, b.outbox.publish(decorated)), { activityId: "teams-2" });
  const [first, second] = t.bodies();
  assert.ok(first?.["suggestedActions"] !== undefined);
  assert.deepEqual(second?.["entities"], [{ type: "mention" }]);
  assert.equal(second["suggestedActions"], undefined);

  const refused = teams();
  refused.answers = [json(400, {})];
  const c = build({ teams: refused });
  const labelled = envelope("answer");
  labelled.activity = { ...labelled.activity, entities: [ROOT] };
  assert.equal(await settle(c.clock, c.outbox.publish(labelled)), undefined);
  assert.equal(refused.calls.length, 2);
  assert.equal(c.queue.sent[0]?.activity["entities"], undefined); // the plain one
});

test("a 400 for an activity without extras goes to the queue at once", async () => {
  const t = teams();
  t.answers = [json(400, {})];
  const b = build({ teams: t });
  assert.equal(await settle(b.clock, b.outbox.publish(envelope("plain"))), undefined);
  assert.equal(t.calls.length, 1);
  assert.equal(b.queue.sent.length, 1);
});

// --- streams ---

test("a stream request is sent once, directly, and returns the id", async () => {
  const b = build();
  const delivered = await settle(b.clock, b.outbox.publishStream(envelope("streamed")));
  assert.deepEqual(delivered, { activityId: "teams-1" });
  assert.equal(b.teams.calls.length, 1);
});

test("a refused stream request throws with the status and code and is not retried or queued", async () => {
  const t = teams();
  t.answers = [json(403, { error: { code: "ContentStreamNotAllowed" } })];
  const b = build({ teams: t });
  const error = await settle(b.clock, b.outbox.publishStream(envelope("x"))).then(
    () => assert.fail("not refused"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof StreamRefusedError);
  assert.deepEqual(
    [error.status, error.code, error.message],
    [403, "ContentStreamNotAllowed", "status 403 ContentStreamNotAllowed"],
  );
  t.answers = [empty(503)];
  await assert.rejects(settle(b.clock, b.outbox.publishStream(envelope("y"))), (e: unknown) => {
    return e instanceof StreamRefusedError && e.status === 503;
  });
  assert.equal(t.calls.length, 2);
  assert.deepEqual(b.queue.sent, []);
});

test("a stream is refused while the conversation is on the queue, for a bad address and at the deadline", async () => {
  const t = teams();
  t.imdsStatus = 400;
  const b = build({ teams: t });
  await settle(b.clock, b.outbox.publish(envelope("queued")));
  await assert.rejects(b.outbox.publishStream(envelope("x")), /the conversation is on the queue/);
  await assert.rejects(
    b.outbox.publishStream(envelope("x", { ref: reference("c2", "https://evil.example/") })),
    (e: unknown) => e instanceof StreamRefusedError && e.message === "UnaddressableError",
  );
  const slow = teams();
  slow.delayMs = () => 60_000;
  const c = build({ teams: slow, limits: { sendDeadlineMs: 200, requestTimeoutMs: 100_000 } });
  await assert.rejects(
    settle(c.clock, c.outbox.publishStream(envelope("x")), 10),
    (e: unknown) => e instanceof StreamRefusedError && e.message === "TimeoutError" && e.status === 0,
  );
});

// --- a 1:1 conversation ---

test("open personal creates the conversation and returns its id", async () => {
  const t = teams();
  t.answers = [json(201, { id: "a:1on1" })];
  const b = build({ teams: t });
  assert.equal(await settle(b.clock, b.outbox.openPersonal(SERVICE_URL, "29:user", "tenant", "28:bot")), "a:1on1");
  const [call] = t.calls;
  assert.equal(call?.url, "https://smba.trafficmanager.net/amer/v3/conversations");
  assert.deepEqual(JSON.parse(call.body), {
    isGroup: false,
    bot: { id: "28:bot" },
    members: [{ id: "29:user" }],
    tenantId: "tenant",
  });
});

test("open personal fails with the reason only", async () => {
  const b = build();
  await assert.rejects(b.outbox.openPersonal("", "29:u", "t", "28:b"), ConversationNotOpenedError);
  await assert.rejects(b.outbox.openPersonal("https://evil.example/", "29:u", "t", "28:b"), /not a Bot Connector host/);
  const t = teams();
  t.answers = [empty(503)];
  const c = build({ teams: t });
  await assert.rejects(
    settle(c.clock, c.outbox.openPersonal(SERVICE_URL, "29:u", "t", "28:b")),
    /^ConversationNotOpenedError: status 503$/,
  );
  assert.equal(t.calls.length, 2); // one try and one retry
  t.answers = [json(200, {})];
  await assert.rejects(
    settle(c.clock, c.outbox.openPersonal(SERVICE_URL, "29:u", "t", "28:b")),
    /status 200 without a conversation id/,
  );
  const slow = teams();
  slow.delayMs = () => 60_000;
  const d = build({ teams: slow });
  await assert.rejects(
    settle(d.clock, d.outbox.openPersonal(SERVICE_URL, "29:u", "t", "28:b"), 100),
    /the overall deadline passed/,
  );
});

// --- members ---

test("list members reads the roster with one retry on a rejected token", async () => {
  const t = teams();
  t.answers = [empty(401), json(200, [{ id: "29:a", name: "Lin Mei" }, "junk", { id: "29:b", name: "Robin" }])];
  const b = build({ teams: t });
  const members = await settle(b.clock, b.outbox.listMembers(SERVICE_URL, "19:chat@thread.v2"));
  assert.deepEqual(members, [
    { id: "29:a", name: "Lin Mei" },
    { id: "29:b", name: "Robin" },
  ]);
  assert.equal(t.calls[1]?.url, "https://smba.trafficmanager.net/amer/v3/conversations/19:chat@thread.v2/members");
  assert.equal(t.calls[1].method, "GET");
  assert.equal(t.calls[1].headers["authorization"], "Bearer token-2");
  t.answers = [json(200, { not: "a list" })];
  assert.deepEqual(await settle(b.clock, b.outbox.listMembers(SERVICE_URL, "19:chat")), []);
});

test("list members throws when teams does not answer", async () => {
  const b = build();
  await assert.rejects(b.outbox.listMembers("", "19:chat"), UnaddressableError);
  await assert.rejects(b.outbox.listMembers("https://evil.example/", "19:chat"), UnaddressableError);
  const cases: [FakeTeams["answers"], RegExp][] = [
    [[empty(401)], /^status 401$/],
    [[empty(500)], /^status 500$/],
    [[new Response("not json", { status: 200 })], /the member list is not JSON/],
    [[new TypeError("fetch failed")], /^network: TypeError$/],
  ];
  for (const [answers, reason] of cases) {
    const t = teams();
    t.answers = answers;
    const c = build({ teams: t });
    await assert.rejects(settle(c.clock, c.outbox.listMembers(SERVICE_URL, "19:chat")), (e: unknown) => {
      return e instanceof UndeliverableError && reason.test(e.message);
    });
  }
  const t = teams();
  t.imdsStatus = 400;
  const c = build({ teams: t });
  await assert.rejects(
    settle(c.clock, c.outbox.listMembers(SERVICE_URL, "19:chat")),
    /^UndeliverableError: token: IMDS answered 400$/,
  );
});

test("the outbox exposes its token source and closes it", async () => {
  const b = build();
  let closed = false;
  const tokens = b.outbox.tokens;
  tokens.close = () => {
    closed = true;
    return Promise.resolve();
  };
  await b.outbox.close();
  assert.ok(closed);
  assert.equal(new TokenError("x").transient, false);
});
