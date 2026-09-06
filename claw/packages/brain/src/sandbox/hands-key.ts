// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The startup check that makes the retention namespace's separation a fact
 * rather than a convention.
 *
 * Reads already tell the two apart by the entry's value, and a retention only
 * ever creates its key. What neither covers is a deployment that *already*
 * holds a session binding under the reserved prefix: for the one generation
 * whose key it occupies, a retention could not be written at all, and the
 * container it would have protected is reclaimed as idle with its work in it.
 * There is no repair that is safe to make automatically -- moving the key
 * diverges from every replica still reading the old name -- so the deployment
 * is refused instead, loudly and with the key named.
 *
 * The key shape itself lives in `@claw/protocol`, because three services read
 * these keys and a reader that builds one itself resolves a different entry.
 */

import {
  HANDS_KEY_PREFIX, handsSessionKey, isReservedRetentionKey, isRetentionEntry,
} from "@claw/protocol";

export {
  HANDS_KEY_PREFIX, REKEYED_MARKER, RETAINED_PREFIX, handsKeyNeedsRekey,
  handsSessionKey, isRetentionEntry, isReservedRetentionKey, sessionIdFromHandsKey,
} from "@claw/protocol";

/**
 * The store the scan needs, narrowed so a test can supply one.
 *
 * Revision-aware: a rolling upgrade runs this on several replicas at once
 * against one bucket, so a read-then-put would let two of them write the same
 * destination and the loser's delete then remove a source whose value never
 * landed anywhere.
 */
export interface HandsKeyStore {
  keys(filter: string): Promise<string[]>;
  read(key: string): Promise<{ value: string; revision: number } | null>;
  /** False where the key already exists. Never overwrites. */
  create(key: string, value: string): Promise<boolean>;
  delete(key: string, expectedRevision: number): Promise<boolean>;
}

export interface ReservedKeyMigration {
  scanned: number;
  migrated: string[];
  /** Moves a previous run had already copied and not yet deleted. */
  resumed: string[];
  /** Keys something else already holds; the deployment is refused on these. */
  conflicted: string[];
}

/**
 * Move a pre-existing session binding out of the retention namespace.
 *
 * Collision-safe in the three ways a rolling upgrade needs. The destination is
 * *created*, never written over, so a replica racing another one -- or a
 * session that legitimately owns the destination -- is left alone. The source
 * is deleted conditioned on the revision its value was copied from, so a
 * session that rewrote its own binding meanwhile keeps it. And a destination
 * already holding this move's own bytes is the move resuming after a crash
 * between the copy and the delete, not a conflict: calling that a conflict
 * would make the next startup refuse to boot on its own unfinished work.
 */
export async function migrateReservedSessionKeys(
  store: HandsKeyStore,
): Promise<ReservedKeyMigration> {
  // Walked as whole session keys and narrowed here: the store's `*` matches one
  // whole token and never a prefix inside one, so a filter spelling the marker
  // into the token would match nothing and report a namespace it never looked at.
  const keys = (await store.keys(`${HANDS_KEY_PREFIX}*`)).filter(isReservedRetentionKey);
  const result: ReservedKeyMigration = {
    scanned: keys.length, migrated: [], resumed: [], conflicted: [],
  };

  for (const key of keys) {
    try {
      const source = await store.read(key);
      if (source === null) {
        result.conflicted.push(key);
        continue;
      }
      if (isRetentionEntry(JSON.parse(source.value))) continue;

      const destination = handsSessionKey(key.slice(HANDS_KEY_PREFIX.length));
      if (!await store.create(destination, source.value)) {
        const existing = await store.read(destination);
        if (existing?.value !== source.value) {
          result.conflicted.push(key);
          continue;
        }
        result.resumed.push(key);
      }
      if (!await store.delete(key, source.revision)) {
        result.conflicted.push(key);
        continue;
      }
      result.migrated.push(key);
    } catch {
      result.conflicted.push(key);
    }
  }
  return result;
}

/** Refused at startup, naming the entries that cannot be separated. */
export class ReservedKeyCollision extends Error {}

/**
 * Refuse the deployment where a session binding occupies a retention's key.
 *
 * An entry that cannot be read is refused too: it may be either, and a check
 * that passed on what it could not open would be no check.
 */
export async function assertRetentionSeparation(store: HandsKeyStore): Promise<void> {
  const colliding: string[] = [];
  // Walked as whole session keys and narrowed here: the store's `*` matches one
  // whole token and never a prefix inside one, so a filter spelling the marker
  // into the token would match nothing and report a namespace it never looked at.
  for (const key of await store.keys(`${HANDS_KEY_PREFIX}*`)) {
    if (!isReservedRetentionKey(key)) continue;
    try {
      const entry = await store.read(key);
      if (entry === null || !isRetentionEntry(JSON.parse(entry.value))) colliding.push(key);
    } catch {
      colliding.push(key);
    }
  }
  if (colliding.length) {
    throw new ReservedKeyCollision(
      `refusing to start: ${colliding.length} registry key(s) occupy the namespace `
      + `reserved for retained containers (${colliding.join(", ")}). A container `
      + `retained under the colliding generation could not keep its binding and `
      + `would be reclaimed with its work. Remove or rename these sessions first.`,
    );
  }
}
