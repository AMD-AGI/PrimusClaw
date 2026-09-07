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
  /**
   * Set where a reconciliation could not complete, so the roster is missing
   * targets it was about to take on.
   *
   * On the record rather than in one process's memory: the roster is shared, so
   * an incomplete one is incomplete for every replica reading it, and a
   * neighbour that never hit the contention would otherwise go on admitting
   * against the same understated count.
   */
  stale?: { at: number; replicaId: string; reason: string };
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
  | { ok: false; reason: "at_capacity"; rosterSize: number; reserveRemaining: number }
  | { ok: false; reason: "stale"; staleReason: string };

export type BindResult =
  | { ok: true; added: boolean }
  | { ok: false; reason: "token_gone" };

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
export class RosterContended extends Error {}

async function mutate<T>(
  store: RosterStore,
  config: RosterConfig,
  decide: (roster: Roster, now: number) => { write: Roster; result: T } | { result: T },
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
  // Raised, never answered with an empty roster. A caller handed
  // `{admitted: [], rosterSize: 0}` reads a fleet with no targets in it: the
  // count every deferral bound rests on is understated, no breach is reported,
  // and ordinary admission carries on against a number nobody could write.
  throw new RosterContended(
    `the admission roster could not be updated in ${MAX_ATTEMPTS} attempts under contention`,
  );
}

/**
 * Drop entries whose claiming replica stopped renewing them.
 *
 * Only the sweep may reap bound entries, using the complete set of identities
 * still named by handle records. Provisional entries need no such guard.
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
    // Read in the same decision the write is conditioned on. Checked before the
    // claim and outside its compare-and-set, a reconcile can mark the roster
    // incomplete in between and the claim still commits against a count nobody
    // could write.
    if (roster.stale) {
      return { result: { ok: false, reason: "stale", staleReason: roster.stale.reason } };
    }
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
  });
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
  });
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
  });
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
 * Record that the roster is incomplete, for every replica reading it.
 *
 * Throws where the marker itself cannot be written. Swallowed, the roster goes
 * on looking healthy to every replica while it is missing targets -- which is
 * the failure this marker exists to announce, now invisible as well.
 */
export async function markFleetStale(
  store: RosterStore, config: RosterConfig, reason: string,
): Promise<void> {
  await mutate<void>(store, config, (roster, now) => ({
    write: { ...roster, stale: { at: now, replicaId: config.replicaId, reason } },
    result: undefined,
  }));
}

export async function isFleetStale(store: RosterStore): Promise<boolean> {
  const current = await store.read();
  return !!current?.roster.stale;
}

/**
 * Take on every target the roster does not already hold, before serving it.
 *
 * `complete` says whether the census this was given can be trusted: a target
 * scan that could not read everything produces a smaller set, and reconciling
 * that set would clear a staleness the fleet still has.
 */
export async function reconcileTargets(
  store: RosterStore, config: RosterConfig, identities: string[], complete = true,
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
    // Only a complete census clears the flag. Reconciling a partial one would
    // announce a fleet whole on the strength of a scan that could not read it.
    const stale = complete
      ? undefined
      : roster.stale ?? { at: now, replicaId: config.replicaId, reason: "incomplete target scan" };
    const next: Roster = { ...roster, entries, ...(stale ? { stale } : {}) };
    if (complete) delete next.stale;
    return missing.length === 0 && complete && !roster.stale
      ? { result }
      : { write: next, result };
  });
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
  });
}

/**
 * How many sweeps it can take to reach every target, given how many pings one
 * sweep is guaranteed to start.
 */
export function deferralCount(rosterSize: number, pingsPerSweep: number): number {
  return Math.max(0, Math.ceil(rosterSize / pingsPerSweep) - 1);
}
