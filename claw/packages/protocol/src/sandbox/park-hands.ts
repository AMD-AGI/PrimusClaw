// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Parking a deleted session's `hands.<sid>` handle for the idle-reclaim sweep.
 *
 * Two callers reach this, and they must leave the entry in the same shape: the
 * API when it deletes a session, and Brain when its own teardown cannot confirm
 * it removed everything. Shared rather than written twice because the shape *is*
 * the contract -- the sweep selects on these fields, so a divergence between the
 * two is a divergence in what gets reclaimed, and nothing would catch it.
 */

import { isRevisionConflict } from "@claw/utils";

/**
 * The revision-aware slice of a NATS KV bucket this needs. Duck-typed so utils
 * stays NATS-free, matching the approach in kv/store.ts.
 */
export interface RevisionedKv {
  get(key: string): Promise<{ value: Uint8Array; revision: number } | null>;
  update(key: string, value: Uint8Array, revision: number): Promise<number>;
}

/**
 * What parking managed to do.
 *
 * `superseded` is not a failure: every Brain replica runs the same teardown, so
 * all of them park and only one can win the conditional write -- the winner wrote
 * the same fields. `gone` means somebody finished the teardown outright and
 * removed the entry, which got further than parking would have.
 */
export type ParkOutcome = "parked" | "gone" | "superseded" | "failed";

export interface ParkResult {
  outcome: ParkOutcome;
  /** Present only when the outcome is "failed". */
  error?: unknown;
}

/**
 * Mark a session's handle idle so the multi-node sweep will reclaim its clusters.
 *
 * Every field written here is read by something:
 *
 *   - `keepalive: false` is what the sweep selects on, and what stops the
 *     keepalive ticker from pinging a pod whose session is gone.
 *   - `idleSince` is what the sweep measures its window from; a missing value
 *     reads as "not idle yet".
 *   - `sessionDeleted` exempts this from that window: a deleted session has no
 *     next message to keep a cluster warm for, so the GPUs go back one window
 *     sooner. Usually that is all it buys. A parked READY handle is not left to
 *     expire -- collectTargets re-puts it every tick *because* `keepalive` is
 *     false, refreshing its TTL until SANDBOX_IDLE_REUSE_MS (15 min), three
 *     times the window it would have had to sit through.
 *
 *     Two configurations do need it. A parked PENDING handle gets no such
 *     refresh, since collectTargets considers only READY entries, and keepalive
 *     can be switched off entirely (SANDBOX_KEEPALIVE_INTERVAL_SEC <= 0). In
 *     both the entry lives exactly one bucket TTL -- which is also the length of
 *     the window, so it would expire at the moment it qualified, and its
 *     clusters would be left to the workload's own timeout.
 *   - `token` is cleared because revoking it in-process only covers the replica
 *     that ran the revocation, while token validation falls back to scanning
 *     `hands.*` -- so a token left in a surviving entry stays accepted elsewhere.
 *
 * `handsUrl` is deliberately left alone. The health-check sweep skips an entry
 * without one, and a session parked here may still have a live sandbox: Brain
 * reaches this when its teardown could not confirm itself, and the API's own
 * direct destroy only covers a SaFE workload with a platform key, so neither
 * path guarantees the pod is gone.
 *
 * `status` is not inspected either. A pending handle belongs to an in-flight
 * ensureHands that may already have provisioned workloads, and its platform key
 * is the only way back to them; the sweep can act on it because `sessionDeleted`
 * waives the window it would otherwise never survive to reach.
 *
 * The write is conditioned on the revision just read, so a concurrent teardown
 * that already removed the entry is never resurrected.
 */
export async function parkHandsHandle(
  kv: RevisionedKv,
  sessionId: string,
): Promise<ParkResult> {
  const key = `hands.${sessionId}`;
  try {
    const entry = await kv.get(key);
    if (!entry) return { outcome: "gone" };
    const info = JSON.parse(new TextDecoder().decode(entry.value)) as Record<string, unknown>;
    info.keepalive = false;
    info.idleSince = Date.now();
    info.sessionDeleted = true;
    info.token = "";
    await kv.update(key, new TextEncoder().encode(JSON.stringify(info)), entry.revision);
    return { outcome: "parked" };
  } catch (err) {
    if (isRevisionConflict(err)) return { outcome: "superseded" };
    return { outcome: "failed", error: err };
  }
}
