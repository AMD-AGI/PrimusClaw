// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which registry key names a session's sandbox.
 *
 * Shared rather than owned by Brain because three services read these keys, and
 * a reader that builds the key itself sees a migrated session as one that has
 * no sandbox at all -- reporting no workload for a live one, and skipping the
 * TTL refresh that keeps its record alive.
 *
 * A container retained because it still holds live work keeps its binding in
 * the same keyspace, under a reserved marker, so no acquisition can select it.
 * A session whose own id begins with that marker is therefore re-keyed into a
 * namespace of its own: the mapping is total and injective, so a plain key
 * never begins with either marker, a re-keyed one always begins with the
 * re-key marker, and no two session ids can produce one key.
 */

import { decodeKeyPart, encodeKeyPart } from "./base32.js";

export const HANDS_KEY_PREFIX = "hands.";

/** The variable part a retention's entry takes, which no session may hold. */
export const RETAINED_PREFIX = "retained-";

/**
 * Marks a re-keyed session entry. Inside the characters the key-value client
 * admits and outside base32's alphabet, so a re-keyed part can never be read as
 * a plain one.
 */
export const REKEYED_MARKER = "=";

export function handsKeyNeedsRekey(sessionId: string): boolean {
  return sessionId.startsWith(RETAINED_PREFIX) || sessionId.startsWith(REKEYED_MARKER);
}

export function handsSessionKey(sessionId: string): string {
  return HANDS_KEY_PREFIX
    + (handsKeyNeedsRekey(sessionId) ? REKEYED_MARKER + encodeKeyPart(sessionId) : sessionId);
}

/** The session id a registry key names, whichever form it takes. */
export function sessionIdFromHandsKey(key: string): string {
  const part = key.slice(HANDS_KEY_PREFIX.length);
  return part.startsWith(REKEYED_MARKER) ? decodeKeyPart(part.slice(1)) : part;
}
