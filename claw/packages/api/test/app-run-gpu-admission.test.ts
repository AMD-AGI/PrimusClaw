// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An app run's GPU demand counts against the GPU-node admission ceiling, and it
 * is read from the resources the submitter requested, never from the app's own
 * input (whose `topology` key is the app's, not Claw's). Real Postgres.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_MANIFEST_SCHEMA } from "@claw/protocol";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const OWNER = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "pk-u1", virtualKey: "vk-u1" };
const MANIFEST = {
  schema: APP_MANIFEST_SCHEMA, name: "example-app", version: "1.0.0",
  container: {}, state_dir: "/state", command: ["run"],
};

describe("app run GPU admission", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let plugin = 0;
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);
  const create = (sessionId: string, resources: object, input: object = {}) => app.inject({
    method: "POST", url: `/v1/sessions/${sessionId}/tasks`,
    payload: { mode: "app", plugin_id: plugin, input, resources },
  });
  const res = (gpus: number) => ({ image: "registry.example.invalid/app:1", gpus, workspace: "ws-ok" });

  before(async () => {
    process.env.CLAW_DEPLOY_MODE = "safe";
    h = await startAdmissionCluster({ APP_RUNS_ENABLED: "true", ADMIT_HARD_GPU_NODES: "1" });
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    const ports = (await import("../src/tasks/app-run.js")).appRunPorts as any;
    ports.workspaceAccess = async () => "ok";
    plugin = Number(((await q(
      `INSERT INTO plugins (name, version, resource, owner_user_id, is_public)
       VALUES ('p', '1', $1::jsonb, 'u1', true) RETURNING id`, [JSON.stringify({ app: { manifest: MANIFEST } })],
    )).rows[0] as { id: string }).id);
    for (const sid of ["s1", "s2", "s3"]) {
      await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ($1, 't', 'u1', 'claw')", [sid]);
    }
    app = Fastify();
    app.addHook("preHandler", async (req) => { (req as any).user = OWNER; });
    await (await import("../src/routes/tasks.js")).registerTaskCreateRoute(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await h?.stop(); });
  beforeEach(async () => { await q("DELETE FROM claw_app_runs"); await q("DELETE FROM claw_tasks"); });

  test("a run asking for GPUs holds a GPU node; the next one over the ceiling is refused", async () => {
    assert.equal((await create("s1", res(8))).statusCode, 200);
    const second = await create("s2", res(8));
    assert.equal(second.statusCode, 429, second.body);
    assert.equal(second.json().error, "admission_rejected");
    assert.equal(Number(((await q("SELECT COUNT(*)::int AS n FROM claw_tasks")).rows[0] as any).n), 1);
  });

  test("a run with no GPUs holds none", async () => {
    assert.equal((await create("s1", res(0))).statusCode, 200);
    assert.equal((await create("s2", res(0))).statusCode, 200);
    assert.equal((await create("s3", res(4))).statusCode, 200, "the GPU ceiling is still free");
  });

  test("a `topology` key in the app input counts for nothing, however large", async () => {
    const huge = { topology: { nodes: 1e30 } };
    assert.equal((await create("s1", res(0), huge)).statusCode, 200);
    assert.equal((await create("s2", res(0), { topology: { nodes: 999 } })).statusCode, 200);
    // And it does not poison the aggregate the next GPU run is admitted against.
    assert.equal((await create("s3", res(8), huge)).statusCode, 200);
  });
});
