// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * W3 of sandbox-allowed-namespaces.test.ts, on a real Postgres: a DAG whose
 * node sandbox names a workspace the deployment does not isolate
 * (SANDBOX_ALLOWED_NAMESPACES) is refused 400 on `POST /v1/sessions/:id/tasks`
 * and on `POST /v1/batches`, and writes nothing; the same DAG naming a listed
 * workspace, none, or a template rendered at dispatch is admitted, and with no
 * list every workspace is admitted as before.
 *
 * Nothing that opens the database is imported at the top of this file: the
 * pool is built from DATABASE_URL when it is first imported, and
 * startAdmissionCluster points that at this file's own database first.
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { SANDBOX_WORKSPACE_NOT_ALLOWED } from "@claw/protocol";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const LISTED = { SANDBOX_ALLOWED_NAMESPACES: "ws-isolated, ws-gpu" };

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.SANDBOX_ALLOWED_NAMESPACES;
  delete process.env.SANDBOX_ALLOWED_NAMESPACES;
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.SANDBOX_ALLOWED_NAMESPACES;
    else process.env.SANDBOX_ALLOWED_NAMESPACES = saved;
  }
}

describe("W3 DAG node sandboxes", { skip: postgresSkipReason() }, () => {
  const SUBMITTER = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "pk-u1", virtualKey: "vk-u1" };
  const node = (namespace?: string) => ({
    id: "n0", executor: "brain", mode: "llm", depends_on: [],
    sandbox: { handle: "ws", image: "registry.example.invalid/img:1", ...(namespace ? { namespace } : {}) },
  });
  let harness: AdmissionCluster;
  let app: FastifyInstance;
  const q = (text: string, params: unknown[] = []) => harness.app.db.db.query(text, params);
  const countTasks = async () => Number(((await q("SELECT COUNT(*)::int AS n FROM claw_tasks")).rows[0] as { n: number }).n);

  before(async () => {
    harness = await startAdmissionCluster({});
    await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s-ns', 't', 'u1', 'claw')");
    const derived = JSON.stringify({ derived: { root_node_id: "n0", handle_last_user: { ws: "n0" }, schema_digest: "d" } });
    for (const [id, ns] of [["dag-open", "ws-open"], ["dag-listed", "ws-isolated"], ["dag-default", undefined], ["dag-template", "{{input.ws}}"]] as const) {
      await q(
        `INSERT INTO claw_task_dags (dag_id, name, nodes, metadata, owner_user_id, is_public)
         VALUES ($1, $1, $2::jsonb, $3::jsonb, 'u1', true)`,
        [id, JSON.stringify([node(ns)]), derived],
      );
    }
    const tasks = await import("../src/routes/tasks.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => { (req as unknown as { user: unknown }).user = SUBMITTER; });
    await tasks.registerTaskCreateRoute(app);
    await tasks.registerBatchRoute(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await harness?.stop();
  });
  beforeEach(async () => {
    await q("DELETE FROM claw_tasks");
    await q("DELETE FROM claw_batches");
  });

  const createTask = (dag: string) => app.inject({ method: "POST", url: "/v1/sessions/s-ns/tasks", payload: { dag_id: dag, input: {} } });
  const createBatch = (dag: string) => app.inject({ method: "POST", url: "/v1/batches", payload: { session_id: "s-ns", dag_id: dag, inputs: [{}] } });

  test("a node sandbox naming a workspace off the list is refused 400 on both surfaces, and nothing is written", async () => {
    await withEnv(LISTED, async () => {
      for (const [surface, res] of [["tasks", await createTask("dag-open")], ["batches", await createBatch("dag-open")]] as const) {
        assert.equal(res.statusCode, 400, `${surface}: ${res.body}`);
        const body = res.json() as { error: string; workspace: string };
        assert.equal(body.error, SANDBOX_WORKSPACE_NOT_ALLOWED, surface);
        assert.equal(body.workspace, "ws-open", surface);
      }
      assert.equal(await countTasks(), 0, "a refused DAG wrote tasks");
    });
  });

  test("the same DAG naming a listed workspace, none, or a template is admitted", async () => {
    await withEnv(LISTED, async () => {
      for (const dag of ["dag-listed", "dag-default", "dag-template"]) {
        const res = await createTask(dag);
        assert.equal(res.statusCode, 200, `${dag}: ${res.body}`);
      }
      assert.ok(await countTasks() > 0);
    });
  });

  test("with no list, the DAG naming any workspace is admitted as before", async () => {
    await withEnv({}, async () => {
      const res = await createTask("dag-open");
      assert.equal(res.statusCode, 200, res.body);
    });
  });
});
