// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run whose sandbox the platform could not provide reads as failed, with why,
 * on a real Postgres through the real create route, claim, completion consumer
 * and runs route.
 *
 * On 2026-11-17 such a run answered `GET /v1/runs` with `class: exited`,
 * `exit_code: null` and an empty `failure_reason`, and the session read idle:
 * nothing a caller could read said the sandbox never started. The worker now
 * reports the run's failure beside the turn's normal ending (`run_failure_reason`,
 * `run_failure_message`), and a task's callback reports it as an error with a
 * `failure_message`. Skipped without DATABASE_URL; a skip is not a pass.
 *
 * Coverage:
 *   F1 a turn that answered without its sandbox: the run is failed with the code and the platform's account,
 *      and the conversation keeps the answer and goes idle as for any turn
 *   F2 the same turn without the fields is a run that exited, as before
 *   F3 a task's callback with a failure message: the run says it beside the code
 */

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import {
  DOORBELL_SEMANTICS_VERSION, RUN_FAILURE_MESSAGE_FIELD, RUN_FAILURE_REASON_FIELD, isRunDoorbell, type RunDoorbell,
} from "@claw/protocol";

import type { UserInfo } from "../src/auth/models.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { postgresSkipReason } from "./support/pg-cluster.js";

const skip = postgresSkipReason();
const USER = "user-run-failure";
/** The provider's account of the 2026-11-17 sandbox, as the run received it. */
const WHY = "workload claw-1-sandbox-m2c89 could not be scheduled: no node can take the sandbox right now, and no new "
  + "node is being added (admitted by the platform, but no node took its pod for 302s; phase=notready)";

let harness: AdmissionCluster;
let client: pg.Client;
let app: FastifyInstance;
let ports: typeof import("../src/sessions/dispatch.js")["sessionDispatchPorts"];
let originalPorts: typeof ports;
let gate: typeof import("../src/tasks/doorbell-gate.js");
let published: RunDoorbell[];
let consumerErrors: unknown[];

before(async () => {
  if (skip) return;
  harness = await startAdmissionCluster({ RUN_DOORBELL_DISPATCH: "true" });
  client = await harness.connect();
  ({ sessionDispatchPorts: ports } = await import("../src/sessions/dispatch.js"));
  originalPorts = { ...ports };
  gate = await import("../src/tasks/doorbell-gate.js");
  const { tombstoneReader } = await import("../src/events/consumer.js");
  Object.assign(tombstoneReader, { has: async () => false });
  const { registerRunRoutes } = await import("../src/runs/routes.js");
  app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = {
      userId: USER, userName: USER, roles: ["default"], platformKey: "pk-test", virtualKey: "vk-test",
    };
  });
  await harness.app.sessions.registerSessionRoutes(app);
  await registerRunRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  if (skip) return;
  await client.query("TRUNCATE claw_tasks, claw_sessions, claw_workspaces CASCADE");
  await client.query("TRUNCATE claw_conversation_turns");
  await client.query("TRUNCATE claw_session_events");
  Object.assign(ports, originalPorts);
  published = [];
  consumerErrors = [];
  gate.setDoorbellLatch({ state: "floor", version: DOORBELL_SEMANTICS_VERSION });
  ports.publishSse = () => {};
});

after(async () => {
  if (skip) return;
  Object.assign(ports, originalPorts);
  gate.resetDoorbellGate();
  await app?.close();
  await harness?.stop();
});

/** The worker's report, through the real completion consumer. */
async function deliverCompletion(doorbell: RunDoorbell, extra: Record<string, unknown>): Promise<void> {
  const { consumeEventDelivery } = await import("../src/events/consumer.js");
  const { sc } = await import("../src/infra/nats.js");
  const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
  resetDeletedSessionCache();
  await consumeEventDelivery({
    subject: `events.${doorbell.session_id}`,
    data: sc.encode(JSON.stringify({
      type: "exec_complete",
      session_id: doorbell.session_id,
      message_id: doorbell.message_id,
      task_id: doorbell.task_id,
      user_id: USER,
      prompt: "start the session",
      final_text: "I could not start anything: the sandbox could not be scheduled.",
      failed: false,
      error_count: 1,
      skills_used: {},
      ...extra,
    })),
    seq: 1,
    ack: () => {}, nak: () => {},
  }).catch((err) => { consumerErrors.push(err); });
}

/** Create a session with a message; its worker claims the run and reports `extra` on its completion. */
async function runTurn(extra: Record<string, unknown>): Promise<{ sessionId: string; runId: string }> {
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  ports.publishTask = async (_subject, payload) => {
    const doorbell: unknown = JSON.parse(payload);
    assert.ok(isRunDoorbell(doorbell));
    published.push(doorbell);
    assert.ok(await claimRunById(doorbell.task_id, "brain-1"), "the worker claimed the row");
    await deliverCompletion(doorbell, extra);
    return 1;
  };
  const response = await app.inject({
    method: "POST", url: "/v1/sessions",
    payload: { name: "probe", message: { content: "start the session", timeout: 25_200 } },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(consumerErrors, []);
  assert.equal(published.length, 1);
  return { sessionId: published[0]!.session_id, runId: published[0]!.task_id };
}

async function runView(sessionId: string) {
  const response = await app.inject({ method: "GET", url: `/v1/runs?session_ids=${sessionId}` });
  assert.equal(response.statusCode, 200, response.body);
  const runs = (response.json() as { runs: Array<Record<string, any>> }).runs;
  assert.equal(runs.length, 1, response.body);
  return runs[0]!;
}

test("F1 a turn that answered without its sandbox is a failed run, with the code and the platform's account", { skip }, async () => {
  const { sessionId, runId } = await runTurn({
    [RUN_FAILURE_REASON_FIELD]: "sandbox_unschedulable",
    [RUN_FAILURE_MESSAGE_FIELD]: WHY,
  });
  const run = await runView(sessionId);
  assert.equal(run.run_id, runId);
  assert.equal(run.phase, "terminal");
  assert.equal(run.terminal.class, "failed");
  assert.equal(run.terminal.kill_reason, "");
  assert.equal(run.terminal.failure_reason, "sandbox_unschedulable");
  assert.equal(run.terminal.failure_message, WHY);
  const { rows: [row] } = await client.query(
    "SELECT status, failure_reason, error_message FROM claw_tasks WHERE task_id = $1", [runId],
  );
  assert.deepEqual(row, { status: "failed", failure_reason: "sandbox_unschedulable", error_message: WHY });
  // The conversation's ending is a turn's like any other: the answer is in it and the session takes the next message.
  const { rows: [session] } = await client.query("SELECT agent_status FROM claw_sessions WHERE session_id = $1", [sessionId]);
  assert.equal(session.agent_status, "idle");
  const { rows: turns } = await client.query(
    "SELECT role, content FROM claw_conversation_turns WHERE session_id = $1 ORDER BY turn_index", [sessionId],
  );
  assert.ok(turns.some((t) => t.role === "assistant" && /could not be scheduled/.test(t.content)), JSON.stringify(turns));
});

test("F2 the same turn without the fields is a run that exited, as before", { skip }, async () => {
  const { sessionId } = await runTurn({});
  const run = await runView(sessionId);
  assert.equal(run.terminal.class, "exited");
  assert.equal(run.terminal.failure_reason, "");
  assert.equal(run.terminal.failure_message, "");
});

test("F3 a task's callback with a failure message: the run says it beside the code", { skip }, async () => {
  await client.query(`INSERT INTO claw_sessions (session_id, user_id, name) VALUES ('s-task', $1, 'task')`, [USER]);
  await client.query(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, origin) VALUES ('ktsk_task', 's-task', 'task', 'running', 'task')`,
  );
  await harness.app.lifecycle.applyAgentDone("ktsk_task", {
    final_text: "I could not start anything.",
    abort_reason: "error",
    failure_reason: "sandbox_pending_timeout",
    failure_message: "workload wl-2 still waiting for capacity after 10800.0s (phase=notready)",
  });
  const run = await runView("s-task");
  assert.equal(run.terminal.class, "killed", "a provisioning timeout is the platform's, as before");
  assert.equal(run.terminal.failure_reason, "sandbox_pending_timeout");
  assert.equal(run.terminal.failure_message, "workload wl-2 still waiting for capacity after 10800.0s (phase=notready)");
});
