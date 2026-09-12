// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One counted A2A row per `(session_id, message_id)` execution.
 *
 * Without uniqueness enforced where the row is written, a resend of one pair
 * observes the single row the aggregate collapsed it to, clears the ceiling,
 * and executes again -- indefinitely, while being counted once.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("an A2A execution is the session and message pair", { skip }, () => {
  let harness: AdmissionCluster;

  before(async () => { harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "2" }); });
  after(async () => { await harness?.stop(); });

  const open = (sessionId: string, messageId: string) =>
    harness.app.chatRun.openChatRun({
      dispatch: "fat",
      origin: "a2a",
      sessionId,
      userId: "a2a",
      messageId,
      prompt: "hello",
      status: "preparing",
      issueLease: false,
      recordWorkspaceUse: false,
    });

  const rowCount = async (sessionId: string) => {
    const r = await harness.app.db.db.query(
      "SELECT COUNT(*)::int AS n FROM claw_tasks WHERE session_id = $1", [sessionId],
    );
    return Number((r.rows[0] as { n: number }).n);
  };

  test("a repeated pair executes exactly once against a hard ceiling of two", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const { admission } = harness.app;
    const ask = { origin: "a2a" as const, newRunRoots: 1 as const, sandboxes: 0, gpuNodes: 0 };

    // Three sends carrying one pair. The first executes; the second and third
    // are told the execution already exists and publish nothing.
    const first = await open("a2a-1", "msg-1");
    assert.ok(first, "the first send opens the execution");
    for (const repeat of [2, 3]) {
      assert.equal(await open("a2a-1", "msg-1"), null, `send ${repeat} writes no second row`);
    }
    assert.equal(await rowCount("a2a-1"), 1, "one counted row, whatever the client resends");

    // A different message id on that session is a second execution, and the
    // one after it is the excess the ceiling refuses.
    assert.equal((await admission.decideAdmission(ask)).kind, "admit");
    assert.ok(await open("a2a-1", "msg-2"), "a distinct pair is a distinct execution");
    assert.equal(await rowCount("a2a-1"), 2);
    const third = await admission.decideAdmission(ask);
    assert.equal(third.kind, "reject");
    assert.equal((third as { reason: string }).reason, "runs_hard_limit");
  });

  test("two sessions may present the same client-minted message id", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    assert.ok(await open("a2a-x", "shared-id"));
    assert.ok(await open("a2a-y", "shared-id"), "the pair is the identity, never the id alone");
    assert.equal(await rowCount("a2a-x"), 1);
    assert.equal(await rowCount("a2a-y"), 1);
  });

  test("an a2a row is counted in every dimension and closed by its message id", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const run = await harness.app.chatRun.openChatRun({
      dispatch: "fat", origin: "a2a", sessionId: "a2a-z", userId: "a2a",
      messageId: "msg-z", prompt: "hello", status: "preparing", issueLease: false,
      recordWorkspaceUse: false, sandboxSpec: "default",
      spec: { topology: { nodes: 4 } },
    });
    assert.ok(run);
    const usage = await harness.app.admission.loadUsage();
    assert.equal(usage.runRoots, 1);
    assert.equal(usage.sandboxes, 1);
    assert.equal(usage.gpuNodes, 4);

    const closed = await harness.app.chatRun.closeChatRun("a2a-z", "msg-z", "completed");
    assert.deepEqual(closed, [run.taskId], "exec_complete closes the a2a row like any other");
    assert.equal((await harness.app.admission.loadUsage()).runRoots, 0);
  });

  test("a retry of an a2a row is refused and inserts nothing", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const run = await open("a2a-r", "msg-r");
    assert.ok(run);
    await harness.app.db.db.query(
      "UPDATE claw_tasks SET status = 'failed', completed_at = NOW() WHERE task_id = $1",
      [run.taskId],
    );
    const lifecycle = await import("../src/tasks/lifecycle.js");
    assert.deepEqual(await lifecycle.retryTask(run.taskId), { ok: false });
    assert.equal(await rowCount("a2a-r"), 1);
  });
});
