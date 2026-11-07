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
  releaseSlot, type ClaimResult, type RosterConfig, type RosterStore,
} from "./admission-roster.js";
import type { CapacitySettings } from "./keepalive-capacity.js";
import { rosterDeps } from "./roster-store.js";
import { SANDBOX_ADMISSION_STALE_WAIT_MS } from "../config.js";

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
  // A fresh bind is a fresh view: whatever this process could not reconcile
  // before it bound belonged to a roster it is no longer looking at.
  localStaleLatch = false;
  censusReconciled = false;
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
  if (localStaleLatch) return true;
  return isFleetStale(roster.store).catch(() => true);
}

/**
 * Refuse this replica's own claims even where the shared marker could not be
 * written.
 *
 * A reconcile that failed and a stale marker that also failed leave the roster
 * looking healthy to everyone, including this process. The latch is what stops
 * this one admitting against it once contention clears, and only a sweep that
 * reconciled a complete census lifts it.
 */
let localStaleLatch = false;

export function latchRosterStale(stale: boolean): void {
  localStaleLatch = stale;
}

/** Record that the roster is incomplete, for every replica reading it. */
export async function markRosterStale(reason: string): Promise<void> {
  if (!roster) return;
  // Raised rather than swallowed: a marker that could not be written leaves the
  // roster looking healthy to every replica while it is missing targets.
  await markFleetStale(roster.store, roster.config, reason).catch((err) => {
    logger.error(
      { err: (err as Error)?.message, reason },
      "admission.stale_marker_unwritten",
    );
    throw err;
  });
}

/**
 * Whether a census of the existing fleet has been reconciled onto the roster at
 * least once since this process bound it.
 *
 * The roster is stamped empty at boot and the first sweep runs behind the
 * consumer, so between the two a claim is checked against a count that omits
 * every sandbox this replica did not create -- which is the ceiling being
 * enforced against a number nobody took.
 */
let censusReconciled = false;

/** Recorded by the sweep that reconciled a complete census onto the roster. */
export function markCensusReconciled(): void {
  censusReconciled = true;
}

/**
 * Refuse to take on a ping target while the fleet is uncounted.
 *
 * Both paths that produce one go through here. Reusing an existing sandbox
 * makes no claim -- the container is already in the fleet -- but it does make
 * this replica ping it, and a target served by a replica whose roster does not
 * hold it is the ceiling being enforced after the fact. The refusal lasts only
 * until the first sweep, which the boot path awaits.
 *
 * @throws SandboxCapacityRefused where a roster is bound and no census has been
 * reconciled onto it yet.
 */
export function assertFleetCensused(sessionId: string): void {
  if (!roster || censusReconciled) return;
  logger.warn({ sessionId }, "admission.census_pending");
  throw new SandboxCapacityRefused(
    "sandbox admission refused: the keepalive roster has not yet been reconciled "
    + "against a census of the running fleet, so a target taken on now would be "
    + "served against a count that omits every sandbox this replica did not create",
  );
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
 * How long a claim waits for a stale fleet count, and how often it looks again.
 * Mutable only so tests can shorten it.
 */
const staleWait = { ms: SANDBOX_ADMISSION_STALE_WAIT_MS, pollMs: 2_000 };

export function setAdmissionStaleWaitForTest(ms: number, pollMs = 2_000): () => void {
  const before = { ...staleWait };
  staleWait.ms = ms;
  staleWait.pollMs = pollMs;
  return () => { Object.assign(staleWait, before); };
}

type ClaimOutcome = ClaimResult;

/**
 * Claim a slot, waiting out a fleet count that is briefly unreadable.
 *
 * Staleness is a reading, not a verdict: the next sweep that reads the fleet
 * whole clears it, and that sweep is at most one keepalive interval away. A
 * claim refused at once turned that interval into a user's task failing, so the
 * claim is retried until the count is readable again or the wait runs out --
 * and only then refused. Nothing is claimed while the count is stale, so the
 * ceiling is never checked against a number nobody could read; a claim made
 * after the wait is the same compare-and-set an immediate one would have been.
 */
async function claimOnceCounted(
  sessionId: string, store: RosterStore, config: RosterConfig, signal?: AbortSignal,
): Promise<ClaimOutcome> {
  const deadline = Date.now() + staleWait.ms;
  let waiting = false;
  for (;;) {
    // Checked before every claim, not only between waits: a run that was
    // cancelled while it waited must not come back holding a slot -- and then
    // a sandbox -- it no longer needs.
    throwIfAborted(signal);
    let outcome: ClaimOutcome;
    if (localStaleLatch) {
      outcome = {
        ok: false, reason: "stale",
        staleReason: "this replica could not reconcile the keepalive roster",
      };
    } else {
      outcome = await claimProvisionalSlot(store, config);
      if (outcome.ok || outcome.reason !== "stale") {
        if (waiting) logger.info({ sessionId }, "admission.stale_cleared");
        return outcome;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return outcome;
    if (!waiting) {
      waiting = true;
      logger.warn(
        { sessionId, reason: outcome.staleReason, waitMs: staleWait.ms },
        "admission.stale_waiting",
      );
    }
    await pause(Math.min(staleWait.pollMs, remaining), signal);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("sandbox admission aborted");
  }
}

/** A wait an abort ends at once, so a cancelled run is not held for the rest of it. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Reserve capacity for a sandbox that does not exist yet.
 *
 * Returns a hold the caller binds and releases. Throws
 * {@link SandboxCapacityRefused} where the fleet is at its ceiling; nothing is
 * provisioned in that case. A fleet count that is briefly unreadable is waited
 * out first; `signal` ends that wait, and an aborted signal throws its reason
 * with nothing claimed.
 */
export async function admitSandbox(
  sessionId: string, signal?: AbortSignal,
): Promise<AdmissionHold> {
  if (!roster) return NO_HOLD;
  const { store, config } = roster;

  assertFleetCensused(sessionId);
  const claim = await claimOnceCounted(sessionId, store, config, signal);
  if (!claim.ok && claim.reason === "stale") {
    logger.warn(
      { sessionId, reason: claim.staleReason, waitedMs: staleWait.ms },
      "admission.roster_stale",
    );
    throw new SandboxCapacityRefused(
      "sandbox admission refused: the sandbox fleet count could not be confirmed "
      + `for ${Math.round(staleWait.ms / 1000)}s (${claim.staleReason}), so no new `
      + "sandbox could be started safely. This is temporary; retrying the task in a "
      + "minute or two should succeed.",
    );
  }
  if (!claim.ok) {
    logger.warn(
      { sessionId, rosterSize: claim.rosterSize, reserveRemaining: claim.reserveRemaining },
      "admission.at_capacity",
    );
    throw new SandboxCapacityRefused(
      `sandbox admission refused: all sandbox slots are in use (${claim.rosterSize} `
      + `of ${config.ceiling}, with ${claim.reserveRemaining} reserved for sandboxes `
      + "already running). A slot frees when another task's sandbox is released; "
      + "retry the task later.",
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
