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
  /**
   * Non-reversible digest of the command this start carries. Diagnostic only:
   * two deliberate starts of one command are two intents and two rows, so it
   * identifies nothing on its own.
   */
  commandDigest?: string;
  /**
   * The call site this start came from, sealed here before the dispatch.
   *
   * This is what a replay is recognised by. Matching command text instead
   * merges a genuinely new same-command call into a predecessor's unfinished
   * one, and leaves a genuinely different call with the predecessor's still
   * unresolved -- neither of which the run has any way to notice.
   */
  stepIdentity?: string;
  /** Which start of this command under this run identity, from one upwards. */
  sequence?: number;
  /**
   * The replica that claimed this sequence.
   *
   * Recorded rather than relied on: a resumed run adopts a predecessor's
   * unresolved row by design, so this does not gate adoption. It is what makes
   * a handover legible afterwards -- which replica's unfinished call this was.
   */
  claimedBy?: string;
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
  /**
   * False where the revision moved, on the same terms as `write`: the row was
   * rewritten after it was read, so this delete is not the one that decides its
   * fate. A lost race is an answer, never a failure -- a delete that raised it
   * would abandon whatever the caller was walking.
   */
  delete(key: string, expectedRevision: number): Promise<boolean>;
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
  carry: Pick<BgHandleRow, "commandDigest" | "sequence" | "claimedBy" | "stepIdentity"> = {},
): Promise<void> {
  const key = rowKey(address);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await store.read(key);
    const row = current ? JSON.parse(current.value) as BgHandleRow : null;
    if (row && row.generation === generation && RANK[row.state] >= RANK[state]) return;
    const next = JSON.stringify({
      ...address, generation, state,
      commandDigest: carry.commandDigest ?? row?.commandDigest,
      sequence: carry.sequence ?? row?.sequence,
      claimedBy: carry.claimedBy ?? row?.claimedBy,
      stepIdentity: carry.stepIdentity ?? row?.stepIdentity,
    } satisfies BgHandleRow);
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

/** A row, and the revision the read that produced it saw. */
export interface BgRowRead {
  row: BgHandleRow;
  revision: number;
}

/**
 * Every row this run identity holds, whatever state each is in.
 *
 * The revision travels with the row because a decision taken from a row is a
 * decision about *that* row. Between the read and the act, the address may hold
 * a later row written by a dispatch that is still happening, and nothing in the
 * row's own fields separates the two -- a re-read alone cannot tell a caller
 * whether what it is looking at is what it decided from.
 */
export async function readRunRows(
  store: BgRowStore, ownerScope: string, runIdentity: string,
): Promise<BgRowRead[]> {
  const rows: BgRowRead[] = [];
  for (const key of await store.keys(runRowFilter(ownerScope, runIdentity))) {
    const entry = await store.read(key);
    if (entry) {
      rows.push({ row: JSON.parse(entry.value) as BgHandleRow, revision: entry.revision });
    }
  }
  return rows;
}

/** What a release attempt did -- which is not the same question as what it saw. */
export type RowRelease =
  /** This call performed the delete: the row the decision rests on is gone. */
  | "released"
  /** Nothing at the address. Someone else removed it, on evidence unknown here. */
  | "absent"
  /** The address holds a row later than the one the decision was taken from. */
  | "moved_on";

/**
 * Drop one row whose start positively never reached the sandbox.
 *
 * Conditioned on `decidedRevision` -- the revision the row was read at when the
 * release was decided -- and never on a fresh read. The window that has to be
 * closed opens at that read, not at this one: a release is licensed only by
 * `dispatched`, which is written before the request goes out and stands for a
 * whole spawn round trip, so a confirmation landing anywhere across that span
 * is precisely what is being raced. Deleting at whatever revision a re-read
 * hands back would happily remove a `spawn_confirmed` row -- the one durable
 * record that a shell exists -- and report it as a start that never ran.
 *
 * @returns `released` only where this call performed the delete. The other two
 * are different evidence and neither substitutes for it: `absent` says the row
 * this decision rests on is gone and nothing here removed it, `moved_on` says
 * it was rewritten by the only writer that rewrites it, a dispatch of this same
 * start still in flight. Both are compatible with the command having run.
 */
export async function releaseRow(
  store: BgRowStore, address: BgHandleAddress, decidedRevision: number,
): Promise<RowRelease> {
  const key = rowKey(address);
  const entry = await store.read(key);
  if (!entry) return "absent";
  // Read first only to tell the two non-releases apart for whoever reads the
  // log; the delete below is what decides, and it is conditioned on the
  // decision's revision either way.
  if (entry.revision !== decidedRevision) return "moved_on";
  return await store.delete(key, decidedRevision) ? "released" : "moved_on";
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
    //
    // Skipped, not raised. This is the run's last pass over its own rows, and
    // they sit in a bucket with no expiry: a contended row that ended the loop
    // would take every row after it with it, and nothing would come back for
    // them. One row left to its live writer is the intended cost; the rest of
    // the run's rows are not.
    const entry = await store.read(key);
    if (!entry) continue;
    if (!await store.delete(key, entry.revision)) continue;
    deleted += 1;
  }
  return deleted;
}
