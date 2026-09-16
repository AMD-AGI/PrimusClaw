// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which creates the session-tree ceiling is allowed to see.
 *
 * The ceiling used to be consulted only when the create also carried a first
 * message, on the reasoning that a create with no message writes no run. But
 * `sessionTreeShape` counts sessions, not runs -- it exists precisely because
 * "a caller grows past the ceiling by idling each child in turn" -- and a
 * messageless parented create is that idled child. It is also the ordinary
 * shape: the `claw_create_session` MCP tool forms an agent team by POSTing
 * `parent_session_id` with no message at all.
 *
 * Left unmetered the node is admitted and the bill arrives somewhere else: the
 * next turn of *every* session in the tree, the root included, is refused
 * `tree_nodes_exceeded`, because the shape is read from any member and counts
 * the whole tree. So these drive the HTTP route rather than
 * `admitParentedSessionCreate`, which was never the part that was wrong.
 */

import "./tree-ceiling-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { registerSessionRoutes } from "../src/routes/sessions.js";
import { startHarness, type Harness } from "./scenario-harness.js";

const OWNER = {
  userId: "u-owner",
  userName: "u-owner",
  roles: ["default"],
  platformKey: "pk",
  virtualKey: "vk",
};

let h: Harness;
let app: FastifyInstance;

before(async () => {
  h = await startHarness();
  app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: unknown }).user = OWNER;
  });
  await registerSessionRoutes(app);
  await app.ready();
});
beforeEach(async () => { await h.reset(); });
after(async () => {
  await app?.close();
  await h?.close();
});

/** A root owned by OWNER with `children` children hanging off it. */
async function seedTree(children: number): Promise<void> {
  await h.sql(
    "INSERT INTO claw_sessions (session_id, user_id, agent_status) VALUES ('s-root', $1, 'idle')",
    [OWNER.userId],
  );
  for (let i = 0; i < children; i++) {
    await h.sql(
      `INSERT INTO claw_sessions (session_id, user_id, agent_status, parent_session_id)
       VALUES ($1, $2, 'idle', 's-root')`,
      [`s-child-${i}`, OWNER.userId],
    );
  }
}

const countSessions = async (): Promise<number> =>
  Number((await h.sql("SELECT COUNT(*)::int AS n FROM claw_sessions"))[0].n);

const createChild = (parentSid: string | null) => app.inject({
  method: "POST",
  url: "/v1/sessions",
  payload: parentSid === null
    ? { name: "root" }
    : { name: "child", parent_session_id: parentSid },
});

test("a create with no message is refused once its parent's tree is at the ceiling", async () => {
  await seedTree(2);

  const res = await createChild("s-root");

  assert.equal(res.statusCode, 429, "the ceiling answers the create, not a later turn");
  assert.deepEqual(res.json(), {
    ok: false, error: "admission_rejected", reason: "tree_nodes_exceeded",
  });
  assert.equal(await countSessions(), 3, "a refused create leaves no row behind");
});

test("and the same create one node below the ceiling is admitted", async () => {
  // Without this the case above holds just as well against a route that
  // refuses every parented create.
  await seedTree(1);

  const res = await createChild("s-root");

  assert.equal(res.statusCode, 200);
  const body = res.json() as { data: { session_id: string; agent_status: string } };
  assert.equal(body.data.agent_status, "idle");
  const rows = await h.sql(
    "SELECT parent_session_id FROM claw_sessions WHERE session_id = $1", [body.data.session_id],
  );
  assert.equal(rows[0].parent_session_id, "s-root", "and the child was written under its parent");
});

test("a create naming no parent is not measured against anyone's tree", async () => {
  // It grows no existing tree, so a fleet at its ceiling can still open a new
  // conversation -- the create path that never takes the admission transaction.
  await seedTree(2);

  const res = await createChild(null);

  assert.equal(res.statusCode, 200);
  assert.equal(await countSessions(), 4);
});

test("a run ceiling at its limit does not refuse a child that starts no run", async () => {
  // ADMIT_HARD_RUNS is 1 here and the fleet is already holding one, so the full
  // decision would answer `runs_hard_limit` -- for a write that adds a session
  // node and no run, and which an unparented create of the same shape is never
  // asked about. Only the tree bounds apply to this write; a run meets a run cap
  // when it is dispatched.
  await seedTree(0);
  await h.sql(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor)
     VALUES ('busy', 's-root', 'busy', 'running', 'chat', 'brain')`,
  );

  const res = await createChild("s-root");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await countSessions(), 2);
});

test("a tree refusal is counted, so the rollout's rejection checks can see it", async () => {
  // The route stopped going through decideAdmission, which was what recorded
  // these. A 429 this route makes and does not count is a route that reads as
  // never refusing anything -- which is what the Stage 3T positive-rejection
  // check looks for.
  const { registry } = await import("../src/infra/metrics.js");
  await seedTree(2);
  const before = await registry.getSingleMetricAsString("claw_api_admission_rejected_total");

  assert.equal((await createChild("s-root")).statusCode, 429);

  const after = await registry.getSingleMetricAsString("claw_api_admission_rejected_total");
  assert.notEqual(after, before, "the refusal was not counted");
  assert.match(after, /tree_nodes_exceeded/);
});
