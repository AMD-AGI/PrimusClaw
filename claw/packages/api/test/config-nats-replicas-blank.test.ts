// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a deployment that sets nothing gets, and what one object saying
 * otherwise gets.
 *
 * `NATS_REPLICAS` is blank in almost every real deployment: `.env.example`
 * ships it empty and `start-all.sh` runs `set -a; source .env`, which EXPORTS
 * the blank key; the Helm chart's `secret.natsReplicas` defaults to `""` and
 * the template quotes it into the Secret unconditionally. So "blank" is the
 * default installation, not an edge case, and what it resolves to is the
 * replica count of every stream and bucket in production.
 *
 * The outcome, not the mechanism: resolve it to 1 and every default install
 * provisions PRIMUS_CLAW_TASKS on exactly one server -- the state that caused
 * the 2026-09-01 outage, where the server hosting `tasks.>` went away, publish
 * returned NO_RESPONDERS (surfaced as the bare code "503") and POST /sessions
 * answered 503 for four and a half hours. 3 -- the code default, matching the
 * clustered NATS the chart installs -- is the only working answer, and it has
 * to survive an empty string rather than only an absent key.
 *
 * The per-object override is here too because it is the same fallback chain
 * read from the other end: it exists so a cluster can give one object a
 * different count without moving the deployment-wide default, and an
 * implementation that read only `NATS_REPLICAS` would satisfy every assertion
 * about defaults while silently discarding what an operator asked for.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic import, as in config-blank-env.test.ts. The
 * single-node case needs different values for these same keys and so is its own
 * process, in config-nats-replicas.test.ts. Blank never reaches the `{ min: 1 }`
 * floor on these settings -- `readIntSetting` returns the caller's fallback
 * before any bound is compared -- so the out-of-range case is a third process
 * again, in config-nats-replicas-refused.test.ts.
 *
 * Coverage:
 *   R3 a blank deployment-wide default is the code default of 3, not 0 or 1
 *   R4 an object told its own count keeps it
 */
import test from "node:test";
import assert from "node:assert/strict";

// Exactly what a default Helm install and a copied `.env.example` hand this
// process. The whitespace on one key is deliberate: a key set to spaces is the
// same absent setting, because trim() runs before the fallback decision.
process.env.NATS_REPLICAS = "";
process.env.TASK_STREAM_REPLICAS = "  ";
process.env.BRAIN_REGISTRY_REPLICAS = "";
process.env.BRAIN_CHECKPOINTS_REPLICAS = "";
process.env.SYSTEM_ENV_REPLICAS = "";
// The one object this deployment is opinionated about.
process.env.EVENT_STREAM_REPLICAS = "5";

const {
  NATS_REPLICAS, TASK_STREAM_REPLICAS, EVENT_STREAM_REPLICAS,
  BRAIN_REGISTRY_REPLICAS, BRAIN_CHECKPOINTS_REPLICAS, SYSTEM_ENV_REPLICAS,
} = await import("../src/config.js");

test("R3 a blank deployment-wide default is the code default of 3, not 0 or 1", () => {
  assert.equal(NATS_REPLICAS, 3,
    "the chart writes this key empty, so a blank read as anything but the code "
    + "default is what every default installation runs on");
  assert.equal(TASK_STREAM_REPLICAS, 3,
    "one replica here is the 2026-09-01 outage: the single server hosting "
    + "tasks.> goes away and every POST /sessions answers 503");
  assert.equal(BRAIN_REGISTRY_REPLICAS, 3);
  assert.equal(BRAIN_CHECKPOINTS_REPLICAS, 3);
  assert.equal(SYSTEM_ENV_REPLICAS, 3,
    "the last of the buckets on the same blank line, and the one nobody would "
    + "think to check: a start-up reads SYSTEM_ENV once, so a single-server "
    + "bucket looks fine until a pod restarts while that server is gone");
});

test("R4 an object told its own count keeps it", () => {
  assert.equal(EVENT_STREAM_REPLICAS, 5,
    "the per-object names are the ones operators already had; a chain that "
    + "read only NATS_REPLICAS would drop what they set and say nothing");
});
