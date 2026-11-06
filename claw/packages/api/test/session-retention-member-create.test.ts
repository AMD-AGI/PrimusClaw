// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A team member cannot be created under a parent while the parent's deletion is
 * in flight.
 *
 * The retention pass locks the parent `FOR UPDATE`, locks and rechecks its
 * existing members, and commits. A member inserted after that recheck but before
 * the commit would leave a deleted parent with a running member, so both ways a
 * member is attached -- the chat create (`admitParentedSessionCreate`) and the
 * A2A send with `parent_session_id` -- read the parent `FOR KEY SHARE`. The
 * deletion here is the same lock statement the deletion takes, held open on a
 * second connection so the create can be seen waiting on it, then committed
 * with the parent deleted. Skipped without DATABASE_URL; a skip is not a pass.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

const OWNER = { userId: "u1", userName: "u1", roles: ["user"], platformKey: "pk", virtualKey: "vk" };

describe("a member create waits for its parent's deletion", { skip }, () => {
  let harness: AdmissionCluster;
  let app: FastifyInstance;

  const query = (sql: string, params: unknown[] = []) => harness.app.db.db.query(sql, params);

  before(async () => {
    // No ceiling: the production default, where no admission lock serialises anything.
    harness = await startAdmissionCluster({});
    const a2a = await import("../src/routes/a2a.js");
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = OWNER; });
    await a2a.registerA2ARoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await harness?.stop();
  });

  const seedParent = async (id: string) => {
    await query("DELETE FROM claw_tasks");
    await query("DELETE FROM claw_sessions");
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, status)
       VALUES ($1, 'lead', 'u1', 'claw', 'idle', 'archived')`,
      [id],
    );
  };

  /**
   * Hold the parent as a deletion does, run `create`, and report whether it was
   * seen waiting on a lock before the deletion committed.
   */
  const raceDeletion = async <T>(parent: string, create: () => Promise<T>) => {
    const deleter = await harness.connect();
    try {
      await deleter.query("BEGIN");
      await deleter.query("SELECT 1 FROM claw_sessions WHERE session_id = $1 FOR UPDATE", [parent]);
      let settled = false;
      const pending = create().finally(() => { settled = true; });
      let waited = false;
      for (let i = 0; i < 100 && !waited && !settled; i++) {
        const r = await deleter.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND datname = current_database()`);
        waited = r.rows.length > 0;
        if (!waited) await new Promise((res) => setTimeout(res, 50));
      }
      await deleter.query(
        "UPDATE claw_sessions SET deleted_at = NOW(), status = 'deleted' WHERE session_id = $1",
        [parent],
      );
      await deleter.query("COMMIT");
      return { waited, result: await pending };
    } finally {
      await deleter.end();
    }
  };

  const children = async (parent: string) =>
    (await query("SELECT session_id FROM claw_sessions WHERE parent_session_id = $1", [parent])).rowCount;

  test("a chat create naming the parent waits, then is refused as not found", async () => {
    await seedParent("lead-chat");
    const { waited, result } = await raceDeletion("lead-chat", () =>
      harness.app.sessions.admitParentedSessionCreate("lead-chat", OWNER as never, {
        sessionId: "member-chat", name: "member", userId: "u1", mode: "claw",
        agentStatus: "running", systemPrompt: "", config: {}, parentSid: "lead-chat", role: "",
      }));
    assert.ok(waited, "the create waited on the parent's lock");
    assert.equal(result?.statusCode, 404);
    assert.equal(result?.response.error, "parent_session_not_found");
    assert.equal(await children("lead-chat"), 0, "no member was written under the deleted parent");
  });

  test("an A2A send attaching to the parent waits, then is refused", async () => {
    await seedParent("lead-a2a");
    const { waited, result } = await raceDeletion("lead-a2a", () => app.inject({
      method: "POST",
      url: "/a2a",
      headers: { "a2a-version": "1.0" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: { messageId: "m-member", role: "user", parts: [{ text: "hello" }] },
          metadata: { parent_session_id: "lead-a2a" },
          configuration: { returnImmediately: true },
        },
      },
    }));
    assert.ok(waited, "the send waited on the parent's lock");
    assert.equal(
      (JSON.parse(result.body) as { error?: { message?: string } }).error?.message,
      "Failed to create task",
    );
    assert.equal(await children("lead-a2a"), 0, "no member was attached to the deleted parent");
  });
});
