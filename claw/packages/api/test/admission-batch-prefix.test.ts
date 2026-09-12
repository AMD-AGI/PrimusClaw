// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The commit boundary of `POST /v1/batches`: one transaction around the whole
 * expansion loop, so a batch leaves either its admitted prefix with a `size`
 * that matches it, or nothing at all.
 *
 * Which input the ceiling refuses is chosen by seeded occupancy alone -- the
 * batch's own admitted inputs count against it, because admission runs on the
 * batch's own transaction client and sees the rows it has not committed yet.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { seedRun, startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

// Outside kubernetes mode `stampSessionCredentials` refuses a caller without a
// platform key, and the route answers 403 instead of the boundary under test.
const SUBMITTER = {
  userId: "u1",
  userName: "u1",
  roles: ["default"],
  platformKey: "pk-u1",
  virtualKey: "vk-u1",
};

/** One entry node and no sandbox, so each admitted input is exactly one run root. */
const ONE_NODE = [{ id: "n0", executor: "brain", mode: "llm", sandbox: "none", depends_on: [] }];

interface Ctx {
  harness: AdmissionCluster;
  app: FastifyInstance;
}

const reset = async (ctx: Ctx) => {
  const q = ctx.harness.app.db.db;
  await q.query("DELETE FROM claw_tasks");
  await q.query("DELETE FROM claw_batches");
  await q.query("UPDATE claw_sessions SET config = '{}'::jsonb WHERE session_id = 's-batch'");
};

const submit = (ctx: Ctx, inputs: Array<Record<string, unknown>>) => ctx.app.inject({
  method: "POST",
  url: "/v1/batches",
  payload: { session_id: "s-batch", dag_id: "one-node", inputs },
});

const scalar = async (ctx: Ctx, sql: string, params: unknown[] = []) => {
  const r = await ctx.harness.app.db.db.query(sql, params);
  return r.rows[0] as Record<string, unknown> | undefined;
};

const count = async (ctx: Ctx, sql: string, params: unknown[] = []) =>
  Number((await scalar(ctx, sql, params))!.n);

/** The accepted prefix commits, and every row it wrote agrees on how long it is. */
function registerAcceptedPrefixCases(ctx: () => Ctx): void {
  test("a three-input batch refused on its third input commits the first two", async () => {
    const c = ctx();
    await reset(c);

    const res = await submit(c, [{ i: 1 }, { i: 2 }, { i: 3 }]);
    const body = res.json() as {
      ok: boolean;
      batch_id: string;
      dag_root_task_ids: string[];
      refused_reason?: string;
    };

    assert.equal(res.statusCode, 200, "an accepted prefix is a 200, never the refusal's 429");
    assert.equal(body.ok, true);
    assert.equal(body.dag_root_task_ids.length, 2, "the two inputs inside the ceiling");
    assert.equal(body.refused_reason, "runs_hard_limit");
    assert.match(body.batch_id, /^kbat_[0-9A-HJKMNP-TV-Z]{26}$/);

    const batch = await scalar(
      c,
      "SELECT size, status, session_id, dag_id FROM claw_batches WHERE batch_id = $1",
      [body.batch_id],
    );
    assert.equal(Number(batch!.size), 2, "size is the accepted count, never the requested three");
    assert.equal(batch!.status, "running");
    assert.equal(batch!.session_id, "s-batch");
    assert.equal(batch!.dag_id, "one-node");
    assert.equal(await count(c, "SELECT COUNT(*)::int AS n FROM claw_batches"), 1);

    assert.equal(
      await count(c, "SELECT COUNT(*)::int AS n FROM claw_tasks WHERE batch_id = $1", [body.batch_id]),
      2,
      "one brain node per admitted input, and none for the third",
    );
    assert.equal(
      await count(c, "SELECT COUNT(*)::int AS n FROM claw_tasks"),
      4,
      "two virtual DAG roots plus their two nodes",
    );

    const roots = await c.harness.app.db.db.query(
      "SELECT task_id FROM claw_tasks WHERE task_id = ANY($1::text[]) AND executor = 'dag'",
      [body.dag_root_task_ids],
    );
    assert.equal(roots.rowCount, 2, "the roots the response names are the committed ones");

    const cfg = await scalar(
      c,
      `SELECT config->>'platform_key' AS k, config->>'_server_managed_credentials' AS m
       FROM claw_sessions WHERE session_id = 's-batch'`,
    );
    assert.equal(cfg!.k, "pk-u1");
    assert.equal(cfg!.m, "true");
  });

  test("a batch every input of which is admitted keeps size at the requested count", async () => {
    const c = ctx();
    await reset(c);

    const res = await submit(c, [{ i: 1 }, { i: 2 }]);
    const body = res.json() as { batch_id: string; dag_root_task_ids: string[] };

    assert.equal(res.statusCode, 200);
    assert.equal(body.dag_root_task_ids.length, 2);
    assert.equal("refused_reason" in body, false, "nothing was refused, so nothing is reported");

    const batch = await scalar(
      c, "SELECT size FROM claw_batches WHERE batch_id = $1", [body.batch_id],
    );
    assert.equal(Number(batch!.size), 2);
  });
}

/** A wholly refused batch: the preparation is rolled back with the refusal. */
function registerWhollyRefusedCases(ctx: () => Ctx): void {
  test("a batch refused on its first input writes no batch row and no credential", async () => {
    const c = ctx();
    await reset(c);
    const q = await c.harness.connect();
    // Two committed run roots, so the very first input's ask is already over.
    await seedRun(q, { taskId: "t-full-1", sessionId: "s-batch", status: "queued" });
    await seedRun(q, { taskId: "t-full-2", sessionId: "s-batch", status: "running" });

    const res = await submit(c, [{ i: 1 }, { i: 2 }, { i: 3 }]);

    assert.equal(res.statusCode, 429, "a wholly refused batch is a refusal, never a 200 with zero roots");
    assert.deepEqual(res.json(), {
      ok: false,
      error: "admission_rejected",
      reason: "runs_hard_limit",
    });

    assert.equal(
      await count(c, "SELECT COUNT(*)::int AS n FROM claw_batches"),
      0,
      "the provisional INSERT was rolled back with the refusal",
    );
    assert.equal(
      await count(c, "SELECT COUNT(*)::int AS n FROM claw_batches WHERE size = 0"),
      0,
      "a wholly refused batch must not leave a size = 0 row",
    );

    const cfg = await scalar(
      c,
      `SELECT config::text AS c, config->>'platform_key' AS k
       FROM claw_sessions WHERE session_id = 's-batch'`,
    );
    assert.equal(cfg!.k, null, "the stamp was rolled back with the refusal");
    assert.equal(cfg!.c, "{}", "and nothing else was written to config either");

    assert.equal(
      await count(c, "SELECT COUNT(*)::int AS n FROM claw_tasks"),
      2,
      "only the two seeded occupants",
    );
    assert.equal(
      await count(c, "SELECT COUNT(*)::int AS n FROM claw_tasks WHERE dag_id = 'one-node'"),
      0,
    );
  });
}

describe("a batch commits its admitted prefix, or nothing", { skip }, () => {
  const ctx = {} as Ctx;

  before(async () => {
    ctx.harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "2" });
    const q = ctx.harness.app.db.db;
    await q.query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode)
       VALUES ('s-batch', 'b', 'u1', 'claw')`,
    );
    await q.query(
      `INSERT INTO claw_task_dags (dag_id, name, nodes, metadata, owner_user_id, is_public)
       VALUES ('one-node', 'one node', $1::jsonb, $2::jsonb, 'u1', true)`,
      [
        JSON.stringify(ONE_NODE),
        JSON.stringify({ derived: { root_node_id: "n0", handle_last_user: {}, schema_digest: "d" } }),
      ],
    );
    // `src/config.ts` reads every ADMIT_* once at load, so the route may only be
    // imported after the harness has set them.
    const tasks = await import("../src/routes/tasks.js");
    ctx.app = Fastify();
    ctx.app.addHook("preHandler", async (req) => { (req as unknown as { user: unknown }).user = SUBMITTER; });
    await tasks.registerBatchRoute(ctx.app);
    await ctx.app.ready();
  });
  after(async () => {
    await ctx.app?.close();
    await ctx.harness?.stop();
  });

  registerAcceptedPrefixCases(() => ctx);
  registerWhollyRefusedCases(() => ctx);
});
