// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which run a wait belongs to, resolved once and threaded from there.
 *
 * The phase ledger used to be opened under the gate's lock key and read under
 * `dag_root_task_id || session_id`. Both are proxies with the wrong lifetime --
 * a workspace several sessions share, a conversation spanning many runs -- and
 * under the default gate they are not even the same string, so every wait
 * missed the entry it was supposed to land in and reported as execution.
 *
 * This module is the only place a ledger key is made. It is pure: total, no
 * clock, no I/O, no logger. A lease URL whose shape it does not recognise is
 * reported in the returned resolution rather than logged from here, so the
 * single-minting-site property stays checkable by reading one file.
 */
import type { ExecuteRequest, RunIdentity, RunIdentityKey } from "@claw/protocol";

export type { RunIdentity, RunIdentityKey, RunIdentitySource } from "@claw/protocol";

export interface RunIdentityResolution {
  readonly identity: RunIdentity;
  /** `run_lease.url` was present but its shape was unrecognised. */
  readonly leaseShapeMiss: boolean;
}

/**
 * The task row id a lease URL is addressed to.
 *
 * The protocol promises only that the URL renews a lease; it does not promise
 * the path encodes an id. So a URL that does not match is never guessed at --
 * the caller is told the shape missed and falls through to the tier below.
 */
const LEASE_TASK_ID = /\/tasks\/([^/?#]+)\/lease(?:$|[?#])/;

/**
 * Disambiguates the one tier with nothing stable to derive from.
 *
 * Two runs resolving to one string would share a ledger entry, where each
 * `beginRun` re-zeroes the other and the first `endRun` deletes it out from
 * under the rest -- counted wrongly, which is harder to notice than uncounted.
 */
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
 * The identity this run is tracked under, from the request that started it.
 *
 * Total: every combination of present, absent and empty across `task_id` and
 * `message_id` yields a non-empty key and one of the three sources. The chat
 * dispatcher defaults `message_id` to the empty string, which is falsy and
 * would otherwise slip through the ledger's own absent-key guard, so an empty
 * string is treated as absent rather than as an identity.
 *
 * Deliberately not derived from `TaskRunner.runId`, and not a source for it:
 * that value decides which sandbox shells a redelivered attempt re-adopts, and
 * the lease and message tiers here would silently change that answer.
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
  // An idempotency key, so the key is derived with no counter: a redelivery of
  // one message must address the entry its first delivery opened, not a second.
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
 * An identity for a run whose own identity was never threaded to it.
 *
 * Takes no request, so it structurally cannot substitute a proxy for the value
 * that went missing. The distinct prefix separates a wiring bug from a run that
 * genuinely has no identity to resolve.
 */
export function untheadedRunIdentity(): RunIdentity {
  return { key: keyOf(`unknown.unthreaded.${++unknownRuns}`), source: "unknown" };
}
