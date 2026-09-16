// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { type LeaderLease, withLeaderLock } from "../infra/leader-lock.js";

/**
 * Run `run` under this session's completion lock, or skip if someone else has it.
 *
 * `run` may take the {@link LeaderLease} and is not obliged to: this lock is
 * taken around a decide-then-act that is a handful of statements long, not
 * around a traversal, so there is no loop boundary here for a check to sit at.
 * It is passed through rather than swallowed because the lock is the same lock,
 * the loss is the same loss, and a caller whose body ever grows a loop should
 * find the lease already in its hand rather than have to come back here for it.
 *
 * What protects this path is the other half: `withLeaderLock` throws
 * `LeadershipLostError` when the lock connection dropped mid-run, which the
 * completion consumer's own catch turns into a nak and a redelivery with
 * `processed_at` still NULL -- so the completion is redone under a lock that is
 * really held. That matters here more than anywhere else the lock is used,
 * because two holders that both read `processed_at = null` both pass the gate,
 * and both run `handleComplete` for the same `exec_complete`: duplicate
 * terminalization and a second `recordCompletionTurns` at the same turn index.
 * A redelivery is the only remedy that exists for it after the fact, and it is
 * reachable only if the loss is not reported as a clean pass.
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
