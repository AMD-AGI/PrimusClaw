// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { withLeaderLock } from "../infra/leader-lock.js";

export function withCompletionLock<T>(sessionId: string, run: () => Promise<T>) {
  // Keep session locks outside the range of fixed maintenance lock IDs.
  const digest = createHash("sha256").update(`session-completion:${sessionId}`).digest();
  const lockId = 2 ** 52 + digest.readUIntBE(0, 6);
  return withLeaderLock(lockId, "session_completion", run);
}
