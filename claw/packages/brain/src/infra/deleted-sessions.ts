// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Sessions this pod has been told are gone, so it stops writing their files.
 *
 * Deleting a session lists and deletes every object under its S3 prefix, and
 * the run that was executing it is stopped by the same message that starts the
 * delete. But stopping a run is not instant: its final workspace flush is
 * already on its way, and a flush that lands after the delete pass re-creates
 * objects under the prefix of a session that no longer exists. Nothing would
 * notice -- the workspace reaper walks the shared filesystem, not S3, and there
 * is no row left to join against -- so the files stay until somebody audits the
 * bucket by hand. That is the compliance hole the delete exists to close,
 * reopened by a race.
 *
 * The KV tombstone answers the same question durably, but not from inside an
 * upload: it costs a round trip on a path that runs per sync, and the buckets
 * are bound elsewhere. This is the local half -- the pod that was running the
 * session is the pod whose flush is in flight -- and it is set from the cleanup
 * notification, which arrives before the delete pass begins.
 *
 * It narrows the window rather than closing it: a sync that has already passed
 * the check can still land afterwards. Closing that needs the delete to be
 * repeatable from the API side, which is a sweeper rather than a guard.
 */

/**
 * Bounded so a long-lived pod cannot accumulate one entry per session it ever
 * saw deleted. Entries only need to outlive the run being torn down, which is
 * minutes; a thousand is generous for that and cheap to hold.
 */
const MAX_REMEMBERED = 1_000;

const deleted = new Set<string>();

/** Note that this session has been deleted and must not be written to again. */
export function markSessionDeleted(sessionId: string): void {
  if (deleted.has(sessionId)) return;
  if (deleted.size >= MAX_REMEMBERED) {
    // Sets iterate in insertion order, so this drops the oldest.
    const oldest = deleted.values().next();
    if (!oldest.done) deleted.delete(oldest.value);
  }
  deleted.add(sessionId);
}

/** Whether this pod has been told the session is gone. */
export function isSessionDeletedLocally(sessionId: string): boolean {
  return deleted.has(sessionId);
}

/** Test seam: forget everything. */
export function forgetDeletedSessions(): void {
  deleted.clear();
}
