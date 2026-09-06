// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain's per-shell reference row: not a second copy of a shell's identity, but
 * the one fact the sandbox cannot supply once it is gone.
 *
 * A shell id whose sandbox record is missing must read `lost`, and one that was
 * never issued must read `unknown`. Bare absence cannot separate those, so the
 * row records how far a dispatch got and which sandbox generation it went to.
 *
 * Each state precedes the act it attests, because a row written on the way back
 * leaves the spawn-then-crash window covered by nothing durable. `issued` says
 * the request never reached the transport, so nothing ran under any generation.
 * `dispatched` says it may have reached Hands. `spawn_confirmed` says Hands
 * returned a shell id.
 *
 * The rows take a bucket with no expiry at all. No finite lifetime is
 * admissible: a run whose budget is configured off has no deadline, so no
 * number bounds its life, and a lowered constant is applied downward to an
 * existing bucket -- narrowing rows out from under runs already stamped. A row
 * is removed when its run ends, never because time passed.
 */

import { encodeKeyPart } from "./bg-key.js";

export type BgRowState = "issued" | "dispatched" | "spawn_confirmed";

export interface BgHandleAddress {
  ownerScope: string;
  runIdentity: string;
  shellId: string;
}

export interface BgHandleRow extends BgHandleAddress {
  /** The sandbox generation the dispatch was issued against. */
  generation: string;
  state: BgRowState;
}

/** The store this needs, narrowed so a test can supply one without JetStream. */
export interface BgRowStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(filter: string): Promise<string[]>;
}

export const BG_ROW_PREFIX = "bgshell";

export function rowKey(address: BgHandleAddress): string {
  return [
    BG_ROW_PREFIX,
    encodeKeyPart(address.ownerScope),
    encodeKeyPart(address.runIdentity),
    encodeKeyPart(address.shellId),
  ].join(".");
}

/** Every row a run identity owns, for the delete its terminal paths issue. */
export function runRowFilter(ownerScope: string, runIdentity: string): string {
  return `${BG_ROW_PREFIX}.${encodeKeyPart(ownerScope)}.${encodeKeyPart(runIdentity)}.*`;
}

const RANK: Record<BgRowState, number> = { issued: 0, dispatched: 1, spawn_confirmed: 2 };

/**
 * Advance a row to `state`, never backwards.
 *
 * Monotone and idempotent, so concurrent or replayed dispatches converge with
 * no arbitration: the arbiter is and stays the sandbox's own exclusive create.
 */
export async function advanceRow(
  store: BgRowStore, address: BgHandleAddress, generation: string, state: BgRowState,
): Promise<void> {
  const key = rowKey(address);
  const current = await readRow(store, address);
  if (current && current.generation === generation && RANK[current.state] >= RANK[state]) return;
  await store.put(key, JSON.stringify({ ...address, generation, state } satisfies BgHandleRow));
}

/**
 * The row for one address, or null where none exists.
 *
 * Throws where the row exists and cannot be read: an unreadable row is not an
 * absent one, and every caller here decides differently between the two.
 */
export async function readRow(
  store: BgRowStore, address: BgHandleAddress,
): Promise<BgHandleRow | null> {
  const raw = await store.get(rowKey(address));
  if (raw === null) return null;
  return JSON.parse(raw) as BgHandleRow;
}

/**
 * Drop a run identity's rows because the run is over.
 *
 * Issued only from paths that mean the run will not be picked up again -- never
 * from a termination checkpoint, a lost lease, or a retryable error, all of
 * which mean the run's shells are still its own.
 */
export async function deleteRunRows(
  store: BgRowStore, ownerScope: string, runIdentity: string,
): Promise<number> {
  const keys = await store.keys(runRowFilter(ownerScope, runIdentity));
  for (const key of keys) await store.delete(key);
  return keys.length;
}
