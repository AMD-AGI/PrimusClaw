// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A2A's half of the ceiling: what a send asks for, and what a failed publish
 * must not leave behind.
 *
 * The ask used to be built from raw request metadata -- no GPU nodes at all,
 * and a sandbox only when the caller happened to name an image -- so a send
 * that resolved a plugin or the default workload image was charged nothing for
 * it. And the counted row was opened before the publish with no compensation,
 * so a publish that failed stranded the row, and its slice of every ceiling,
 * until its deadline.
 *
 * `initNats` is never called here, so `js.publish` throws: that is the publish
 * failure under test, and it is also why every admitted send in this file ends
 * in the compensation path. The throw is not a `NatsError`, so it is a failure
 * that proves nothing about whether the stream stored the message -- the
 * compensation therefore cancels the counted row rather than deleting it, and
 * leaves the session as the send wrote it. Which failures may delete instead is
 * `a2a-publish-failure-classes.test.ts`; what matters here is that the row is
 * settled at all rather than left `preparing` until its deadline.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { seedRun, startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

const CALLER = { userId: "u-a2a", userName: "u-a2a", roles: ["user"], platformKey: "pk", virtualKey: "vk" };

describe("an A2A send is charged what it resolved, and strands nothing", { skip }, () => {
  let harness: AdmissionCluster;
  let app: FastifyInstance;

  before(async () => {
    harness = await startAdmissionCluster({
      ADMIT_HARD_GPU_NODES: "4",
      ADMIT_HARD_SANDBOXES: "1",
      ADMIT_HARD_RUNS: "8",
    });
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

  const rpc = (method: string, params: unknown) => app.inject({
    method: "POST",
    url: "/a2a",
    headers: { "a2a-version": "1.0" },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });

  const send = (message: unknown, metadata?: unknown) =>
    rpc("SendMessage", { message, metadata, configuration: { returnImmediately: true } });

  const clear = async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    await harness.app.db.db.query("DELETE FROM claw_sessions WHERE user_id = 'a2a'");
    await harness.app.db.db.query("DELETE FROM resources");
  };

  const errorOf = (raw: string) => (JSON.parse(raw) as { error?: { message?: string } }).error?.message;

  test("a declared topology is charged against the GPU ceiling", async () => {
    await clear();
    const res = await send(
      { messageId: "m-gpu", role: "user", parts: [{ text: "hello" }] },
      { topology: { nodes: 8, backend: "rayjob" } },
    );
    assert.equal(errorOf(res.body), "admission_rejected", "eight nodes against a ceiling of four");
    const rows = await harness.app.db.db.query("SELECT 1 FROM claw_tasks");
    assert.equal(rows.rowCount, 0, "a refusal before any materialisation writes nothing");
    const sessions = await harness.app.db.db.query("SELECT 1 FROM claw_sessions WHERE user_id = 'a2a'");
    assert.equal(sessions.rowCount, 0, "and mints no session either");
  });

  test("a resolved default image is a sandbox, even when the request names none", async () => {
    await clear();
    await harness.app.db.db.query(
      `INSERT INTO resources (name, type, image, resource) VALUES ('d','default','registry/default','{}'::jsonb)`,
    );
    const q = await harness.connect();
    await seedRun(q, { taskId: "t-sandbox", sessionId: "s-other", status: "running", sandbox: true });

    const res = await send({ messageId: "m-sbx", role: "user", parts: [{ text: "hello" }] });
    assert.equal(
      errorOf(res.body), "admission_rejected",
      "the image the chain resolves is the one the execution will hold",
    );
  });

  test("a failed publish settles the row the send created, rather than stranding it", async () => {
    await clear();
    const res = await send({ messageId: "m-strand", role: "user", parts: [{ text: "hello" }] });
    assert.equal(res.statusCode, 200);
    assert.equal(errorOf(res.body), "Failed to create task");

    const rows = await harness.app.db.db.query("SELECT status FROM claw_tasks");
    assert.equal(rows.rowCount, 1, "an ambiguous failure keeps the accounting for possible work");
    assert.equal(
      (rows.rows[0] as { status: string }).status, "cancelling",
      "settled, not left preparing until its deadline",
    );
  });

  test("a failed publish to an existing target keeps that target", async () => {
    await clear();
    await harness.app.db.db.query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id)
       VALUES ('a2a-live','live','a2a','claw','input_required','ctx-keep',$1)`,
      [`user:${CALLER.userId}`],
    );

    const res = await send({
      messageId: "m-existing", role: "user", parts: [{ text: "hello" }], taskId: "a2a-live",
    });
    assert.equal(errorOf(res.body), "Failed to create task");

    const rows = await harness.app.db.db.query("SELECT status FROM claw_tasks");
    assert.equal(rows.rowCount, 1);
    assert.equal(
      (rows.rows[0] as { status: string }).status, "cancelling",
      "the counted row is settled, not left preparing",
    );
    const session = (await harness.app.db.db.query(
      "SELECT agent_status, context_id FROM claw_sessions WHERE session_id = 'a2a-live'",
    )).rows[0] as { agent_status: string; context_id: string };
    assert.equal(
      session.agent_status, "pending",
      "a target that already existed keeps the send's write; it is never deleted",
    );
    assert.equal(session.context_id, "ctx-keep");
  });

  test("the legacy invoke path is gated like every other entry", async () => {
    await clear();
    const q = await harness.connect();
    for (let i = 0; i < 8; i++) {
      await seedRun(q, { taskId: `t-full-${i}`, sessionId: "s-other", status: "running" });
    }
    const res = await app.inject({ method: "POST", url: "/invoke", payload: { question: "hello" } });
    assert.equal(res.statusCode, 429);
    assert.equal(
      (JSON.parse(res.body) as { error: string }).error, "admission_rejected",
      "legacy callers used to be the one entry that never asked",
    );
    const sessions = await harness.app.db.db.query("SELECT 1 FROM claw_sessions WHERE user_id = 'a2a'");
    assert.equal(sessions.rowCount, 0, "and a refused invoke mints no session");
  });

  test("a legacy invoke inside the ceiling opens a counted row", async () => {
    await clear();
    const res = await app.inject({ method: "POST", url: "/invoke", payload: { question: "hello" } });
    // The publish then fails, so the row is compensated -- what this asserts is
    // that the path is admitted rather than refused.
    assert.equal(res.statusCode, 500);
    assert.equal((JSON.parse(res.body) as { error: string }).error, "Failed to process request");
    const rows = await harness.app.db.db.query("SELECT status FROM claw_tasks");
    assert.equal(rows.rowCount, 1, "the send was admitted and opened its row");
    assert.equal(
      (rows.rows[0] as { status: string }).status, "cancelling",
      "and that row is compensated, not stranded",
    );
  });
});
