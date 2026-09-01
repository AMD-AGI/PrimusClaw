// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One variable has to be enough to make a whole deployment single-replica.
 *
 * `NATS_REPLICAS` is the deployment-wide default every stream and bucket falls
 * back to, and the local quick start is the reason it exists: a single
 * `nats-server -js` is not clustered, JetStream answers a replicas>1 request
 * there with err 10074, and the API exits while provisioning. The README tells
 * the reader to set one variable. If any of the five per-object settings kept
 * its own hardcoded 3 instead of falling back to this one, that reader's API
 * would still die -- on whichever object was missed, with an error naming a
 * variable they did set correctly.
 *
 * The fallback chain is the thing being pinned, not the numbers: writing
 * `envInt("TASK_STREAM_REPLICAS", 3, { min: 1 })` again is a one-token change
 * that nothing else in the suite notices, because every other test that touches
 * replicas passes the count to `ensureStream` as a literal.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic import, as in config-blank-env.test.ts. This
 * process is the single-node configuration and holds nothing else -- the
 * clustered-default and per-object-override cases need different values for
 * these same keys, so they live in config-nats-replicas-blank.test.ts, and the
 * count that is out of range altogether lives in
 * config-nats-replicas-refused.test.ts.
 *
 * Coverage:
 *   R1 NATS_REPLICAS reaches both streams
 *   R2 NATS_REPLICAS reaches all three KV buckets this process creates
 */
import test from "node:test";
import assert from "node:assert/strict";

// The one line the quick start asks for. The per-object keys are blank on
// purpose: that is what `set -a; source .env` exports from a copied
// `.env.example`, so this is the configuration a local reader actually runs,
// not an artificially empty environment.
process.env.NATS_REPLICAS = "1";
process.env.TASK_STREAM_REPLICAS = "";
process.env.EVENT_STREAM_REPLICAS = "";
process.env.BRAIN_REGISTRY_REPLICAS = "";
process.env.BRAIN_CHECKPOINTS_REPLICAS = "";
process.env.SYSTEM_ENV_REPLICAS = "";

const {
  NATS_REPLICAS, TASK_STREAM_REPLICAS, EVENT_STREAM_REPLICAS,
  BRAIN_REGISTRY_REPLICAS, BRAIN_CHECKPOINTS_REPLICAS, SYSTEM_ENV_REPLICAS,
} = await import("../src/config.js");

test("R1 NATS_REPLICAS reaches both streams", () => {
  assert.equal(NATS_REPLICAS, 1, "the value under test, or the rest proves nothing");
  assert.equal(TASK_STREAM_REPLICAS, 1,
    "a task stream that ignores NATS_REPLICAS asks a non-clustered server for "
    + "three and takes the local API down at startup");
  assert.equal(EVENT_STREAM_REPLICAS, 1,
    "and the event stream is created first, so it fails before the task stream "
    + "is even reached");
});

test("R2 NATS_REPLICAS reaches all three KV buckets this process creates", () => {
  // These three were the objects that already had per-object variables, which
  // is exactly how one of them comes to keep a literal while the others are
  // rewired: the edit that adds the fallback has five places to land.
  assert.equal(BRAIN_REGISTRY_REPLICAS, 1,
    "js.views.kv refuses replicas>1 on a single node the same way a stream does");
  assert.equal(BRAIN_CHECKPOINTS_REPLICAS, 1);
  assert.equal(SYSTEM_ENV_REPLICAS, 1);
});
