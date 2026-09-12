// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A message-bearing child create is decided and written under one lock.
 *
 * With the `parent_session_id` INSERT on the pool ahead of dispatch, two such
 * creates both become visible before either admission check runs, and each then
 * reads a tree the other has already grown -- both admitted past the ceiling,
 * or both refused while one slot was free.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("a parented create is admitted and written atomically", { skip }, () => {
  let harness: AdmissionCluster;

  before(async () => {
    // Three nodes: a root and two children is the ceiling, so a tree of two is
    // exactly one node below it and only one of two racers may grow it.
    harness = await startAdmissionCluster({ ADMIT_TREE_MAX_NODES: "3" });
  });
  after(async () => { await harness?.stop(); });

  const seedTree = async (rootId: string, childId: string) => {
    const q = harness.app.db.db;
    await q.query("DELETE FROM claw_sessions");
    await q.query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, status)
       VALUES ($1, 'root', 'u1', 'claw', 'idle', 'active')`,
      [rootId],
    );
    await q.query(
      `INSERT INTO claw_sessions
         (session_id, name, user_id, mode, agent_status, status, parent_session_id)
       VALUES ($1, 'child', 'u1', 'claw', 'idle', 'active', $2)`,
      [childId, rootId],
    );
  };

  const newRow = (sessionId: string, parentSid: string) => ({
    sessionId, name: "child", userId: "u1", mode: "claw",
    agentStatus: "running", systemPrompt: "", config: {}, parentSid, role: "",
  });

  const operator = { userId: "u1", userName: "u1", roles: ["system-admin"], platformKey: "", virtualKey: "" };

  test("two concurrent creates one node below the ceiling admit exactly one", async () => {
    await seedTree("root-1", "child-1");
    const attempt = (id: string) =>
      harness.app.sessions.admitParentedSessionCreate(
        "root-1", operator as never, newRow(id, "root-1"),
      );

    const [first, second] = await Promise.all([attempt("new-a"), attempt("new-b")]);

    const refusals = [first, second].filter((r) => r !== null);
    assert.equal(refusals.length, 1, "exactly one of the two racers is refused");
    assert.equal(refusals[0]!.statusCode, 429);
    assert.deepEqual(refusals[0]!.response.error, "admission_rejected");
    assert.equal(refusals[0]!.response.reason, "tree_nodes_exceeded");

    // A reject rolls back, so the refused create leaves no session row at all.
    const rows = await harness.app.db.db.query(
      "SELECT session_id FROM claw_sessions WHERE session_id = ANY($1::text[])",
      [["new-a", "new-b"]],
    );
    assert.equal(rows.rowCount, 1, "the refused create wrote no session row");
  });

  test("a create that fits is admitted and its row is committed", async () => {
    await seedTree("root-2", "child-2");
    const refusal = await harness.app.sessions.admitParentedSessionCreate(
      "root-2", operator as never, newRow("new-c", "root-2"),
    );
    assert.equal(refusal, null);
    const rows = await harness.app.db.db.query(
      "SELECT parent_session_id FROM claw_sessions WHERE session_id = $1", ["new-c"],
    );
    assert.equal(rows.rows[0].parent_session_id, "root-2");
  });

  test("an unauthorised parent is refused without writing the child", async () => {
    await seedTree("root-3", "child-3");
    const refusal = await harness.app.sessions.admitParentedSessionCreate(
      "missing-parent", operator as never, newRow("new-d", "missing-parent"),
    );
    assert.equal(refusal?.statusCode, 404);
    const rows = await harness.app.db.db.query(
      "SELECT 1 FROM claw_sessions WHERE session_id = $1", ["new-d"],
    );
    assert.equal(rows.rowCount, 0);
  });
});
