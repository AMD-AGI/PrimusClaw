// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox that can place a model-issued process under its own identity.
 *
 * A bare test process declares no identity range, which is the disclosed state
 * in which spawns proceed under Hands' own identity and say so. A fixture whose
 * subject is something else -- ownership, counts, waits -- declares the boundary
 * here instead, exactly as a real sandbox does, so what it asserts is asserted
 * against the enforced path rather than the fallback.
 *
 * The range is real where the test process can allocate from one, so the
 * identity separation those tests assert is the genuine article rather than a
 * stand-in. Elsewhere it is this process's own id, which spawns but separates
 * nothing -- and no test asserting separation uses that case.
 */
import { bindSandboxIsolation } from "../../src/runtime/child-privilege.js";

const UNPRIVILEGED_RANGE = { min: 65500, max: 65533 };

export function isolatingSandbox(): void {
  const uid = process.getuid?.() ?? 0;
  bindSandboxIsolation({
    identityRange: () => (uid === 0 ? UNPRIVILEGED_RANGE : { min: uid, max: uid }),
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
