// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox that can place a model-issued process under its own identity.
 *
 * Every spawn is refused where the sandbox cannot, which is the whole point of
 * the boundary and also the state a bare test process is in: no `hidepid` on
 * `/proc`, no configured identity range. So a fixture whose subject is
 * something else -- ownership, counts, waits -- says here that its sandbox
 * provides the boundary, exactly as a real one declares it.
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

/** A sandbox that can provide neither half, so every spawn is refused. */
export function unisolatedSandbox(): void {
  bindSandboxIsolation({
    identityRange: () => null,
    partitionsProcessView: () => false,
  });
}

export function releaseSandboxIsolation(): void {
  bindSandboxIsolation(null);
}
