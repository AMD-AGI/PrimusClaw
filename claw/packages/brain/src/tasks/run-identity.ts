// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The only place a ledger key is made. Pure: no clock, no I/O, no logger.
 */
import type { ExecuteRequest, RunIdentitySource } from "@claw/protocol";

export type { RunIdentitySource } from "@claw/protocol";

/** Nominal. Only this module may mint one. */
export type RunIdentityKey = string & { readonly __runIdentity: unique symbol };

export interface RunIdentity {
  readonly key: RunIdentityKey;
  readonly source: RunIdentitySource;
}

export interface RunIdentityResolution {
  readonly identity: RunIdentity;
  /** `run_lease.url` was present but its shape was unrecognised. */
  readonly leaseShapeMiss: boolean;
}

// The protocol promises only that this URL renews a lease, not that its path
// encodes an id, so a URL that does not match is never guessed at.
const LEASE_TASK_ID = /\/tasks\/([^/?#]+)\/lease(?:$|[?#])/;

// Two runs resolving to one key would share an entry and miscount each other.
let unknownRuns = 0;

function keyOf(raw: string): RunIdentityKey {
  return raw as RunIdentityKey;
}

function taskIdFromLease(request: ExecuteRequest): { id: string | null; shapeMiss: boolean } {
  const url = request.run_lease?.url;
  if (!url) return { id: null, shapeMiss: false };
  const match = LEASE_TASK_ID.exec(url);
  const id = match?.[1] ?? "";
  return id ? { id, shapeMiss: false } : { id: null, shapeMiss: true };
}

/**
 * The identity this run is tracked under. Total over every combination of
 * present, absent and empty across `task_id` and `message_id`.
 *
 * Independent of `TaskRunner.runId`, which decides which sandbox shells a
 * redelivered attempt re-adopts: the tiers below would change that answer.
 */
export function resolveRunIdentity(
  request: ExecuteRequest,
  messageId: string,
): RunIdentityResolution {
  const taskId = request.task_id;
  if (taskId) {
    return { identity: { key: keyOf(taskId), source: "task_id" }, leaseShapeMiss: false };
  }
  const lease = taskIdFromLease(request);
  if (lease.id) {
    return { identity: { key: keyOf(lease.id), source: "task_id" }, leaseShapeMiss: false };
  }
  // An idempotency key, so no counter: a redelivery addresses one entry.
  if (messageId) {
    return {
      identity: { key: keyOf(`msg.${messageId}`), source: "message_id" },
      leaseShapeMiss: lease.shapeMiss,
    };
  }
  return {
    identity: { key: keyOf(`unknown.${++unknownRuns}`), source: "unknown" },
    leaseShapeMiss: lease.shapeMiss,
  };
}

/**
 * Takes no request, so it cannot substitute a proxy for the identity that went
 * missing; the prefix separates a wiring bug from a run that genuinely has none.
 */
export function untheadedRunIdentity(): RunIdentity {
  return { key: keyOf(`unknown.unthreaded.${++unknownRuns}`), source: "unknown" };
}
