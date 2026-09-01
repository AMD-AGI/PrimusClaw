// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A replica count of zero is refused, replaced with a working one, and said
 * out loud.
 *
 * `{ min: 1 }` on these two settings is the whole guard. Zero is not "no
 * redundancy" -- a KV bucket asked for `replicas: 0` is an invalid config that
 * JetStream rejects, so brain dies opening DAG_HANDLES and no task is ever
 * claimed. That bucket is also the one brain creates rather than attaches to,
 * and `views.kv` ignores options on a bucket that already exists, so the floor
 * is guarding the single call in a cluster's life that decides the count.
 *
 * Nothing else in the package can see that floor. Every other replica test
 * leaves these keys blank or absent, and `readIntSetting` returns null for
 * both before `min` is compared against anything, so the caller's fallback
 * comes back and the bounds are never consulted -- deleting `{ min: 1 }` from
 * either line is a change the rest of the suite stays green through. A value
 * genuinely out of range is the only thing that reaches the comparison, and
 * this file is the only process that supplies one.
 *
 * Two separate outcomes, both asserted, because a silent fallback and a
 * reported one are different products. The count has to come out as something
 * JetStream will serve, or brain does not boot. And the refusal has to reach
 * `envSettingProblems()` -- the list startup validation logs -- because a zero
 * somebody typed is a zero they meant something by: brain running at 3 while
 * primus-claw-secrets says 0 teaches the next reader the setting is inert.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic import, as in config-blank-env.test.ts. The
 * single-node and default-install configurations need different values for
 * these same keys and so are their own processes, in
 * config-nats-replicas.test.ts and config-nats-replicas-blank.test.ts.
 *
 * Coverage:
 *   R5 a zero replica count falls back to the working default instead of being taken literally
 *   R6 and both refusals are reported, naming the range and the value used instead
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PG_INT4_MAX } from "@claw/utils";

// One mistyped line in primus-claw-secrets, in both spellings an operator can
// write it: the deployment-wide default, and the bucket's own override. Each
// is refused on its own bound, so a floor missing from either line shows up as
// that one setting coming out as 0.
process.env.NATS_REPLICAS = "0";
process.env.DAG_HANDLES_REPLICAS = "0";

const { NATS_REPLICAS, DAG_HANDLES_REPLICAS, envSettingProblems } = await import("../src/config.js");

test("R5 a zero replica count falls back to the working default instead of being taken literally", () => {
  assert.equal(NATS_REPLICAS, 3,
    "0 replicas is a config JetStream rejects, and this is the number every "
    + "bucket brain reads falls back to, so taking it literally is a pod that "
    + "cannot finish booting");
  assert.equal(DAG_HANDLES_REPLICAS, 3,
    "DAG_HANDLES is opened at this count on the one call that can ever set it, "
    + "so a 0 reaching js.views.kv is a bucket that is never created and a "
    + "sandbox.use that has no handles to resolve through");
});

test("R6 both refused replica counts are reported, naming the range and the value used instead", () => {
  // The half a fallback alone does not cover. Startup logs this list, and it
  // is the only place an operator learns that the count their Secret asks for
  // is not the count brain is running -- otherwise the bucket comes up at 3,
  // everything looks healthy, and the setting reads as decoration.
  for (const key of ["NATS_REPLICAS", "DAG_HANDLES_REPLICAS"]) {
    assert.deepEqual(
      envSettingProblems().filter((p) => p.startsWith(`${key}=`)),
      [`${key}=0 is outside the usable range 1..${PG_INT4_MAX}; using 3`],
      `${key}=0 has to be reported exactly once, and say both what was refused `
      + `and what brain is running on instead`,
    );
  }
});
