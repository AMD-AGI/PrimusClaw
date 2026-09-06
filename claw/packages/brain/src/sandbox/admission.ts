// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The admission step every provisioning path takes before it provisions.
 *
 * The ceiling bounds how many targets one sweeper faces, and every deferral
 * bound -- and with it the guarantee that an active background shell is
 * refreshed before its host is reclaimed -- is proven against that number. A
 * check made after the sandbox exists is not that bound: two provisions racing
 * the last slot both start, and by the time a sweep notices, both are live work
 * nothing may evict.
 *
 * So the slot is claimed first, under a token that names no sandbox, and bound
 * to the identity the provider assigns at the earliest moment that identity
 * exists -- before bootstrap, before the health check, before the durable handle
 * record and before local registration. A hold that cannot be bound, or a
 * provisioning that fails, gives the slot back.
 */

import type { KV } from "nats";
import pino from "pino";
import {
  CeilingDisagreement, bindSlot, claimProvisionalSlot, isFleetStale, markFleetStale,
  releaseSlot, type RosterConfig, type RosterStore,
} from "./admission-roster.js";
import type { CapacitySettings } from "./keepalive-capacity.js";
import { rosterDeps } from "./roster-store.js";

const logger = pino({ name: "sandbox-admission" });

let roster: { store: RosterStore; config: RosterConfig } | null = null;

/**
 * Bind the roster this process admits against, and check it agrees.
 *
 * The ceiling is stamped on the roster by the first claim made against it and
 * one value governs the whole fleet, so a replica configured differently would
 * compute a different deferral count and prove a different refresh gap against
 * the same handles. Read here, at boot, and raised: discovering it on a later
 * sweep means the replica is already serving requests under a bound it does not
 * share, and is reported healthy while doing so.
 */
export async function bindAdmission(kv: KV, capacity: CapacitySettings): Promise<void> {
  roster = rosterDeps(kv, capacity).roster ?? null;
  if (!roster) return;
  const { store, config } = roster;

  // Stamped here, not left to whichever sweep claims first. An empty bucket
  // agrees with every ceiling, so two replicas configured differently would
  // both start, both report healthy, and only later discover -- one of them,
  // mid-sweep, already serving -- that they had been proving different refresh
  // gaps against the same handles. Creating it is the atomic act that makes one
  // of them the fleet's value and the other's a disagreement.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await store.read();
    if (current) {
      if (current.roster.ceiling !== config.ceiling) {
        roster = null;
        throw new CeilingDisagreement(current.roster.ceiling, config.ceiling);
      }
      return;
    }
    if (await store.write({ ceiling: config.ceiling, entries: [] }, null)) return;
  }
  roster = null;
  throw new Error("the admission roster could not be read or stamped at startup");
}

/**
 * Give back the slot a target held, on any path that ends it.
 *
 * The provisioning hold covers only the window before a sandbox becomes a ping
 * target; after that the slot is released here, from the same place the target
 * stops being pinged. Without it a slot outlives its sandbox until the stale
 * horizon, and ordinary teardown of a busy deployment refuses admission for
 * sandboxes that no longer exist.
 */
export async function releaseAdmission(identity: string): Promise<boolean> {
  if (!roster) return true;
  const released = await releaseSlot(roster.store, roster.config, { identity })
    .catch((err) => {
      logger.error({ identity, err: (err as Error)?.message }, "admission.release_failed");
      return false;
    });
  if (!released) {
    // Reported, not assumed: a release that lost every retry leaves the slot
    // counted against the ceiling until the reclaim horizon, and a caller that
    // treated this as done would never look again.
    logger.error({ identity }, "admission.release_unconfirmed");
  }
  return released;
}

/**
 * Whether the roster is known to be incomplete, as the fleet sees it.
 *
 * Recorded on the shared roster rather than in this process's memory: an
 * incomplete roster is incomplete for everyone reading it, and a replica that
 * never hit the fault would otherwise go on admitting against the same
 * understated count.
 */
export async function isRosterStale(): Promise<boolean> {
  if (!roster) return false;
  return isFleetStale(roster.store).catch(() => true);
}

/** Record that the roster is incomplete, for every replica reading it. */
export async function markRosterStale(reason: string): Promise<void> {
  if (roster) await markFleetStale(roster.store, roster.config, reason);
}

/** Raised when the fleet is at its declared ceiling. Provisions nothing. */
export class SandboxCapacityRefused extends Error {}

export interface AdmissionHold {
  /**
   * Exchange the token for the provider-assigned identity. Throws where it
   * cannot commit, because a live sandbox holding no slot is the un-slotted
   * target the ceiling exists to prevent -- the caller's obligation is then to
   * stop what it just created.
   */
  bind(identity: string): Promise<void>;
  /** Give the slot back. Safe to call whether or not the bind happened. */
  release(): Promise<void>;
}

/** A hold that reserves nothing, for a deployment with no ceiling to hold. */
const NO_HOLD: AdmissionHold = {
  async bind() { /* nothing was reserved */ },
  async release() { /* nothing was reserved */ },
};

/**
 * Reserve capacity for a sandbox that does not exist yet.
 *
 * Returns a hold the caller binds and releases. Throws
 * {@link SandboxCapacityRefused} where the fleet is at its ceiling; nothing is
 * provisioned in that case.
 */
export async function admitSandbox(sessionId: string): Promise<AdmissionHold> {
  if (!roster) return NO_HOLD;
  const { store, config } = roster;

  if (await isRosterStale()) {
    throw new SandboxCapacityRefused(
      "sandbox admission refused: the keepalive roster could not be reconciled, so "
      + "the fleet count it would be checked against is incomplete",
    );
  }
  const claim = await claimProvisionalSlot(store, config);
  if (!claim.ok) {
    logger.warn(
      { sessionId, rosterSize: claim.rosterSize, reserveRemaining: claim.reserveRemaining },
      "admission.at_capacity",
    );
    throw new SandboxCapacityRefused(
      `sandbox admission refused: the keepalive roster holds ${claim.rosterSize} of `
      + `${config.ceiling} targets, with ${claim.reserveRemaining} reserved for reconciliation`,
    );
  }

  return {
    async bind(identity: string) {
      const result = await bindSlot(store, config, claim.token, identity);
      if (!result.ok) {
        throw new Error(`sandbox admission could not bind its slot (${result.reason})`);
      }
      logger.info({ sessionId, identity, added: result.added }, "admission.bound");
    },
    // By token either way: the bind keeps it on the entry it moves, so one
    // release covers both phases and a caller need not know which it reached.
    async release() {
      await releaseSlot(store, config, { token: claim.token })
        .catch((err) => logger.warn({ sessionId, err: (err as Error)?.message }, "admission.release_failed"));
    },
  };
}
