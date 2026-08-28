// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A key left empty in `.env` is a key nobody set, not a setting whose value is
 * the empty string.
 *
 * `.env.example` is meant to be copied to `.env` verbatim and deliberately
 * leaves entries blank -- its own banner promises "everything below has a
 * working default in code". `start-all.sh` then runs `set -a; source .env`,
 * which EXPORTS every blank key, so this process is handed `S3_BUCKET=""`
 * rather than an absent `S3_BUCKET` the moment an operator clears the line.
 * `??` substitutes a fallback only for `undefined`, so the promised default
 * never applied.
 *
 * The outcome, not the mechanism: an empty bucket name is not a bucket. Every
 * `PutObject` this process issues names `S3_BUCKET`, and S3 rejects an empty
 * one, so uploads fail for the whole deployment while the config screen shows
 * a setting that "has a default". The memory model is the same shape one level
 * down -- a blank `MEMORY_LLM_MODEL` has to reach `DEFAULT_MODEL`, or the
 * memory summariser posts completions with no model at all.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic import, as in config-lease-bounds.test.ts.
 *
 * Coverage:
 *   E1 a blank bucket setting resolves to the bucket the default names
 *   E2 a blank setting falls through a chained default rather than stopping it
 *   E3 blank is unset for env() the way it already is for envBool()/envInt()
 */
import test from "node:test";
import assert from "node:assert/strict";

// Exactly what `set -a; source .env` does with a blank line. The whitespace is
// deliberate: a key set to spaces is the same absent setting, because trim()
// runs before the fallback decision.
process.env.S3_BUCKET = "";
process.env.S3_REGION = "  ";
process.env.S3_PLUGINS_BUCKET = "";
process.env.DEFAULT_MODEL = "claude-sonnet-4-20250514";
process.env.MEMORY_LLM_MODEL = "";
process.env.NATS_URL = "";
process.env.APP_ENV = "";
process.env.UPLOAD_TTL_DAYS = "";

const {
  S3_BUCKET, S3_REGION, S3_PLUGINS_BUCKET, MEMORY_LLM_MODEL, NATS_URL, APP_ENV,
  UPLOAD_TTL_DAYS, envSettingProblems,
} = await import("../src/config.js");

test("E1 a blank bucket setting resolves to the bucket the default names", () => {
  assert.equal(S3_BUCKET, "claw",
    "'' is not a bucket: every PutObject naming it is rejected, so a cleared "
    + "line in .env takes the deployment's uploads down");
  assert.equal(S3_PLUGINS_BUCKET, "plugins",
    "and the plugin store is the same call with a different name");
  assert.equal(S3_REGION, "us",
    "a blank region is signed into the request and refused just as flatly");
});

test("E2 a blank setting falls through a chained default rather than stopping it", () => {
  assert.equal(MEMORY_LLM_MODEL, "claude-sonnet-4-20250514",
    "env(a, env(b, ...)) only chains while blank counts as unset; otherwise the "
    + "memory summariser posts a completion with an empty model");
  assert.equal(NATS_URL, "nats://localhost:4222",
    "and an empty NATS_URL is not localhost, it is a connect() with no server");
  assert.equal(APP_ENV, "production",
    "APP_ENV gates startup validation; '' is neither production nor dev");
});

test("E3 blank is unset for env() the way it already is for envBool()/envInt()", () => {
  // envInt defers to utils readIntSetting, which documents blank as "an absent
  // setting"; envBool does `if (!v) return fallback`. env() treating blank as a
  // configured empty string made one file answer the same question two ways.
  assert.equal(UPLOAD_TTL_DAYS, 7, "envInt: blank is an absent setting");
  assert.equal(
    envSettingProblems().filter((p) => p.startsWith("UPLOAD_TTL_DAYS=")).length,
    0,
    "and an absent setting is not a refused one, so it is not reported",
  );
});
