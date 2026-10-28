// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The API's half of "a foreground Stop does not end the application": the Stop
 * (`stopSessionRuns`) publishes `interrupt.<sessionId>` and cancels the session's
 * chat rows only, so the app run's row is left alone; and the interrupts that are
 * meant for the application -- its cancel and the sweeper's budget backstop -- are
 * addressed to its own task id, the name Brain registers it under
 * (brain/src/tasks/abort-registry.ts). Over a real Postgres; skipped without
 * DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("app run and Stop", { skip }, () => {
  let c: AdmissionCluster;
  let chatRun: typeof import("../src/tasks/chat-run.js");
  let lifecycle: typeof import("../src/tasks/lifecycle.js");
  let originalPublish: (subject: string) => void;
  const published: string[] = [];
  const sql = async (text: string, params: unknown[] = []) => (await c.app.db.db.query(text, params)).rows as any[];

  before(async () => {
    c = await startAdmissionCluster({ APP_RUNS_ENABLED: "true" });
    chatRun = await import("../src/tasks/chat-run.js");
    lifecycle = await import("../src/tasks/lifecycle.js");
    originalPublish = chatRun.chatRunPorts.publishInterrupt;
    chatRun.chatRunPorts.publishInterrupt = (subject: string) => { published.push(subject); };
  });
  after(async () => {
    chatRun.chatRunPorts.publishInterrupt = originalPublish;
    await c?.stop();
  });
  beforeEach(async () => {
    published.length = 0;
    for (const t of ["claw_tasks", "claw_sessions"]) await sql(`DELETE FROM ${t}`);
    await sql("INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status) VALUES ('s1', 't', 'u-1', 'claw', 'running')");
    await sql(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, mode, executor, lease_owner, lease_expires_at)
       VALUES ('app-1', 's1', 'app', 'running', 'task', 'app', 'brain', 'brain-A', NOW() + interval '1 hour')`,
    );
    await sql(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, metadata, lease_owner, lease_expires_at)
       VALUES ('chat-1', 's1', 'chat', 'running', 'chat', 'brain', '{"message_id":"claw-1"}'::jsonb, 'brain-A', NOW() + interval '1 hour')`,
    );
  });

  test("a Stop is published to the session and cancels the chat turn, not the application's row", async () => {
    await chatRun.stopSessionRuns("s1");
    assert.deepEqual(published, ["interrupt.s1"]);
    const rows = Object.fromEntries((await sql("SELECT task_id, status FROM claw_tasks")).map((r) => [r.task_id, r.status]));
    assert.equal(rows["app-1"], "running", "the application's row is untouched");
    assert.notEqual(rows["chat-1"], "running", "the turn was stopped");
  });

  test("the application's own cancel is addressed to its task id; a chat cancel stays on the session", async () => {
    const app = await lifecycle.cancelTask("app-1");
    assert.equal(app.ok, true);
    assert.equal(app.interrupt_key, "app-1");
    const chat = await lifecycle.cancelTask("chat-1");
    assert.equal(chat.interrupt_key, "s1");
  });

  test("interruptKeyOf: a DAG node answers to its root, an app run to itself, anything else to its session", () => {
    const k = lifecycle.interruptKeyOf;
    assert.equal(k({ task_id: "t", session_id: "s", dag_root_task_id: "root", mode: "llm" }), "root");
    assert.equal(k({ task_id: "t", session_id: "s", dag_root_task_id: null, mode: "app" }), "t");
    assert.equal(k({ task_id: "t", session_id: "s", dag_root_task_id: null, mode: "llm" }), "s");
  });
});
