// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Classifying the errors a revision-conditioned NATS KV write can fail with.
 *
 * Shared rather than kept next to either caller, because the distinction is only
 * as good as its agreement with JetStream's error shape, and two copies of that
 * would be free to drift apart.
 */

/**
 * Did a revision-conditioned KV write lose to a concurrent one?
 *
 * JetStream reports it as `err_code` 10071 ("wrong last sequence"), with the text
 * as a fallback for transports that surface only that. Distinguishing it from a
 * real KV error is what lets callers tell "somebody else decided the fate of this
 * entry", which is routine, from "the store could not be reached", which is not.
 */
export function isRevisionConflict(err: unknown): boolean {
  if ((err as { api_error?: { err_code?: number } } | null)?.api_error?.err_code === 10071) {
    return true;
  }
  return /wrong last sequence/i.test(String((err as Error | null)?.message ?? err ?? ""));
}
