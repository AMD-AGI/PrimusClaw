// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A workbench run mints a hidden session, and that creation must be counted.
 *
 * `claw_api_session_created_total` is the rollout's answer to "is anything
 * creating sessions on this pod", and a workbench run writes `claw_sessions`
 * itself rather than calling the standard create, so a counter only that route
 * increments reads as a quiet fleet while this path runs.
 *
 * The insert runs on the transaction an admission refusal rolls back -- and a
 * `COMMIT` can fail on its own -- so the count belongs after the commit rather
 * than to the statement or to the decision to commit. All three outcomes are
 * driven here, because "counted a session that was rolled back" and "counted
 * nothing" are different bugs.
 *
 * `APP_ENV` and `CLAW_DEPLOY_MODE` are read once when `config.ts` loads, so
 * they are set before the dynamic imports: the run route authenticates through
 * the same middleware production uses, and the dev-bypass user it injects
 * carries no platform key.
 */

import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

process.env.APP_ENV = "dev";
process.env.CLAW_INSECURE_DEV_AUTH = "1";
process.env.CLAW_DEPLOY_MODE = "kubernetes";
process.env.ADMIT_TREE_MAX_NODES = "1";

type DbStub = import("./support/db-stub.js").DbStub;
let stubDb: typeof import("./support/db-stub.js")["stubDb"];

const WORKBENCH_ID = "counter-bench";
const DAG_ID = "counter-bench-dag";
const CREATED = "claw_api_session_created_total";
const DEV_USER = "dev-user";

/** One node, public, so `canExecuteTaskDag` and the expander both accept it. */
const DAG_ROW = {
  dag_id: DAG_ID,
  name: "counter bench dag",
  version: "1",
  nodes: [{ id: "n1", name: "only", prompt: "go" }],
  metadata: { derived: { root_node_id: "n1", handle_last_user: {}, schema_digest: "d" } },
  owner_user_id: DEV_USER,
  is_public: true,
  trust_level: "user",
  input_schema: {},
  status: "active",
};

/** Two nodes against a ceiling of one, so the expander refuses after the insert. */
const OVER_CEILING_DAG_ROW = {
  ...DAG_ROW,
  nodes: [
    { id: "n1", name: "first", prompt: "go" },
    { id: "n2", name: "second", prompt: "go", depends_on: ["n1"] },
  ],
};

const PLUGIN_ROW = {
  id: 1, name: "counter-plugin", version: "1", status: "active",
  repositories: [], tools: [], mcp_servers: {}, resource: {},
  sandbox_image: "img", owner_user_id: DEV_USER, visibility: "public",
};

let registry: typeof import("../src/infra/metrics.js")["registry"];
let db: typeof import("../src/infra/db.js")["db"];
let app: FastifyInstance;
let dbStub: DbStub | null = null;

before(async () => {
  stubDb = (await import("./support/db-stub.js")).stubDb;
  registry = (await import("../src/infra/metrics.js")).registry;
  db = (await import("../src/infra/db.js")).db;
  const { workbenchRegistry } = await import("../src/workbenches/registry.js");
  const { registerWorkbenchRunRoutes } = await import("../src/workbenches/routes.js");
  workbenchRegistry.register({
    id: WORKBENCH_ID,
    title: "counter bench",
    dag_id: DAG_ID,
    plugin_ref: { name: "counter-plugin", version: "1" },
    runs: {
      normaliseInput: (body: Record<string, unknown>) => ({ ...body }),
      sessionName: () => "counter-bench-run",
    },
  } as never);
  app = Fastify();
  await registerWorkbenchRunRoutes(app);
  await app.ready();
});

after(async () => { await app?.close(); });
afterEach(() => { dbStub?.restore(); dbStub = null; });

/**
 * The stub with its `COMMIT` failing, everything before it succeeding.
 *
 * The row is written and the run is decided; only the statement that would make
 * any of it durable fails. A count taken on the way to the commit survives that
 * and names a session no row backs.
 */
function seedReadsWithFailingCommit(): void {
  seedReads();
  const real = dbStub!;
  const inner = db.pool.connect;
  db.pool.connect = (async () => {
    const client = await (inner as () => Promise<{ query: (t: string, p?: unknown[]) => unknown }>)();
    const clientQuery = client.query;
    client.query = async (text: string, params?: unknown[]) => {
      const result = await clientQuery.call(client, text, params);
      // Recorded before it fails, so the test can tell "the commit failed" from
      // "the run never reached one".
      if (/^COMMIT/.test(text.trim())) throw new Error("could not serialize access");
      return result;
    };
    return client;
  }) as typeof db.pool.connect;
  const restore = real.restore.bind(real);
  real.restore = () => { db.pool.connect = inner; restore(); };
}

/** Every read a run makes before its insert, answered with one row. */
function seedReads(dag: Record<string, unknown> = DAG_ROW): void {
  dbStub = stubDb((sql) => {
    if (/FROM claw_task_dags/.test(sql)) {
      return [dag];
    }
    if (/FROM plugins/.test(sql)) {
      return [PLUGIN_ROW];
    }
    return [];
  });
}

async function moved(act: () => Promise<{ statusCode: number; body: string }>) {
  const before = await registry.metrics();
  const res = await act();
  const after = await registry.metrics();
  const delta = (outcome: string) => {
    const read = (text: string) => {
      for (const line of text.split("\n")) {
        if (line.startsWith(`${CREATED}{`) && line.includes(`outcome="${outcome}"`)) {
          return Number(line.slice(line.lastIndexOf(" ") + 1));
        }
      }
      return 0;
    };
    return read(after) - read(before);
  };
  return { ok: delta("ok"), error: delta("error"), res };
}

const postRun = (payload: Record<string, unknown>) => app.inject({
  method: "POST",
  url: `/v1/workbenches/${WORKBENCH_ID}/runs`,
  payload,
});

test("a run that mints its hidden session books one creation", async () => {
  seedReads();
  const { ok, error, res } = await moved(() => postRun({ prompt: "go" }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.ok(dbStub!.ran(/^INSERT INTO claw_sessions/));
  assert.equal(ok, 1);
  assert.equal(error, 0);
});

test("a run whose session the caller named books nothing", async () => {
  dbStub = stubDb((sql) => {
    if (/FROM claw_task_dags/.test(sql)) {
      return [DAG_ROW];
    }
    if (/FROM plugins/.test(sql)) {
      return [PLUGIN_ROW];
    }
    if (/FROM claw_sessions WHERE session_id/.test(sql)) {
      return [{ session_id: "sess-named", user_id: DEV_USER }];
    }
    return [];
  });
  const { ok, error, res } = await moved(() => postRun({ prompt: "go", session_id: "sess-named" }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(dbStub!.ran(/^INSERT INTO claw_sessions/), false);
  assert.equal(ok, 0);
  assert.equal(error, 0);
});

// The refusal rolls the insert back, so a count taken at the statement would
// name a session no row backs.
test("a run refused by the tree ceiling books nothing, though it did insert", async () => {
  seedReads(OVER_CEILING_DAG_ROW);
  const { ok, error, res } = await moved(() => postRun({ prompt: "go" }));
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(JSON.parse(res.body).reason, "tree_nodes_exceeded");
  assert.ok(dbStub!.ran(/^INSERT INTO claw_sessions/), "the row was written");
  assert.ok(dbStub!.ran(/^ROLLBACK/), "and the transaction rolled it back");
  assert.equal(ok, 0);
  assert.equal(error, 0);
});

// A commit is not a formality: it can fail on serialization, on a lost
// connection, or on a constraint deferred to it. Counting before it confirms
// reports a session the database never kept.
test("a run whose commit fails books nothing, though it wrote and decided", async () => {
  seedReadsWithFailingCommit();
  const { ok, error, res } = await moved(() => postRun({ prompt: "go" }));
  assert.equal(res.statusCode, 500, res.body);
  assert.ok(dbStub!.ran(/^INSERT INTO claw_sessions/), "the row was written");
  assert.ok(dbStub!.ran(/^COMMIT/), "and the commit was reached");
  assert.equal(ok, 0, "but nothing durable came of it");
  assert.equal(error, 0);
});

/**
 * The workbench surface's own spelling of the malformed-topology refusal.
 *
 * `92cc1dcb` gated every path that creates a run, this one included, and then
 * nothing in the tree ever registered a workbench -- `workbenches/<id>/index.ts`
 * is the documented seam and no such file exists -- so `sendRunRefusal`'s 400
 * arm had no caller and no test. It is not dead code though: the route is wired
 * into `index.ts` at boot, and this file's own registration is proof that one
 * `register()` call away it is live. Without this, deleting the arm, or letting
 * it answer 429, is a change no test in the repo notices, and the first
 * workbench anybody adds persists a node count `int4` cannot hold.
 *
 * `normaliseInput` here is a pass-through, which is what lets a caller's
 * `topology` reach the validator at all -- a workbench that builds its input
 * from a fixed template would never produce this refusal.
 */
test("a workbench run naming a topology int4 cannot hold is refused 400, not 429", async () => {
  seedReads();

  const { res } = await moved(() => postRun({
    prompt: "go",
    topology: { nodes: 1e30, backend: "rayjob" },
  }));

  const body = JSON.parse(res.body) as { ok?: boolean; error?: string; errors?: unknown };
  assert.equal(res.statusCode, 400, "a malformed topology is not a ceiling refusal");
  assert.equal(body.ok, false);
  assert.equal(body.error, "invalid_topology");
  assert.ok(
    Array.isArray(body.errors) && body.errors.length > 0,
    "the validator's own messages reach the caller",
  );
  assert.equal(
    dbStub!.ran(/^INSERT INTO claw_tasks/), false,
    "and it wrote no run on the way to saying so",
  );
});

test("and the same run without that topology is admitted", async () => {
  // The positive control: without it the case above holds just as well against
  // a route that refuses everything, or one this fixture can no longer reach.
  seedReads();

  const { res } = await moved(() => postRun({ prompt: "go" }));

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).ok, true);
});
