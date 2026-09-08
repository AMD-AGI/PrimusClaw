// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether this pod may publish a doorbell, and whether one is still on its way.
 *
 * A message that must not be understood is a message that must not be sent, so
 * the publisher is the only gate: every other placement depends on the consumer
 * having code it does not have. Two things must both hold. The deployment must
 * want doorbell dispatch at all, which is restart-scoped configuration; and the
 * fleet on the other end of the subject must be able to understand one, which
 * is dynamic and must be revocable without a rollout.
 *
 * The second is an operator-asserted floor in a KV key. Every state in which
 * this process has never observed a usable floor resolves to fat dispatch --
 * slower, and never incorrect. What failing closed does NOT cover is a floor
 * this process HAS observed: the bucket drops aged entries with no marker at
 * all, so an expiry is silence rather than a revocation, and revocation is an
 * explicit operator step instead.
 *
 * A boolean is not enough for that step. Between the branch and the publish a
 * dispatch does real work, so a revocation landing in that window closes the
 * latch on every pod while a dispatch that read it open is still on its way to
 * the stream. The gate is therefore a barrier with a counted in-flight set, and
 * a pod exports both numbers: neither alone answers "can an incompatible binary
 * safely bind the durable now".
 */

import pino from "pino";
import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

import { RUN_DOORBELL_DISPATCH } from "../config.js";

const logger = pino({ name: "doorbell-gate" });

/** The KV key an operator asserts the fleet's floor in. */
export const DOORBELL_SEMANTICS_KEY = "brain.doorbell_semantics";

export type DoorbellLatch =
  | { state: "unknown"; reason: string }
  | { state: "floor"; version: number }
  | { state: "revoked" }
  | { state: "invalid"; value: string };

/**
 * `unknown` and `revoked` are separate states with the same gate contribution,
 * because they have different causes and different operator responses:
 * collapsing them would make "the watch died" read as "the operator turned it
 * off" in the logs.
 *
 * The starting value is the baseline floor rather than `unknown`. Version 1 is
 * the first semantics there has ever been, and every reader in the tree already
 * treats its absence as 1 -- `doorbellSemanticsOf` on the wire, and
 * `COALESCE((metadata->>'doorbell_semantics')::int, 1)` in both claim filters --
 * so a fleet that has asserted nothing is a version-1 fleet, not an unknown one.
 * Requiring an assertion to reach a floor the whole tree already assumes turned
 * every existing doorbell installation off on upgrade, silently, and demanded an
 * operator step to get back to the behaviour it already had. The floor earns its
 * keep from version 2 onward, where an assertion says something the default
 * cannot.
 *
 * A revocation still closes the gate, and survives a restart, because the delete
 * is a tombstone the watch replays out of a bucket that does not expire.
 */
export const DOORBELL_SEMANTICS_BASELINE = 1;
let latch: DoorbellLatch = { state: "floor", version: DOORBELL_SEMANTICS_BASELINE };

/** Tokens issued and not yet released. Bounded by the dispatches in progress. */
let inFlight = 0;

/**
 * One-way while the latch is closed, so it cannot flicker open under a rollback.
 *
 * Initialised from the latch rather than to `false`. Only `setDoorbellLatch`
 * moves it, and an empty floor bucket delivers no watch event at all, so a
 * hardcoded `false` here leaves the barrier shut on exactly the installation the
 * baseline exists for -- one that has asserted nothing. The two are the same
 * decision read twice; seeding one and not the other is how the baseline reached
 * a live cluster and still dispatched fat.
 */
let barrierOpen = gateOpenFor(latch);

export function doorbellLatch(): DoorbellLatch {
  return latch;
}

/** True iff the deployment wants doorbells and the fleet has asserted it can take them. */
/** The gate's own predicate, so the barrier can be seeded from the same rule. */
function gateOpenFor(l: DoorbellLatch): boolean {
  return RUN_DOORBELL_DISPATCH && l.state === "floor" && l.version >= DOORBELL_SEMANTICS_VERSION;
}

export function doorbellGateOpen(): boolean {
  return RUN_DOORBELL_DISPATCH
    && latch.state === "floor"
    && latch.version >= DOORBELL_SEMANTICS_VERSION;
}

/** Dispatches that read the gate open and can still reach the stream. */
export function doorbellInFlight(): number {
  return inFlight;
}

/**
 * A token, or null when this dispatch must take the fat path.
 *
 * Released exactly once, when the dispatch stops being able to publish a
 * doorbell: after the publish resolves, after it throws and compensation has
 * returned its verdict, or on any early return in between. A dispatch holding a
 * token is never aborted mid-flight -- doing so would leave the row and the
 * session in the states publish-failure compensation exists to keep consistent.
 */
export function beginDoorbellDispatch(): { release: () => void } | null {
  if (!doorbellGateOpen() || !barrierOpen) return null;
  inFlight += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      inFlight -= 1;
    },
  };
}

/**
 * Move the latch, and open or close the barrier with it.
 *
 * Closing issues no further tokens from that instant; tokens already held are
 * not revoked.
 */
export function setDoorbellLatch(next: DoorbellLatch): void {
  const wasOpen = doorbellGateOpen();
  latch = next;
  const nowOpen = doorbellGateOpen();
  barrierOpen = nowOpen;
  if (nowOpen === wasOpen) return;
  const fields = { latch: next.state, supported: DOORBELL_SEMANTICS_VERSION };
  if (nowOpen) logger.info(fields, "doorbell.gate_opened");
  else logger.warn(fields, "doorbell.gate_closed");
}

/**
 * Read one KV operation into a latch state.
 *
 * A value that does not parse is `invalid` rather than absent: a corrupt
 * assertion is not the same fact as no assertion, and folding them together
 * would hide a rollout writing garbage.
 */
export function latchFromOperation(operation: string, value: string | null): DoorbellLatch {
  if (operation === "DEL" || operation === "PURGE") return { state: "revoked" };
  const raw = (value ?? "").trim();
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1) {
    logger.error(
      { key: DOORBELL_SEMANTICS_KEY, value: raw.slice(0, 64) },
      "doorbell.floor_unparseable",
    );
    return { state: "invalid", value: raw.slice(0, 64) };
  }
  return { state: "floor", version: parsed };
}

/** A watch that died is a closed gate: a floor whose feed is dead is unrevocable. */
export function closeDoorbellLatch(reason: string): void {
  logger.error({ reason }, "doorbell.floor_watch_lost");
  setDoorbellLatch({ state: "unknown", reason });
}

/** Reset to process-start state. Test seam only. */
export function resetDoorbellGate(): void {
  latch = { state: "unknown", reason: "no delivery yet" };
  barrierOpen = false;
  inFlight = 0;
}
