// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A timing setting an operator reads as "off" must not be taken literally, and
 * neither must one that is merely tiny.
 *
 * Zero is the natural way to try to disable a heartbeat, and none of the four
 * renewal settings here can be disabled: `setInterval(fn, 0)` is one lock
 * renewal, one lease POST, or one delivery beat per event-loop turn per run, so
 * a pod configured that way spends itself on NATS and on the API instead of
 * stopping. The ratio checks at startup are no answer: a zero interval
 * satisfies every one of them, since zero times three fits inside any TTL and
 * any beat at all is well inside ack_wait. The one case they would notice, a
 * lease TTL under three heartbeats, they only log: the value takes effect
 * anyway, leases are written with it, and the API derives its reap grace from
 * it. So the bound has to live on the setting, where a refused value is
 * reported and the default is kept.
 *
 * The two tool ceilings are here for the second half of that argument rather
 * than the first. Zero is not "no limit" for them either: the RPC deadline is
 * the granted timeout plus transport slack, so a ceiling of zero grants every
 * call the slack alone and one below minus the slack grants a deadline the MCP
 * client reads as already expired. Same shape, same remedy -- refuse it where
 * it is read, and say so.
 *
 * The bound has to exclude the failure rather than the number, which is why
 * these tests are about magnitude. At `LOCK_REFRESH_INTERVAL_MS=1` the pod
 * issues a thousand KV renewals a second per run: the same loop by a different
 * spelling, and a floor of 1 admits it. Each value fed in below therefore sits
 * above zero and under the floor of its own setting, so a floor that regressed
 * to 1 would fail these tests rather than pass them.
 *
 * Env vars are set before config is imported because it reads each of them once
 * at module scope; hence the dynamic import below rather than a static one.
 *
 * Coverage:
 *   C1 a value under the floor is refused rather than applied
 *   C2 each refusal is reported by name, with the floor it fell under
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MIN_RENEWAL_INTERVAL_MS, RUN_LEASE_HEARTBEATS_PER_TTL } from "@claw/protocol";

/**
 * What each setting must stay above, and a value that does not.
 *
 * The floors are read from the protocol rather than restated, because the point
 * of the tests is that one number bounds every renewal: a copy here would still
 * pass with the settings pinned to a different one.
 *
 * The lease TTL's floor is the renewal floor times the renewals a lease has to
 * cover, rather than a second number of its own: the TTL exists to be proved by
 * heartbeats, so the shortest one worth writing is the one a lease renewed as
 * fast as it may be renewed can still prove liveness inside.
 */
const BOUNDED = {
  LOCK_REFRESH_INTERVAL_MS: { floor: MIN_RENEWAL_INTERVAL_MS, refused: "1" },
  RUN_LEASE_HEARTBEAT_MS: {
    floor: MIN_RENEWAL_INTERVAL_MS,
    refused: String(MIN_RENEWAL_INTERVAL_MS - 1),
  },
  DELIVERY_HEARTBEAT_MS: { floor: MIN_RENEWAL_INTERVAL_MS, refused: "2" },
  RUN_LEASE_TTL_MS: {
    floor: MIN_RENEWAL_INTERVAL_MS * RUN_LEASE_HEARTBEATS_PER_TTL,
    refused: String(MIN_RENEWAL_INTERVAL_MS * RUN_LEASE_HEARTBEATS_PER_TTL - 1),
  },
  // In seconds, and floored at 1 rather than at a renewal interval: what a zero
  // breaks here is the deadline built from it, not a loop.
  BASH_MAX_TIMEOUT_SEC: { floor: 1, refused: "0" },
  WAIT_MAX_SEC: { floor: 1, refused: "0" },
  HANDS_ENV_FILE_WAIT_SEC: { floor: 1, refused: "0" },
  MAX_CONCURRENT: { floor: 1, refused: "0" },
  // MAX_CONCURRENT's fallback is this setting's min when both are unusable.
  MAX_RESIDENT: { floor: 3, refused: "0" },
};
for (const [key, { refused }] of Object.entries(BOUNDED)) process.env[key] = refused;

const {
  LOCK_REFRESH_INTERVAL_MS, RUN_LEASE_HEARTBEAT_MS, RUN_LEASE_TTL_MS,
  DELIVERY_HEARTBEAT_MS, BASH_FOREGROUND_MAX_SEC, WAIT_MAX_SEC,
  HANDS_ENV_FILE_WAIT_SEC, MAX_CONCURRENT, MAX_RESIDENT, envSettingProblems,
} = await import("../src/config.js");

test("C1 a value under the floor is refused rather than applied", () => {
  assert.ok(LOCK_REFRESH_INTERVAL_MS >= BOUNDED.LOCK_REFRESH_INTERVAL_MS.floor,
    "a lock renewed a thousand times a second is not a lock refresh");
  assert.ok(RUN_LEASE_HEARTBEAT_MS >= BOUNDED.RUN_LEASE_HEARTBEAT_MS.floor,
    "nor is a lease POST a millisecond under the shared floor a heartbeat");
  assert.ok(DELIVERY_HEARTBEAT_MS >= BOUNDED.DELIVERY_HEARTBEAT_MS.floor,
    "nor is a working() publish five hundred times a second a progress report");
  assert.ok(RUN_LEASE_TTL_MS >= BOUNDED.RUN_LEASE_TTL_MS.floor,
    "and a lease that short has expired by about the time the row is written");
  assert.ok(BASH_FOREGROUND_MAX_SEC >= BOUNDED.BASH_MAX_TIMEOUT_SEC.floor,
    "a ceiling of zero grants every command the transport slack and nothing else");
  assert.ok(WAIT_MAX_SEC >= BOUNDED.WAIT_MAX_SEC.floor,
    "and a wait that may not wait is not a wait");
  assert.ok(HANDS_ENV_FILE_WAIT_SEC >= BOUNDED.HANDS_ENV_FILE_WAIT_SEC.floor,
    "zero does not turn the env-file guard off; it is refused and the default kept");
  assert.ok(MAX_CONCURRENT >= BOUNDED.MAX_CONCURRENT.floor,
    "zero concurrent tasks is not a ceiling, it is a constructor throw at import");
  assert.ok(MAX_RESIDENT >= MAX_CONCURRENT,
    "a resident ceiling below the execution ceiling is the other constructor throw");
});

test("C2 each refusal is reported by name, with the floor it fell under", () => {
  const problems = envSettingProblems().join("\n");
  for (const [key, { floor, refused }] of Object.entries(BOUNDED)) {
    // The floor in the sentence the operator reads, because a bound that moved
    // silently leaves them retuning against a number nothing states.
    assert.match(
      problems,
      new RegExp(`${key}=${refused} [^\\n]*\\b${floor}\\.\\.`),
      `a setting that was configured and then ignored has to say so, and say the `
      + `range it missed: ${key}`,
    );
  }
});
