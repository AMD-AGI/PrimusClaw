// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A resent A2A request executes once, from the request in.
 *
 * The pair `(session_id, message_id)` is enforced at write time by
 * `idx_tasks_a2a_execution`, and the whole point of enforcing it there rather
 * than by counting is that counting cannot see it: a resend observes the single
 * row the aggregate collapsed the pair to, finds the ceiling clear, and
 * executes again. So the ceiling here is two with one execution outstanding --
 * the repeats have room to run, and only the pair stops them.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

const CALLER = { userId: "u-a2a", userName: "u-a2a", roles: ["user"], platformKey: "pk", virtualKey: "vk" };
const TASK_SUBJECT = "tasks.execute";
const SESSION = "a2a-repeat";

interface Ctx {
  harness: AdmissionCluster;
  app: FastifyInstance;
  spy: typeof import("./support/jetstream-spy.js");
}

const send = (ctx: Ctx, message: unknown) => ctx.app.inject({
  method: "POST",
  url: "/a2a",
  headers: { "a2a-version": "1.0" },
  payload: {
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: { message, configuration: { returnImmediately: true } },
  },
});

const clear = async (ctx: Ctx) => {
  await ctx.harness.app.db.db.query("DELETE FROM claw_tasks");
  await ctx.harness.app.db.db.query("DELETE FROM claw_sessions WHERE user_id = 'a2a'");
  ctx.spy.clearPublished();
};

const seedSession = (ctx: Ctx) => ctx.harness.app.db.db.query(
  `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id)
   VALUES ($1,'repeat','a2a','claw','input_required','ctx-repeat',$2)`,
  [SESSION, `user:${CALLER.userId}`],
);

const executions = async (ctx: Ctx, sessionId: string): Promise<string[]> => {
  const rows = await ctx.harness.app.db.db.query(
    `SELECT metadata->>'message_id' AS message_id FROM claw_tasks
      WHERE session_id = $1 AND origin = 'a2a' ORDER BY created_at`,
    [sessionId],
  );
  return rows.rows.map((r) => (r as { message_id: string }).message_id);
};

const taskOf = (raw: string) =>
  (JSON.parse(raw) as {
    result?: { task?: { id: string; contextId: string; status: { state: string } } };
  }).result?.task;

const errorOf = (raw: string) => (JSON.parse(raw) as { error?: { message?: string } }).error?.message;

/** The pair is the identity: repeats of one are answered, counted and published once. */
function registerRepeatCases(ctx: () => Ctx): void {
  test("three sends of one pair open one row and publish once", async () => {
    const c = ctx();
    await clear(c);
    await seedSession(c);
    const message = { messageId: "m-repeat", role: "user", parts: [{ text: "hello" }], taskId: SESSION };

    const answers: string[] = [];
    for (const attempt of [1, 2, 3]) {
      const res = await send(c, message);
      assert.equal(res.statusCode, 200, `send ${attempt} is answered`);
      answers.push(res.body);
    }

    assert.deepEqual(await executions(c, SESSION), ["m-repeat"], "one counted row for the pair");
    const published = c.spy.publishedTo(TASK_SUBJECT);
    assert.equal(published.length, 1, "the repeats publish nothing");
    assert.equal(
      (JSON.parse(published[0].payload) as { message_id: string }).message_id, "m-repeat",
    );

    answers.forEach((body, i) => {
      const task = taskOf(body);
      assert.equal(task?.id, SESSION, `send ${i + 1} answers with the execution's task`);
      assert.equal(task?.contextId, "ctx-repeat");
      assert.equal(task?.status.state, "TASK_STATE_SUBMITTED");
    });
  });

  test("the ceiling had room for the repeats it refused", async () => {
    const c = ctx();
    const second = await send(c, {
      messageId: "m-second", role: "user", parts: [{ text: "hello" }], taskId: SESSION,
    });
    assert.equal(taskOf(second.body)?.id, SESSION, "a distinct message id is a distinct execution");
    assert.deepEqual(await executions(c, SESSION), ["m-repeat", "m-second"]);
    assert.equal(c.spy.publishedTo(TASK_SUBJECT).length, 2);

    const third = await send(c, {
      messageId: "m-third", role: "user", parts: [{ text: "hello" }], taskId: SESSION,
    });
    assert.equal(
      errorOf(third.body), "admission_rejected",
      "two is the ceiling, so the pair stopped the repeats",
    );
    assert.deepEqual(await executions(c, SESSION), ["m-repeat", "m-second"]);
    assert.equal(c.spy.publishedTo(TASK_SUBJECT).length, 2);
  });
}

/** The legacy entry carries no client identity, so it mints a pair per call. */
function registerLegacyInvokeCases(ctx: () => Ctx): void {
  test("a legacy invoke mints its own pair, so identical bodies are separate executions", async () => {
    const c = ctx();
    await clear(c);
    const body = { question: "hello" };

    const first = await c.app.inject({ method: "POST", url: "/invoke", payload: body });
    const second = await c.app.inject({ method: "POST", url: "/invoke", payload: body });
    const idOf = (raw: string) => (JSON.parse(raw) as { result: { task_id: string } }).result.task_id;
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.notEqual(idOf(first.body), idOf(second.body), "the legacy path carries no client identity");

    const rows = await c.harness.app.db.db.query(
      "SELECT DISTINCT metadata->>'message_id' AS message_id FROM claw_tasks WHERE origin = 'a2a'",
    );
    assert.equal(rows.rowCount, 2, "two executions, each with its own minted pair");
    assert.equal(c.spy.publishedTo(TASK_SUBJECT).length, 2);

    const third = await c.app.inject({ method: "POST", url: "/invoke", payload: body });
    assert.equal(third.statusCode, 429, "and the ceiling counts them both");
    assert.equal(c.spy.publishedTo(TASK_SUBJECT).length, 2);
  });
}

describe("a resent A2A request is one execution", { skip }, () => {
  const ctx = {} as Ctx;

  before(async () => {
    ctx.harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "2" });
    ctx.spy = await import("./support/jetstream-spy.js");
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

  registerRepeatCases(() => ctx);
  registerLegacyInvokeCases(() => ctx);
});
