// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A deleted session's files stay deleted.
 *
 * Deleting a session lists and deletes every object under its S3 prefix, and
 * the same message that starts the delete stops the run executing it. Stopping
 * a run is not instant, though: its final workspace flush is already on its way
 * out, and one that lands after the delete pass re-creates objects under the
 * prefix of a session that no longer exists. Nothing downstream notices -- the
 * workspace reaper walks the shared filesystem rather than S3, and there is no
 * row left to join against -- so the files stay until somebody audits the
 * bucket by hand, which is the compliance hole the delete exists to close.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  markSessionDeleted, isSessionDeletedLocally, forgetDeletedSessions,
} from "../src/infra/deleted-sessions.js";
import { syncWorkspaceToS3, archiveRunToS3 } from "../src/workspace/s3-uploader.js";
import type { HandsClient } from "../src/clients/hands.js";

beforeEach(() => forgetDeletedSessions());

/** A sandbox that fails the test if it is asked to do anything at all. */
function unusableHands(): HandsClient {
  return {
    callTool: async () => {
      throw new Error("the uploader talked to the sandbox for a deleted session");
    },
  } as unknown as HandsClient;
}

test("a flush for a deleted session does not reach S3", async () => {
  markSessionDeleted("sess-gone");

  const result = await syncWorkspaceToS3(unusableHands(), "sess-gone", "user-1");
  assert.deepEqual(result, {
    uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true,
  });
});

test("neither does a per-turn archive", async () => {
  // Archives are written under the same prefix and are the bulk of the objects
  // a long session accumulates, so leaving this path open would leave the
  // heavier half of the problem in place.
  markSessionDeleted("sess-gone");

  assert.equal(await archiveRunToS3("sess-gone", "user-1", "msg-1"), 0);
});

test("a session nobody deleted is untouched by any of this", async () => {
  // The guard has to be inert on the normal path: it sits in front of every
  // workspace sync there is.
  assert.equal(isSessionDeletedLocally("sess-live"), false);
  await assert.rejects(
    () => syncWorkspaceToS3(unusableHands(), "sess-live", "user-1"),
    /talked to the sandbox/,
    "a live session's sync must still probe its sandbox and upload",
  );
});

test("what the pod remembers is bounded", async () => {
  // One entry per session this pod ever saw deleted would be a slow leak in a
  // process that runs for weeks. Entries only need to outlive the run being
  // torn down, so the oldest are the ones to lose.
  for (let i = 0; i < 1_200; i++) markSessionDeleted(`sess-${i}`);

  assert.equal(isSessionDeletedLocally("sess-0"), false, "the oldest gave way");
  assert.equal(isSessionDeletedLocally("sess-1199"), true, "the newest is what matters");
});

test("being told twice is not two entries", async () => {
  // The cleanup notification and the tombstone check both report the same
  // deletion, and on the ordinary path both fire.
  markSessionDeleted("sess-x");
  markSessionDeleted("sess-x");

  assert.equal(isSessionDeletedLocally("sess-x"), true);
});
