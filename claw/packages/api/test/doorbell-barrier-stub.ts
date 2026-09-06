// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two answers the publisher barrier can give, as a substitution for the
 * port both dispatch suites already replace.
 *
 * A token rather than a boolean because a closed gate is not immediately a
 * quiet one: a dispatch that read the gate open is still able to publish until
 * it releases, and that is what a rollback must be able to observe.
 */

/** The barrier issuing tokens. */
export function openDoorbellBarrier(): { release: () => void } {
  return { release() {} };
}

/** The barrier closed: every dispatch takes the fat path. */
export function closedDoorbellBarrier(): null {
  return null;
}
