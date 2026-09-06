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

const DECLARED = { targetCeiling: "200", reconcileReserve: "20" };

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
    { ceiling: 0, reconciliationReserve: 0 },
    "with background shells off there is no ceiling to hold and no work to protect",
  );
  assert.deepEqual(
    validateKeepaliveCapacity({ bgShellEnabled: true, keepaliveIntervalSec: 60, ...DECLARED }),
    { ceiling: 200, reconciliationReserve: 20 },
  );
});

test("an undeclared, non-integer or non-positive ceiling is refused, never defaulted", () => {
  for (const targetCeiling of ["", "   ", "abc", "0", "-5", "1.5", "200x"]) {
    assert.throws(
      () => validateKeepaliveCapacity({
        bgShellEnabled: true, keepaliveIntervalSec: 60,
        targetCeiling, reconcileReserve: "20",
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
        bgShellEnabled: true, keepaliveIntervalSec: 60,
        targetCeiling: "200", reconcileReserve,
      }),
      /SANDBOX_KEEPALIVE_RECONCILE_RESERVE/,
      JSON.stringify(reconcileReserve),
    );
  }
});

test("a reserve that swallows the ceiling leaves no ordinary admission", () => {
  assert.throws(
    () => validateKeepaliveCapacity({
      bgShellEnabled: true, keepaliveIntervalSec: 60,
      targetCeiling: "20", reconcileReserve: "20",
    }),
    /leaves no ordinary admission/,
  );
});
