// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A replica count of zero is refused, replaced with a working one, and said
 * out loud.
 *
 * `{ min: 1 }` on each of these settings is the whole guard. Zero is not "no
 * redundancy" -- `num_replicas: 0` is an invalid stream and bucket config, so
 * JetStream rejects the create outright and the API exits while provisioning,
 * before it has served a request. The floor is what turns a typo in
 * primus-claw-secrets into a deployment that starts.
 *
 * Nothing else in the suite can see that floor. Every other replica test leaves
 * these keys blank, and `readIntSetting` returns null for a blank value before
 * `min` is ever compared against anything, so the caller's fallback is handed
 * back and the bounds are never consulted. Deleting `{ min: 1 }` from any of
 * these lines is therefore a change the rest of the package stays green
 * through; a value that is actually out of range is the only thing that sees
 * it, and this file is the only process that supplies one.
 *
 * Two separate outcomes, both asserted, because a silent fallback and a
 * reported one are different products. The value has to come out as the
 * working default, or the deployment does not start. And the refusal has to
 * reach `envSettingProblems()` -- the list `validateStartupConfig()` logs --
 * because a zero somebody typed is a zero they meant something by: a process
 * running happily at 3 while the Secret says 0 teaches the next reader that
 * the setting does nothing.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic import, as in config-blank-env.test.ts. The
 * single-node and default-install configurations need different values for
 * these same keys, so they are their own processes, in
 * config-nats-replicas.test.ts and config-nats-replicas-blank.test.ts.
 *
 * Coverage:
 *   R5 a zero replica count falls back to the working default instead of being taken literally
 *   R6 and every refusal is reported, naming the range and the value used instead
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PG_INT4_MAX } from "@claw/utils";

// One mistyped line in primus-claw-secrets, applied to every object this
// process creates: the deployment-wide default and all five per-object
// overrides. Each is refused on its own bound, so a floor missing from any one
// line shows up as that one setting coming out as 0.
process.env.NATS_REPLICAS = "0";
process.env.TASK_STREAM_REPLICAS = "0";
process.env.EVENT_STREAM_REPLICAS = "0";
process.env.BRAIN_REGISTRY_REPLICAS = "0";
process.env.BRAIN_CHECKPOINTS_REPLICAS = "0";
process.env.SYSTEM_ENV_REPLICAS = "0";

const {
  NATS_REPLICAS, TASK_STREAM_REPLICAS, EVENT_STREAM_REPLICAS,
  BRAIN_REGISTRY_REPLICAS, BRAIN_CHECKPOINTS_REPLICAS, SYSTEM_ENV_REPLICAS,
  envSettingProblems,
} = await import("../src/config.js");

/** The keys above, in the order config evaluates them. */
const REFUSED_KEYS = [
  "NATS_REPLICAS", "BRAIN_REGISTRY_REPLICAS", "BRAIN_CHECKPOINTS_REPLICAS",
  "SYSTEM_ENV_REPLICAS", "TASK_STREAM_REPLICAS", "EVENT_STREAM_REPLICAS",
];

test("R5 a zero replica count falls back to the working default instead of being taken literally", () => {
  assert.equal(NATS_REPLICAS, 3,
    "0 replicas is a config JetStream rejects, and this is the number every "
    + "object below inherits, so taking it literally is an API that exits "
    + "while provisioning its first stream");
  assert.equal(TASK_STREAM_REPLICAS, 3,
    "the task stream is the one the 2026-09-01 outage was on; a create it "
    + "refuses is a deployment that never reaches POST /sessions at all");
  assert.equal(EVENT_STREAM_REPLICAS, 3,
    "and the event stream is created first, so it is the object the start-up dies on");
  assert.deepEqual(
    { BRAIN_REGISTRY_REPLICAS, BRAIN_CHECKPOINTS_REPLICAS, SYSTEM_ENV_REPLICAS },
    { BRAIN_REGISTRY_REPLICAS: 3, BRAIN_CHECKPOINTS_REPLICAS: 3, SYSTEM_ENV_REPLICAS: 3 },
    "the buckets carry the same floor: js.views.kv with replicas: 0 is refused "
    + "exactly as flatly as a stream is",
  );
});

test("R6 every refused replica count is reported, naming the range and the value used instead", () => {
  // The half a fallback alone does not cover. Startup logs this list, and it
  // is the only place an operator learns that the count their Secret asks for
  // is not the count their cluster is running -- otherwise the objects come up
  // at 3, everything looks healthy, and the setting reads as inert.
  for (const key of REFUSED_KEYS) {
    assert.deepEqual(
      envSettingProblems().filter((p) => p.startsWith(`${key}=`)),
      [`${key}=0 is outside the usable range 1..${PG_INT4_MAX}; using 3`],
      `${key}=0 has to be reported exactly once, and say both what was refused `
      + `and what the process is running on instead`,
    );
  }
});
