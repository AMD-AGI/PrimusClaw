// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How many distinct ping targets one sweeper may face, held by admission rather
 * than observed after the fact.
 *
 * The deferral count a sweep can accumulate is a function of how many targets
 * it faces, and the activity gap the keepalive relation is proven against is a
 * function of that count. A target taken on over the ceiling therefore stretches
 * the gap for every handle already live -- including the ones hosting the
 * background work the sweep exists to protect -- so a shell can miss its
 * idle-GC deadline because a *different* sandbox was admitted.
 *
 * Counting the roster and then writing is exactly the shape that fails: at one
 * slot below the boundary it admits every replica that looked. Every mutation
 * here is a compare-and-set against the revision the mutating replica read, and
 * a writer that loses re-reads and re-decides rather than re-applying its
 * arithmetic. Process-local state is never admission evidence: the in-memory
 * registry is per-process and stays what a process pings.
 *
 * The claim precedes provisioning, so it precedes the identity the provider
 * assigns, which makes admission two-phase: a provisional slot under a
 * Brain-minted token that names no sandbox and is never pinged, then a bind
 * exchanging that token for the identity, adding no slot.
 */

import { randomUUID } from "node:crypto";

export interface RosterEntry {
  /** The provider-assigned ping-target identity, or null while provisional. */
  identity: string | null;
  /** The Brain-minted token a provisional slot is held under. */
  token: string;
  claimedBy: string;
  renewedAtMs: number;
}

export interface Roster {
  /** The ceiling this roster was stamped at, so a disagreeing replica refuses. */
  ceiling: number;
  entries: RosterEntry[];
}

export interface RosterRead {
  roster: Roster;
  revision: number;
}

/**
 * The store this needs: a read that reports the revision it read at, and a
 * write that is refused when that revision has moved.
 */
export interface RosterStore {
  read(): Promise<RosterRead | null>;
  /** Returns false where the revision moved; the caller re-reads and re-decides. */
  write(roster: Roster, expectedRevision: number | null): Promise<boolean>;
}

export interface RosterConfig {
  /** N_max: the declared ceiling, one value governing the whole fleet. */
  ceiling: number;
  /** Slots held back so reconciliation never has to be refused. */
  reconciliationReserve: number;
  /** How long an unrenewed entry is held before any replica may release it. */
  reclaimHorizonMs: number;
  replicaId: string;
}

export type ClaimResult =
  | { ok: true; token: string; rosterSize: number }
  | { ok: false; reason: "at_capacity"; rosterSize: number; reserveRemaining: number };

export type BindResult =
  | { ok: true; added: boolean }
  | { ok: false; reason: "token_gone" | "contended" };

/**
 * The ceiling is stamped on the roster at the first claim made against it, and
 * one value governs the whole fleet. A replica configured differently is not
 * silently reconciled: it would compute a different deferral count and prove a
 * different activity gap against the same handles.
 */
export class CeilingDisagreement extends Error {
  constructor(readonly stamped: number, readonly configured: number) {
    super(`SANDBOX_KEEPALIVE_TARGET_CEILING is ${configured} here and ${stamped} `
      + "on the admission roster; one value governs the whole fleet");
  }
}

/** Bounded, because contention must refuse rather than spin. */
const MAX_ATTEMPTS = 8;

const EMPTY = (ceiling: number): Roster => ({ ceiling, entries: [] });

/**
 * Read, decide, and compare-and-set, retrying only on a lost race.
 *
 * `decide` returns the roster to write, or a result to report without writing.
 */
async function mutate<T>(
  store: RosterStore,
  config: RosterConfig,
  decide: (roster: Roster, now: number) => { write: Roster; result: T } | { result: T },
  contended: T,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await store.read();
    const roster = current?.roster ?? EMPTY(config.ceiling);
    if (current && roster.ceiling !== config.ceiling) {
      throw new CeilingDisagreement(roster.ceiling, config.ceiling);
    }
    const outcome = decide(roster, Date.now());
    if (!("write" in outcome)) return outcome.result;
    if (await store.write(outcome.write, current?.revision ?? null)) return outcome.result;
  }
  return contended;
}

/**
 * Drop entries whose claiming replica stopped renewing them.
 *
 * A bound entry is released only where no handle record names its identity --
 * releasing a slot for a target still being pinged is exactly what carries the
 * fleet past the ceiling -- so the caller supplies that set, and there is no
 * default for it. Reaping used to happen inside every mutation with an empty
 * set, which meant an ordinary claim could delete a stale-but-still-named entry
 * moments before the sweep that would have adopted it. Only the sweep reaps,
 * and only with the set in hand. A provisional entry names no identity and
 * carries no such guard.
 */
function reap(roster: Roster, config: RosterConfig, now: number, named: Set<string>): Roster {
  const alive = roster.entries.filter((entry) => {
    if (now - entry.renewedAtMs <= config.reclaimHorizonMs) return true;
    return entry.identity !== null && named.has(entry.identity);
  });
  return alive.length === roster.entries.length ? roster : { ...roster, entries: alive };
}

/**
 * Reserve one slot for a sandbox that does not exist yet.
 *
 * Refused once the roster reaches the ceiling less the reconciliation reserve,
 * so reconciliation always has slots to take without carrying the roster past
 * the value the startup relation was proven at. A refusal provisions nothing.
 */
export async function claimProvisionalSlot(
  store: RosterStore, config: RosterConfig,
): Promise<ClaimResult> {
  const token = randomUUID();
  return mutate<ClaimResult>(store, config, (roster, now) => {
    const boundary = config.ceiling - config.reconciliationReserve;
    if (roster.entries.length >= boundary) {
      return {
        result: {
          ok: false, reason: "at_capacity", rosterSize: roster.entries.length,
          reserveRemaining: Math.max(0, config.ceiling - roster.entries.length),
        },
      };
    }
    const entry: RosterEntry = {
      identity: null, token, claimedBy: config.replicaId, renewedAtMs: now,
    };
    return {
      write: { ...roster, entries: [...roster.entries, entry] },
      result: { ok: true, token, rosterSize: roster.entries.length + 1 },
    };
  }, { ok: false, reason: "at_capacity", rosterSize: config.ceiling, reserveRemaining: 0 });
}

/**
 * Exchange a provisional token for the identity the provider assigned.
 *
 * Adds no slot. An identity the roster already holds releases the provisional
 * one instead of adding a second: one target, one slot, whichever path reached
 * it.
 */
export async function bindSlot(
  store: RosterStore, config: RosterConfig, token: string, identity: string,
): Promise<BindResult> {
  return mutate<BindResult>(store, config, (roster, now) => {
    const index = roster.entries.findIndex((e) => e.token === token && e.identity === null);
    if (index < 0) return { result: { ok: false, reason: "token_gone" } };

    const withoutToken = roster.entries.filter((_, i) => i !== index);
    if (withoutToken.some((e) => e.identity === identity)) {
      return { write: { ...roster, entries: withoutToken }, result: { ok: true, added: false } };
    }
    const bound: RosterEntry = {
      ...roster.entries[index], identity, renewedAtMs: now,
    };
    return {
      write: { ...roster, entries: [...withoutToken, bound] },
      result: { ok: true, added: true },
    };
  }, { ok: false, reason: "contended" });
}

/** Give a slot back, by token or by identity. A release that loses re-reads. */
export async function releaseSlot(
  store: RosterStore, config: RosterConfig, held: { token?: string; identity?: string },
): Promise<boolean> {
  return mutate<boolean>(store, config, (roster) => {
    const entries = roster.entries.filter((e) =>
      !((held.token && e.token === held.token) || (held.identity && e.identity === held.identity)));
    return entries.length === roster.entries.length
      ? { result: true }
      : { write: { ...roster, entries }, result: true };
  }, false);
}

export interface ReconcileResult {
  admitted: string[];
  rosterSize: number;
  /** True where the roster now stands above the declared ceiling. */
  breach: boolean;
  /** The identities beyond the ceiling, named so the breach is reportable. */
  beyondCeiling: string[];
}

/**
 * Take on every target the roster does not already hold, before serving it.
 *
 * A target a sweep faces is never a confirmed-idle handle -- that one is neither
 * pinged nor a target -- so it is either working or unaccounted for, and its
 * refresh is this replica's business whichever replica created it. The ceiling
 * is held against ordinary admission, never against work already running: where
 * reconciliation exhausts the reserve it admits regardless, and the resulting
 * roster size above the ceiling is a declared capacity breach, reported as such.
 * Nothing is expired, reclaimed, evicted or terminated on account of it.
 */
export async function reconcileTargets(
  store: RosterStore, config: RosterConfig, identities: string[],
): Promise<ReconcileResult> {
  return mutate<ReconcileResult>(store, config, (roster, now) => {
    const held = new Set(roster.entries.map((e) => e.identity).filter((i): i is string => !!i));
    const missing = identities.filter((identity) => !held.has(identity));
    const entries = [...roster.entries, ...missing.map((identity) => ({
      identity, token: randomUUID(), claimedBy: config.replicaId, renewedAtMs: now,
    }))];
    const beyond = entries.length > config.ceiling
      ? entries.slice(config.ceiling).map((e) => e.identity ?? e.token)
      : [];
    const result: ReconcileResult = {
      admitted: missing,
      rosterSize: entries.length,
      breach: entries.length > config.ceiling,
      beyondCeiling: beyond,
    };
    return missing.length === 0 ? { result } : { write: { ...roster, entries }, result };
  }, { admitted: [], rosterSize: 0, breach: false, beyondCeiling: [] });
}

/**
 * Renew this replica's entries, and release those nobody renewed.
 *
 * `named` is the set of identities a handle record still names; a bound entry
 * in it is adopted and renewed rather than released, because releasing a slot
 * for a target still being pinged is what carries the fleet past the ceiling.
 */
export async function renewAndReap(
  store: RosterStore, config: RosterConfig, named: Set<string>, now = Date.now(),
): Promise<number> {
  return mutate<number>(store, config, (roster) => {
    // The one place reaping happens, and the only one that holds the set of
    // identities a handle record still names.
    const kept = reap(roster, config, now, named);
    const entries = kept.entries.map((entry) =>
      (entry.claimedBy === config.replicaId || (entry.identity && named.has(entry.identity))
        ? { ...entry, claimedBy: config.replicaId, renewedAtMs: now }
        : entry));
    return { write: { ...roster, entries }, result: entries.length };
  }, -1);
}

/**
 * How many sweeps it can take to reach every target, given how many pings one
 * sweep is guaranteed to start.
 */
export function deferralCount(rosterSize: number, pingsPerSweep: number): number {
  return Math.max(0, Math.ceil(rosterSize / pingsPerSweep) - 1);
}
