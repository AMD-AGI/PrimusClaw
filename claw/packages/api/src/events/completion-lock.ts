// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { type LeaderLease, withLeaderLock } from "../infra/leader-lock.js";

/**
 * Run `run` under this session's completion lock, or skip if someone else has it.
 *
 * `run` takes the {@link LeaderLease}, and not for the reason the traversals
 * take one. This lock is held around a decide-then-act a handful of statements
 * long, so there is no loop boundary here to stop at and nothing above the last
 * statement that stopping could take back: `handleComplete` closes a row,
 * releases a session gate and writes turns, and a loss noticed afterwards
 * unwinds none of it.
 *
 * What the lease decides here is one statement, and it is the one that decides
 * whether any of the rest can be repaired. `withLeaderLock` throws
 * `LeadershipLostError` when the lock connection dropped mid-run, which the
 * completion consumer's own catch turns into a nak and a redelivery with
 * `processed_at` still NULL -- so the completion is redone under a lock that is
 * really held. That matters here more than anywhere else the lock is used,
 * because two holders that both read `processed_at = null` both pass the gate,
 * and both run `handleComplete` for the same `exec_complete`: duplicate
 * terminalization and a second `recordCompletionTurns` at the same turn index.
 * A redelivery is the only remedy that exists for it after the fact, and it is
 * reachable only if the loss is not reported as a clean pass AND the pass that
 * lost the lock did not stamp `processed_at` on its way out. The throw gives
 * the first; only the lease can give the second, because the stamp is the
 * body's own last statement and the throw happens after the body has returned.
 * A stamp written unconditionally short-circuits the very redelivery its own
 * nak asked for, which is the same silence the throw was introduced to remove,
 * arrived at one statement earlier.
 */
export function withCompletionLock<T>(
  sessionId: string,
  run: (lease: LeaderLease) => Promise<T>,
) {
  // Keep session locks outside the range of fixed maintenance lock IDs.
  const digest = createHash("sha256").update(`session-completion:${sessionId}`).digest();
  const lockId = 2 ** 52 + digest.readUIntBE(0, 6);
  return withLeaderLock(lockId, "session_completion", run);
}
