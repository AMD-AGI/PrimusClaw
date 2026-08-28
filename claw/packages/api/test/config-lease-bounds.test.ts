// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The lease timings are one setting read by two processes, so one value has to
 * mean one thing on both sides.
 *
 * `RUN_LEASE_TTL_MS` and `RUN_LEASE_HEARTBEAT_MS` come out of the same secret
 * for brain and for this process, which is what keeps the worker that renews a
 * lease and the reaper that judges it talking about the same lease. Brain
 * refuses a value below the floor a renewal implies and keeps the shared
 * default; read unbounded here, `RUN_LEASE_TTL_MS=0` gave brain 45s and this
 * process a literal zero, which is then the leaseTtlMs the reap grace is derived
 * from -- a verdict computed against a lease no row ever carries.
 *
 * Env vars are set before config is imported because it reads each of them once
 * at module scope; hence the dynamic import below.
 *
 * Coverage:
 *   L1 a value under the floor is refused and the shared default kept
 *   L2 the refusal is reported by name, with the floor it fell under
 *   L3 the grace is derived from the default rather than from the refused value
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUN_LEASE_HEARTBEAT_MS,
  DEFAULT_RUN_LEASE_TTL_MS,
  MIN_RENEWAL_INTERVAL_MS,
  resolveLeaseReapGraceSec,
  RUN_LEASE_HEARTBEATS_PER_TTL,
} from "@claw/protocol";

process.env.RUN_LEASE_TTL_MS = "0";
process.env.RUN_LEASE_HEARTBEAT_MS = "1";

const {
  RUN_LEASE_TTL_MS, RUN_LEASE_HEARTBEAT_MS, LEASE_LOST_GRACE_SEC,
  BRAIN_REGISTRY_TTL_MS, TASK_SWEEPER_TICK_MS, TASK_MAX_DELIVER,
  envSettingProblems,
} = await import("../src/config.js");

test("L1 a value under the floor is refused and the shared default kept", () => {
  assert.equal(RUN_LEASE_TTL_MS, DEFAULT_RUN_LEASE_TTL_MS,
    "the two processes only agree while they fall back to the same default");
  assert.equal(RUN_LEASE_HEARTBEAT_MS, DEFAULT_RUN_LEASE_HEARTBEAT_MS);
});

test("L2 the refusal is reported by name, with the floor it fell under", () => {
  const problems = envSettingProblems().join("\n");
  assert.match(
    problems,
    new RegExp(`RUN_LEASE_TTL_MS=0 [^\\n]*\\b${MIN_RENEWAL_INTERVAL_MS * RUN_LEASE_HEARTBEATS_PER_TTL}\\.\\.`),
    "a lease has to cover the renewals it promises, so its floor is that product",
  );
  assert.match(
    problems,
    new RegExp(`RUN_LEASE_HEARTBEAT_MS=1 [^\\n]*\\b${MIN_RENEWAL_INTERVAL_MS}\\.\\.`),
    "a renewal is a round trip, so a millisecond apart is not a schedule",
  );
});

test("L3 the grace is derived from the default rather than from the refused value", () => {
  // The setting is not where the damage was. The grace subtracts the lease TTL
  // and adds the heartbeat, so refused values reaching the derivation put the
  // reaper's verdict a whole lease away from the timing the worker is actually
  // renewing on -- with every startup check passing, because they are all asked
  // about these same drifted numbers.
  const shared = {
    lockTtlMs: BRAIN_REGISTRY_TTL_MS,
    sweeperTickMs: TASK_SWEEPER_TICK_MS,
    maxDeliver: TASK_MAX_DELIVER,
  };
  assert.equal(
    LEASE_LOST_GRACE_SEC,
    resolveLeaseReapGraceSec({
      ...shared,
      leaseTtlMs: DEFAULT_RUN_LEASE_TTL_MS,
      heartbeatMs: DEFAULT_RUN_LEASE_HEARTBEAT_MS,
    }),
    "the grace must describe the lease brain is writing, which is the default one",
  );
  assert.notEqual(
    LEASE_LOST_GRACE_SEC,
    resolveLeaseReapGraceSec({ ...shared, leaseTtlMs: 0, heartbeatMs: 1 }),
    "and the refused values must not be what it was computed from",
  );
});
