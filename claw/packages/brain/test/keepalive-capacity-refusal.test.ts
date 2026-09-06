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
  idleDeadlineSec: "900", pingsPerSweep: 64, sweepSpanSec: 30,
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
    { ceiling: 0, reconciliationReserve: 0, deferralCount: 0, activityGapSec: 0 },
    "with background shells off there is no ceiling to hold and no work to protect",
  );
  const proven = validateKeepaliveCapacity({
    bgShellEnabled: true, keepaliveIntervalSec: 60, ...DECLARED,
  });
  assert.equal(proven.ceiling, 200);
  assert.equal(proven.reconciliationReserve, 20);
  assert.equal(proven.deferralCount, Math.ceil(200 / 64) - 1, "D = ceil(N_max / C) - 1");
  assert.ok(proven.activityGapSec < 900, "and the gap it implies clears the reclaim");
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
      targetCeiling: "20000", idleDeadlineSec: "900",
    }),
    (err: unknown) => err instanceof KeepaliveConfigRefused
      && /deferral/.test(err.message)
      && /not under the 900s reclaim/.test(err.message),
  );
});

test("equality with the reclaim is a breach, not a fit", () => {
  // One ceiling under the boundary starts; the one that lands exactly on it
  // does not, because a gap equal to the deadline is a gap that loses.
  const atBoundary = (deadline: number) => validateKeepaliveCapacity({
    ...DECLARED, bgShellEnabled: true, keepaliveIntervalSec: 60,
    targetCeiling: "64", pingsPerSweep: 64, sweepSpanSec: 30,
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
