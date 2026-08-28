// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A key left empty in `.env` is a key nobody set, not a setting whose value is
 * the empty string.
 *
 * `.env.example` is meant to be copied to `.env` verbatim, and it deliberately
 * leaves entries blank -- its own banner promises "everything below has a
 * working default in code". `start-all.sh` then does `set -a; source .env`,
 * which EXPORTS every one of those blank keys. So the documented quick start
 * hands this process `BRAIN_CHECKPOINTS_BUCKET=""` and `BRAIN_REGISTRY_BUCKET=""`
 * -- present, empty -- and `??` substitutes a fallback only for `undefined`.
 *
 * The outcome that made this a release blocker is not "a helper returned a
 * string". It is that `index.ts` opens its KV handles as
 * `js.views.kv(BRAIN_REGISTRY_BUCKET)`, so an empty name asks NATS for a bucket
 * that cannot exist and was never created, and the pod dies during startup on
 * the configuration the README told the reader to use. What the assertions
 * below therefore check is that the names still come out as the buckets the API
 * actually creates.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic import, as in config-timing-bounds.test.ts.
 *
 * Coverage:
 *   B1 blank bucket names resolve to the buckets api/src/infra/nats.ts creates
 *   B2 blank is unset for every env() setting, not just the two buckets
 *   B3 env(), envBool() and envInt() agree about what a blank value means
 *   B4 a blank setting is absent, so startup does not report it as a typo
 */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * The names api/src/infra/nats.ts creates the KV buckets under. Restated rather
 * than imported because brain does not depend on the api package; that file
 * carries the matching "Must match brain/src/config.ts mirror values" note.
 */
const API_CREATES = {
  BRAIN_REGISTRY_BUCKET: "BRAIN_REGISTRY",
  BRAIN_CHECKPOINTS_BUCKET: "BRAIN_CHECKPOINTS",
  SYSTEM_ENV_BUCKET: "SYSTEM_ENV",
};

// Exactly what `set -a; source .env` does with a blank line in the file. The
// surrounding whitespace is deliberate: a key set to spaces is the same absent
// setting, and trim() runs before the fallback decision.
process.env.BRAIN_CHECKPOINTS_BUCKET = "";
process.env.BRAIN_REGISTRY_BUCKET = "  ";
process.env.SYSTEM_ENV_BUCKET = "";
process.env.USER_ID = "";
process.env.MAX_CONCURRENT = "";
process.env.BG_SHELL_ENABLED = "";
process.env.RUN_GATE_KEY = "";

const { pickLockKey } = await import("../src/tasks/lock.js");
const {
  BRAIN_REGISTRY_BUCKET, BRAIN_CHECKPOINTS_BUCKET, SYSTEM_ENV_BUCKET,
  USER_ID, MAX_CONCURRENT, RUN_GATE_KEY, RUN_GATE_KEY_CONFIGURED,
  envSettingProblems,
} = await import("../src/config.js");

test("B1 blank bucket names resolve to the buckets api/src/infra/nats.ts creates", () => {
  assert.equal(BRAIN_REGISTRY_BUCKET, API_CREATES.BRAIN_REGISTRY_BUCKET,
    "js.views.kv('') is not a registry; the quick start's blank .env line must "
    + "still attach brain to the bucket the API created");
  assert.equal(BRAIN_CHECKPOINTS_BUCKET, API_CREATES.BRAIN_CHECKPOINTS_BUCKET,
    "and a checkpoint bucket named '' loses every task's state at startup");
  assert.equal(SYSTEM_ENV_BUCKET, API_CREATES.SYSTEM_ENV_BUCKET,
    "same bucket, same mirror, same blank line in .env.example");
});

test("B2 blank is unset for every env() setting, not just the two buckets", () => {
  // The defect was in env() itself, so pinning only the buckets would leave the
  // next setting somebody blanks free to regress.
  assert.equal(USER_ID, "default",
    "an owner of '' is not an owner; every path keyed on USER_ID would collide");
});

test("B3 env(), envBool() and envInt() agree about what a blank value means", () => {
  // envInt already reads blank as absent (utils readIntSetting returns null for
  // it) and envBool already does `if (!v) return fallback`. env() reading it as
  // a configured empty string made one file answer the same question two ways.
  assert.equal(MAX_CONCURRENT, 3, "envInt: blank is an absent setting");
  assert.equal(
    envSettingProblems().filter((p) => p.startsWith("MAX_CONCURRENT=")).length,
    0,
    "and an absent setting is not a refused one, so it is not reported",
  );
});

test("B4 a blank setting is absent, so startup does not report it as a typo", async () => {
  // index.ts logs startup.run_gate_key_unrecognised whenever the raw value and
  // the resolved one differ, and tells the operator the setting "must be
  // workspace or session". Under `??` a blank line in .env made every quick
  // start emit that error about a key nobody had set -- and the gate it names
  // is the one that stops two runs writing one directory, so it is the last
  // error anyone should learn to scroll past.
  assert.equal(RUN_GATE_KEY, "workspace", "the safe key, as when the var is absent");
  assert.equal(RUN_GATE_KEY_CONFIGURED, RUN_GATE_KEY,
    "and nothing was configured, so boot has nothing to report");

  const request = {
    session_id: "sess-1", message_id: "msg-1", prompt: "hello", history: [],
    user_id: "u1", files_workspace_id: "kws_1",
  } as unknown as import("@claw/protocol").ExecuteRequest;
  assert.equal(pickLockKey(request), "ws.kws_1",
    "the outcome that matters: the gate still keys on the workspace");
});
