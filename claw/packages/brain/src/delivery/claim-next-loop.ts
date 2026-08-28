// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How an idle pod takes work that never rang a doorbell.
 *
 * The doorbell is a wakeup for a run that may start now. Soft-limit overflow
 * never publishes one: the row sits at `queued` until a replica with a free
 * slot asks. This loop is that ask. It holds a gate slot only for the claim
 * and the run, never for the idle sleep, so a pod waiting for work does not
 * look full to the delivery path. The loop does not wait for a claimed run to
 * finish before asking again: each run holds its own slot, and free slots keep
 * claiming.
 */

import type { ClaimedRun } from "../clients/run-claim.js";

export interface ClaimNextLoopDeps {
  enabled: boolean;
  idleMs: number;
  /**
   * Whether this pod is currently refusing new work, for any reason. Asked
   * once per cycle, so a pod that stops draining starts claiming again.
   */
  isDraining: () => boolean;
  /**
   * Whether this pod is on its way out. Separate from {@link isDraining}
   * because only this one is terminal — see {@link startClaimNextLoop}.
   */
  isShuttingDown: () => boolean;
  gate: { acquire(): Promise<void>; release(): void; admissible(): boolean };
  claimNext: () => Promise<ClaimedRun | null>;
  handle: (claimed: ClaimedRun) => Promise<void>;
  onError: (err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type ClaimNextOutcome = "idle" | "ran" | "draining";

export async function runClaimNextCycle(deps: ClaimNextLoopDeps): Promise<ClaimNextOutcome> {
  if (deps.isDraining()) return "draining";
  if (!deps.gate.admissible()) return "idle";
  await deps.gate.acquire();
  let handedOff = false;
  try {
    if (deps.isDraining()) return "draining";
    const claimed = await deps.claimNext();
    if (!claimed) return "idle";
    handedOff = true;
    void Promise.resolve(deps.handle(claimed)).catch(deps.onError).finally(() => deps.gate.release());
    return "ran";
  } finally {
    if (!handedOff) deps.gate.release();
  }
}

/**
 * Poll until shutdown. A drain pauses the loop; it does not end it.
 *
 * The exit condition is shutdown alone, never `isDraining()`. It was the
 * latter, back when a drain could only be entered and the pod was expected to
 * die in it, and both the `while` test and the `"draining"` break were a
 * one-way door. The version drain is now reversible, and this loop is started
 * exactly once from main(), so nothing restored it: a pod that released its
 * drain resumed taking deliveries -- delivery-dispatch re-reads the flag per
 * message -- while claim-next stayed dead for the rest of the process.
 *
 * That is reachable on boot, not just in theory. watchVersionDrain() runs
 * before this, and a KV watch replays the key's current value immediately, so
 * a pod starting while the *previous* upgrade's tag is still in the key drains
 * before this loop is even started -- the `while` test would have been false
 * on entry and the body would never have run once. Every replica of the new
 * version boots into the same value, so the whole fleet loses claim-next at
 * the same moment, and a full pod acks a doorbell expecting an idle replica to
 * claim the row (see delivery-dispatch's isWakeup), so the queued runs behind
 * those doorbells are left with nobody to pick them up.
 *
 * A drained cycle therefore sleeps like an idle one and asks again, which
 * costs one `idleMs` of latency when the drain lifts.
 */
export function startClaimNextLoop(deps: ClaimNextLoopDeps): void {
  if (!deps.enabled) return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  void (async () => {
    while (!deps.isShuttingDown()) {
      try {
        // Only a claim earns an immediate retry: a free slot should keep
        // pulling. "idle" and "draining" both mean there was nothing to take.
        const outcome = await runClaimNextCycle(deps);
        if (outcome !== "ran") await sleep(deps.idleMs);
      } catch (err) {
        deps.onError(err);
        await sleep(deps.idleMs);
      }
    }
  })();
}
