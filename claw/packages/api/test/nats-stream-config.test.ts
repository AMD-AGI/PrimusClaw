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
 * A stream's replica count goes the other way, and the tests below say why the
 * two rules differ: moving copies of a log between servers never drops a
 * message, so the count is reconciled to the exact figure in both directions,
 * while shortening a retention deletes history and is therefore refused.
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

interface StreamConfig { max_age: number; duplicate_window: number; num_replicas: number }

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
  const { mgr, updates } = manager({ max_age: 30 * 24 * HOUR_NS, duplicate_window: 0, num_replicas: 3 });

  await ensureStream(mgr, "PRIMUS_CLAW_EVENTS", ["events.>"], 24 * HOUR_NS, 0, 3);

  assert.deepEqual(updates, [],
    "a start that shortens a retention is a start that deletes history");
});

test("a retention that never expires is not read as the narrowest one", async () => {
  // NATS spells "keep forever" as max_age = 0, which is the widest setting
  // there is and the smallest number, so a numeric comparison cuts exactly the
  // stream an operator was most deliberate about back to hours.
  const { mgr, updates } = manager({ max_age: 0, duplicate_window: 0, num_replicas: 3 });

  await ensureStream(mgr, "PRIMUS_CLAW_EVENTS", ["events.>"], 24 * HOUR_NS, 0, 3);

  assert.deepEqual(updates, []);
});

test("a stream too narrow for the redelivery budget is widened", async () => {
  const { mgr, updates } = manager({ max_age: HOUR_NS, duplicate_window: HOUR_NS, num_replicas: 3 });

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS, 3);

  assert.deepEqual(updates, [{ max_age: 2 * HOUR_NS, duplicate_window: 2 * HOUR_NS }],
    "this is the drift the reconciliation exists for: at the old flat hour the "
    + "stream deleted tasks the durable could still redeliver");
});

test("a duplicate window already longer than required is kept", async () => {
  // A longer window only recognises more replays as replays, which is the safe
  // direction: it is what stops a drain that failed after publishing from
  // running the same turn twice.
  const { mgr, updates } = manager({ max_age: 4 * HOUR_NS, duplicate_window: 4 * HOUR_NS, num_replicas: 3 });

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS, 3);

  assert.deepEqual(updates, []);
});

test("a stream that does not exist yet is created with what the code asked for", async () => {
  const { mgr, updates, added } = manager(null);

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS, 3);

  assert.equal(added.length, 1);
  assert.equal(added[0].name, "PRIMUS_CLAW_TASKS");
  assert.deepEqual(added[0].subjects, ["tasks.>"]);
  assert.equal(added[0].max_age, 2 * HOUR_NS);
  assert.equal(added[0].duplicate_window, 2 * HOUR_NS);
  assert.equal(added[0].num_replicas, 3,
    "a stream added without this field is added at the JetStream default of 1");
  assert.deepEqual(updates, [], "nothing existed to reconcile");
});

// ===== replicas =====

test("a stream left at one replica is raised to the configured count", async () => {
  // The 2026-09-01 outage in one assertion. PRIMUS_CLAW_TASKS was created
  // before `ensureStream` took a replica count, so it lived on exactly one
  // server; when that server's pod went away nothing was hosting `tasks.>`,
  // `js.publish` came back NO_RESPONDERS -- reported as the bare code "503" --
  // and every POST /sessions failed for four and a half hours. Reconciling on
  // start is what makes the fix reach clusters that already exist.
  const { mgr, updates } = manager({ max_age: 4 * HOUR_NS, duplicate_window: 4 * HOUR_NS, num_replicas: 1 });

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS, 3);

  assert.deepEqual(updates, [{ num_replicas: 3 }],
    "retention was already wide enough, so replicas are the only correction");
});

test("a replica count already correct is not rewritten", async () => {
  const { mgr, updates } = manager({ max_age: 4 * HOUR_NS, duplicate_window: 4 * HOUR_NS, num_replicas: 3 });

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS, 3);

  assert.deepEqual(updates, []);
});

test("a single-node cluster is left at one replica rather than asked for three", async () => {
  // NATS_REPLICAS=1 is how the local quick start survives: JetStream answers a
  // replicas>1 request in non-clustered mode with err 10074, so a start-up that
  // insisted on three here would die exactly where the KV buckets used to.
  const { mgr, updates, added } = manager(null);

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS, 1);

  assert.equal(added[0].num_replicas, 1);
  assert.deepEqual(updates, []);
});

test("a stream on three replicas is brought back down for a single-node cluster", async () => {
  // The mirror image of the retention rule at the top of this file, and the
  // reason the two are allowed to differ: changing a replica count moves copies
  // of a log between servers and never drops a message, while shortening a
  // retention deletes history on the spot with nothing to restore it from. So
  // replicas narrow and retention does not. Reconciling only upward here would
  // be invisible in every other test in this file, because every one of them
  // asks for more replicas than the stream has or for the same number -- and it
  // would strand exactly the operator the config tests exist for: someone
  // taking a cluster to NATS_REPLICAS=1 keeps streams at three that JetStream
  // outside clustered mode answers with err 10074, and no restart corrects it.
  const { mgr, updates } = manager({ max_age: 4 * HOUR_NS, duplicate_window: 4 * HOUR_NS, num_replicas: 3 });

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS, 1);

  assert.deepEqual(updates, [{ num_replicas: 1 }],
    "a stream left at three on a single-node cluster is a stream JetStream "
    + "refuses to serve, and this start-up is the only thing that would lower it");

  // Still clustered, just narrower -- a five-server cluster taken to three.
  // Nothing in the process rewrites a stream's replica count except this line,
  // so a count only ever widened drifts one way for the life of the cluster.
  const shrunk = manager({ max_age: 4 * HOUR_NS, duplicate_window: 4 * HOUR_NS, num_replicas: 5 });

  await ensureStream(shrunk.mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS, 3);

  assert.deepEqual(shrunk.updates, [{ num_replicas: 3 }],
    "the figure is reconciled exactly, not treated as a floor");
});

test("a narrow retention and a lone replica are corrected in one update", async () => {
  // Both drifts travel in the same `streams.update`, so a cluster carrying both
  // is not left half-reconciled by a start that fails between two calls.
  const { mgr, updates } = manager({ max_age: HOUR_NS, duplicate_window: HOUR_NS, num_replicas: 1 });

  await ensureStream(mgr, "PRIMUS_CLAW_TASKS", ["tasks.>"], 2 * HOUR_NS, 2 * HOUR_NS, 3);

  assert.deepEqual(updates, [
    { max_age: 2 * HOUR_NS, duplicate_window: 2 * HOUR_NS, num_replicas: 3 },
  ]);
});

test("the reconciliation names the event operators watch and what the stream was", () => {
  // The two producers a live cluster's move from one replica to three is
  // visible through, and the only ones: `ensureStream` reaches its logger
  // through the module, not through an argument, so the manager double above
  // sees the `streams.update` call and nothing of the line that reports it.
  // Reading the source is what is left, as with the tombstone bucket's
  // `retentionMeasured` below -- it holds that the payload and the event name
  // are wired together, not that the line runs.
  //
  // Both halves are new and both are load-bearing. The event was renamed from
  // `nats.stream_retention_widened`, which is no longer a true description
  // once replicas travel in the same update -- and a rename is a break for
  // whoever hung an alert or a log query on the old string, so it needs to be
  // deliberate rather than a thing that drifts back. `wasReplicas` is the
  // before-figure: `widened` says the stream is now on three, and only this
  // field says it was on one, which is the difference between a start-up that
  // corrected the outage and a start-up that had nothing to correct.
  const src = readFileSync(fileURLToPath(new URL("../src/infra/nats.ts", import.meta.url)), "utf-8");

  assert.match(src, /wasReplicas: existing\.config\.num_replicas,[\s\S]*?"nats\.stream_config_reconciled"/,
    "without the before-figure on this line there is no record that a cluster's "
    + "streams ever moved off one replica");
  assert.doesNotMatch(src, /nats\.stream_retention_widened/,
    "the old event name is gone from the file, so the rename is one decision "
    + "and not two lines emitting under different names");
});

// ===== the counts above are the ones initNats actually passes =====

/**
 * Every `ensureStream(...)` in the source -- the call sites and the declaration
 * -- each as its argument or parameter list split at the top-level commas, with
 * line and block comments stripped off first.
 *
 * A depth-counting scan rather than a regular expression, because a regular
 * expression cannot match a balanced parenthesis: `[^)]*` stops at the first
 * `)`, which in an argument list is the one closing a nested call, so wrapping
 * any argument in a helper -- `resolveTaskStreamMaxAgeNs(...)` sits one line
 * away from the task call already -- would fail a call site that is entirely
 * correct. Walking from the opening paren to its match takes the arguments
 * whole however they nest. Stripping comments is the other half: an identifier
 * written in prose, in a line comment or in the JSDoc on `ensureStream`, is
 * not code that runs, and a text search cannot tell the difference.
 *
 * The declaration is kept rather than filtered out, and flagged, because the
 * question below is asked of both: what the parameter list requires is half of
 * whether a call site can omit it.
 */
interface EnsureStreamSite { args: string[]; isDeclaration: boolean }

function ensureStreamSites(source: string): EnsureStreamSite[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const sites: EnsureStreamSite[] = [];
  for (const at of code.matchAll(/(?<![\w$.])(function\s+)?ensureStream\s*\(/g)) {
    const args: string[] = [];
    let start = at.index + at[0].length;
    let depth = 1;
    let i = start;
    for (; i < code.length && depth > 0; i += 1) {
      const ch = code[i];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      else if (ch === "," && depth === 1) { args.push(code.slice(start, i)); start = i + 1; }
    }
    args.push(code.slice(start, i - 1));
    sites.push({
      args: args.map((a) => a.trim()).filter((a) => a !== ""),
      isDeclaration: at[1] !== undefined,
    });
  }
  return sites;
}

test("each ensureStream call site in the source names its own replica variable", () => {
  // Everything above calls `ensureStream` directly with a number, which holds
  // that the reconciliation is correct and nothing at all about the number it
  // is given. `initNats` is where that number is chosen, and it needs a live
  // NATS connection -- it connects, opens a JetStream manager and provisions
  // the consumer and four buckets before it returns -- so there is no seam to
  // assert the two calls through. That leaves the source, as with the
  // tombstone bucket's `retentionMeasured` below.
  //
  // What this holds: in the code of that file, comments removed, there is one
  // `ensureStream` call per stream and each ends in the replica variable
  // belonging to its own stream -- so the count is neither a hardcoded 1 (the
  // JetStream default that put PRIMUS_CLAW_TASKS on a single server and turned
  // one lost pod into four and a half hours of 503 on POST /sessions) nor the
  // other stream's setting. What it does not hold -- and the name says the same
  // thing -- is that `initNats` runs at all, that these are the calls it
  // reaches, or that the number the variable carries arrives at the server
  // intact: both calls inside `if (false)` would satisfy it. It is a reading of
  // the wiring, better than the text search it replaces only in that prose can
  // no longer satisfy it and a wrapped argument can no longer break it. The
  // fallback chain behind each variable is pinned behaviourally in
  // config-nats-replicas.test.ts.
  //
  // Read by the replica parameter's position rather than as the last argument:
  // it was last until `maxMsgs` was added behind it, and "last" is a property of
  // the signature rather than of the thing being checked.
  const src = readFileSync(fileURLToPath(new URL("../src/infra/nats.ts", import.meta.url)), "utf-8");
  const sites = ensureStreamSites(src);
  const declaration = sites.find((s) => s.isDeclaration);
  assert.ok(declaration, "the parameter list is what gives the positions below meaning");
  const replicaIndex = declaration.args.findIndex((p) => /^replicas\b/.test(p));
  assert.notEqual(replicaIndex, -1, "the replica count is still its own parameter");
  const calls = sites.filter((s) => !s.isDeclaration).map((s) => s.args);

  const taskCalls = calls.filter((args) => args[1] === "TASK_STREAM");
  const eventCalls = calls.filter((args) => args[1] === "EVENT_STREAM");
  const dispatchCalls = calls.filter((args) => args[1] === "DISPATCH_STREAM");

  assert.equal(taskCalls.length, 1,
    "exactly one call site creates the task stream, or the one being read here "
    + "is not the one start-up runs");
  assert.equal(taskCalls[0][replicaIndex], "TASK_STREAM_REPLICAS",
    "this is the stream the outage was on, so a literal in the last argument is "
    + "the defect reappearing exactly as it was; EVENT_STREAM_REPLICAS here is "
    + "the quieter version -- both settings fall back to NATS_REPLICAS, so in a "
    + "default deployment the swap changes nothing and only the operator who "
    + "raised TASK_STREAM_REPLICAS after the outage finds out, when the stream "
    + "they were told to fix does not move");

  assert.equal(eventCalls.length, 1,
    "and exactly one creates the event stream");
  assert.equal(eventCalls[0][replicaIndex], "EVENT_STREAM_REPLICAS",
    "an event stream on one server loses session history to the same lost pod, "
    + "and there is nothing to rebuild it from");

  assert.equal(dispatchCalls.length, 1,
    "and exactly one creates the dispatch stream");
  assert.equal(dispatchCalls[0][replicaIndex], "DISPATCH_STREAM_REPLICAS",
    "the dispatcher's events are the record of what was dispatched; on one "
    + "server they go with the pod");
});

test("no ensureStream call site can leave the replica count to a default", () => {
  // The test above knows the two streams that exist today by name, which is the
  // whole of its reach: a third stream added tomorrow the way the first two were
  // originally written --
  //
  //   await ensureStream(jsm, "PRIMUS_CLAW_AUDIT", ["audit.>"], retentionNs);
  //
  // -- is the 2026-09-01 outage verbatim in a new stream, and it neither is nor
  // filters as TASK_STREAM or EVENT_STREAM. What makes that line compile at all
  // is a default on the parameter, which is exactly how the field went missing
  // the first time; requiring the argument is what forces a new call site to say
  // what it wants, and requiredness is a property of the declaration, so both
  // halves are read here. This is quantified over whatever the file contains
  // rather than over the two names, so it closes over streams that do not exist
  // yet.
  const src = readFileSync(fileURLToPath(new URL("../src/infra/nats.ts", import.meta.url)), "utf-8");
  const sites = ensureStreamSites(src);
  const declarations = sites.filter((s) => s.isDeclaration);
  const calls = sites.filter((s) => !s.isDeclaration);

  assert.equal(declarations.length, 1,
    "one declaration, or the parameter list being read is not the one the calls "
    + "below are checked against");
  const params = declarations[0].args;

  // `=(?!>)` rather than a bare `=`: an arrow type in a parameter -- none today --
  // is not a default value, and reading one as such would fail a correct list.
  assert.deepEqual(params.filter((p) => /=(?!>)/.test(p)), [],
    "a defaulted parameter is a call site that never has to mention it, which is "
    + "how PRIMUS_CLAW_TASKS came to be created at the JetStream default of one "
    + "replica and stayed there until a pod went away");

  const replicaIndex = params.findIndex((p) => /^replicas\b/.test(p));
  assert.notEqual(replicaIndex, -1,
    "the replica count is still a parameter of its own and not folded into an "
    + "options object this scan would read as one argument");

  assert.ok(calls.length >= 2,
    `the scan found ${calls.length} call sites, so the loop below would pass on `
    + "an empty list -- both streams are provisioned in initNats");
  for (const { args } of calls) {
    const named = args[1] ?? "(unnamed)";
    const arg = args[replicaIndex];
    assert.ok(arg !== undefined,
      `${named} is created by a call that stops short of the replica count, so `
      + "the stream lands on one server and one lost pod takes its subject down");
    assert.match(arg, /_REPLICAS$/,
      `${named} passes ${arg} where the replica count goes: a literal is a count `
      + "no operator can change, and NATS_REPLICAS itself skips the per-stream "
      + "override the deployment documents");
  }
});

test("a stream created without a duplicate window does not get one", async () => {
  // The event stream. Setting one there would cost the server the dedup index
  // for a publish path that carries no message ids.
  const { mgr, added } = manager(null);

  await ensureStream(mgr, "PRIMUS_CLAW_EVENTS", ["events.>"], 24 * HOUR_NS, 0, 3);

  assert.equal("duplicate_window" in added[0], false);
});

// ===== what has to cover the stream asks the stream =====

test("the retention read back is the one the stream has, not the one the code wants", async () => {
  // The whole reason for reading it. `ensureStream` above leaves a wider stream
  // alone, so on a cluster kept for a month the constant is a month out of date --
  // and the tombstone TTL derived from it expires while the events it answers for
  // are still being delivered.
  const { mgr } = manager({ max_age: 30 * 24 * HOUR_NS, duplicate_window: 0, num_replicas: 3 });

  assert.deepEqual(
    await readEventStreamRetentionMs(mgr),
    { retentionMs: 30 * 24 * HOUR_MS, measured: true },
  );
});

test("a stream that never expires is reported as having no retention at all", async () => {
  // Not as zero milliseconds, which is what a number would have to mean here and
  // is the opposite of what NATS spells with it. A caller sizing a TTL has to be
  // able to tell "no window" from "an empty window".
  const { mgr } = manager({ max_age: 0, duplicate_window: 0, num_replicas: 3 });

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
