// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The compute half of a session delete: which key it runs with, and what it
 * may conclude when there is none.
 *
 * Every SaFE call needs a key, and a session delete has three places to find
 * one: the cleanup notification (the deleting caller's own key), the session's
 * `hands.<sid>` binding (the key its sandbox was created with), or neither. The
 * last used to be reported as `no_platform_key` and parked for idle reclaim,
 * whatever the reason there was no key.
 *
 * That conflated two different situations:
 *
 *   - the binding is there but carries no key, or cannot be read. Something
 *     Claw created may still be running and it cannot be addressed: a real
 *     incomplete teardown, parked and counted.
 *   - there is no binding at all and nobody offered a key. Claw holds no handle
 *     to anything this session could own. The sandbox's binding outlives the
 *     sandbox (keepalive, idle reclaim and destroyHands remove it only once the
 *     workload is stopped), and the multi-node idle sweeper reaches a session's
 *     GPU clusters only through that same binding -- so no Claw path, now or
 *     later, has anything left to act on. Parking is a no-op there too:
 *     `parkHandsHandle` finds nothing and answers "gone".
 *
 * The second is every session the retention pass deletes -- archived for weeks,
 * its sandbox reclaimed long ago -- and every replay of a delete whose earlier
 * cleanup already removed the binding. Reporting those as incomplete turned the
 * first retention pass into thousands of `session.cleanup_incomplete_parked`
 * errors and a firing "Session teardown left sandboxes behind" alert over
 * sessions that had nothing left behind. They are now a finished teardown with
 * nothing found, logged as such.
 */
import pino from "pino";

import { getHandsKv, readHandsEntry as readSessionBinding } from "./registry.js";
import type { SessionDestroyResult } from "./multi-node/types.js";

const logger = pino({ name: "session-compute-teardown" });

/** Where the teardown's key came from, or why there is none. */
export type CleanupCredential =
  | { kind: "key"; platformKey: string; source: "notification" | "binding" }
  /** No key offered and no binding: nothing Claw created is addressable. */
  | { kind: "no_handle" }
  /** A binding exists (or could not be read) and no key reaches it. */
  | { kind: "no_key"; binding: "present" | "unreadable" };

/**
 * Decide which key a session teardown runs with.
 *
 * An unreadable store is not an absent binding: it may be hiding a live
 * sandbox, so it is reported as `no_key` and the teardown stays incomplete.
 */
export async function resolveCleanupCredential(
  sessionId: string,
  offeredKey: string,
): Promise<CleanupCredential> {
  const offered = offeredKey.trim();
  if (offered) return { kind: "key", platformKey: offered, source: "notification" };
  let found: Awaited<ReturnType<typeof readSessionBinding>>;
  try {
    found = await readSessionBinding(getHandsKv(), sessionId);
  } catch (err) {
    logger.warn({ err: String(err), sessionId }, "session.cleanup_binding_unreadable");
    return { kind: "no_key", binding: "unreadable" };
  }
  if (!found) return { kind: "no_handle" };
  let key = "";
  try {
    key = String((JSON.parse(found.value) as { platformKey?: unknown }).platformKey ?? "").trim();
  } catch {
    // A binding that is not JSON is still a binding: something may be behind it.
  }
  return key
    ? { kind: "key", platformKey: key, source: "binding" }
    : { kind: "no_key", binding: "present" };
}

export interface SessionComputeTeardownDeps {
  /** Whether this deployment provisions through SaFE at all. */
  multiNodeAvailable: () => boolean;
  /** The provider's session-scoped destroy. */
  destroyForSession: (sessionId: string, opts: { platformKey: string }) => Promise<SessionDestroyResult>;
}

/**
 * Remove everything on the platform that a deleted session owns.
 *
 * @param offeredKey the key on the cleanup notification, "" when it carried none.
 */
export async function destroySessionCompute(
  sessionId: string,
  offeredKey: string,
  deps: SessionComputeTeardownDeps,
): Promise<SessionDestroyResult> {
  if (!deps.multiNodeAvailable()) return { complete: true, found: 0, deleted: 0 };
  const credential = await resolveCleanupCredential(sessionId, offeredKey);
  switch (credential.kind) {
    case "key":
      return deps.destroyForSession(sessionId, { platformKey: credential.platformKey });
    case "no_handle":
      logger.info({ sessionId }, "session.cleanup_nothing_addressable");
      return { complete: true, found: 0, deleted: 0 };
    case "no_key":
      logger.warn({ sessionId, binding: credential.binding }, "mn.safe_session_destroy_skipped_no_key");
      return { complete: false, reason: "no_platform_key", found: 0, deleted: 0 };
  }
}
