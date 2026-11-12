// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With `CLAW_ASSISTANT_ENABLED` off nothing of the assistant runs: no query for a role, no route, no sweep,
 * no record of a turn's end, and a turn's request is exactly what it was. Real Postgres without the assistant's
 * tables, so any query that reaches for one fails loudly. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   O1  a turn's request is finished without a single statement, and without a change
 *   O2  the sweep does nothing
 *   O3  the MCP route is not registered
 *   O4  a completion does not ask for a worker turn's record, nor for a router turn's unsaid answer
 */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import Fastify from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("assistant switched off", { skip }, () => {
  let h: AdmissionCluster;
  before(async () => { h = await startAdmissionCluster({ CLAW_ASSISTANT_ENABLED: "false", CLAW_ASSISTANT_TOKEN_KEY: "" }); });
  after(async () => { await h?.stop(); });

  /** Every statement fails: a test that passes under it asked the database nothing. */
  async function withNoDatabase<T>(run: () => Promise<T>): Promise<T> {
    const real = h.app.db.db.query;
    (h.app.db.db as any).query = async (text: string) => { throw new Error(`the database was asked: ${text.slice(0, 60)}`); };
    try { return await run(); } finally { (h.app.db.db as any).query = real; }
  }

  test("O1 a turn's request is finished without a statement and without a change", async () => {
    const { applySessionRoleToTask } = await import("../src/assistant/role-profile.js");
    const task: Record<string, unknown> = { session_id: "s", task_id: "ktsk_1", message_id: "m", mcp_servers: { mine: { type: "http", url: "http://m" } } };
    const before = JSON.stringify(task);
    await withNoDatabase(() => applySessionRoleToTask(task, "any-session"));
    assert.equal(JSON.stringify(task), before);
  });

  test("O2 the sweep does nothing", async () => {
    const { sweepAssistant } = await import("../src/assistant/sweep.js");
    await withNoDatabase(async () => {
      await sweepAssistant();
    });
  });

  test("O3 the MCP route is not registered", async () => {
    const { registerAssistantMcpRoutes } = await import("../src/assistant/mcp.js");
    const app = Fastify();
    await registerAssistantMcpRoutes(app);
    const res = await app.inject({ method: "POST", url: "/v1/internal/assistant-mcp", payload: {} });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test("O4 a completion does not ask for a worker turn's record, nor for a router turn's unsaid answer", async () => {
    const { consumeEventDelivery, completionPorts, tombstoneReader } = await import("../src/events/consumer.js");
    const { sc } = await import("../src/infra/nats.js");
    const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
    await h.app.db.db.query("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s1', 't', 'u1', 'claw')");
    // A run that is open, so that the completion ends a run: without one the step that asks for a turn's record is never reached.
    await h.app.db.db.query(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, input, metadata, depends_on, created_at, queued_at)
       VALUES ('ktsk_1', 's1', 'chat', 'running', 'chat', 'brain', '{}'::jsonb, '{"message_id": "m1"}'::jsonb, '{}', NOW(), NOW())`,
    );
    const originalTombstone = { ...tombstoneReader };
    Object.assign(tombstoneReader, { has: async () => false });
    resetDeletedSessionCache();
    const original = completionPorts.recordWorkerTurnEnd;
    const originalUnsaid = completionPorts.deliverUnsaidAnswer;
    let asked = 0;
    completionPorts.recordWorkerTurnEnd = async (e) => { asked += 1; return original(e); };
    completionPorts.deliverUnsaidAnswer = async (e) => { asked += 1; return originalUnsaid(e); };
    const outcome: string[] = [];
    try {
      await consumeEventDelivery({
        subject: "events.s1",
        data: sc.encode(JSON.stringify({
          type: "exec_complete", session_id: "s1", user_id: "u1", message_id: "m1", task_id: "ktsk_1",
          prompt: "hi", final_text: "done", failed: false, error_count: 0, skills_used: {},
        })),
        seq: 1, ack: () => { outcome.push("ack"); }, nak: () => { outcome.push("nak"); },
      });
    } finally {
      completionPorts.recordWorkerTurnEnd = original;
      completionPorts.deliverUnsaidAnswer = originalUnsaid;
      Object.assign(tombstoneReader, originalTombstone);
      resetDeletedSessionCache();
    }
    assert.deepEqual(outcome, ["ack"], "the completion was handled");
    assert.equal((await h.app.db.db.query("SELECT status FROM claw_tasks WHERE task_id = 'ktsk_1'")).rows[0].status, "completed", "and it ended the run, which is what the record is asked for");
    assert.equal(asked, 0);
  });
});
