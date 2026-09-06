// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Moving a session binding out of the reserved retention namespace.
 *
 * Refusing to mint new colliding keys protects a fresh deployment and nothing
 * else: a session whose id already begins with the marker is indistinguishable
 * from a retention by key shape, so the first retention minted under a matching
 * generation would write over a live session's binding.
 *
 * The key shape itself lives in `@claw/protocol`, because three services read
 * these keys and a reader that builds one itself sees a migrated session as one
 * with no sandbox at all.
 */

import { HANDS_KEY_PREFIX, RETAINED_PREFIX, handsSessionKey } from "@claw/protocol";

export {
  HANDS_KEY_PREFIX, RETAINED_PREFIX, handsSessionKey, sessionIdFromHandsKey,
} from "@claw/protocol";

/**
 * Claim the registry key a retention keeps its container's binding under.
 *
 * Create-only, and that is the guarantee rather than an optimisation: a
 * retention that overwrote an existing entry would destroy a live session's
 * binding, and the session would then be routed nowhere and swept as idle. A
 * key already taken is refused, which is a retention that does not happen --
 * recoverable -- instead of a session that is silently lost.
 *
 * Every retention write must go through here. The startup and sweep scans move
 * strays out of this namespace; this is what makes a stray that has not been
 * moved yet harmless rather than fatal.
 */
export async function reserveRetentionKey(
  store: Pick<HandsKeyStore, "create">, generation: string, value: string,
): Promise<boolean> {
  return store.create(`${HANDS_KEY_PREFIX}${RETAINED_PREFIX}${generation}`, value);
}

/** Whether an entry's value carries the marker only a retention writes. */
export function isRetentionEntry(value: unknown): boolean {
  return !!value && typeof value === "object"
    && (value as { protected?: unknown }).protected === true;
}

/**
 * The store the scan needs, narrowed so a test can supply one.
 *
 * Revision-aware, because a rolling upgrade runs this on several replicas at
 * once against one bucket. A read-then-put would let two of them write the same
 * destination and the loser's delete then remove a source whose value never
 * landed anywhere; a delete not conditioned on what was read would remove an
 * entry a live session rewrote in between.
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
  /** Keys left alone because something else already holds the destination. */
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
  // Walked as whole session keys and narrowed here, because the store's `*`
  // matches one whole token and never a prefix inside one -- a filter spelling
  // the marker into the token would match nothing at all and the scan would
  // report a clean namespace it never looked at.
  const keys = (await store.keys(`${HANDS_KEY_PREFIX}*`))
    .filter((key) => key.slice(HANDS_KEY_PREFIX.length).startsWith(RETAINED_PREFIX));
  const result: ReservedKeyMigration = {
    scanned: keys.length, migrated: [], resumed: [], conflicted: [],
  };

  for (const key of keys) {
    // An unreadable entry is not an absent one: it may name a live sandbox, and
    // deleting or passing over it silently would be the loss this scan exists
    // to prevent. It is reported and left in place for operator repair, and so
    // is a destination already occupied -- two sessions cannot own one binding.
    try {
      const source = await store.read(key);
      if (source === null) {
        result.conflicted.push(key);
        continue;
      }
      if (isRetentionEntry(JSON.parse(source.value))) continue;

      const destination = handsSessionKey(key.slice(HANDS_KEY_PREFIX.length));
      // Create, never put: a destination that already exists belongs to
      // something else -- a session that legitimately owns it -- and
      // overwriting it loses a live binding.
      //
      // Except when it is this same move, finished halfway. A crash between the
      // copy and the delete leaves both keys, and a later startup that called
      // that a conflict would refuse to boot on its own unfinished work, with
      // no way forward but a manual edit. Matching content identifies it: the
      // copy is byte-for-byte what the source holds, so it is this migration
      // resuming rather than a second session.
      if (!await store.create(destination, source.value)) {
        const existing = await store.read(destination);
        if (existing?.value !== source.value) {
          result.conflicted.push(key);
          continue;
        }
        result.resumed.push(key);
      }
      // Conditioned on the revision the value came from, so a session that
      // rewrote its own entry between the read and here keeps it. The copy
      // stands either way; a source left behind is reported, never a silent
      // divergence.
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
