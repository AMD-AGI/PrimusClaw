// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A refused create leaves nothing behind, and an unknown discard is a failure.
 *
 * `discardChatRunDispatch` shares its guard and its unmatched-row verdict with
 * `failChatRunDispatch`, so a row a worker already holds is still left to its
 * holder. The verdict a caller may not act on is `unknown`: that row is still
 * open, still unheld and still claimable, and answering `rejected` over it
 * tells the caller the turn was declined while claim-next runs it.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("a post-insert refusal erases its row", { skip }, () => {
  let harness: AdmissionCluster;

  before(async () => { harness = await startAdmissionCluster({}); });
  after(async () => { await harness?.stop(); });

  const openTurn = async (sessionId: string) => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const run = await harness.app.chatRun.openChatRun({
      dispatch: "doorbell", sessionId, userId: "u1", messageId: "m1",
      prompt: "hi", status: "queued", issueLease: false, recordWorkspaceUse: false,
    });
    assert.ok(run);
    return run.taskId;
  };

  const statusOf = async (taskId: string) => {
    const r = await harness.app.db.db.query(
      "SELECT status FROM claw_tasks WHERE task_id = $1", [taskId],
    );
    return r.rowCount ? (r.rows[0] as { status: string }).status : null;
  };

  test("an unheld open row is deleted, not recorded at failed", async () => {
    const taskId = await openTurn("s-discard");
    assert.equal(await harness.app.chatRun.discardChatRunDispatch(taskId), "closed");
    assert.equal(await statusOf(taskId), null, "no row survives a refusal, not even a failed one");
  });

  test("a row a worker holds is left to its holder", async () => {
    const taskId = await openTurn("s-held");
    await harness.app.db.db.query(
      `UPDATE claw_tasks SET lease_owner = 'brain-1', claim_count = 1 WHERE task_id = $1`,
      [taskId],
    );
    assert.equal(await harness.app.chatRun.discardChatRunDispatch(taskId), "held");
    assert.equal(await statusOf(taskId), "queued", "the holder's row is untouched");
  });

  test("a terminal row is closed, since nothing will execute it", async () => {
    const taskId = await openTurn("s-terminal");
    await harness.app.db.db.query(
      "UPDATE claw_tasks SET status = 'cancelled', completed_at = NOW() WHERE task_id = $1",
      [taskId],
    );
    assert.equal(await harness.app.chatRun.discardChatRunDispatch(taskId), "closed");
  });

  test("an open unheld row the statement did not match is unknown", async () => {
    const taskId = await openTurn("s-unknown");
    // A receipt version no pass may act on: the row stays open, unheld and
    // claimable, and the DELETE matches nothing.
    await harness.app.db.db.query(
      `UPDATE claw_tasks
          SET metadata = jsonb_set(metadata, '{dispatch_compensation}',
                '{"version":"99"}'::jsonb)
        WHERE task_id = $1`,
      [taskId],
    );
    assert.equal(await harness.app.chatRun.discardChatRunDispatch(taskId), "unknown");
    assert.equal(await statusOf(taskId), "queued", "and the row is left exactly as it was");
  });

  test("the discard and the settle bind one predicate", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../src/tasks/chat-run.ts", import.meta.url), "utf8");
    const uses = src.match(/WHERE \$\{unheldOpenRowSql\(/g) ?? [];
    assert.equal(uses.length, 2, "the DELETE and the UPDATE share the guard, verb aside");
    assert.match(src, /DELETE FROM claw_tasks\n\s*WHERE \$\{unheldOpenRowSql\(/);
  });
});
