// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A ceiling is never allowed to answer a question about someone else's tree.
 *
 * The tree bounds are decided from a recursive walk of `claw_sessions`, and that
 * walk has no tenant predicate -- it cannot have one, because the same function
 * serves the chat surface, which scopes by `user_id`, and the A2A surface, which
 * scopes by `a2a_caller_id`. So the scoping has to be the order the send runs
 * in: authorise the id the caller named, then read its shape, then decide. Ask
 * first and the refusal itself is the answer -- "that tree is full" for a task
 * that exists and belongs to a stranger, "no such task" for one that does not,
 * which is an existence oracle over every row in the table, reported to a caller
 * who was never entitled to either answer.
 *
 * `ADMIT_TREE_MAX_NODES = 1` is the smallest configuration that makes the two
 * answers differ, and it is the honest one: a fleet that wants no session trees
 * at all sets exactly this.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

const CALLER = { userId: "u-a2a", userName: "u-a2a", roles: ["user"], platformKey: "pk", virtualKey: "vk" };
const STRANGER = "user:u-other";

describe("an A2A send learns nothing about another tenant's tree", { skip }, () => {
  let harness: AdmissionCluster;
  let app: FastifyInstance;

  const query = (sql: string, params: unknown[] = []) => harness.app.db.db.query(sql, params);

  const send = (message: unknown, metadata?: unknown) => app.inject({
    method: "POST",
    url: "/a2a",
    headers: { "a2a-version": "1.0" },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: { message, metadata, configuration: { returnImmediately: true } },
    },
  });

  const errorOf = (raw: string) => (JSON.parse(raw) as { error?: { message?: string } }).error?.message;

  before(async () => {
    harness = await startAdmissionCluster({ ADMIT_TREE_MAX_NODES: "1" });
    const a2a = await import("../src/routes/a2a.js");
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = CALLER; });
    await a2a.registerA2ARoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await harness?.stop();
  });

  test("the tree bound is configured, or neither case below reads a tree at all", () => {
    assert.equal(harness.app.admission.envAdmitLimits().treeMaxNodes, 1);
  });

  test("a stranger's task id is not found, rather than reported as over its ceiling", async () => {
    await query("DELETE FROM claw_tasks");
    await query("DELETE FROM claw_sessions");
    // Two nodes under another caller: the existing-task branch is decided on the
    // shape as it stands, so this tree is strictly past a bound of one.
    await query(
      `INSERT INTO claw_sessions
         (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id, parent_session_id)
       VALUES
         ('a2a-other-root','root','a2a','claw','idle','ctx-o1',$1,NULL),
         ('a2a-other-child','child','a2a','claw','input_required','ctx-o2',$1,'a2a-other-root')`,
      [STRANGER],
    );

    const res = await send({
      messageId: "m-peek", role: "user", parts: [{ text: "hello" }], taskId: "a2a-other-child",
    });

    assert.equal(
      errorOf(res.body), "Task not found",
      "the same answer an id that exists nowhere gets, which is the whole point",
    );
    assert.equal(
      (await query("SELECT 1 FROM claw_tasks")).rowCount, 0,
      "and a send refused for ownership opens no counted row",
    );
  });

  test("a stranger's session as parent is refused exactly as a parent that does not exist", async () => {
    await query("DELETE FROM claw_tasks");
    await query("DELETE FROM claw_sessions");
    // An ordinary chat session of another user: one node, so the prospective
    // shape is two against a bound of one, while a parent id that exists nowhere
    // is one against one and clears it. Before the ownership read was hoisted,
    // that difference was the oracle.
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id)
       VALUES ('s-other-plain','theirs','u-other','claw','idle','ctx-plain')`,
    );

    const stranger = await send(
      { messageId: "m-parent-real", role: "user", parts: [{ text: "hello" }] },
      { parent_session_id: "s-other-plain" },
    );
    const nowhere = await send(
      { messageId: "m-parent-none", role: "user", parts: [{ text: "hello" }] },
      { parent_session_id: "a2a-not-a-session" },
    );

    assert.equal(
      errorOf(stranger.body), errorOf(nowhere.body),
      "an existing parent the caller cannot write and a parent that is not there are one answer",
    );
    assert.equal(errorOf(stranger.body), "Failed to create task");
    assert.equal(
      (await query("SELECT 1 FROM claw_sessions WHERE user_id = 'a2a'")).rowCount, 0,
      "neither refusal leaves a session behind",
    );
  });
});
