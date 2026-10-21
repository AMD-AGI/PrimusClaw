// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Evidence that can only hold a keepalive destroy, kept under its own key.
 *
 * A failed jobs probe, a positive count, or a reading that ends a destroy
 * streak used to reach the other Brain replicas only through the hands record,
 * written under CAS. That record is renewed by every sweep, so the write can
 * lose its revision race every time it is retried; past the bounded retry the
 * reading lived only in the memory of the replica that made it, and another
 * replica read the old streak, an empty roster, and destroyed the sandbox
 * inside the quiet window.
 *
 * So the same evidence is also written here, to `reclaimhold.<identity>` in the
 * same bucket, with a plain put: nothing else writes this key on a schedule, a
 * put does not depend on a revision, and the value is merged as the later of
 * what is there and what is new (read, merge, put, then read back and merge
 * again if a concurrent put covered it). Every destructive confirmation reads
 * it, and an unreadable hold key holds the destroy.
 *
 * Lifetime: the bucket's max age drops a key nobody re-puts, and `expiresAt`
 * bounds how long a note is honoured however often it is re-put. The
 * confirmation re-puts a key while it is still holding a destroy, and
 * destroyHands deletes it with the record. The key never matches `hands.*`:
 * the identity is base32-encoded, so it is one token with no dot.
 */

import { StringCodec, type KV } from "nats";
import { encodeKeyPart } from "@claw/protocol";
import { isTombstone } from "../tasks/lock.js";
import { later, type ReclaimReason, type ReclaimStreak } from "./reclaim-evidence.js";

const sc = StringCodec();

export const RECLAIM_HOLD_PREFIX = "reclaimhold.";

/** The hold key for one sandbox identity (see keepalive's entryIdentity). */
export function reclaimHoldKey(identity: string): string {
  return RECLAIM_HOLD_PREFIX + encodeKeyPart(identity);
}

/** A streak a holding reading was seen to end, bound to the idle period it ran in. */
export interface EndedStreak {
  firstAt: number;
  idleEpoch?: number;
  idleSince?: number;
}

/** What one or more holding readings say about one sandbox. */
export interface ReclaimHold {
  identity: string;
  /** Latest failed probe. */
  failureAt?: number;
  /** Latest positive user-process count. */
  positiveAt?: number;
  /** Per reason, when a reading last ended a streak of it (time-based). */
  endedAt: Partial<Record<ReclaimReason, number>>;
  /**
   * Per reason, the latest streak a reading was seen to end. Clock-free: a
   * streak in the same idle period whose first reading is no later than this
   * one's is the ended streak (or older), whichever replica's clock wrote it.
   */
  endedStreaks: Partial<Record<ReclaimReason, EndedStreak>>;
  /** Latest note. */
  at: number;
  /** Not honoured after this instant, however often it was re-put. */
  expiresAt: number;
}

function laterEnded(a: EndedStreak | undefined, b: EndedStreak | undefined): EndedStreak | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.firstAt > a.firstAt ? b : a;
}

/** Field-wise later of two holds on the same identity. */
export function mergeHolds(a: ReclaimHold, b: ReclaimHold): ReclaimHold {
  const endedAt: Partial<Record<ReclaimReason, number>> = { ...a.endedAt };
  for (const [r, at] of Object.entries(b.endedAt) as [ReclaimReason, number][]) {
    endedAt[r] = later(endedAt[r], at);
  }
  const endedStreaks: Partial<Record<ReclaimReason, EndedStreak>> = { ...a.endedStreaks };
  for (const [r, s] of Object.entries(b.endedStreaks) as [ReclaimReason, EndedStreak][]) {
    endedStreaks[r] = laterEnded(endedStreaks[r], s);
  }
  const out: ReclaimHold = {
    identity: a.identity,
    endedAt,
    endedStreaks,
    at: Math.max(a.at, b.at),
    expiresAt: Math.max(a.expiresAt, b.expiresAt),
  };
  const failureAt = later(a.failureAt, b.failureAt);
  const positiveAt = later(a.positiveAt, b.positiveAt);
  if (failureAt !== undefined) out.failureAt = failureAt;
  if (positiveAt !== undefined) out.positiveAt = positiveAt;
  return out;
}

/** Whether `have` already carries everything `note` says. */
function covers(have: ReclaimHold, note: ReclaimHold): boolean {
  return JSON.stringify(mergeHolds(have, note)) === JSON.stringify(mergeHolds(have, have));
}

/**
 * The record's evidence fields as `hold` says they are: the later failure and
 * positive-count times, and no streak the hold saw ended. `dropped` says
 * whether a streak was removed.
 */
export function applyHold<T extends {
  lastProbeFailureAt?: number; lastPositiveCountAt?: number; reclaimStreak?: ReclaimStreak;
}>(info: T, hold: ReclaimHold | null | undefined, identity: string, now: number): { info: T; dropped: boolean } {
  if (!hold || hold.identity !== identity || now > hold.expiresAt) return { info, dropped: false };
  const merged: T = {
    ...info,
    lastProbeFailureAt: later(info.lastProbeFailureAt, hold.failureAt),
    lastPositiveCountAt: later(info.lastPositiveCountAt, hold.positiveAt),
  };
  const streak = merged.reclaimStreak;
  if (!streak) return { info: merged, dropped: false };
  const endedAt = hold.endedAt[streak.reason];
  const ended = hold.endedStreaks[streak.reason];
  // Strictly before: a streak that starts on the very reading that ended the
  // previous one is the new run, not the old.
  const byTime = typeof endedAt === "number" && streak.firstAt < endedAt;
  const byStreak = !!ended
    && ended.idleEpoch === streak.idleEpoch
    && ended.idleSince === streak.idleSince
    && streak.firstAt <= ended.firstAt;
  if (byTime || byStreak) {
    delete merged.reclaimStreak;
    return { info: merged, dropped: true };
  }
  return { info: merged, dropped: false };
}

/** A hold value that cannot be read as one. Held on by readers, replaced by writers. */
export class MalformedReclaimHoldError extends Error {}

function parseHold(raw: Uint8Array): ReclaimHold {
  let v: Partial<ReclaimHold>;
  try {
    v = JSON.parse(sc.decode(raw)) as Partial<ReclaimHold>;
  } catch {
    throw new MalformedReclaimHoldError("reclaim hold record is not JSON");
  }
  if (!v || typeof v !== "object" || typeof v.identity !== "string"
    || typeof v.at !== "number" || typeof v.expiresAt !== "number") {
    throw new MalformedReclaimHoldError("reclaim hold record is malformed");
  }
  return { ...v, endedAt: v.endedAt ?? {}, endedStreaks: v.endedStreaks ?? {} } as ReclaimHold;
}

/**
 * The hold for `identity`, or null when there is none. Throws when the bucket
 * cannot answer or the value cannot be read: the caller must hold the destroy.
 */
export async function readReclaimHold(kv: Pick<KV, "get">, identity: string): Promise<ReclaimHold | null> {
  const e = await kv.get(reclaimHoldKey(identity));
  if (!e || isTombstone(e)) return null;
  const hold = parseHold(e.value);
  // Another identity under this key cannot happen (the key is the identity),
  // and is not evidence about this one.
  return hold.identity === identity ? hold : null;
}

const HOLD_PUT_ROUNDS = 3;

/**
 * Merge `note` into the hold key with an unconditional put, then read back:
 * a concurrent put of another note may have overwritten this one, and it is
 * merged again until the key covers it. Throws only when the bucket fails.
 */
export async function putReclaimHold(kv: Pick<KV, "get" | "put">, note: ReclaimHold): Promise<void> {
  const key = reclaimHoldKey(note.identity);
  let have: ReclaimHold | null = null;
  try {
    have = await readReclaimHold(kv, note.identity);
  } catch (err) {
    // A malformed value is replaced; a bucket that cannot answer is not.
    if (!(err instanceof MalformedReclaimHoldError)) throw err;
  }
  for (let round = 1; round <= HOLD_PUT_ROUNDS; round++) {
    const next = have ? mergeHolds(have, note) : note;
    await kv.put(key, sc.encode(JSON.stringify(next)));
    let back: ReclaimHold | null = null;
    try {
      back = await readReclaimHold(kv, note.identity);
    } catch {
      return; // The put landed; an unreadable read-back is the reader's to hold on.
    }
    // Gone means destroyHands removed it with the sandbox: nothing left to hold.
    if (!back || covers(back, note)) return;
    have = back;
  }
}

/**
 * Remove the hold key once the sandbox it is about is gone. Only where there is
 * a hold of this identity: a delete of an absent key still writes a marker to
 * the bucket, and most sandboxes are destroyed without ever having held. A
 * value that is not one is left to the bucket's max age.
 */
export async function deleteReclaimHold(kv: Pick<KV, "get" | "delete">, identity: string): Promise<void> {
  let held: ReclaimHold | null;
  try {
    held = await readReclaimHold(kv, identity);
  } catch (err) {
    if (err instanceof MalformedReclaimHoldError) return;
    throw err;
  }
  if (held) await kv.delete(reclaimHoldKey(identity));
}
