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
  bindSlot, claimProvisionalSlot, releaseSlot, type RosterConfig, type RosterStore,
} from "./admission-roster.js";
import type { CapacitySettings } from "./keepalive-capacity.js";
import { rosterDeps } from "./roster-store.js";

const logger = pino({ name: "sandbox-admission" });

let roster: { store: RosterStore; config: RosterConfig } | null = null;

/** Bind the roster this process admits against. Called once at boot. */
export function bindAdmission(kv: KV, capacity: CapacitySettings): void {
  roster = rosterDeps(kv, capacity).roster ?? null;
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
export async function releaseAdmission(identity: string): Promise<void> {
  if (!roster) return;
  await releaseSlot(roster.store, roster.config, { identity })
    .catch((err) => logger.warn(
      { identity, err: (err as Error)?.message }, "admission.release_failed",
    ));
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
