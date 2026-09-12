// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A2A's half of the ceiling: what a send is charged for, and what a failed
 * publish must not leave behind.
 *
 * The ask is built from the resolved execution rather than from raw request
 * metadata, so a plugin's image or the default workload image is charged as the
 * sandbox it will be, and a declared topology as the GPU nodes it will hold.
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
import {
  failNextCommit, seedRun, startAdmissionCluster, type AdmissionCluster,
} from "./support/admission-cluster.js";

const skip = postgresSkipReason();

const CALLER = { userId: "u-a2a", userName: "u-a2a", roles: ["user"], platformKey: "pk", virtualKey: "vk" };

interface Ctx {
  harness: AdmissionCluster;
  app: FastifyInstance;
}

const send = (ctx: Ctx, message: unknown, metadata?: unknown) => ctx.app.inject({
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

const invoke = (ctx: Ctx) =>
  ctx.app.inject({ method: "POST", url: "/invoke", payload: { question: "hello" } });

const query = (ctx: Ctx, sql: string, params: unknown[] = []) =>
  ctx.harness.app.db.db.query(sql, params);

const clear = async (ctx: Ctx) => {
  await query(ctx, "DELETE FROM claw_tasks");
  await query(ctx, "DELETE FROM claw_sessions WHERE user_id = 'a2a'");
  await query(ctx, "DELETE FROM resources");
};

const errorOf = (raw: string) => (JSON.parse(raw) as { error?: { message?: string } }).error?.message;

const statusOfOnlyRun = async (ctx: Ctx) => {
  const rows = await query(ctx, "SELECT status FROM claw_tasks");
  assert.equal(rows.rowCount, 1, "exactly one counted row");
  return (rows.rows[0] as { status: string }).status;
};

/** What a send is charged for: the execution it resolved, not the words it used. */
function registerAskCases(ctx: () => Ctx): void {
  test("a declared topology is charged against the GPU ceiling", async () => {
    const c = ctx();
    await clear(c);
    const res = await send(
      c,
      { messageId: "m-gpu", role: "user", parts: [{ text: "hello" }] },
      { topology: { nodes: 8, backend: "rayjob" } },
    );
    assert.equal(errorOf(res.body), "admission_rejected", "eight nodes against a ceiling of four");
    const rows = await query(c, "SELECT 1 FROM claw_tasks");
    assert.equal(rows.rowCount, 0, "a refusal before any materialisation writes nothing");
    const sessions = await query(c, "SELECT 1 FROM claw_sessions WHERE user_id = 'a2a'");
    assert.equal(sessions.rowCount, 0, "and mints no session either");
  });

  test("a resolved default image is a sandbox, even when the request names none", async () => {
    const c = ctx();
    await clear(c);
    await query(
      c,
      `INSERT INTO resources (name, type, image, resource) VALUES ('d','default','registry/default','{}'::jsonb)`,
    );
    const q = await c.harness.connect();
    await seedRun(q, { taskId: "t-sandbox", sessionId: "s-other", status: "running", sandbox: true });

    const res = await send(c, { messageId: "m-sbx", role: "user", parts: [{ text: "hello" }] });
    assert.equal(
      errorOf(res.body), "admission_rejected",
      "the image the chain resolves is the one the execution will hold",
    );
  });
}

/** A publish that failed settles the row it opened, whichever target it had. */
function registerCompensationCases(ctx: () => Ctx): void {
  test("a failed publish settles the row the send created, rather than stranding it", async () => {
    const c = ctx();
    await clear(c);
    const res = await send(c, { messageId: "m-strand", role: "user", parts: [{ text: "hello" }] });
    assert.equal(res.statusCode, 200);
    assert.equal(errorOf(res.body), "Failed to create task");

    assert.equal(
      await statusOfOnlyRun(c), "cancelling",
      "an ambiguous failure keeps the accounting, settled rather than left preparing",
    );
  });

  test("a failed publish to an existing target keeps that target", async () => {
    const c = ctx();
    await clear(c);
    await query(
      c,
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id)
       VALUES ('a2a-live','live','a2a','claw','input_required','ctx-keep',$1)`,
      [`user:${CALLER.userId}`],
    );

    const res = await send(c, {
      messageId: "m-existing", role: "user", parts: [{ text: "hello" }], taskId: "a2a-live",
    });
    assert.equal(errorOf(res.body), "Failed to create task");

    assert.equal(await statusOfOnlyRun(c), "cancelling");
    const session = (await query(
      c, "SELECT agent_status, context_id FROM claw_sessions WHERE session_id = 'a2a-live'",
    )).rows[0] as { agent_status: string; context_id: string };
    assert.equal(
      session.agent_status, "pending",
      "a target that already existed keeps the send's write; it is never deleted",
    );
    assert.equal(session.context_id, "ctx-keep");
  });
}

/** The legacy entry, which asks the same ceiling the JSON-RPC one does. */
function registerLegacyInvokeCases(ctx: () => Ctx): void {
  test("the legacy invoke path is gated like every other entry", async () => {
    const c = ctx();
    await clear(c);
    const q = await c.harness.connect();
    for (let i = 0; i < 8; i++) {
      await seedRun(q, { taskId: `t-full-${i}`, sessionId: "s-other", status: "running" });
    }
    const res = await invoke(c);
    assert.equal(res.statusCode, 429);
    assert.equal(
      (JSON.parse(res.body) as { error: string }).error, "admission_rejected",
      "the legacy entry asks the same ceiling, so a full fleet refuses it too",
    );
    const sessions = await query(c, "SELECT 1 FROM claw_sessions WHERE user_id = 'a2a'");
    assert.equal(sessions.rowCount, 0, "and a refused invoke mints no session");
  });

  test("a legacy invoke inside the ceiling opens a counted row", async () => {
    const c = ctx();
    await clear(c);
    const res = await invoke(c);
    // The publish then fails, so the row is compensated -- what this asserts is
    // that the path is admitted rather than refused.
    assert.equal(res.statusCode, 500);
    assert.equal((JSON.parse(res.body) as { error: string }).error, "Failed to process request");
    assert.equal(
      await statusOfOnlyRun(c), "cancelling",
      "the send was admitted, opened its row, and that row is compensated",
    );
  });
}

/** The session and the row that references it commit together, or not at all. */
function registerAtomicityCases(ctx: () => Ctx): void {
  test("a commit that fails leaves no run row referencing the session it rolled back", async () => {
    const c = ctx();
    await clear(c);
    const restore = failNextCommit(c.harness.app.db.db.pool);
    try {
      const res = await send(c, { messageId: "m-commit", role: "user", parts: [{ text: "hello" }] });
      assert.equal(errorOf(res.body), "Failed to create task");
    } finally {
      restore();
    }

    assert.equal(
      (await query(c, "SELECT 1 FROM claw_sessions WHERE user_id = 'a2a'")).rowCount, 0,
    );
    assert.equal(
      (await query(c, "SELECT 1 FROM claw_tasks")).rowCount, 0,
      "the counted row shares the session's transaction, so it cannot outlive it",
    );
  });
}

describe("an A2A send is charged what it resolved, and strands nothing", { skip }, () => {
  const ctx = {} as Ctx;

  before(async () => {
    ctx.harness = await startAdmissionCluster({
      ADMIT_HARD_GPU_NODES: "4",
      ADMIT_HARD_SANDBOXES: "1",
      ADMIT_HARD_RUNS: "8",
    });
    const a2a = await import("../src/routes/a2a.js");
    ctx.app = Fastify();
    ctx.app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = CALLER; });
    await a2a.registerA2ARoutes(ctx.app);
    await ctx.app.ready();
  });
  after(async () => {
    await ctx.app?.close();
    await ctx.harness?.stop();
  });

  registerAskCases(() => ctx);
  registerCompensationCases(() => ctx);
  registerLegacyInvokeCases(() => ctx);
  registerAtomicityCases(() => ctx);
});
