// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The lifetime knob has to reach whichever backend is actually in use.
//
// CLAW_DEPLOY_MODE picks the provider -- "kubernetes" gets agent-sandbox, every
// other value including unset falls to safe-workload -- and the knob was wired
// to agent-sandbox only. On a `safe` deployment, setting
// AGENT_SANDBOX_MAX_SESSION_DURATION=48h left every Sandbox on the 24h that
// SANDBOX_DEFAULT_TIMEOUT_SECONDS put there: no error, no warning, the setting
// simply did not exist on that path.
//
// SaFE's `timeout` is seconds from dispatch, which is the same quantity
// agent-sandbox calls maxSessionDuration, so that is where it goes. Its idle
// counterpart has nowhere to go and deliberately stays unwired -- see the note
// on workloadTimeoutSeconds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { workloadTimeoutSeconds } from "../src/sandbox/safe-workload-provider.js";
import { goDurationNs, goDurationSeconds } from "../src/config.js";
import {
  SANDBOX_DEFAULT_TIMEOUT_SECONDS,
  AGENT_SANDBOX_MAX_SESSION_SECONDS,
  AGENT_SANDBOX_MAX_SESSION_DURATION,
} from "../src/config.js";

const HOUR = 3600;

test("the configured ceiling is what the workload gets", () => {
  assert.equal(workloadTimeoutSeconds(undefined, 48 * HOUR), 48 * HOUR);
});

test("no ceiling configured leaves the existing default alone", () => {
  assert.equal(
    workloadTimeoutSeconds(undefined, null),
    SANDBOX_DEFAULT_TIMEOUT_SECONDS,
    "a deployment that configured nothing must render exactly what it did before",
  );
});

test("an explicit run deadline is honoured, buffer and all", () => {
  assert.equal(
    workloadTimeoutSeconds(600, 48 * HOUR),
    600 + HOUR,
    "a caller naming a deadline is describing this run; the extra hour is the "
      + "room the platform needs to stop it cleanly at that deadline",
  );
});

test("a deadline longer than the ceiling is clamped to it", () => {
  // A maximum that any caller can walk past by naming a timeout is a default
  // wearing a ceiling's name.
  assert.equal(
    workloadTimeoutSeconds(72 * HOUR, 48 * HOUR),
    48 * HOUR,
    "the deployment said 48h; the run does not get 73",
  );
});

test("with no ceiling a deadline is not clamped", () => {
  assert.equal(workloadTimeoutSeconds(72 * HOUR, null), 72 * HOUR + HOUR);
});

test("the ceiling does not get the shutdown buffer", () => {
  // The hour is room to stop a run that hit its deadline. A ceiling is already
  // the final answer to how long the sandbox may exist, so adding to it would
  // hand out more than was asked for.
  assert.equal(workloadTimeoutSeconds(undefined, 48 * HOUR), 48 * HOUR);
  assert.notEqual(workloadTimeoutSeconds(undefined, 48 * HOUR), 48 * HOUR + HOUR);
});

test("a refused value reaches this path as no ceiling, not as a bad one", () => {
  // Validation lives in config: a value that is not a positive Go duration is
  // reported into envSettingProblems and resolves to empty, so both providers
  // see "unset" rather than each inventing their own fallback. What must not
  // happen is this path quietly parsing the raw string itself.
  if (AGENT_SANDBOX_MAX_SESSION_DURATION === "") {
    assert.equal(AGENT_SANDBOX_MAX_SESSION_SECONDS, null);
  } else {
    assert.equal(typeof AGENT_SANDBOX_MAX_SESSION_SECONDS, "number");
    assert.ok((AGENT_SANDBOX_MAX_SESSION_SECONDS as number) > 0);
  }
});

test("the seconds value is derived from the same parse, not a second one", () => {
  // Two parsers is two answers. This is the property that keeps the Go-duration
  // rules -- truncation, overflow, the units Go accepts -- from having to be
  // reimplemented for a backend that wants seconds.
  if (AGENT_SANDBOX_MAX_SESSION_DURATION) {
    assert.notEqual(AGENT_SANDBOX_MAX_SESSION_SECONDS, null,
      "a value good enough for the string form must be good enough for seconds");
  }
});

test("a sub-second ceiling becomes one second, not none", () => {
  // SaFE reads timeout=0 as "no timeout at all", so truncating a very short
  // duration downwards turns the tightest possible ceiling into the absence of
  // one -- the opposite of what was configured.
  assert.equal(goDurationSeconds(goDurationNs("500ms") as bigint), 1);
  assert.equal(goDurationSeconds(goDurationNs("1ns") as bigint), 1);
});

test("whole seconds are not rounded up past themselves", () => {
  assert.equal(goDurationSeconds(goDurationNs("48h") as bigint), 48 * HOUR);
  assert.equal(goDurationSeconds(goDurationNs("90s") as bigint), 90);
  assert.equal(goDurationSeconds(goDurationNs("1500ms") as bigint), 1,
    "truncation is right above the floor: 1.5s of lifetime is 1s, not 2");
});
