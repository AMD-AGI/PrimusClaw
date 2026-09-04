// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A CHECKPOINT_WRITE_VERSION nobody can honour is refused BY NAME, so startup
 * can stop instead of writing a format nobody chose.
 *
 * `envInt(..., { min: 3, max: 4 })` does not clamp: an out-of-range value is
 * recorded as a problem and the FALLBACK is returned. So `5` -- a plausible
 * typo for someone rolling forward -- does not become 4. It becomes 3, the
 * weaker format, on a pod whose values file says the operator asked for
 * sealing. `2` reads as a request for a format that no longer exists and lands
 * on 3 the same way. Neither is a setting that failed loudly; both are a
 * setting that appears to have been obeyed.
 *
 * That is why this refusal is separated from the rest by
 * `envSettingRefused()`. Most refused settings are worth logging and
 * surviving; this one decides whether conversations are sealed or merely
 * redacted, and `validateStartupConfig()` exits on it. This file asserts the
 * predicate that exit is wired to -- for the value, for the fallback it came
 * back as, and for the fact that an untouched setting does not trip it.
 *
 * Env is set before the import because config reads each key once at module
 * scope; hence the dynamic import, as in the sibling config tests.
 *
 * Coverage:
 *   C1 an out-of-range version is refused, not clamped, and comes back as the default
 *   C2 the refusal is attributable to CHECKPOINT_WRITE_VERSION specifically
 *   C3 a setting nobody touched is not reported as refused
 */
import test from "node:test";
import assert from "node:assert/strict";

// Rolling forward past the last format there is. The pod would otherwise start
// on 3 and write redacted plaintext while the operator believes it seals.
process.env.CHECKPOINT_WRITE_VERSION = "5";

const { CHECKPOINT_WRITE_VERSION, envSettingProblems, envSettingRefused } =
  await import("../src/config.js");

test("C1 an out-of-range checkpoint version falls back rather than clamping", () => {
  assert.equal(
    CHECKPOINT_WRITE_VERSION, 3,
    "5 must not become 4: readIntSetting refuses out-of-range values and returns the fallback",
  );
});

test("C2 the refusal names CHECKPOINT_WRITE_VERSION, so startup can exit on it", () => {
  assert.equal(
    envSettingRefused("CHECKPOINT_WRITE_VERSION"), true,
    "validateStartupConfig() exits on this predicate; without it the pod runs on a format nobody chose",
  );
  const problems = envSettingProblems().filter(
    (p) => p.startsWith("CHECKPOINT_WRITE_VERSION="),
  );
  assert.equal(problems.length, 1, `expected exactly one refusal, got ${JSON.stringify(problems)}`);
  assert.match(
    problems[0]!, /outside the usable range 3\.\.4/,
    "the operator has to be told which range was enforced, and what ran instead",
  );
});

test("C3 a setting that was never set is not a refusal", () => {
  assert.equal(
    envSettingRefused("CHECKPOINT_TTL_MS"), false,
    "prefix matching must not fire on settings nobody configured, or every pod fails to start",
  );
});
