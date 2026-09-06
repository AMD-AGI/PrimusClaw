// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which registry key names a session's sandbox, and how the reserved retention
 * namespace stays separate from it.
 *
 * A container retained because it still holds live work would keep its binding
 * in this same keyspace -- anywhere else and the keepalive sweep never walks it,
 * so it is reclaimed as idle, which is the destruction the retention exists to
 * prevent. Its key's variable part is the fixed marker below followed by the
 * sandbox generation.
 *
 * A session id that begins with that marker is re-keyed out of the way, so no
 * session can take a retention's key going forward. `handsSessionKey` is the
 * one place the shape is decided, and every service resolves through it -- a
 * reader that builds the key itself would look under a name a re-keyed session
 * no longer answers to.
 *
 * Separation is also carried by the entry's **value**, which is what makes the
 * two legible where both exist: only a retention writes the protection marker,
 * so a pre-existing session entry under the prefix is unambiguously not one.
 */

import { decodeKeyPart, encodeKeyPart } from "./base32.js";

export const HANDS_KEY_PREFIX = "hands.";

/** The variable part a retention's entry takes, which no session may hold. */
export const RETAINED_PREFIX = "retained-";

/**
 * Marks a re-keyed session entry.
 *
 * Two characters, and the second is not in base32's alphabet, so an encoded key
 * is distinguishable from a raw one *by shape alone* -- which a single marker
 * was not: a raw session id beginning `=` whose remainder happened to be valid
 * base32 was indistinguishable from an encoding, and either decoded to
 * something no session answered to or was skipped by the scan.
 *
 * A session id that itself begins with this marker cannot be admitted, because
 * no encoding of it could then be told from the raw form. Such an id is refused
 * at the boundary rather than repaired (`assertSessionIdKeyable`).
 */
export const REKEYED_MARKER = "=.";

export function handsKeyNeedsRekey(sessionId: string): boolean {
  return sessionId.startsWith(RETAINED_PREFIX);
}

/**
 * Refuse a session id whose key shape would be ambiguous.
 *
 * There is no encoding that separates it from its own encoded form, so the id
 * is rejected by name at the boundary instead of producing a key two readers
 * could resolve differently.
 */
export function assertSessionIdKeyable(sessionId: string): void {
  if (sessionId.startsWith(REKEYED_MARKER)) {
    throw new Error(
      `session id ${JSON.stringify(sessionId)} may not begin with ${JSON.stringify(REKEYED_MARKER)}: `
      + "that prefix marks a re-keyed registry entry and an id carrying it has no unambiguous key",
    );
  }
}

/**
 * The registry key for one session's sandbox binding.
 *
 * Total and injective: a plain key never begins with either marker, a re-keyed
 * one always begins with the re-key marker, and base32 is injective, so no two
 * session ids produce one key and no session id produces a retention's.
 */
export function handsSessionKey(sessionId: string): string {
  assertSessionIdKeyable(sessionId);
  return HANDS_KEY_PREFIX
    + (handsKeyNeedsRekey(sessionId) ? REKEYED_MARKER + encodeKeyPart(sessionId) : sessionId);
}

/** The session id a registry key names, whichever form it takes. */
export function sessionIdFromHandsKey(key: string): string {
  const part = key.slice(HANDS_KEY_PREFIX.length);
  return part.startsWith(REKEYED_MARKER)
    ? decodeKeyPart(part.slice(REKEYED_MARKER.length))
    : part;
}

/**
 * Whether a registry key sits in the namespace reserved for retentions.
 *
 * Read off the key as written, not off the session id it decodes to: a
 * re-keyed session decodes back to an id that begins with the marker while its
 * key deliberately does not, and that is the whole point of re-keying it.
 */
export function isReservedRetentionKey(key: string): boolean {
  return key.slice(HANDS_KEY_PREFIX.length).startsWith(RETAINED_PREFIX);
}

/**
 * Whether a key is one this scheme would never write.
 *
 * Both markers, because both are re-keyed: an entry sitting under the raw
 * re-key marker predates the scheme exactly as one under the reserved marker
 * does, and read as an already-encoded key it decodes to something no session
 * answers to.
 */
export function isLegacySessionKey(key: string): boolean {
  return key.slice(HANDS_KEY_PREFIX.length).startsWith(RETAINED_PREFIX);
}

/** Whether this key is one this scheme wrote, by shape alone. */
export function isEncodedSessionKey(key: string): boolean {
  return key.slice(HANDS_KEY_PREFIX.length).startsWith(REKEYED_MARKER);
}

/** The key this session id would have had before re-keying existed. */
export function legacyHandsKey(sessionId: string): string {
  return HANDS_KEY_PREFIX + sessionId;
}

/** Whether an entry's value carries the marker only a retention writes. */
export function isRetentionEntry(value: unknown): boolean {
  return !!value && typeof value === "object"
    && (value as { protected?: unknown }).protected === true;
}
