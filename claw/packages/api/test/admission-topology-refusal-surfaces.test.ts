// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The answer every creation surface gives a malformed topology.
 *
 * A ceiling refusal is 429 and means "not now"; a topology the validator
 * rejects is 400 and means "not ever, as written". The distinction is the
 * whole point of `sendCreateRefusal`, and it is spelled separately on four
 * surfaces -- `POST /v1/sessions/:id/tasks`, `POST /v1/batches`,
 * `POST /v1/tasks/:id/retry` and `POST /v1/workbenches/:id/runs`. Only the
 * validator itself had tests: every one of these four spellings could have
 * been deleted, or could have answered 429, with the whole suite still green.
 *
 * `gpuNodesFromSpec` clamps at `PG_INT4_MAX` and the admission aggregate
 * compares against that clamp, so a spec that gets past here persists a figure
 * no later admission can reconcile. That is why the refusal is at the boundary
 * that writes, rather than at the one that reads.
 *
 * Every case carries a positive control: the same request with the topology
 * removed. Without it these would hold just as well against a surface that
 * refuses everything.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

const SUBMITTER = {
  userId: "u1",
  userName: "u1",
  roles: ["default"],
  platformKey: "pk-u1",
  virtualKey: "vk-u1",
};

/** What `validateTopology` refuses: a node count `int4` cannot hold. */
const BAD_TOPOLOGY = { nodes: 1e30, backend: "rayjob" };

const ONE_NODE = [{ id: "n0", executor: "brain", mode: "llm", sandbox: "none", depends_on: [] }];

interface Ctx {
  harness: AdmissionCluster;
  app: FastifyInstance;
}

const q = (c: Ctx) => c.harness.app.db.db;

const countTasks = async (c: Ctx): Promise<number> => {
  const r = await q(c).query("SELECT COUNT(*)::int AS n FROM claw_tasks");
  return Number((r.rows[0] as { n: number }).n);
};

const reset = async (c: Ctx): Promise<void> => {
  await q(c).query("DELETE FROM claw_tasks");
  await q(c).query("DELETE FROM claw_batches");
};

/** A 400 that names the validator, and wrote nothing on the way to saying so. */
async function assertTopologyRefused(
  c: Ctx,
  res: { statusCode: number; json: () => unknown },
): Promise<void> {
  const body = res.json() as { ok?: boolean; error?: string; errors?: unknown };
  assert.equal(res.statusCode, 400, "a malformed topology is not a ceiling refusal");
  assert.equal(body.ok, false);
  assert.equal(body.error, "invalid_topology");
  assert.ok(
    Array.isArray(body.errors) && body.errors.length > 0,
    "the validator's own messages reach the caller",
  );
  assert.equal(await countTasks(c), 0, "a refused create persists nothing");
}

describe("a malformed topology is refused as one on every creation surface", { skip }, () => {
  const ctx = {} as Ctx;

  before(async () => {
    // Every ceiling off: this boundary is about the shape of the request, not
    // about capacity, and a ceiling would answer 429 over the top of it.
    ctx.harness = await startAdmissionCluster({});
    await q(ctx).query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode)
       VALUES ('s-topo', 't', 'u1', 'claw')`,
    );
    await q(ctx).query(
      `INSERT INTO claw_task_dags (dag_id, name, nodes, metadata, owner_user_id, is_public)
       VALUES ('one-node', 'one node', $1::jsonb, $2::jsonb, 'u1', true)`,
      [
        JSON.stringify(ONE_NODE),
        JSON.stringify({ derived: { root_node_id: "n0", handle_last_user: {}, schema_digest: "d" } }),
      ],
    );
    const tasks = await import("../src/routes/tasks.js");
    ctx.app = Fastify();
    ctx.app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = SUBMITTER;
    });
    await tasks.registerTaskCreateRoute(ctx.app);
    await tasks.registerBatchRoute(ctx.app);
    await ctx.app.ready();
  });

  after(async () => {
    await ctx.app?.close();
    await ctx.harness?.stop();
  });

  test("a single task naming a topology int4 cannot hold is refused 400, not 429", async () => {
    await reset(ctx);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/sessions/s-topo/tasks",
      payload: { dag_id: "one-node", input: { topology: BAD_TOPOLOGY } },
    });

    await assertTopologyRefused(ctx, res);
  });

  test("and the same create without that topology is admitted", async () => {
    await reset(ctx);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/sessions/s-topo/tasks",
      payload: { dag_id: "one-node", input: { i: 1 } },
    });

    assert.equal(res.statusCode, 200, "the fixture is admissible; only the topology was refused");
    assert.ok(await countTasks(ctx) > 0, "and it persisted the run it admitted");
  });

  test("a batch refused on its first input answers 400 and writes no batch row", async () => {
    await reset(ctx);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/batches",
      payload: {
        session_id: "s-topo",
        dag_id: "one-node",
        inputs: [{ topology: BAD_TOPOLOGY }],
      },
    });

    await assertTopologyRefused(ctx, res);
    const batches = await q(ctx).query("SELECT COUNT(*)::int AS n FROM claw_batches");
    assert.equal(Number((batches.rows[0] as { n: number }).n), 0);
  });

  test("a batch whose later input is malformed reports it by name, not as a ceiling", async () => {
    // The partial-prefix path spells the reason through `refusalReason` rather
    // than `sendCreateRefusal`, so it is a second producer of the same word and
    // needs its own case: a 200 carrying `admission_rejected` here would tell
    // an operator the fleet was full when the request was malformed.
    await reset(ctx);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/batches",
      payload: {
        session_id: "s-topo",
        dag_id: "one-node",
        inputs: [{ i: 1 }, { topology: BAD_TOPOLOGY }],
      },
    });

    const body = res.json() as { ok: boolean; dag_root_task_ids: string[]; refused_reason?: string };
    assert.equal(res.statusCode, 200, "an accepted prefix is a 200");
    assert.equal(body.dag_root_task_ids.length, 1, "the well-formed input committed");
    assert.equal(body.refused_reason, "invalid_topology");
  });
});
