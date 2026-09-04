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
 * Two shapes reached v3 the same silent way after the out-of-range case was
 * closed, because neither one was a refusal at all: `3.5` was TRUNCATED to 3,
 * and a blank -- what a Helm value that failed to render leaves behind -- was
 * read as "nobody set this" and took the default 3. Both then made
 * `envSettingRefused()` false, so the exit below never fired and the pod wrote
 * redacted plaintext under a values file that says 4. Each is imported into
 * its own module instance (the `?v=` query) because config reads its keys once
 * at module scope.
 *
 * Coverage:
 *   C1 an out-of-range version is refused, not clamped, and comes back as the default
 *   C2 the refusal is attributable to CHECKPOINT_WRITE_VERSION specifically
 *   C3 a setting nobody touched is not reported as refused
 *   C4 a fractional version is refused, not truncated to the format below it
 *   C5 a blank version is refused, not read as an unset setting
 *   C6 an unset version is still the default, and still not a refusal
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

// Each of these needs config evaluated afresh, so each gets its own module
// instance. Sequential rather than parallel: they share process.env.
process.env.CHECKPOINT_WRITE_VERSION = "3.5";
const fractional = await import("../src/config.js?cwv=fractional");

process.env.CHECKPOINT_WRITE_VERSION = "";
const blank = await import("../src/config.js?cwv=blank");

delete process.env.CHECKPOINT_WRITE_VERSION;
const unset = await import("../src/config.js?cwv=unset");

test("C4 a fractional checkpoint version is refused, not truncated to 3", () => {
  assert.equal(
    fractional.envSettingRefused("CHECKPOINT_WRITE_VERSION"), true,
    "3.5 truncated silently to 3 -- the weaker format -- on a pod whose values file asked for sealing",
  );
  const [problem] = fractional.envSettingProblems().filter(
    (p) => p.startsWith("CHECKPOINT_WRITE_VERSION="),
  );
  assert.match(
    problem!, /is not a whole number/,
    "the operator has to be told the value was not one of the two formats, not that it was out of range",
  );
});

test("C5 a blank checkpoint version is refused, not read as unset", () => {
  assert.equal(
    blank.envSettingRefused("CHECKPOINT_WRITE_VERSION"), true,
    "a Helm value that rendered empty is a setting that failed, not a setting nobody made",
  );
  const [problem] = blank.envSettingProblems().filter(
    (p) => p.startsWith("CHECKPOINT_WRITE_VERSION="),
  );
  assert.match(problem!, /is blank/);
});

test("C6 an unset checkpoint version is the default, and not a refusal", () => {
  assert.equal(
    unset.CHECKPOINT_WRITE_VERSION, 3,
    "the documented default has to survive: most deployments never set this",
  );
  assert.equal(
    unset.envSettingRefused("CHECKPOINT_WRITE_VERSION"), false,
    "refusing an unset setting would stop every pod that never configured it",
  );
});
