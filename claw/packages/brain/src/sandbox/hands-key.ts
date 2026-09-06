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
  HANDS_KEY_PREFIX, isReservedRetentionKey, isRetentionEntry,
} from "@claw/protocol";

export {
  HANDS_KEY_PREFIX, RETAINED_PREFIX, handsSessionKey, isRetentionEntry,
  isReservedRetentionKey, sessionIdFromHandsKey,
} from "@claw/protocol";

/** The store the check needs, narrowed so a test can supply one. */
export interface HandsKeyStore {
  keys(filter: string): Promise<string[]>;
  read(key: string): Promise<{ value: string } | null>;
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
