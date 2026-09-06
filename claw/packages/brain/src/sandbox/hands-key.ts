// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which key in the registry bucket names a session's sandbox, and how the
 * reserved retention namespace is kept disjoint from it.
 *
 * A container retained because it still holds live work keeps its binding in
 * the same keyspace the keepalive sweep walks -- anywhere else and nothing
 * pings it, so it is reclaimed as idle, which is the destruction the retention
 * exists to prevent. Its key's variable part is the fixed marker `retained-`
 * followed by the sandbox generation, so no acquisition can select it.
 *
 * That leaves a session whose own id already begins with the marker. Refusing
 * to mint new ones going forward does not help a deployment that already has
 * one: its key is indistinguishable from a retention's by shape, and the first
 * retention minted under a colliding generation would write over a live
 * session's binding. Every such session id is therefore re-keyed -- by this
 * function for new writes, and by the upgrade-time scan below for entries
 * already present -- into a namespace of its own that no retention can name.
 */

import { decodeKeyPart, encodeKeyPart } from "./bg-key.js";

export const HANDS_KEY_PREFIX = "hands.";

/** The variable part a retention's entry takes, which no session may hold. */
export const RETAINED_PREFIX = "retained-";

/**
 * Marks a re-keyed session entry.
 *
 * Chosen from the characters the key-value client admits and outside base32's
 * alphabet, so a re-keyed part can never be read as a plain one.
 */
const REKEYED_MARKER = "=";

function needsRekey(sessionId: string): boolean {
  return sessionId.startsWith(RETAINED_PREFIX) || sessionId.startsWith(REKEYED_MARKER);
}

/**
 * The registry key for one session's sandbox binding.
 *
 * Total and injective: a plain key never begins with the reserved marker or the
 * re-key marker, a re-keyed one always begins with the re-key marker, and
 * base32 is injective, so no two session ids can produce one key and no session
 * id can produce a retention's.
 */
export function handsSessionKey(sessionId: string): string {
  return HANDS_KEY_PREFIX + (needsRekey(sessionId) ? REKEYED_MARKER + encodeKeyPart(sessionId) : sessionId);
}

/** The session id a registry key names, whichever form it takes. */
export function sessionIdFromHandsKey(key: string): string {
  const part = key.slice(HANDS_KEY_PREFIX.length);
  return part.startsWith(REKEYED_MARKER) ? decodeKeyPart(part.slice(1)) : part;
}

/** Whether an entry's value carries the marker only a retention writes. */
export function isRetentionEntry(value: unknown): boolean {
  return !!value && typeof value === "object"
    && (value as { protected?: unknown }).protected === true;
}

/** The store the scan needs, narrowed so a test can supply one. */
export interface HandsKeyStore {
  keys(filter: string): Promise<string[]>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ReservedKeyMigration {
  scanned: number;
  migrated: string[];
  /** Keys left alone because a retention already holds the destination. */
  conflicted: string[];
}

/**
 * Move any pre-existing session entry out of the reserved retention namespace.
 *
 * Run once at startup, before anything can mint a retention. A session-keyed
 * entry is one whose value carries no retention marker; a retention's own entry
 * is left exactly as it is. The move is collision-safe: an entry is written to
 * its re-keyed destination and the original removed only once the write has
 * landed, and a destination already occupied is reported rather than
 * overwritten, since two sessions cannot both own one binding.
 */
export async function migrateReservedSessionKeys(
  store: HandsKeyStore,
): Promise<ReservedKeyMigration> {
  const keys = await store.keys(`${HANDS_KEY_PREFIX}${RETAINED_PREFIX}*`);
  const result: ReservedKeyMigration = { scanned: keys.length, migrated: [], conflicted: [] };

  for (const key of keys) {
    // An unreadable entry is not an absent one: it may name a live sandbox, and
    // deleting or passing over it silently would be the loss this scan exists
    // to prevent. It is reported and left in place for operator repair, and so
    // is a destination already occupied -- two sessions cannot own one binding.
    try {
      const raw = await store.get(key);
      if (raw === null) {
        result.conflicted.push(key);
        continue;
      }
      if (isRetentionEntry(JSON.parse(raw))) continue;

      const destination = handsSessionKey(key.slice(HANDS_KEY_PREFIX.length));
      if (await store.get(destination) !== null) {
        result.conflicted.push(key);
        continue;
      }
      await store.put(destination, raw);
      await store.delete(key);
      result.migrated.push(key);
    } catch {
      result.conflicted.push(key);
    }
  }
  return result;
}
