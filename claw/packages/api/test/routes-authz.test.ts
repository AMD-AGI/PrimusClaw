// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Cross-tenant authorization, asserted at the HTTP boundary.
 *
 * The predicates themselves are already covered (session-access.test.ts,
 * task-dag-access.test.ts). What no predicate test can see is a handler that
 * forgets to call one: the gate is a plain function call inside each handler, not
 * a route-level hook, so a route added or refactored without it is silently open.
 * These tests register the real route modules on a real Fastify instance and
 * assert what a client actually receives.
 *
 * Every case pairs a denial with the same request as its rightful owner, because
 * a route that answers 403 to everybody would otherwise look correct here.
 *
 * `db.query` is a property on an exported object, so a stub replaces it without
 * module mocking or a database. The trade-off is explicit: these tests prove the
 * authorization decision and that no data crosses the boundary, not that the SQL
 * scopes rows correctly. That last part needs a live Postgres and is not
 * covered here.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";

import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { registerTaskRoutes } from "../src/routes/tasks.js";

const SESSION_ID = "sess-owned";
const TASK_ID = "task-owned";

function user(userId: string, roles: string[] = ["default"]): UserInfo {
  return { userId, userName: userId, roles, platformKey: "", virtualKey: `vk-${userId}` };
}

const OWNER = user("u-owner");
const OTHER_TENANT = user("u-other");
const READONLY_ADMIN = user("u-ops", ["system-admin-readonly"]);

interface SeenQuery { text: string; params: unknown[] }

const originalQuery = db.query;
after(() => { db.query = originalQuery; });

/**
 * Serves exactly one session and one task, both owned by OWNER. Anything else is
 * "no rows", which is what lets an unknown id be told apart from a forbidden one.
 */
function stubDb(): SeenQuery[] {
  const seen: SeenQuery[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ text: sql, params });
    if (/FROM claw_sessions WHERE session_id = \$1/.test(sql)) {
      return params[0] === SESSION_ID
        ? { rows: [{ session_id: SESSION_ID, user_id: OWNER.userId }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/FROM claw_tasks WHERE task_id = \$1/.test(sql)) {
      return params[0] === TASK_ID
        ? { rows: [{ task_id: TASK_ID, session_id: SESSION_ID, status: "completed" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    throw new Error(`stubDb: unexpected query ${sql.slice(0, 80)}`);
  }) as typeof db.query;
  return seen;
}

/**
 * A server that acts as `caller`. Mirrors src/index.ts, where `authMiddleware`
 * is one global preHandler registered above the route modules: routes never
 * authenticate themselves, so a stub hook is the whole harness.
 */
async function appAs(
  caller: UserInfo | null,
  register: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => { (req as any).user = caller; });
  await register(app);
  await app.ready();
  return app;
}

test("session file read is scoped to the session's owner", async () => {
  stubDb();
  // `/download` returns the stream path straight after the gate, so the assertion
  // is about the authorization decision and never reaches S3.
  const url = `/v1/sessions/${SESSION_ID}/files/main.py/download`;

  const owner = await appAs(OWNER, registerSessionRoutes);
  const foreign = await appAs(OTHER_TENANT, registerSessionRoutes);
  const ops = await appAs(READONLY_ADMIN, registerSessionRoutes);
  try {
    const allowed = await owner.inject({ method: "GET", url });
    assert.equal(allowed.statusCode, 200, "the owner must get through the gate");
    assert.match(allowed.body, /main\.py/);

    const denied = await foreign.inject({ method: "GET", url });
    assert.equal(denied.statusCode, 403);
    assert.equal(
      denied.body.includes(OWNER.userId), false,
      "a denial must not disclose the owner it was checked against",
    );
    assert.equal(denied.body.includes("main.py"), false, "nor any part of the workspace");

    // Admins are platform operators for reads by design (canAccessSessionAsOperator),
    // so this is the boundary the 403 above is drawn against, not a second denial.
    const inspected = await ops.inject({ method: "GET", url });
    assert.equal(inspected.statusCode, 200, "read-only admin may inspect a tenant's files");
  } finally {
    await Promise.all([owner.close(), foreign.close(), ops.close()]);
  }
});

test("upload into another tenant's session is refused before anything is written", async () => {
  const seen = stubDb();
  const url = `/v1/sessions/${SESSION_ID}/upload`;
  // The upload route reads a multipart body, so the parser has to be present for
  // the request to reach the handler at all -- otherwise Fastify answers 415 and
  // the test would pass without ever exercising the gate.
  const withUploads = async (app: FastifyInstance) => {
    await app.register(multipart);
    await registerSessionRoutes(app);
  };
  const upload = { method: "POST" as const, url, headers: { "content-type": "multipart/form-data; boundary=--b" }, payload: "" };

  const foreign = await appAs(OTHER_TENANT, withUploads);
  const ops = await appAs(READONLY_ADMIN, withUploads);
  try {
    const denied = await foreign.inject(upload);
    assert.equal(denied.statusCode, 403);

    // A role named read-only must not be able to mutate a tenant's workspace,
    // even though it may read it (asserted above). This is the one asymmetry
    // between canAccessSessionAsOperator and canWriteSessionAsOperator.
    const readOnly = await ops.inject(upload);
    assert.equal(readOnly.statusCode, 403);

    // The gate runs before the multipart body is even looked at, so a rejected
    // upload cannot have touched storage or quota.
    assert.deepEqual(
      seen.map((q) => q.text.startsWith("SELECT * FROM claw_sessions")),
      [true, true],
      "a refused upload issues only the ownership lookup",
    );
  } finally {
    await Promise.all([foreign.close(), ops.close()]);
  }
});

test("task read is scoped to the owner of the task's session", async () => {
  stubDb();
  const url = `/v1/tasks/${TASK_ID}`;

  const owner = await appAs(OWNER, registerTaskRoutes);
  const foreign = await appAs(OTHER_TENANT, registerTaskRoutes);
  try {
    const allowed = await owner.inject({ method: "GET", url });
    assert.equal(allowed.statusCode, 200);
    assert.equal(JSON.parse(allowed.body).item.task_id, TASK_ID);

    // Authorization is inherited from the task's session, so a task id alone is
    // not a capability: guessing one must not reveal that it exists.
    const denied = await foreign.inject({ method: "GET", url });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.includes(SESSION_ID), false, "no session id leaks through the denial");
    assert.equal(denied.body.includes("completed"), false, "no task state leaks through the denial");

    const missing = await owner.inject({ method: "GET", url: "/v1/tasks/task-does-not-exist" });
    assert.equal(missing.statusCode, 404);
  } finally {
    await Promise.all([owner.close(), foreign.close()]);
  }
});

test("an unauthenticated request cannot reach a session or a task", async () => {
  stubDb();
  const anonSessions = await appAs(null, registerSessionRoutes);
  const anonTasks = await appAs(null, registerTaskRoutes);
  try {
    assert.equal(
      (await anonSessions.inject({ method: "GET", url: `/v1/sessions/${SESSION_ID}/files/main.py/download` })).statusCode,
      403,
    );
    assert.equal(
      (await anonTasks.inject({ method: "GET", url: `/v1/tasks/${TASK_ID}` })).statusCode,
      403,
    );
  } finally {
    await Promise.all([anonSessions.close(), anonTasks.close()]);
  }
});
