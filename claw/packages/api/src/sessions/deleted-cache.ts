// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What this process already knows about a session having been deleted.
 *
 * Deletion is terminal and session ids are not reused, so a positive answer
 * never needs rechecking and is remembered outright. A negative one is cached
 * only briefly: the window it opens is the window in which a just-deleted
 * session can still have events written for it -- which is why a replica that
 * has just written the tombstone, or has just heard `cleanup.<sid>`, has to
 * push the id in here rather than waiting for that window to elapse.
 */

const knownDeleted = new Set<string>();
const liveUntil = new Map<string, number>();

export const LIVE_ANSWER_TTL_MS = 10_000;
// Both maps are bounded because a long-lived process sees unboundedly many
// sessions. Dropping the whole cache is correct, only briefly more expensive:
// every answer is re-derived from the tombstone bucket.
const SESSION_CACHE_MAX = 10_000;

/** Whether this process has already observed the deletion. */
export function isKnownDeleted(sessionId: string): boolean {
  return knownDeleted.has(sessionId);
}

/**
 * Whether a live answer is still being trusted.
 *
 * Hit without a refresh: the window is measured from the last real read, not
 * from the last event, so a stream of events cannot stretch it.
 */
export function liveAnswerIsFresh(sessionId: string, now = Date.now()): boolean {
  const fresh = liveUntil.get(sessionId);
  return fresh !== undefined && fresh > now;
}

/** Remember that a real read found the session still alive. */
export function cacheLiveAnswer(sessionId: string, now = Date.now()): void {
  if (liveUntil.size >= SESSION_CACHE_MAX) liveUntil.clear();
  liveUntil.set(sessionId, now + LIVE_ANSWER_TTL_MS);
}

/**
 * Close the live-answer window for this session.
 *
 * Called from the replica that wrote the tombstone, and from every replica
 * that hears `cleanup.<sid>` -- the same message that tells Brain to abort,
 * which is the message whose trailing `exec_complete` would otherwise land
 * inside the live cache and write conversation content back under a session
 * the user just deleted.
 */
export function rememberSessionDeleted(sessionId: string): void {
  if (!sessionId) return;
  liveUntil.delete(sessionId);
  if (knownDeleted.size >= SESSION_CACHE_MAX) knownDeleted.clear();
  knownDeleted.add(sessionId);
}

/**
 * The cleanup notification is how other replicas learn a session is gone
 * without waiting on the live-answer TTL. Core NATS, same subject Brain
 * already subscribes to.
 */
export function rememberDeletedFromCleanupSubject(subject: string): void {
  if (!subject.startsWith("cleanup.")) return;
  rememberSessionDeleted(subject.slice("cleanup.".length));
}

/** Test seam: the maps are process-global and would otherwise leak across cases. */
export function resetDeletedSessionCache(): void {
  knownDeleted.clear();
  liveUntil.clear();
}
