// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Moving every stored secret to the first encryption key, so an older key can be removed from TEAMS_ENCRYPTION_KEYS.
 * A row is rewritten only if it still holds the token that was read (a concurrent write is never overwritten), and each
 * row is its own write: an interrupted run leaves every row readable and the next run finishes the rest.
 */
import { InvalidToken } from "../crypto/fernet.js";
import type { StoreContext } from "./context.js";
import { col } from "./database.js";

/** Every column that holds a Fernet token, as (table, key column, encrypted column). A new one must be listed here, or
 * it is never moved to a new key and is lost when the old key goes. */
export const ENCRYPTED_COLUMNS: readonly (readonly [string, string, string])[] = [
  ["links", "aad_id", "key_enc"],
  ["pending_keys", "code_hash", "key_enc"],
  ["notify_subs", "aad_id", "secret_enc"],
];

export interface ReencryptCounts {
  /** Re-encrypted now. */
  rotated: number;
  /** Already under the first key. */
  current: number;
  /** Under none of the configured keys; left as they are. */
  undecryptable: number;
}

function readsUnder(read: () => unknown): boolean {
  try {
    read();
    return true;
  } catch (error) {
    if (error instanceof InvalidToken) return false;
    throw error;
  }
}

export function reencrypt(ctx: StoreContext): ReencryptCounts {
  const counts: ReencryptCounts = { rotated: 0, current: 0, undecryptable: 0 };
  const { primary, all } = ctx.secrets;
  for (const [table, keyColumn, encColumn] of ENCRYPTED_COLUMNS) {
    for (const row of ctx.db.all(`SELECT ${keyColumn} AS k, ${encColumn} AS enc FROM ${table}`)) {
      const token = col.bytes(row, "enc");
      if (readsUnder(() => primary.decrypt(token))) {
        counts.current += 1;
        continue;
      }
      let rotated: string;
      try {
        rotated = all.rotate(token, (n) => ctx.random.bytes(n));
      } catch (error) {
        if (!(error instanceof InvalidToken)) throw error;
        counts.undecryptable += 1;
        continue;
      }
      const changed = ctx.db.run(
        `UPDATE ${table} SET ${encColumn} = ? WHERE ${keyColumn} = ? AND ${encColumn} = ?`,
        new TextEncoder().encode(rotated),
        row["k"] ?? null,
        token,
      );
      // 0: the row was rewritten or deleted meanwhile; a new write uses the first key.
      if (changed === 1) counts.rotated += 1;
    }
  }
  return counts;
}
