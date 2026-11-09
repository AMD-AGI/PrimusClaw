// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Claw delivers each notification at least once (a copy after a timeout, a crash, or from another api replica); a person
 * sees each say once. The event id is claimed in the store before the send, so a copy is caught by whichever process gets it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { EVENT_CLAIM_LEASE_SECONDS, PROCESSED_TTL_SECONDS, type JsonObject } from "@primusclaw/personal-agent";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { advanceSeconds, openFileTestStore, openTestStore } from "../../../../test-support/store.js";
import type { SqliteStore } from "../../src/sqlite/store.js";
import { BUSY_WAIT_MS, clawEventsRoute, sinceOccurred, type ClawEventsDeps } from "../../src/http/claw-events.js";
import type { HttpResponse } from "../../src/http/routes.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { linkedAlice, RecordingSink, say, SECRET, signed } from "./fixtures.js";

function route(store: SqliteStore, clock: FakeClock, sink: RecordingSink, extra: Partial<ClawEventsDeps> = {}) {
  return clawEventsRoute({
    notifySubs: store.notifySubs,
    links: store.links,
    references: store.references,
    claims: store.idempotency,
    deliver: sink.deliver,
    clock,
    gone: false,
    ...extra,
  });
}

function bodyOf(response: HttpResponse): unknown {
  return "json" in response ? response.json : response.text;
}

test("two replicas on one store send a say once", async () => {
  const file = openFileTestStore();
  try {
    linkedAlice(file.store);
    const second = file.reopen();
    const a = new RecordingSink();
    const b = new RecordingSink();
    a.before = b.before = () => file.clock.sleep(100);
    const ra = route(file.store, file.clock, a);
    const rb = route(second, file.clock, b);
    const both = Promise.all([ra.handle(signed(file.clock, say())), rb.handle(signed(file.clock, say()))]);
    await flushMicrotasks();
    await file.clock.runAll();
    const together = (await both)
      .map((r) => [r.status, bodyOf(r)])
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    assert.deepEqual(together, [
      [200, { status: "delivered" }],
      [200, { status: "duplicate" }],
    ]);
    const later = [await ra.handle(signed(file.clock, say())), await rb.handle(signed(file.clock, say()))];
    assert.deepEqual(
      later.map((r) => [r.status, bodyOf(r)]),
      [
        [200, { status: "duplicate" }],
        [200, { status: "duplicate" }],
      ],
    );
    assert.equal(a.sent.length + b.sent.length, 1);
  } finally {
    file.close();
  }
});

test("a copy after a restart is a duplicate", async () => {
  const file = openFileTestStore();
  try {
    linkedAlice(file.store);
    const first = new RecordingSink();
    assert.deepEqual(bodyOf(await route(file.store, file.clock, first).handle(signed(file.clock, say()))), {
      status: "delivered",
    });
    advanceSeconds(file.clock, 23 * 3600); // Claw's last retry of the day
    const reborn = new RecordingSink();
    const again = await route(file.reopen(), file.clock, reborn).handle(signed(file.clock, say()));
    assert.deepEqual([again.status, bodyOf(again)], [200, { status: "duplicate" }]);
    assert.deepEqual(reborn.sent, []);
  } finally {
    file.close();
  }
});

test("a copy while the first send fails is not taken as delivered", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store);
  const sink = new RecordingSink();
  sink.failNext = true;
  sink.before = () => clock.sleep(100);
  const r = route(store, clock, sink);
  const both = Promise.all([r.handle(signed(clock, say())), r.handle(signed(clock, say()))]);
  await flushMicrotasks();
  await clock.runAll();
  const together = (await both).map((x) => [x.status, bodyOf(x)]);
  // A 2xx is recorded by Claw as delivered, so no copy may get one while the say has not reached the chat: the copy that waited
  // sends it itself once the first send failed.
  assert.deepEqual(
    together.sort((x, y) => Number(x[0]) - Number(y[0])),
    [
      [200, { status: "delivered" }],
      [503, { error: "send_failed" }],
    ],
  );
  assert.equal(sink.sent.length, 1);
  const retry = await r.handle(signed(clock, say())); // Claw's retry
  assert.deepEqual([retry.status, bodyOf(retry)], [200, { status: "duplicate" }]);
  assert.equal(sink.sent.length, 1);
});

test("a copy within the claim waits and after it is sent", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store);
  assert.equal(store.idempotency.claimEvent("claw-event:say-1").state, "claimed"); // a process that claimed it and died
  const sink = new RecordingSink();
  const r = route(store, clock, sink);
  const waiting = r.handle(signed(clock, say()));
  await flushMicrotasks();
  await clock.advance(BUSY_WAIT_MS);
  const first = await waiting;
  assert.deepEqual([first.status, bodyOf(first)], [503, { error: "in_progress" }]); // its claim still runs: try again later
  assert.deepEqual(sink.sent, []);
  advanceSeconds(clock, EVENT_CLAIM_LEASE_SECONDS + 1);
  assert.deepEqual(bodyOf(await r.handle(signed(clock, say()))), { status: "delivered" });
  assert.deepEqual(bodyOf(await r.handle(signed(clock, say()))), { status: "duplicate" });
  assert.equal(sink.sent.length, 1);
});

test("an event id header that disagrees with the signed body is refused", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store);
  const sink = new RecordingSink();
  const r = route(store, clock, sink);
  assert.deepEqual(bodyOf(await r.handle(signed(clock, say()))), { status: "delivered" });
  const refused = await r.handle(signed(clock, say(), { eventIdHeader: "say-other" }));
  assert.deepEqual([refused.status, bodyOf(refused)], [400, { error: "bad_event" }]);
  assert.equal(sink.sent.length, 1);
});

test("the record of a sent event expires after its ttl", async () => {
  const file = openFileTestStore();
  try {
    linkedAlice(file.store);
    const r = route(file.store, file.clock, new RecordingSink());
    assert.deepEqual(bodyOf(await r.handle(signed(file.clock, say("say-1")))), { status: "delivered" });
    advanceSeconds(file.clock, PROCESSED_TTL_SECONDS - 60);
    assert.deepEqual(bodyOf(await r.handle(signed(file.clock, say("say-1")))), { status: "duplicate" });
    advanceSeconds(file.clock, 60 + EVENT_CLAIM_LEASE_SECONDS + 1);
    assert.deepEqual(bodyOf(await r.handle(signed(file.clock, say("say-2")))), { status: "delivered" });
    const rows = file.raw.prepare("SELECT event_key FROM event_claims ORDER BY event_key").all();
    assert.deepEqual(
      rows.map((row) => row["event_key"]),
      ["claw-event:say-2"],
    );
  } finally {
    file.close();
  }
});

test("a wrong signature, an unknown route and a stale timestamp are refused, and nothing is sent", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store);
  const sink = new RecordingSink();
  const r = route(store, clock, sink);
  const wrong = await r.handle(signed(clock, say(), { signature: "sha256=" + "0".repeat(64) }));
  const unknown = await r.handle(signed(clock, say(), { route: "route-nobody" }));
  const stale = await r.handle(signed(clock, say(), { stampSeconds: clock.epochMs() / 1000 - 301 }));
  assert.deepEqual(
    [wrong, unknown, stale].map((x) => [x.status, bodyOf(x)]),
    [
      [401, { error: "bad_signature" }],
      [401, { error: "bad_signature" }],
      [401, { error: "stale_timestamp" }],
    ],
  );
  const notJson = await r.handle({ ...signed(clock, say()), body: new TextEncoder().encode("[1]") });
  assert.equal(notJson.status, 401); // (the signature covers the body: a changed body is a wrong signature)
  assert.deepEqual(sink.sent, []);
});

test("an event of another claw user, or for a person with no chat, is dropped (410 where claw takes it)", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store, false);
  const sink = new RecordingSink();
  const other: JsonObject = { ...say(), user_id: "u-mallory" };
  assert.deepEqual(bodyOf(await route(store, clock, sink).handle(signed(clock, other))), { status: "dropped" });
  const gone = await route(store, clock, sink, { gone: true }).handle(signed(clock, say()));
  assert.deepEqual([gone.status, bodyOf(gone)], [410, { error: "no_chat", status: "dropped" }]);
  assert.deepEqual(sink.sent, []);
});

test("a turn still running is retried later, a held event counts as taken, and a delivery is measured", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store);
  const sink = new RecordingSink();
  const measured: Array<[string, number, number | null]> = [];
  const r = route(store, clock, sink, { metrics: { eventDelivered: (t, s, since) => measured.push([t, s, since]) } });
  sink.outcome = "retry";
  const retried = await r.handle(signed(clock, say("e-1")));
  assert.deepEqual([retried.status, bodyOf(retried)], [503, { error: "turn_in_progress" }]);
  sink.outcome = "held";
  assert.deepEqual(bodyOf(await r.handle(signed(clock, say("e-1")))), { status: "held" });
  assert.deepEqual(bodyOf(await r.handle(signed(clock, say("e-1")))), { status: "duplicate" });
  sink.outcome = "delivered";
  await r.handle(signed(clock, say("e-2")));
  assert.deepEqual(
    measured.map((m) => m[0]),
    ["assistant.say"],
  );
  assert.equal(sinceOccurred("2026-11-07T08:53:00Z", Date.UTC(2026, 10, 7, 8, 53, 10) / 1000), 10);
  assert.equal(sinceOccurred("2026-11-07T08:53:00", 0), null);
  assert.equal(sinceOccurred(undefined, 0), null);
});

test("a signed claw event does not log the webhook secret or what it says", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store, false);
  const logger = new RecordingLogger();
  const r = route(store, clock, new RecordingSink(), { logger });
  const event = { ...say(), text: "MESSAGE-MARK", summary: "ANSWER-MARK" };
  await r.handle(signed(clock, event, { signature: "sha256=" + "0".repeat(64) }));
  await r.handle(signed(clock, event));
  const dump = logger.dump();
  assert.ok(logger.lines.length > 0);
  for (const secret of [SECRET, "MESSAGE-MARK", "ANSWER-MARK"]) assert.ok(!dump.includes(secret), secret);
});

test("an event the chat already answered meanwhile is answered 200 dropped and taken", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store);
  const sink = new RecordingSink();
  sink.outcome = "dropped";
  const r = route(store, clock, sink);
  const answered = await r.handle(signed(clock, say("e-9")));
  assert.deepEqual([answered.status, bodyOf(answered)], [200, { status: "dropped" }]);
  assert.deepEqual(bodyOf(await r.handle(signed(clock, say("e-9")))), { status: "duplicate" });
});

test("event ids that are not strings are python's str() of them, and a body without them is refused", async () => {
  const { store, clock } = openTestStore();
  linkedAlice(store);
  store.links.setClawUserId("aad-a", "True");
  const sink = new RecordingSink();
  const r = route(store, clock, sink);
  const numeric = { ...say(), event_id: 42, user_id: true };
  const sent = await r.handle(signed(clock, numeric, { eventIdHeader: "42" }));
  assert.deepEqual([sent.status, bodyOf(sent)], [200, { status: "delivered" }]);
  assert.equal(store.idempotency.claimEvent("claw-event:42").state, "done");
  const missing = await r.handle(signed(clock, { type: "assistant.say", event_id: "e-x" }));
  assert.deepEqual([missing.status, bodyOf(missing)], [400, { error: "bad_event" }]);
});
