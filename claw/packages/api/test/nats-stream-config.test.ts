// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a start-up is allowed to do to a stream that already exists.
 *
 * Reconciling `max_age` at all is new: it used to be frozen at whatever the
 * stream was created with, so a corrected task-stream retention reached new
 * environments only while every running cluster kept a window too short for the
 * durable's redelivery budget and quietly deleted tasks it was still entitled
 * to retry. Reconciling it in both directions is worse than not reconciling it,
 * which is what these pin:
 *
 *   1. A retention wider than the code requires is left alone. The event stream
 *      has no environment variable for its retention, so widening it in NATS is
 *      the only way to keep session history for an audit window -- and a start
 *      that narrowed it again would delete that history with no way back.
 *   2. A retention narrower than required is widened, because that is the drift
 *      this exists for.
 *   3. A stream that does not exist is still created.
 *
 * One KV bucket is reconciled the same way, and for a reason of its own: the
 * tombstone bucket's TTL has to cover whatever the event stream actually keeps,
 * so an operator who lengthened it by hand was correcting the code rather than
 * drifting from it. Reconciling that in both directions narrowed it back on the
 * next start, which left no configuration in which a widened event stream and a
 * tombstone that covered it could both exist. Every other bucket's TTL is a
 * setting this code is the authority on, and refusing to shorten one of those is
 * how a bucket comes to outlive the deadlines derived from the same number.
 * Whatever the code cannot read for itself, it reads off the stream instead --
 * which is the last part here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JetStreamManager, KV } from "nats";

import {
  EVENT_STREAM_RETENTION_MS, ensureKvBuckets, ensureStream, ensureTombstoneBucket,
  kvTtlAction, kvTtlRefusal, kvTtlTooNarrow, readEventStreamRetentionMs,
  type EnsureKvBucketOpts,
} from "../src/infra/nats.js";

const HOUR_NS = 3600 * 1_000_000_000;
const HOUR_MS = 3600 * 1000;

interface StreamConfig { max_age: number; duplicate_window: number }

/**
 * A manager holding one stream, or none. Recording the calls rather than the
 * resulting config, because the question here is what the start-up asked the
 * server to change -- a stream left alone is an `update` that never happened.
 */
function manager(existing: StreamConfig | null): {
  mgr: JetStreamManager;
  updates: Array<Record<string, number>>;
  added: Array<Record<string, unknown>>;
} {
  const updates: Array<Record<string, number>> = [];
  const added: Array<Record<string, unknown>> = [];
  const mgr = {
    streams: {
      async info() {
        if (!existing) throw new Error("stream not found");
        return { config: existing };
      },
      async update(_name: string, config: Record<string, number>) {
        updates.push(config);
        return { config: { ...existing, ...config } };
      },
      async add(config: Record<string, unknown>) {
        added.push(config);
        return { config };
      },
    },
  } as unknown as JetStreamManager;
  return { mgr, updates, added };
}

test("a stream kept for longer than the code requires is left as it is", async () => {
  // The audit window case. The code knows a lower bound the stream has to
  // satisfy and nothing about why an operator went above it; narrowing it back
  // deletes everything past the new window on the spot.
  const { mgr, updates } = manager({ max_age: 30 * 24 * HOUR_NS, duplicate_window: 0 });

  await ensureStream(mgr, "PRIMUS_CLAW_EVENTS", ["events.>"], 24 * HOUR_NS);

  assert.deepEqual(updates, [],
    "a start that shortens a retention is a start that deletes history");
});

test("a retention that never expires is not read as the narrowest one", async () => {
  // NATS spells "keep forever" as max_age = 0, which is the widest setting
  // there is and the smallest number, so a numeric comparison cuts exactly the
  // stream an operator was most deliberate about back to hours.
  const { mgr, updates } = manager({ max_age: 0, duplicate_window: 0 });

  await ensureStream(mgr, "PRIMUS_CLAW_EVENTS", ["events.>"], 24 * HOUR_NS);

  assert.deepEqual(updates, []);
});

test("a stream too narrow for the redelivery budget is widened", async () => {
  const { mgr, updates } = manager({ max_age: HOUR_NS, duplicate_window: HOUR_NS });

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS);

  assert.deepEqual(updates, [{ max_age: 2 * HOUR_NS, duplicate_window: 2 * HOUR_NS }],
    "this is the drift the reconciliation exists for: at the old flat hour the "
    + "stream deleted tasks the durable could still redeliver");
});

test("a duplicate window already longer than required is kept", async () => {
  // A longer window only recognises more replays as replays, which is the safe
  // direction: it is what stops a drain that failed after publishing from
  // running the same turn twice.
  const { mgr, updates } = manager({ max_age: 4 * HOUR_NS, duplicate_window: 4 * HOUR_NS });

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS);

  assert.deepEqual(updates, []);
});

test("a stream that does not exist yet is created with what the code asked for", async () => {
  const { mgr, updates, added } = manager(null);

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS);

  assert.equal(added.length, 1);
  assert.equal(added[0].name, "PRIMUS_CLAW_TASKS");
  assert.deepEqual(added[0].subjects, ["tasks.>"]);
  assert.equal(added[0].max_age, 2 * HOUR_NS);
  assert.equal(added[0].duplicate_window, 2 * HOUR_NS);
  assert.deepEqual(updates, [], "nothing existed to reconcile");
});

test("a stream created without a duplicate window does not get one", async () => {
  // The event stream. Setting one there would cost the server the dedup index
  // for a publish path that carries no message ids.
  const { mgr, added } = manager(null);

  await ensureStream(mgr, "PRIMUS_CLAW_EVENTS", ["events.>"], 24 * HOUR_NS);

  assert.equal("duplicate_window" in added[0], false);
});

// ===== what has to cover the stream asks the stream =====

test("the retention read back is the one the stream has, not the one the code wants", async () => {
  // The whole reason for reading it. `ensureStream` above leaves a wider stream
  // alone, so on a cluster kept for a month the constant is a month out of date --
  // and the tombstone TTL derived from it expires while the events it answers for
  // are still being delivered.
  const { mgr } = manager({ max_age: 30 * 24 * HOUR_NS, duplicate_window: 0 });

  assert.deepEqual(
    await readEventStreamRetentionMs(mgr),
    { retentionMs: 30 * 24 * HOUR_MS, measured: true },
  );
});

test("a stream that never expires is reported as having no retention at all", async () => {
  // Not as zero milliseconds, which is what a number would have to mean here and
  // is the opposite of what NATS spells with it. A caller sizing a TTL has to be
  // able to tell "no window" from "an empty window".
  const { mgr } = manager({ max_age: 0, duplicate_window: 0 });

  assert.deepEqual(await readEventStreamRetentionMs(mgr), { retentionMs: null, measured: true });
});

test("a stream that cannot be read falls back, and says that is what it did", async () => {
  // The bound `ensureStream` has just applied is the retention on every cluster
  // nobody widened, so it is the right assumption -- and the wrong one only where
  // the answer would have been larger. That is the same invisibly-short tombstone
  // the bucket's error case is about, so the assumption travels with the number
  // instead of being logged once and forgotten.
  const { mgr } = manager(null);

  assert.deepEqual(
    await readEventStreamRetentionMs(mgr),
    { retentionMs: EVENT_STREAM_RETENTION_MS, measured: false },
  );
});

// ===== the retention that was read is the one the bucket is sized from =====

/** `ensureKvBucket`, recording what it was asked for instead of reaching NATS. */
function recordingEnsure(): {
  ensure: (name: string, opts: EnsureKvBucketOpts) => Promise<KV>;
  calls: Array<{ name: string; opts: EnsureKvBucketOpts }>;
} {
  const calls: Array<{ name: string; opts: EnsureKvBucketOpts }> = [];
  return {
    calls,
    ensure: async (name, opts) => {
      calls.push({ name, opts });
      return {} as KV;
    },
  };
}

test("the tombstone bucket is sized from the retention the stream reported", async () => {
  // The whole point of reading it back, and previously only assertable by reading
  // the source: on a cluster whose event stream was widened for an audit window,
  // a TTL taken from the code's constant instead expires twenty-nine days into the
  // window in which the mark is the only thing between a deleted session and its
  // own events.
  const month = 30 * 24 * HOUR_MS;
  const { ensure, calls } = recordingEnsure();

  await ensureTombstoneBucket({ retentionMs: month, measured: true }, ensure);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "BRAIN_TOMBSTONES");
  assert.equal(calls[0].opts.ttl, month,
    "the number that reaches the bucket has to be the stream's, not the constant's");
});

test("the tombstone bucket is the one bucket whose TTL is never narrowed", async () => {
  const { ensure, calls } = recordingEnsure();

  await ensureTombstoneBucket({ retentionMs: EVENT_STREAM_RETENTION_MS, measured: true }, ensure);

  assert.equal(calls[0].opts.ttlPolicy, "widenOnly");
});

test("and it is the only bucket of the four that asks for that policy", async () => {
  // The conclusion of this whole change, and the thing nothing else holds: every
  // other bucket's TTL is a setting this code is the authority on, so one of them
  // given `widenOnly` as well is a bucket a shortened setting can no longer
  // reach -- silently, since refusing to narrow is by design invisible from
  // outside. Reading the wiring is what used to have to catch that.
  const { ensure, calls } = recordingEnsure();

  const buckets = await ensureKvBuckets({ retentionMs: EVENT_STREAM_RETENTION_MS, measured: true }, ensure);

  assert.deepEqual(
    calls.map((c) => c.name),
    ["BRAIN_REGISTRY", "BRAIN_CHECKPOINTS", "BRAIN_TOMBSTONES", "SYSTEM_ENV"],
    "every bucket this process owns goes through here, or the guard below sees less than it claims",
  );
  assert.deepEqual(
    calls.filter((c) => c.opts.ttlPolicy === "widenOnly").map((c) => c.name),
    ["BRAIN_TOMBSTONES"],
  );
  for (const call of calls) {
    if (call.name === "BRAIN_TOMBSTONES") continue;
    assert.equal(call.opts.ttlPolicy ?? "exact", "exact",
      `${call.name}'s TTL is a setting, so a start-up has to be able to shorten it`);
  }
  assert.deepEqual(Object.keys(buckets).sort(),
    ["checkpoints", "registry", "systemEnv", "tombstones"],
    "and every one of them is handed back, since initNats binds all four");
});

test("the bucket's own line says whether that retention was measured or assumed", () => {
  // An unreadable stream gives the same invisibly-short mark the unbounded case is
  // reported for: suppression works correctly right up to the moment the mark
  // expires, and the first sign of the gap is a deleted session's content back in
  // the database. The reader warns once at start-up, which is not where anybody
  // explaining an expired tombstone weeks later is looking.
  const src = readFileSync(fileURLToPath(new URL("../src/infra/nats.ts", import.meta.url)), "utf-8");
  assert.match(src, /retentionMeasured: retention\.measured,[\s\S]*?"nats\.tombstone_bucket_ttl"/);
});

test("an unbounded stream still gets a finite TTL, and the widest one available", async () => {
  // No finite TTL covers a stream that never expires, so there is no correct
  // number; matching it with an unbounded bucket would trade a stated gap for a
  // bucket that grows by a key per deleted session for ever.
  const { ensure, calls } = recordingEnsure();

  await ensureTombstoneBucket({ retentionMs: null, measured: true }, ensure);

  assert.ok(Number.isFinite(calls[0].opts.ttl));
  assert.ok(calls[0].opts.ttl >= EVENT_STREAM_RETENTION_MS);
});

// ===== a bucket TTL is corrected as far as its own policy allows =====

test("a TTL shorter than required is widened", () => {
  assert.equal(kvTtlTooNarrow(HOUR_NS, 24 * HOUR_NS), true);
});

test("a TTL an operator lengthened is left where they put it", () => {
  // The half that was missing. The tombstone bucket's TTL has to cover the event
  // stream's retention, and there is no environment variable for either, so
  // lengthening the bucket by hand is how an operator makes a widened stream safe
  // -- and being narrowed back on the next start also destroys the marks past the
  // new window, which are the only record that those sessions were deleted.
  assert.equal(kvTtlTooNarrow(30 * 24 * HOUR_NS, 24 * HOUR_NS), false);
  assert.equal(kvTtlTooNarrow(24 * HOUR_NS, 24 * HOUR_NS), false, "and an exact match is no drift");
});

test("never-expiring is the widest TTL on both sides, not the narrowest", () => {
  // Zero is how NATS spells it, so read as a duration it is the smallest number
  // there is: a bucket deliberately made permanent would be read as the one most
  // in need of correction and cut back to hours.
  assert.equal(kvTtlTooNarrow(0, 24 * HOUR_NS), false, "a permanent bucket is not narrow");
  assert.equal(kvTtlTooNarrow(24 * HOUR_NS, 0), true, "and finite is narrower than permanent");
  assert.equal(kvTtlTooNarrow(0, 0), false);
});

test("a bucket whose TTL is a setting is shortened when the setting is", () => {
  // BRAIN_REGISTRY. Its TTL is the lifetime of a dead worker's `lock.<key>`, and
  // the lease reap grace and the lock-blocked takeover deadlines are re-derived
  // from the same variable -- so a bucket left at the old, longer value while
  // those deadlines shorten is a reaper declaring a run dead with the dead pod's
  // lock still held, and a replacement that never gets it. Widen-only was applied
  // to every bucket, which made that the outcome of shortening the variable.
  assert.equal(kvTtlAction(30 * 24 * HOUR_NS, HOUR_NS, "exact"), "apply");
  assert.equal(kvTtlAction(HOUR_NS, 24 * HOUR_NS, "exact"), "apply", "and widened as before");
  assert.equal(kvTtlAction(HOUR_NS, HOUR_NS, "exact"), "none");
});

test("the tombstone bucket refuses to shorten, and says so rather than passing", () => {
  // Refusing is right there -- the keys past the new window are the only record
  // that those sessions were deleted -- but a refusal nobody hears leaves the
  // start-up reporting no problems about a bucket running with a `max_age` this
  // code did not ask for. An event stream widened for an audit and then restored
  // is exactly that: the tombstone TTL stays at the wider value for good.
  assert.equal(kvTtlAction(30 * 24 * HOUR_NS, 24 * HOUR_NS, "widenOnly"), "refused");
  assert.equal(kvTtlAction(24 * HOUR_NS, 24 * HOUR_NS, "widenOnly"), "none",
    "a bucket that already agrees is a silence of a different kind");
  assert.equal(kvTtlAction(HOUR_NS, 24 * HOUR_NS, "widenOnly"), "apply");
});

test("only a refusal is reported, and it names both TTLs", () => {
  // `ensureKvBucket` needs a real server and the refusal changes nothing
  // observable by design, so this used to be a regex over the source -- which
  // held that a warning exists and carries two fields, and would have gone on
  // holding with the condition inverted: a line on every widening, silence on
  // every refusal. The condition travels with the payload now.
  assert.deepEqual(
    kvTtlRefusal("BRAIN_TOMBSTONES", 30 * 24 * HOUR_NS, 24 * HOUR_NS, "widenOnly"),
    {
      name: "BRAIN_TOMBSTONES",
      maxAgeNs: 30 * 24 * HOUR_NS,
      desiredMaxAgeNs: 24 * HOUR_NS,
      ttlPolicy: "widenOnly",
    },
    "which of the two numbers is wrong is the operator's decision, so both are theirs to read",
  );
  assert.equal(kvTtlRefusal("BRAIN_TOMBSTONES", HOUR_NS, 24 * HOUR_NS, "widenOnly"), null,
    "a widening is applied, and applying it is not a problem to report");
  assert.equal(kvTtlRefusal("BRAIN_REGISTRY", 30 * 24 * HOUR_NS, HOUR_NS, "exact"), null,
    "nor is a narrowing under the policy that is allowed to make it");
  assert.equal(kvTtlRefusal("BRAIN_TOMBSTONES", 24 * HOUR_NS, 24 * HOUR_NS, "widenOnly"), null);
});

test("the refusal reaches the log rather than being computed and dropped", () => {
  // All that is left of the guard above: one line, which nothing but the source
  // can show, wiring the payload to the level it has to come out at.
  const src = readFileSync(fileURLToPath(new URL("../src/infra/nats.ts", import.meta.url)), "utf-8");
  assert.match(
    src,
    /if \(refusal\) logger\.warn\(refusal, "nats\.kv_bucket_ttl_narrowing_refused"\)/,
  );
});
