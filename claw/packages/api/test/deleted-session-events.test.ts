// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What happens to an event that arrives after its session was deleted.
 *
 * Deleting a session purges its event stream and then takes the row out of
 * reach, which covers exactly what was in the stream at that instant and
 * nothing else. A Brain that published concurrently, a message the consumer
 * had already pulled, a redelivery after a nak -- each arrives afterwards, and
 * the consumer's first act is an unconditional INSERT into
 * `claw_session_events`, followed for `exec_complete` by conversation turns.
 * So the content the user deleted comes back, under a session id that no
 * longer resolves to anything they can see or delete again.
 *
 * The order the design asks for is "stop the consumers, then purge". Consumers
 * spread across replicas cannot be stopped on command, so the equivalent is to
 * make each one refuse the session: the tombstone is the same mark Brain's
 * dispatcher already consults, and it outlives every window a message can
 * arrive from -- the task stream's redelivery budget and the event stream's own
 * retention -- so nothing that can still ask outlasts the answer.
 */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveTaskDeliveryBudget, resolveTombstoneTtlMs } from "@claw/protocol";

import { TASK_MAX_DELIVER } from "../src/config.js";
import {
  sessionWasDeleted, tombstoneReader, TOMBSTONE_UNKNOWN_NAK_MS,
  consumeEventDelivery, rememberSessionDeleted, rememberDeletedFromCleanupSubject,
} from "../src/events/consumer.js";
import { resetDeletedSessionCache } from "../src/sessions/deleted-cache.js";
import { db } from "../src/infra/db.js";
import { sc } from "../src/infra/nats.js";
import { EVENT_STREAM_RETENTION_MS, tombstoneTtlMs } from "../src/infra/nats.js";

const original = { ...tombstoneReader };
after(() => { Object.assign(tombstoneReader, original); });
afterEach(() => { resetDeletedSessionCache(); });

/** Stand-in for the tombstone bucket, recording what it was asked. */
function stubTombstones(present: Set<string>, fail = false): { reads: string[] } {
  const reads: string[] = [];
  Object.assign(tombstoneReader, {
    has: async (sessionId: string) => {
      reads.push(sessionId);
      if (fail) throw new Error("bucket unavailable");
      return present.has(sessionId);
    },
  });
  return { reads };
}

// The predicate caches per session id, so each case uses an id of its own.
let n = 0;
const freshId = (): string => `s-${++n}-${Date.now()}`;

test("an event for a deleted session is recognised as one to drop", async () => {
  const id = freshId();
  stubTombstones(new Set([id]));
  assert.equal(await sessionWasDeleted(id), true);
});

test("an ordinary session is untouched", async () => {
  stubTombstones(new Set());
  assert.equal(await sessionWasDeleted(freshId()), false);
});

test("a deleted session is remembered, so a stream of events costs one read", async () => {
  // A run emits events continuously and a deletion is terminal, so asking the
  // bucket per event would add a round trip for an answer that cannot change
  // back.
  const id = freshId();
  const { reads } = stubTombstones(new Set([id]));
  for (let i = 0; i < 5; i++) assert.equal(await sessionWasDeleted(id), true);
  assert.equal(reads.length, 1);
});

test("a live session's answer is cached only briefly, because it can be deleted mid-run", async () => {
  // The opposite caching decision from above, for the opposite reason: "not
  // deleted" is exactly the answer that goes stale, and the window it is held
  // for is the window in which deleted content can still be written.
  const id = freshId();
  const present = new Set<string>();
  const { reads } = stubTombstones(present);
  assert.equal(await sessionWasDeleted(id), false);
  present.add(id);
  assert.equal(await sessionWasDeleted(id), false, "within the window the stale answer stands");
  assert.equal(reads.length, 1, "the cost is bounded by time, not by event count");
});

test("a bucket that cannot answer is not a verdict", async () => {
  // Neither verdict is safe on a KV read failure. Dropping would discard a live
  // session's conversation content over a transient error, and persisting would
  // write content back under a session the user deleted, which is the whole point
  // of the check. This is a JetStream delivery, so the answer is "ask again": the
  // caller naks and the message comes back once the bucket responds.
  const id = freshId();
  stubTombstones(new Set([id]), true);
  assert.equal(await sessionWasDeleted(id), "unknown");
});

test("an unreadable answer is not cached either way", async () => {
  // Caching it would turn one blip into a fixed verdict for every later event on
  // that session, which is what the redelivery is there to avoid.
  const id = freshId();
  const present = new Set<string>();
  const { reads } = stubTombstones(present, true);
  assert.equal(await sessionWasDeleted(id), "unknown");
  assert.equal(await sessionWasDeleted(id), "unknown");
  assert.equal(reads.length, 2, "each attempt asks again");
});

test("an empty subject is never treated as a deleted session", async () => {
  // `events.` with no id would otherwise be looked up as `deleted.` and could
  // match a stray key, silently dropping every malformed event.
  const { reads } = stubTombstones(new Set([""]));
  assert.equal(await sessionWasDeleted(""), false);
  assert.equal(reads.length, 0);
});

test("writing the tombstone on this replica closes the live window immediately", async () => {
  // Same replica as the delete: the cleanup notification has not gone out yet,
  // Brain has not aborted yet, and the live cache from a read milliseconds ago
  // would otherwise admit the trailing exec_complete.
  const id = freshId();
  const { reads } = stubTombstones(new Set());
  assert.equal(await sessionWasDeleted(id), false);
  rememberSessionDeleted(id);
  assert.equal(await sessionWasDeleted(id), true);
  assert.equal(reads.length, 1, "the positive answer does not re-read the bucket");
});

test("hearing cleanup.<sid> closes the live window on every other replica", async () => {
  // The message that tells Brain to abort is also the one whose trailing
  // exec_complete lands a few hundred milliseconds later, inside the TTL.
  const id = freshId();
  stubTombstones(new Set());
  assert.equal(await sessionWasDeleted(id), false);
  rememberDeletedFromCleanupSubject(`cleanup.${id}`);
  assert.equal(await sessionWasDeleted(id), true);
});

// ===== the consume loop, not just the predicate =====

const originalQuery = db.query;
afterEach(() => { db.query = originalQuery; });

function fakeDelivery(sessionId: string, event: Record<string, unknown>) {
  const verdicts: string[] = [];
  const msg = {
    subject: `events.${sessionId}`,
    data: sc.encode(JSON.stringify(event)),
    seq: 1,
    ack: () => { verdicts.push("ack"); },
    nak: (ms?: number) => { verdicts.push(`nak:${ms}`); },
  };
  return { msg, verdicts };
}

function stubInserts(): unknown[][] {
  const inserts: unknown[][] = [];
  db.query = (async (sql: string, params?: unknown[]) => {
    if (/INSERT INTO claw_session_events/.test(sql)) {
      inserts.push(params ?? []);
      return { rowCount: 1, rows: [{ id: 1 }] };
    }
    return { rowCount: 0, rows: [] };
  }) as typeof db.query;
  return inserts;
}

test("a deleted session is refused before the INSERT, and the refusal acks", async () => {
  // The two properties the consume loop exists for. The predicate tests above
  // cannot see either: they never reach the write, and they never ack.
  const id = freshId();
  stubTombstones(new Set([id]));
  const inserts = stubInserts();
  const { msg, verdicts } = fakeDelivery(id, {
    type: "exec_complete", prompt: "hi", final_text: "there",
  });

  await consumeEventDelivery(msg);

  assert.deepEqual(inserts, [], "the content the user deleted must not come back");
  assert.deepEqual(verdicts, ["ack"], "there is nothing to retry; the session is gone");
});

test("an unreadable tombstone naks instead of persisting", async () => {
  const id = freshId();
  stubTombstones(new Set(), true);
  const inserts = stubInserts();
  const { msg, verdicts } = fakeDelivery(id, { type: "statusUpdate" });

  await consumeEventDelivery(msg);

  assert.deepEqual(inserts, []);
  assert.deepEqual(verdicts, [`nak:${TOMBSTONE_UNKNOWN_NAK_MS}`]);
});

test("a live session still persists", async () => {
  const id = freshId();
  stubTombstones(new Set());
  const inserts = stubInserts();
  const { msg, verdicts } = fakeDelivery(id, { type: "statusUpdate", agentStatus: "idle" });

  await consumeEventDelivery(msg);

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][1], id);
  assert.deepEqual(verdicts, ["ack"]);
});

// ===== asking again is not asking again immediately =====

test("the retry after an unreadable bucket waits before asking again", () => {
  // A bare nak() is redelivery at whatever rate the consume loop can manage, so
  // the answer to "the KV store is unavailable" was a spin loop against the
  // unavailable KV store, adding load to the outage that caused it. The wait is
  // what makes it a retry rather than a busy poll.
  assert.ok(TOMBSTONE_UNKNOWN_NAK_MS > 0, "an immediate retry is a spin loop, not a retry");
  assert.ok(
    TOMBSTONE_UNKNOWN_NAK_MS >= 1_000 && TOMBSTONE_UNKNOWN_NAK_MS <= 60_000,
    "in the same range as this consumer's other backoffs, which are 5s and 10s",
  );
});

test("no failure path in the consumer naks without a delay", () => {
  // A guard rather than a behaviour test: the loop's naks sit inside `for await`
  // over a live JetStream iterator, and the symptom of a bare one is a rate, not
  // a wrong answer -- nothing fails, the cluster just gets hammered while it is
  // already unwell. Easy to reintroduce and invisible in review.
  const src = readFileSync(
    fileURLToPath(new URL("../src/events/consumer.ts", import.meta.url)),
    "utf-8",
  );
  assert.ok(!/\.nak\(\s*\)/.test(src), "every nak here has to name how long it waits");
});

// ===== the answer has to outlive everything that can ask for it =====

test("the event stream's retention is what covers the tombstone, at every permitted budget", () => {
  // Not a restatement of Math.max: the point is which term decides, and it is
  // never the redelivery one. TASK_MAX_DELIVER is clamped, and at the ceiling the
  // clamp allows the derived window is still under a day -- so on every
  // configuration this system can be given, removing the floor would leave the
  // mark expiring before the events it has to answer for. A test that ranged over
  // unreachable values could not fail if the floor were dropped, because the
  // unreachable ones are the only ones where the other term wins.
  for (const configured of [0, 1, 3, 10, 23, 100, 1000, Infinity, NaN]) {
    const { maxDeliver } = resolveTaskDeliveryBudget(configured);
    assert.ok(
      resolveTombstoneTtlMs(maxDeliver) < EVENT_STREAM_RETENTION_MS,
      `at maxDeliver ${maxDeliver} the redelivery window is not what protects the events`,
    );
    assert.equal(
      tombstoneTtlMs(maxDeliver, EVENT_STREAM_RETENTION_MS),
      EVENT_STREAM_RETENTION_MS,
      `the floor has to be what decides at maxDeliver ${maxDeliver}`,
    );
  }
});

test("a stream an operator widened widens the tombstone with it", () => {
  // The configuration that had no answer before. `ensureStream` leaves a stream
  // wider than the code's constant alone, on purpose, because editing the stream
  // is the only way to keep session history for an audit window -- and the
  // tombstone was still sized from the constant, so on that cluster it expired
  // twenty-nine days before the events it was the only defence against.
  const month = 30 * 24 * 3600 * 1000;
  assert.equal(
    tombstoneTtlMs(TASK_MAX_DELIVER, month),
    month,
    "the mark has to cover the retention the stream actually has",
  );
});

test("a stream that never expires gets the widest bound there is, and a complaint", () => {
  // No finite TTL covers an unbounded stream, so there is no correct number here
  // and the honest outcome is the widest one this code can justify plus a
  // statement of what is therefore not guaranteed. Matching the stream by making
  // the bucket unbounded too would trade a stated gap for a bucket that grows by
  // a key per deleted session for ever, and which the `widenOnly` policy this one
  // bucket is reconciled under could never bring back down.
  const ttl = tombstoneTtlMs(TASK_MAX_DELIVER, null);
  assert.ok(Number.isFinite(ttl));
  assert.ok(ttl >= EVENT_STREAM_RETENTION_MS);

  const src = readFileSync(
    fileURLToPath(new URL("../src/infra/nats.ts", import.meta.url)),
    "utf-8",
  );
  assert.match(
    src,
    /logger\.error\(.*?"nats\.tombstone_cannot_cover_unbounded_event_stream/s,
    "an operator has no other way to find out: nothing fails and no metric moves",
  );
});
