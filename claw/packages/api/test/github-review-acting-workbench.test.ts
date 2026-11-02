// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A workbench run into a session that acts as a user.
 *
 * `POST /v1/workbenches/:id/runs` takes a `session_id` and queues the nodes of its DAG in that session, where every node runs with the review
 * tools that the session's `config.acting_as` brings (github-review/acting-turns.ts). So a run that names such a session is the person's say,
 * like a message to it: the key a sandbox holds, which owns the session, must not be able to start it. The development bypass used here
 * records no authentication method, which is the same refusal as any other credential that is not an identity-provider token.
 *
 * The same request into a session that does not act as a user is admitted, so that the refusal is shown to be the gate and not the route.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

process.env.APP_ENV = "dev";
process.env.CLAW_INSECURE_DEV_AUTH = "1";
process.env.CLAW_DEPLOY_MODE = "kubernetes";
process.env.CLAW_GITHUB_REVIEW_ENABLED = "true";
process.env.CLAW_GITHUB_REVIEW_MCP_SECRET = "t".repeat(40);

type DbStub = import("./support/db-stub.js").DbStub;
let stubDb: typeof import("./support/db-stub.js")["stubDb"];

const WORKBENCH_ID = "acting-bench";
const DAG_ID = "acting-bench-dag";
const DEV_USER = "dev-user";

const DAG_ROW = {
  dag_id: DAG_ID, name: "acting bench dag", version: "1",
  nodes: [{ id: "n1", name: "only", prompt: "go" }],
  metadata: { derived: { root_node_id: "n1", handle_last_user: {}, schema_digest: "d" } },
  owner_user_id: DEV_USER, is_public: true, trust_level: "user", input_schema: {}, status: "active",
};
const PLUGIN_ROW = {
  id: 1, name: "acting-plugin", version: "1", status: "active",
  repositories: [], tools: [], mcp_servers: {}, resource: {}, sandbox_image: "img", owner_user_id: DEV_USER, visibility: "public",
};

let app: FastifyInstance;
let dbStub: DbStub | null = null;

before(async () => {
  stubDb = (await import("./support/db-stub.js")).stubDb;
  const { workbenchRegistry } = await import("../src/workbenches/registry.js");
  const { registerWorkbenchRunRoutes } = await import("../src/workbenches/routes.js");
  workbenchRegistry.register({
    id: WORKBENCH_ID, title: "acting bench", dag_id: DAG_ID, plugin_ref: { name: "acting-plugin", version: "1" },
    runs: { normaliseInput: (body: Record<string, unknown>) => ({ ...body }), sessionName: () => "acting-bench-run" },
  } as never);
  app = Fastify();
  await registerWorkbenchRunRoutes(app);
  await app.ready();
});
after(async () => { await app?.close(); });
afterEach(() => { dbStub?.restore(); dbStub = null; });

/** The caller's own session, with whatever `config.acting_as` the test gives it. */
const seed = (actingAs: unknown): void => {
  dbStub = stubDb((sql) => {
    if (/FROM claw_task_dags/.test(sql)) return [DAG_ROW];
    if (/FROM plugins/.test(sql)) return [PLUGIN_ROW];
    if (/FROM claw_sessions WHERE session_id/.test(sql)) return [{ session_id: "sess-named", user_id: DEV_USER, acting_as: actingAs }];
    return [];
  });
};
const run = () => app.inject({ method: "POST", url: `/v1/workbenches/${WORKBENCH_ID}/runs`, payload: { prompt: "go", session_id: "sess-named" } });

test("W1 a run into a session that acts as a user is refused to a credential that is not an identity-provider token, and writes nothing", async () => {
  seed("u-bob");
  const res = await run();
  assert.equal(res.statusCode, 403, res.body);
  assert.deepEqual(res.json(), { ok: false, error: "interactive_sign_in_required" });
  assert.equal(dbStub!.ran(/^INSERT INTO claw_tasks/), false, "no node was written");
  assert.equal(dbStub!.ran(/^UPDATE claw_sessions/), false, "the session's credentials were not replaced either");
  assert.ok(dbStub!.ran(/^ROLLBACK/), "and the transaction was rolled back");
});

test("W2 the same run into a session that does not act as a user is admitted, and so is one whose acting_as is not a well-formed id", async () => {
  for (const actingAs of [null, undefined, "has space", 7]) {
    seed(actingAs);
    const res = await run();
    assert.equal(res.statusCode, 200, `${JSON.stringify(actingAs)}: ${res.body}`);
    assert.ok(dbStub!.ran(/^INSERT INTO claw_tasks/), "its node was written");
    dbStub!.restore();
  }
});
