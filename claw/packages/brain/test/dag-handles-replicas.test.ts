// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one bucket brain creates for itself is created with the operator's
 * replica count, not with a number that happens to match it today.
 *
 * DAG_HANDLES holds the handle rows every `sandbox.use` resolves through, and
 * brain opens it with `js.views.kv(...)` at boot. Opened without options it
 * takes the JetStream default of a single replica, so one server owns those
 * rows: when that server goes away, `sandbox.use` cannot find a handle its own
 * DAG wrote minutes earlier and the downstream nodes fail with a workload that
 * is still running. That is the 2026-09-01 outage one bucket over -- there it
 * was PRIMUS_CLAW_TASKS at one replica, `js.publish` answering NO_RESPONDERS
 * (surfaced by nats.js as the bare code "503"), and four and a half hours of
 * POST /sessions returning 503.
 *
 * Why the option can only be passed at this call, and why that makes it worth a
 * test of its own: `views.kv` on a bucket that already exists attaches to it and
 * ignores the options entirely, so the first open in a cluster's life is the one
 * and only chance to set the replica count. The API side repairs that kind of
 * drift for the buckets it owns, in `ensureKvBucket`; brain reconciles nothing
 * -- it opens this bucket at boot and never revisits its config -- so a
 * DAG_HANDLES bucket first created at one replica stays at one replica for the
 * life of the cluster and no restart can correct it. Nothing else in the repo
 * names DAG_HANDLES, which is what let the options object go missing in the
 * first place.
 *
 * The environment below is what gives the assertion teeth. With nothing set,
 * `DAG_HANDLES_REPLICAS`, `NATS_REPLICAS` and the literal 3 in config all
 * resolve to the same number, so a call site rewritten to any one of them --
 * including a hard-coded `{ replicas: 3 }` -- still passes. This file therefore
 * configures the bucket at a count that no other expression at that call site
 * can produce: 5 for the bucket, a different 2 deployment-wide, against a code
 * default of 3. An operator who sets DAG_HANDLES_REPLICAS=1 for a single-node
 * server and is ignored gets err 10074 at boot, and per the paragraph above
 * that bucket cannot be corrected afterwards.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic imports, as in config-nats-replicas.test.ts.
 *
 * Coverage:
 *   D1 the bucket is opened by name, with a replicas option carrying the configured value
 *   D2 the second call reuses the memoised map instead of opening the bucket again
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { JetStreamClient } from "nats";

import { makeKv } from "./nats-kv-stub.js";

// Three distinct counts, so the assertion below can only be satisfied by the
// setting that owns this bucket: 5 is what DAG_HANDLES_REPLICAS resolves to, 2
// is what NATS_REPLICAS would give, and 3 is the literal default in config.
// Five is the most replicas JetStream will serve.
process.env.DAG_HANDLES_REPLICAS = "5";
process.env.NATS_REPLICAS = "2";

const { initDagHandles } = await import("../src/sandbox/handles.js");

/** What DAG_HANDLES_REPLICAS=5 above has to arrive at the call site as. */
const CONFIGURED_REPLICAS = 5;

/**
 * A JetStream client that records what `views.kv` was asked for. Recording the
 * options rather than inspecting a bucket afterwards, because on a real server
 * the options are exactly what is dropped when the bucket already exists -- the
 * question here is what brain asked for, not what it ended up attached to.
 */
function client(): { js: JetStreamClient; opens: Array<{ name: string; opts?: { replicas?: number } }> } {
  const opens: Array<{ name: string; opts?: { replicas?: number } }> = [];
  const js = {
    views: {
      kv: async (name: string, opts?: { replicas?: number }) => {
        opens.push({ name, opts });
        return makeKv();
      },
    },
  } as unknown as JetStreamClient;
  return { js, opens };
}

const { js, opens } = client();

test("D1 the dag-handles bucket is opened with the configured replica count", async () => {
  await initDagHandles(js);

  assert.equal(opens.length, 1, "boot binds the bucket exactly once");
  assert.equal(opens[0].name, "DAG_HANDLES",
    "brain's own `sandbox.use` lookups are this bucket's only readers and no "
    + "other process in the repo opens it, so this call is the only place its "
    + "replica count can ever be set");

  // A missing options object is precisely the bug: `js.views.kv(BUCKET)` reads
  // as complete code and creates a single-replica bucket.
  const opts = opens[0].opts;
  assert.notEqual(opts, undefined,
    "views.kv called with no options creates the bucket at the JetStream default of one replica");
  assert.notEqual(opts!.replicas, undefined,
    "an options object without `replicas` is the same single-replica bucket");

  // The env above makes this literal reachable only through
  // DAG_HANDLES_REPLICAS: the code default would arrive as 3 and NATS_REPLICAS
  // as 2, so a call site that passes either constant, or a hard-coded number,
  // fails here rather than agreeing with itself.
  assert.equal(opts!.replicas, CONFIGURED_REPLICAS,
    "what the operator configured for this bucket -- DAG_HANDLES_REPLICAS, "
    + "above the deployment-wide NATS_REPLICAS -- is what has to arrive here, "
    + "on the one call in a cluster's life that can set the count");
});

test("D2 a second init reuses the bound map rather than opening the bucket again", async () => {
  // The memoisation is why D1 is the whole story: every later caller gets the
  // cached map, so the replica count is decided once per process and, because
  // `views.kv` ignores options on an existing bucket, once per cluster.
  const first = await initDagHandles(js);
  const second = await initDagHandles(js);

  assert.equal(second, first,
    "every later caller in this pod resolves handles through the map the first "
    + "init bound, so that one open decides the count for the whole process");
  assert.equal(opens.length, 1,
    "a second open would be a second bucket binding per pod, and on a real "
    + "server it would silently ignore the replicas option it passed");
});
