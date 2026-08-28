// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * In-process singleflight for idempotent create endpoints. Collapses concurrent
 * requests that share the same key into ONE execution: the first caller runs
 * `execute()`, all concurrent joiners await the same promise (touching no extra
 * resources) and replay its result. Kept dependency-free so it is unit-testable
 * without booting the DB / Fastify.
 */

/** Normalized handler result a joiner can faithfully replay. */
export interface FlightResult {
  statusCode: number;
  response: unknown;
}

/** Run `execute` as the flight leader: publish the promise, always clean up. */
async function runFlightLeader(
  inflight: Map<string, Promise<FlightResult>>,
  key: string,
  execute: () => Promise<FlightResult>,
): Promise<FlightResult> {
  const p = execute();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Coordinate a same-key create through `inflight`.
 *
 * A joiner does NOT inherit a result that isn't legitimately its own and
 * re-runs as a fresh leader instead:
 *   - the leader aborted on ITS OWN client disconnect (statusCode 499) while
 *     this caller is still connected (`isCallerGone()` returns false), or
 *   - the leader threw (one request's transient failure must not fail all
 *     joiners).
 * After `maxJoinAttempts` joins are exhausted the caller runs once as the
 * leader so it always produces its own result.
 */
export async function singleflightCreate(
  inflight: Map<string, Promise<FlightResult>>,
  key: string,
  execute: () => Promise<FlightResult>,
  isCallerGone: () => boolean,
  maxJoinAttempts = 3,
): Promise<FlightResult> {
  for (let attempt = 0; attempt < maxJoinAttempts; attempt++) {
    const existing = inflight.get(key);
    if (!existing) {
      return runFlightLeader(inflight, key, execute);
    }
    try {
      const r = await existing;
      // Leader aborted on its OWN disconnect; we're still here -> retry.
      if (r.statusCode === 499 && !isCallerGone()) continue;
      return r;
    } catch {
      // Leader failed; don't inherit its rejection -> retry as fresh attempt.
      continue;
    }
  }
  return runFlightLeader(inflight, key, execute);
}
