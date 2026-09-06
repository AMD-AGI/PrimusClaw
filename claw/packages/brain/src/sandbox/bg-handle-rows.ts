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

import { encodeKeyPart } from "@claw/protocol";

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

/**
 * The store this needs, narrowed so a test can supply one without JetStream.
 *
 * Revision-aware, because the rows have concurrent writers: a replay and the
 * original dispatch can both be advancing one row, and a read-then-write would
 * let the slower of the two put its older state back -- regressing a
 * `spawn_confirmed` row to `dispatched`, which is the difference between
 * resolving a replay and re-sending a start for a shell that already exists.
 */
export interface BgRowStore {
  read(key: string): Promise<{ value: string; revision: number } | null>;
  /** False where the revision moved; the caller re-reads and re-decides. */
  write(key: string, value: string, expectedRevision: number | null): Promise<boolean>;
  delete(key: string, expectedRevision: number): Promise<void>;
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

/** Bounded, because contention has to settle rather than spin. */
const MAX_ATTEMPTS = 8;

/**
 * Advance a row to `state`, never backwards.
 *
 * Monotone under concurrency, not merely monotone in the value written: the
 * decision is made against a revision and the write refused if that revision
 * moved, so a replay that read `dispatched` while the original was confirming
 * cannot put `dispatched` back over `spawn_confirmed`. The arbiter for the
 * spawn itself is and stays the sandbox's own exclusive create.
 */
export async function advanceRow(
  store: BgRowStore, address: BgHandleAddress, generation: string, state: BgRowState,
): Promise<void> {
  const key = rowKey(address);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await store.read(key);
    const row = current ? JSON.parse(current.value) as BgHandleRow : null;
    if (row && row.generation === generation && RANK[row.state] >= RANK[state]) return;
    const next = JSON.stringify({ ...address, generation, state } satisfies BgHandleRow);
    if (await store.write(key, next, current?.revision ?? null)) return;
  }
  throw new Error(`bg handle row ${key} could not be advanced to ${state} under contention`);
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
  const entry = await store.read(rowKey(address));
  return entry === null ? null : JSON.parse(entry.value) as BgHandleRow;
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
  let deleted = 0;
  for (const key of keys) {
    // Conditioned on the revision just read: a row rewritten between the walk
    // and this delete belongs to something that is still happening, and
    // removing it would strand whatever wrote it.
    const entry = await store.read(key);
    if (!entry) continue;
    await store.delete(key, entry.revision);
    deleted += 1;
  }
  return deleted;
}
