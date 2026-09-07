// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The session lifecycle counters, read where they are actually incremented.
 *
 * `onSessionCreated` / `onSessionDeleted` are the API's answer to "is anything
 * on this pod exporting `claw_api_*` at all", so what has to be true of them is
 * not that the helper increments -- that is prom-client's -- but that the two
 * routes reach it on exactly the outcomes they claim: a committed row books
 * `ok`, a request that never wrote one books nothing, and every failure past
 * the point of no return books `error` rather than disappearing into a 5xx.
 * Deletion has two endpoints over one implementation, so both are driven: an
 * accounting only one of them reaches under-reports without ever failing.
 *
 * Both routes are driven over a real Fastify with the real handlers, because
 * the whole question is which exit runs which call, and a helper called
 * directly answers none of it. Every assertion is a delta across the rendered
 * exposition: the registry is a module singleton that accumulates across every
 * file in the process, so an absolute value is not a fact about this test.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import type { UserInfo } from "../src/auth/models.js";
import { registerAnthropicManagedAgentsRoutes } from "../src/routes/anthropic-managed-agents.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { registry } from "../src/infra/metrics.js";
import { teardownPorts } from "../src/sessions/teardown.js";
import { stubDb, type Answer, type DbStub } from "./support/db-stub.js";

const CREATED = "claw_api_session_created_total";
const DELETED = "claw_api_session_deleted_total";
const SID = "sess-owned";
const OWNER: UserInfo = {
  userId: "u-owner",
  userName: "u-owner",
  roles: ["default"],
  platformKey: "pk",
  virtualKey: "vk-u-owner",
};

const originalPorts = { ...teardownPorts };
let dbStub: DbStub | null = null;

afterEach(() => {
  Object.assign(teardownPorts, originalPorts);
  dbStub?.restore();
  dbStub = null;
});

/** The value of one sample, matched by family name and the labels that identify it. */
function sample(text: string, name: string, labels: Record<string, string>): number {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(`${name}{`)) continue;
    const head = line.slice(0, line.lastIndexOf(" "));
    if (!wanted.every((pair) => head.includes(pair))) continue;
    return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return 0;
}

/**
 * What one request moved on both outcomes of a family, and what it answered.
 *
 * Both outcomes always, because "the wrong label moved" and "nothing moved" are
 * different bugs and a single probe cannot tell them apart.
 */
async function outcomes(
  name: string,
  act: () => Promise<{ statusCode: number; body: string }>,
): Promise<{ ok: number; error: number; res: { statusCode: number; body: string } }> {
  const before = await registry.metrics();
  const res = await act();
  const after = await registry.metrics();
  const moved = (outcome: string) =>
    sample(after, name, { outcome }) - sample(before, name, { outcome });
  return { ok: moved("ok"), error: moved("error"), res };
}

/**
 * A server that acts as OWNER, as src/index.ts does with one global preHandler:
 * the routes never authenticate themselves, so a stub hook is the whole harness.
 */
async function ownedApp(
  register: (app: FastifyInstance) => Promise<void> = registerSessionRoutes,
): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = OWNER;
  });
  await register(app);
  await app.ready();
  return app;
}

/** Every step of the cleanup succeeding, so a test can fail exactly one. */
function healthyPorts(): void {
  teardownPorts.writeTombstones = async () => "written";
  teardownPorts.notifyCleanup = () => true;
  teardownPorts.parkHands = async () => "parked";
  teardownPorts.purgeSessionEvents = async () => {};
  teardownPorts.deleteGateLocks = async () => true;
  teardownPorts.deleteWorkspaceObjects = async () => ({ deleted: 1, failed: 0, complete: true });
  teardownPorts.releaseWorkspaceRefs = async () => "released";
}

/** The session exists and belongs to OWNER; everything else answers nothing. */
function sessionOwnedByCaller(extra?: Answer): void {
  dbStub = stubDb((sql, params) => {
    if (/FROM claw_sessions WHERE session_id = \$1/.test(sql)) {
      return [{ session_id: SID, user_id: OWNER.userId }];
    }
    return extra?.(sql, params) ?? [];
  });
}

/**
 * A create with neither parent nor first message, whose whole database
 * footprint is the one INSERT -- optionally the one that fails.
 */
function createHarness(insertFails = false): void {
  dbStub = stubDb((sql) => {
    if (/^INSERT INTO claw_sessions/.test(sql) && insertFails) {
      throw new Error("deadlock detected");
    }
    return [];
  });
}

async function post(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/sessions", payload });
}

async function del(app: FastifyInstance) {
  return app.inject({ method: "DELETE", url: `/v1/sessions/${SID}` });
}

async function delAnthropic(app: FastifyInstance) {
  return app.inject({ method: "DELETE", url: `/anthropic/v1/sessions/${SID}` });
}

test("a create that writes its row books one session creation as ok", async () => {
  createHarness();
  const app = await ownedApp();
  try {
    const { ok, error, res } = await outcomes(CREATED, () => post(app, { name: "s" }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).data.agent_status, "idle");
    assert.equal(ok, 1);
    assert.equal(error, 0);
    assert.ok(dbStub!.ran(/^INSERT INTO claw_sessions/));
  } finally {
    await app.close();
  }
});

test("a create whose insert throws books an error and still answers 500", async () => {
  createHarness(true);
  const app = await ownedApp();
  try {
    const { ok, error, res } = await outcomes(CREATED, () => post(app, { name: "s" }));
    assert.equal(res.statusCode, 500);
    assert.equal(error, 1);
    assert.equal(ok, 0);
  } finally {
    await app.close();
  }
});

test("a create refused before any row is written books neither outcome", async () => {
  dbStub = stubDb();
  const app = await ownedApp();
  try {
    const { ok, error, res } = await outcomes(CREATED, () => post(app, { config: "not-an-object" }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "config must be a JSON object");
    assert.equal(ok, 0);
    assert.equal(error, 0);
    assert.equal(dbStub!.ran(/^INSERT INTO claw_sessions/), false);
  } finally {
    await app.close();
  }
});

test("a create refused for claiming a server-managed key books neither outcome", async () => {
  dbStub = stubDb();
  const app = await ownedApp();
  try {
    const { ok, error, res } = await outcomes(
      CREATED,
      () => post(app, { config: { platform_key: "x" } }),
    );
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "config.platform_key is server-managed");
    assert.equal(ok, 0);
    assert.equal(error, 0);
  } finally {
    await app.close();
  }
});

test("a delete that commits books one session deletion as ok", async () => {
  healthyPorts();
  sessionOwnedByCaller();
  const app = await ownedApp();
  try {
    const { ok, error, res } = await outcomes(DELETED, () => del(app));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, session_id: SID });
    assert.equal(ok, 1);
    assert.equal(error, 0);
  } finally {
    await app.close();
  }
});

test("a delete whose commit did not land books an error behind its 503", async () => {
  healthyPorts();
  sessionOwnedByCaller((sql) => {
    if (/UPDATE claw_sessions SET deleted_at/.test(sql)) {
      throw new Error("terminating connection due to administrator command");
    }
  });
  const app = await ownedApp();
  try {
    const { ok, error, res } = await outcomes(DELETED, () => del(app));
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /Retry the delete/);
    assert.equal(JSON.parse(res.body).retryable, true);
    assert.equal(error, 1);
    assert.equal(ok, 0);
  } finally {
    await app.close();
  }
});

test("the Anthropic delete endpoint books the deletion it shares", async () => {
  healthyPorts();
  sessionOwnedByCaller();
  const app = await ownedApp(registerAnthropicManagedAgentsRoutes);
  try {
    const { ok, error, res } = await outcomes(DELETED, () => delAnthropic(app));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { id: SID, type: "session_deleted" });
    assert.equal(ok, 1);
    assert.equal(error, 0);
  } finally {
    await app.close();
  }
});

test("the Anthropic delete endpoint books an error behind its 503 too", async () => {
  healthyPorts();
  sessionOwnedByCaller((sql) => {
    if (/UPDATE claw_sessions SET deleted_at/.test(sql)) {
      throw new Error("terminating connection due to administrator command");
    }
  });
  const app = await ownedApp(registerAnthropicManagedAgentsRoutes);
  try {
    const { ok, error, res } = await outcomes(DELETED, () => delAnthropic(app));
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /Retry the delete/);
    assert.equal(error, 1);
    assert.equal(ok, 0);
  } finally {
    await app.close();
  }
});

test("a delete of a session the caller does not own books neither outcome", async () => {
  healthyPorts();
  dbStub = stubDb((sql) => {
    if (/FROM claw_sessions WHERE session_id = \$1/.test(sql)) {
      return [{ session_id: SID, user_id: "someone-else" }];
    }
    return [];
  });
  const app = await ownedApp();
  try {
    const { ok, error, res } = await outcomes(DELETED, () => del(app));
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, "only the session creator can delete this session");
    assert.equal(ok, 0);
    assert.equal(error, 0);
  } finally {
    await app.close();
  }
});

test("a delete of a session that is not there books neither outcome", async () => {
  dbStub = stubDb();
  const app = await ownedApp();
  try {
    const { ok, error, res } = await outcomes(DELETED, () => del(app));
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, "not found");
    assert.equal(ok, 0);
    assert.equal(error, 0);
  } finally {
    await app.close();
  }
});

/**
 * The guard against the failure that reads as a passing test: two copies of
 * infra/metrics.ts, each with its own registry, would leave every delta above
 * at zero-versus-zero rather than raising anything.
 */
test("two creates and two deletes move each series by exactly two", async () => {
  createHarness();
  const creator = await ownedApp();
  let created;
  try {
    created = await outcomes(CREATED, async () => {
      await post(creator, { name: "one" });
      return post(creator, { name: "two" });
    });
  } finally {
    await creator.close();
  }
  assert.equal(created.ok, 2);

  healthyPorts();
  dbStub!.restore();
  sessionOwnedByCaller();
  const deleter = await ownedApp();
  let deleted;
  try {
    deleted = await outcomes(DELETED, async () => {
      await del(deleter);
      return del(deleter);
    });
  } finally {
    await deleter.close();
  }
  assert.equal(deleted.ok, 2);
});
