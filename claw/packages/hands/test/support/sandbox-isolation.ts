// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox that can place a model-issued process under its own identity.
 *
 * A bare test process declares no identity range, which is the disclosed state
 * in which spawns proceed under Hands' own identity and say so. A fixture whose
 * subject is something else -- ownership, counts, waits -- declares the boundary
 * here instead, exactly as a real sandbox does.
 *
 * Only where this process can actually assume another identity, which is where
 * it is privileged. Elsewhere the declaration would be one the runtime cannot
 * honour, and honouring it is the whole contract: a declared range refuses the
 * spawn rather than serving it under Hands' own. A fixture asserting the
 * allocation itself binds its own range and never spawns.
 */
import { bindSandboxIsolation } from "../../src/runtime/child-privilege.js";

const UNPRIVILEGED_RANGE = { min: 65500, max: 65533 };

export function isolatingSandbox(): void {
  const privileged = (process.getuid?.() ?? 0) === 0;
  bindSandboxIsolation({
    identityRange: () => (privileged ? UNPRIVILEGED_RANGE : null),
    partitionsProcessView: () => true,
  });
}

/** A sandbox declaring no baseline: spawns proceed and report themselves. */
export function unisolatedSandbox(): void {
  bindSandboxIsolation({
    identityRange: () => null,
    partitionsProcessView: () => false,
  });
}

export function releaseSandboxIsolation(): void {
  bindSandboxIsolation(null);
}
