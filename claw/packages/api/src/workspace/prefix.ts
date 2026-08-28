// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a session's files live, as one string built in one place.
 *
 * This path is not a formatting detail. The delete uses it as the entire safety
 * argument for a bulk removal, the workspace row records it as the location a
 * collector may act on, and Brain writes to it -- so two implementations that
 * disagree do not fail, they address different directories and each reports
 * success about the one it looked at. Deleting silently spares every object;
 * the workspace row silently points a collector at the wrong place.
 *
 * It lives here rather than beside any one of those callers because it belongs
 * to none of them, and because the module that owned it first pulls in an S3
 * client and a NATS connection that a string has no business requiring.
 */

/**
 * The owner segment a session's objects are actually filed under.
 *
 * A session's `user_id` is a nullable column with a default rather than a
 * requirement, so a row hands it over blank or absent, and every writer
 * resolves either to `default`: the file routes, the upload sweeper, and
 * Brain's uploader through the `request.user_id || "default"` its callers pass.
 * So those objects exist under `users/default/`, and a delete that interpolated
 * the blank would refuse its own prefix as unusable -- reporting the workspace
 * as incomplete, hiding the session anyway, and leaving every object of it
 * behind.
 *
 * No delete did that, because each route resolved the column before handing it
 * over -- but the argument was where the resolving happened, so being right
 * depended on every caller having remembered, with nothing failing louder than
 * one entry in an `incomplete` list. Both routes now pass the column as it
 * stands and the resolving is here, because the writers and the delete agreeing
 * is what the safety argument for a prefix-scoped bulk delete rests on.
 *
 * Rests on, rather than is: this function is also where that agreement is known
 * to break. On the A2A path the session row carries the literal `"a2a"` while
 * Brain files the same session's objects under the authenticated caller's id, so
 * the owner segment resolved here is not the one they were written under, and
 * the delete addresses a prefix nothing is filed at. That is a pre-existing
 * ownership question rather than anything a column resolution can settle, and
 * `sessionCheckpointPrefix` in sessions/teardown.ts is where it is set out.
 */
export function workspaceOwnerId(ownerId: string | null): string {
  return ownerId || "default";
}

/**
 * Where a session's files live in S3, and what the workspace row records.
 *
 * Must agree with Brain, which builds the same string in `workspace/s3-uploader.ts`; if
 * the two ever disagree, deletion silently addresses an empty prefix and every
 * object survives. The single API-side implementation, called by the file
 * routes, the upload sweeper, the session delete and the workspace bookkeeping,
 * since several copies of one string is what let them disagree.
 */
export function sessionWorkspacePrefix(ownerId: string | null, sessionId: string): string {
  return `users/${workspaceOwnerId(ownerId)}/sessions/${sessionId}/`;
}
