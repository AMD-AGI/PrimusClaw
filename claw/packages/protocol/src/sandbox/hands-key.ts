// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Registry keys keep session bindings disjoint from retained-container bindings. */

import { decodeKeyPart, encodeKeyPart } from "./base32.js";

export const HANDS_KEY_PREFIX = "hands.";

export const RETAINED_PREFIX = "retained-";

// Must contain no dot because NATS `hands.*` matches one dot-delimited token.
export const REKEYED_MARKER = "=";

export function handsKeyNeedsRekey(sessionId: string): boolean {
  return sessionId.startsWith(RETAINED_PREFIX) || sessionId.startsWith(REKEYED_MARKER);
}

export function assertSessionIdKeyable(sessionId: string): void {
  if (sessionId.startsWith(REKEYED_MARKER) && isEncodedPart(sessionId.slice(REKEYED_MARKER.length))) {
    throw new Error(
      `session id ${JSON.stringify(sessionId)} is shaped exactly like a re-keyed `
      + "registry entry and has no key that could be told from one",
    );
  }
}

function isEncodedPart(part: string): boolean {
  if (!/^[A-Z2-7]+$/.test(part)) return false;
  try {
    return handsKeyNeedsRekey(decodeKeyPart(part));
  } catch {
    return false;
  }
}

export function handsSessionKey(sessionId: string): string {
  assertSessionIdKeyable(sessionId);
  return HANDS_KEY_PREFIX
    + (handsKeyNeedsRekey(sessionId) ? REKEYED_MARKER + encodeKeyPart(sessionId) : sessionId);
}

export function sessionIdFromHandsKey(key: string): string {
  const part = key.slice(HANDS_KEY_PREFIX.length);
  return isEncodedSessionKey(key) ? decodeKeyPart(part.slice(REKEYED_MARKER.length)) : part;
}

export function isReservedRetentionKey(key: string): boolean {
  return key.slice(HANDS_KEY_PREFIX.length).startsWith(RETAINED_PREFIX);
}

export function isLegacySessionKey(key: string): boolean {
  const part = key.slice(HANDS_KEY_PREFIX.length);
  return part.startsWith(RETAINED_PREFIX)
    || (part.startsWith(REKEYED_MARKER) && !isEncodedPart(part.slice(REKEYED_MARKER.length)));
}

export function isEncodedSessionKey(key: string): boolean {
  const part = key.slice(HANDS_KEY_PREFIX.length);
  return part.startsWith(REKEYED_MARKER) && isEncodedPart(part.slice(REKEYED_MARKER.length));
}

export function legacyHandsKey(sessionId: string): string {
  return HANDS_KEY_PREFIX + sessionId;
}

export function isRetentionEntry(value: unknown): boolean {
  return !!value && typeof value === "object"
    && (value as { protected?: unknown }).protected === true;
}
