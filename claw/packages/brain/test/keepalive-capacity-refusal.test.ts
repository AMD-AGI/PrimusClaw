// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The keepalive configuration is refused at startup, not degraded at run time.
 *
 * With background shells on and no sweep, nothing refreshes a sandbox hosting
 * live background work, so the guarantee that an active shell holds off idle
 * reclaim is unenforceable -- and there is no partial mode in which it holds.
 * The capacity settings are the same shape of problem: the deferral count every
 * handle's refresh gap is derived from is proven against a declared ceiling
 * before the sweep starts, so reading an undeclared one as absent would license
 * any fleet size at all against a reclaim that still happens.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  KeepaliveConfigRefused, validateKeepaliveCapacity,
} from "../src/sandbox/keepalive-capacity.js";

/** A fleet whose refresh gap clears its reclaim with room to spare. */
const DECLARED = {
  targetCeiling: "200", reconcileReserve: "20",
  idleDeadlineSec: "3600", pingsPerSweep: 64, sweepSpanSec: 300,
  provisioningCeilingSec: 3600, pingPhaseCeilingSec: 150,
};

test("background shells with the sweep disabled is refused, naming both settings", () => {
  for (const interval of [0, -1]) {
    assert.throws(
      () => validateKeepaliveCapacity({
        bgShellEnabled: true, keepaliveIntervalSec: interval, ...DECLARED,
      }),
      (err: unknown) => err instanceof KeepaliveConfigRefused
        && /BG_SHELL_ENABLED=true/.test(err.message)
        && new RegExp(`SANDBOX_KEEPALIVE_INTERVAL_SEC=${interval}`).test(err.message),
      `interval ${interval}`,
    );
  }
});

test("no path substitutes a default interval for the rejected one", () => {
  assert.throws(
    () => validateKeepaliveCapacity({ bgShellEnabled: true, keepaliveIntervalSec: 0, ...DECLARED }),
    /No default interval is substituted/,
  );
});

test("either half alone starts normally", () => {
  assert.deepEqual(
    validateKeepaliveCapacity({ bgShellEnabled: false, keepaliveIntervalSec: 0, ...DECLARED }),
    { ceiling: 0, reconciliationReserve: 0, deferralCount: 0, activityGapSec: 0, reclaimHorizonMs: 0 },
    "with background shells off there is no ceiling to hold and no work to protect",
  );
  const proven = validateKeepaliveCapacity({
    bgShellEnabled: true, keepaliveIntervalSec: 60, ...DECLARED,
  });
  assert.equal(proven.ceiling, 200);
  assert.equal(proven.reconciliationReserve, 20);
  assert.equal(proven.deferralCount, Math.ceil(200 / 64) - 1, "D = ceil(N_max / C) - 1");
  assert.ok(proven.activityGapSec < 3600, "and the gap it implies clears the reclaim");
});

test("an undeclared, non-integer or non-positive ceiling is refused, never defaulted", () => {
  for (const targetCeiling of ["", "   ", "abc", "0", "-5", "1.5", "200x"]) {
    assert.throws(
      () => validateKeepaliveCapacity({
        ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60, targetCeiling,
      }),
      /SANDBOX_KEEPALIVE_TARGET_CEILING/,
      JSON.stringify(targetCeiling),
    );
  }
});

test("an undeclared or zero reconciliation reserve is refused", () => {
  // Without a reserve, reconciliation has no slots to take and an un-admitted
  // target -- which is either working or unaccounted for -- goes unpinged.
  for (const reconcileReserve of ["", "0", "-1"]) {
    assert.throws(
      () => validateKeepaliveCapacity({
        ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60, reconcileReserve,
      }),
      /SANDBOX_KEEPALIVE_RECONCILE_RESERVE/,
      JSON.stringify(reconcileReserve),
    );
  }
});

test("a reserve that swallows the ceiling leaves no ordinary admission", () => {
  assert.throws(
    () => validateKeepaliveCapacity({
      ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60,
      targetCeiling: "20", reconcileReserve: "20",
    }),
    /leaves no ordinary admission/,
  );
});

test("a ceiling whose deferral count breaks the refresh gap is refused", () => {
  // The relation the ceiling exists to make provable, and the one thing none of
  // the checks above were testing: a fleet this large waits too many sweeps,
  // and a sandbox holding a live shell is reclaimed while waiting.
  assert.throws(
    () => validateKeepaliveCapacity({
      ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60,
      targetCeiling: "20000", idleDeadlineSec: "3600",
    }),
    (err: unknown) => err instanceof KeepaliveConfigRefused
      && /deferral/.test(err.message)
      && /not under the 3600s reclaim/.test(err.message),
  );
});

test("equality with the reclaim is a breach, not a fit", () => {
  // One ceiling under the boundary starts; the one that lands exactly on it
  // does not, because a gap equal to the deadline is a gap that loses.
  const atBoundary = (deadline: number) => validateKeepaliveCapacity({
    ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60,
    targetCeiling: "64", pingsPerSweep: 64, sweepSpanSec: 30, pingPhaseCeilingSec: 10,
    idleDeadlineSec: String(deadline),
  });
  // D = 0, so the gap is 1*60 + 2*30 = 120s.
  assert.equal(atBoundary(121).activityGapSec, 120);
  assert.throws(() => atBoundary(120), KeepaliveConfigRefused);
});

test("an undeclared reclaim deadline is refused rather than read as absent", () => {
  // Reading an unnameable deadline as absent licenses any interval at all
  // against a reclaim that still happens.
  for (const idleDeadlineSec of ["", "   ", "0", "abc"]) {
    assert.throws(
      () => validateKeepaliveCapacity({
        ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60, idleDeadlineSec,
      }),
      /SANDBOX_KEEPALIVE_IDLE_DEADLINE_SEC/,
      JSON.stringify(idleDeadlineSec),
    );
  }
});

test("the reclaim horizon is derived to exceed the provisioning ceiling", () => {
  // The design pins the relation, not the number: a slot released while its
  // sandbox is still being provisioned is a live sandbox holding none, which is
  // the un-slotted target the ceiling exists to prevent. A fixed horizon beside
  // a configurable ceiling cannot hold that.
  for (const provisioningCeilingSec of [600, 3600, 3 * 3600]) {
    const proven = validateKeepaliveCapacity({
      ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60, provisioningCeilingSec,
    });
    assert.ok(proven.reclaimHorizonMs > provisioningCeilingSec * 1000,
      `horizon ${proven.reclaimHorizonMs}ms does not exceed a ${provisioningCeilingSec}s ceiling`);
    assert.ok(proven.reclaimHorizonMs > DECLARED.sweepSpanSec * 1000,
      "and it exceeds one sweep span too");
  }
});

test("an unbounded provisioning ceiling is refused, since no horizon can exceed it", () => {
  assert.throws(
    () => validateKeepaliveCapacity({
      ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60, provisioningCeilingSec: 0,
    }),
    (err: unknown) => err instanceof KeepaliveConfigRefused
      && /unbounded/.test(err.message)
      && /still being provisioned/.test(err.message),
  );
});

test("a sweep span that does not cover a whole tick's worst case is refused", () => {
  // The span is what every refresh gap is derived from, so one the sweep
  // routinely exceeds makes every gap short -- and short by exactly the amount
  // that matters, since the overrun is a phase that ran long. The worst case is
  // the ping phase and the failure handling behind it, each with its own
  // budget, which is what keeps it independent of how many targets failed.
  assert.throws(
    () => validateKeepaliveCapacity({
      ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60,
      sweepSpanSec: 120, pingPhaseCeilingSec: 210,
    }),
    (err: unknown) => err instanceof KeepaliveConfigRefused
      && /does not cover a sweep's/.test(err.message),
  );
  assert.doesNotThrow(() => validateKeepaliveCapacity({
    ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60,
    sweepSpanSec: 300, pingPhaseCeilingSec: 210,
  }));
});

test("the declared span default covers this build's own worst case", async () => {
  // The relation has to hold for the values that actually ship, not only for
  // the ones a test picks.
  const { SANDBOX_KEEPALIVE_SWEEP_SPAN_SEC } = await import("../src/config.js");
  const { keepaliveSweepCeilingSec } = await import("../src/sandbox/keepalive.js");
  assert.ok(SANDBOX_KEEPALIVE_SWEEP_SPAN_SEC > keepaliveSweepCeilingSec(),
    `the shipped span ${SANDBOX_KEEPALIVE_SWEEP_SPAN_SEC}s does not cover a worst-case `
      + `tick of ${keepaliveSweepCeilingSec()}s`);
});
