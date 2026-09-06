// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The keepalive settings that have to hold together before any sandbox is
 * provisioned, checked once at startup rather than degraded at run time.
 *
 * Two of them are a pair with no safe middle. `SANDBOX_KEEPALIVE_INTERVAL_SEC`
 * at or below zero disables the probe-and-ping sweep outright, and
 * `BG_SHELL_ENABLED` is what makes background dispatch available at all -- so in
 * combination nothing refreshes a sandbox hosting live background work and the
 * guarantee that an active shell holds off idle reclaim is unenforceable. There
 * is no partial mode in which it holds, so the configuration is refused.
 *
 * The rest are capacity data. A ceiling nobody declared cannot be the value a
 * deferral count was proven at, and reading an undeclared one as absent would
 * license any fleet size at all against a reclaim that still happens.
 */

export interface CapacitySettings {
  ceiling: number;
  reconciliationReserve: number;
}

export interface CapacityInput {
  bgShellEnabled: boolean;
  keepaliveIntervalSec: number;
  /** Raw, because "declared" is the question and an empty string is not one. */
  targetCeiling: string;
  reconcileReserve: string;
}

/** Refused at startup, naming the settings and their values. */
export class KeepaliveConfigRefused extends Error {}

function requirePositiveInteger(name: string, raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new KeepaliveConfigRefused(
      `${name} is undeclared. It has no default: the keepalive relation is `
      + "proven against it before the sweep starts, so a number nobody declared "
      + "cannot stand in for one.",
    );
  }
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new KeepaliveConfigRefused(
      `${name}=${trimmed} is not a positive integer, and is never coerced to one.`,
    );
  }
  return Number(trimmed);
}

export function validateKeepaliveCapacity(input: CapacityInput): CapacitySettings {
  if (input.bgShellEnabled && input.keepaliveIntervalSec <= 0) {
    throw new KeepaliveConfigRefused(
      `BG_SHELL_ENABLED=true with SANDBOX_KEEPALIVE_INTERVAL_SEC=${input.keepaliveIntervalSec}: `
      + "nothing would refresh a sandbox hosting live background work, so an "
      + "active shell could not hold off idle reclaim. No default interval is "
      + "substituted for the rejected one.",
    );
  }
  if (!input.bgShellEnabled) {
    return { ceiling: 0, reconciliationReserve: 0 };
  }

  const ceiling = requirePositiveInteger("SANDBOX_KEEPALIVE_TARGET_CEILING", input.targetCeiling);
  const reserve = requirePositiveInteger(
    "SANDBOX_KEEPALIVE_RECONCILE_RESERVE", input.reconcileReserve,
  );
  if (reserve >= ceiling) {
    throw new KeepaliveConfigRefused(
      `SANDBOX_KEEPALIVE_RECONCILE_RESERVE=${reserve} leaves no ordinary admission `
      + `below SANDBOX_KEEPALIVE_TARGET_CEILING=${ceiling}.`,
    );
  }
  return { ceiling, reconciliationReserve: reserve };
}
