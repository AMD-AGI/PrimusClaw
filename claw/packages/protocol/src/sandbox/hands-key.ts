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
 * One character, and it carries no `.`: the sweeps and the census enumerate
 * these keys with a `hands.*` filter, and `*` spans exactly one dot-delimited
 * token -- so a marker containing a dot makes every migrated key invisible to
 * every walk, which is worse than the ambiguity it was introduced to fix.
 *
 * Encoded and raw are separated by what the encoding can have been *of* rather
 * than by shape: this scheme only ever encodes an id that needs re-keying, so a
 * part that decodes to something which does not need re-keying was never
 * produced by it. `=MZXW6` is valid base32 and decodes to ordinary text, which
 * is exactly what says it is a raw id and not an encoding.
 */
export const REKEYED_MARKER = "=";

export function handsKeyNeedsRekey(sessionId: string): boolean {
  return sessionId.startsWith(RETAINED_PREFIX) || sessionId.startsWith(REKEYED_MARKER);
}

/**
 * Refuse a session id whose key shape would be ambiguous.
 *
 * There is no encoding that separates it from its own encoded form, so the id
 * is rejected by name at the boundary instead of producing a key two readers
 * could resolve differently.
 */
export function assertSessionIdKeyable(sessionId: string): void {
  // The one shape the discriminator below cannot separate: an id that is itself
  // the marker followed by the encoding of something that needs re-keying.
  if (sessionId.startsWith(REKEYED_MARKER) && isEncodedPart(sessionId.slice(REKEYED_MARKER.length))) {
    throw new Error(
      `session id ${JSON.stringify(sessionId)} is shaped exactly like a re-keyed `
      + "registry entry and has no key that could be told from one",
    );
  }
}

/**
 * Whether this part is something this scheme wrote.
 *
 * Decisive rather than shape-based: only an id that needs re-keying is ever
 * encoded, so a part decoding to one that does not is a raw id that merely
 * looks like base32.
 */
function isEncodedPart(part: string): boolean {
  if (!/^[A-Z2-7]+$/.test(part)) return false;
  try {
    return handsKeyNeedsRekey(decodeKeyPart(part));
  } catch {
    return false;
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
  return isEncodedSessionKey(key) ? decodeKeyPart(part.slice(REKEYED_MARKER.length)) : part;
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
  const part = key.slice(HANDS_KEY_PREFIX.length);
  return part.startsWith(RETAINED_PREFIX)
    || (part.startsWith(REKEYED_MARKER) && !isEncodedPart(part.slice(REKEYED_MARKER.length)));
}

/** Whether this key is one this scheme wrote. */
export function isEncodedSessionKey(key: string): boolean {
  const part = key.slice(HANDS_KEY_PREFIX.length);
  return part.startsWith(REKEYED_MARKER) && isEncodedPart(part.slice(REKEYED_MARKER.length));
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
