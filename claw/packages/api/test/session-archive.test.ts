// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Session auto-archive: which sessions the sweep archives, which it must leave
 * alone, and that archiving never closes a session.
 *
 * The sweep and the owner endpoints run against a real PostgreSQL engine
 * (PGlite), because the property is a WHERE clause: a stubbed database would
 * only show that some statement was sent, not which rows it matches.
 *
 * Coverage:
 *   A1 the sweep archives idle sessions and only those (table-driven)
 *   A2 a parent with a running team member is left alone
 *   A3 days = 0 disables the sweep
 *   A4 a sweep never touches updated_at, so the idle clock is not reset by it
 *   B1 owner archive / unarchive, refusal while running, other users refused
 *   B2 unarchive restarts the idle clock so the next sweep does not undo it
 *   C1 list filter: active, archived, all, default, invalid
 *   D1 a message to an archived session reactivates it before dispatch
 */
import test, { afterEach, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { archiveIdleSessions } from "../src/sessions/archive.js";
import { sessionDispatchPorts } from "../src/sessions/dispatch.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";
import { stubDb, type DbStub } from "./support/db-stub.js";

const OWNER: UserInfo = {
  userId: "u-owner", userName: "u-owner", roles: ["default"], platformKey: "pk", virtualKey: "vk",
};
const OTHER: UserInfo = { ...OWNER, userId: "u-other", userName: "u-other" };

const originalQuery = db.query;
const originalPorts = { ...sessionDispatchPorts };
let pg: PGlite;
let caller: UserInfo = OWNER;
let dbStub: DbStub | null = null;

before(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TABLE claw_sessions (
      session_id TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      user_id TEXT,
      agent_status TEXT DEFAULT 'idle',
      status TEXT DEFAULT 'active',
      parent_session_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )`);
});
after(async () => { await pg.close(); });

beforeEach(async () => {
  await pg.exec("TRUNCATE claw_sessions");
  caller = OWNER;
  db.query = (async (sql: string, params: unknown[] = []) => {
    const r = await pg.query(sql, params);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  }) as typeof db.query;
});
afterEach(() => {
  db.query = originalQuery;
  Object.assign(sessionDispatchPorts, originalPorts);
  dbStub?.restore();
  dbStub = null;
});

interface Seed {
  id: string;
  idleDays: number;
  agent?: string;
  status?: string | null;
  user?: string;
  parent?: string;
  deleted?: boolean;
}

async function seed(s: Seed): Promise<void> {
  await pg.query(
    `INSERT INTO claw_sessions (session_id, user_id, agent_status, status, parent_session_id, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, NOW() - ($6::int * INTERVAL '1 day'), NOW() - ($6::int * INTERVAL '1 day'),
             CASE WHEN $7::boolean THEN NOW() ELSE NULL END)`,
    [s.id, s.user ?? OWNER.userId, s.agent ?? "idle", s.status === undefined ? "active" : s.status,
     s.parent ?? null, s.idleDays, s.deleted ?? false],
  );
}

async function statusOf(id: string): Promise<string | null> {
  return ((await pg.query("SELECT status FROM claw_sessions WHERE session_id = $1", [id])).rows[0] as
    { status: string | null }).status;
}

async function app(): Promise<FastifyInstance> {
  const instance = Fastify();
  instance.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = caller;
  });
  await registerSessionRoutes(instance);
  await instance.ready();
  return instance;
}

test("A1 the sweep archives idle sessions and only those", async () => {
  const cases: Array<{ name: string; seed: Seed; archived: boolean }> = [
    { name: "old and idle", seed: { id: "old-idle", idleDays: 30 }, archived: true },
    { name: "old, never given a status", seed: { id: "old-null", idleDays: 30, status: null }, archived: true },
    { name: "old but running", seed: { id: "old-running", idleDays: 30, agent: "running" }, archived: false },
    { name: "recent and idle", seed: { id: "recent", idleDays: 1 }, archived: false },
    { name: "just under the threshold", seed: { id: "edge", idleDays: 6 }, archived: false },
    { name: "already archived", seed: { id: "gone-already", idleDays: 30, status: "archived" }, archived: true },
    { name: "deleted", seed: { id: "deleted", idleDays: 30, deleted: true }, archived: false },
  ];
  for (const c of cases) await seed(c.seed);

  const n = await archiveIdleSessions(7);

  for (const c of cases) {
    const got = (await statusOf(c.seed.id)) === "archived";
    assert.equal(got, c.archived, `${c.name}: archived=${got}`);
  }
  assert.equal(n, 2, "only the two newly archived rows are counted");
});

test("A2 a parent with a running team member is left alone", async () => {
  await seed({ id: "parent", idleDays: 30 });
  await seed({ id: "child", idleDays: 1, agent: "running", parent: "parent" });
  await seed({ id: "parent-2", idleDays: 30 });
  await seed({ id: "child-2", idleDays: 30, agent: "idle", parent: "parent-2" });

  await archiveIdleSessions(7);

  assert.equal(await statusOf("parent"), "active");
  assert.equal(await statusOf("parent-2"), "archived");
});

test("A3 days = 0 disables the sweep", async () => {
  await seed({ id: "old", idleDays: 400 });
  assert.equal(await archiveIdleSessions(0), 0);
  assert.equal(await statusOf("old"), "active");
});

test("A4 the sweep does not touch updated_at", async () => {
  await seed({ id: "old", idleDays: 30 });
  const before = (await pg.query("SELECT updated_at FROM claw_sessions")).rows[0];
  await archiveIdleSessions(7);
  const after = (await pg.query("SELECT updated_at FROM claw_sessions")).rows[0];
  assert.deepEqual(after, before);
});

test("B1 owner archive and unarchive, with the refusals", async () => {
  await seed({ id: "mine", idleDays: 0 });
  await seed({ id: "busy", idleDays: 0, agent: "running" });
  const server = await app();
  try {
    const post = (id: string, action: string) =>
      server.inject({ method: "POST", url: `/v1/sessions/${id}/${action}` });

    assert.equal((await post("mine", "archive")).statusCode, 200);
    assert.equal(await statusOf("mine"), "archived");
    assert.equal((await post("mine", "archive")).statusCode, 200, "archiving twice is fine");

    const busy = await post("busy", "archive");
    assert.equal(busy.statusCode, 409);
    assert.equal(await statusOf("busy"), "active", "a running session is not archived");

    assert.equal((await post("missing", "archive")).statusCode, 404);

    caller = OTHER;
    assert.equal((await post("mine", "unarchive")).statusCode, 403);
    assert.equal(await statusOf("mine"), "archived", "another user cannot change it");

    caller = OWNER;
    const un = await post("mine", "unarchive");
    assert.equal(un.statusCode, 200);
    assert.equal((un.json() as { data: { status: string } }).data.status, "active");
    assert.equal(await statusOf("mine"), "active");
  } finally {
    await server.close();
  }
});

test("B2 an unarchived old session is not swept again", async () => {
  await seed({ id: "old", idleDays: 30, status: "archived" });
  const server = await app();
  try {
    assert.equal((await server.inject({ method: "POST", url: "/v1/sessions/old/unarchive" })).statusCode, 200);
    await archiveIdleSessions(7);
    assert.equal(await statusOf("old"), "active");
  } finally {
    await server.close();
  }
});

test("C1 the list filters by status and defaults to everything", async () => {
  await seed({ id: "a1", idleDays: 1 });
  await seed({ id: "a2", idleDays: 2, status: null });
  await seed({ id: "z1", idleDays: 3, status: "archived" });
  await seed({ id: "x1", idleDays: 1, user: OTHER.userId, status: "archived" });
  const server = await app();
  try {
    const ids = async (qs: string) => {
      const res = await server.inject({ method: "GET", url: `/v1/sessions${qs}` });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { data: Array<{ session_id: string }>; pagination: { total: number } };
      return { ids: body.data.map((d) => d.session_id).sort(), total: body.pagination.total };
    };
    assert.deepEqual(await ids("?status=active"), { ids: ["a1", "a2"], total: 2 });
    assert.deepEqual(await ids("?status=archived"), { ids: ["z1"], total: 1 });
    assert.deepEqual(await ids("?status=all"), { ids: ["a1", "a2", "z1"], total: 3 });
    assert.deepEqual(await ids(""), { ids: ["a1", "a2", "z1"], total: 3 }, "no filter keeps the old behaviour");
    assert.equal((await server.inject({ method: "GET", url: "/v1/sessions?status=bogus" })).statusCode, 400);
  } finally {
    await server.close();
  }
});

test("D1 a message to an archived session reactivates it before dispatch", async () => {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.openChatRun =
    (async () => ({ taskId: "ktsk_1" })) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.recordPublishState = async () => {};
  sessionDispatchPorts.recordDispatchSeq = async () => {};
  sessionDispatchPorts.noteRefusedPublish = async () => {};
  sessionDispatchPorts.publishTask = async () => {};
  db.query = originalQuery;
  const stub = stubDb((sql) => {
    if (/FROM claw_workspace_refs r/.test(sql)) {
      return [{
        workspace_id: "kws_1", owner_user_id: OWNER.userId,
        storage_prefix: `users/${OWNER.userId}/sessions/s1/`, version: "0",
        writer_run_id: null, retention_expires_at: null, deleted_at: null,
      }];
    }
    if (/FROM claw_sessions WHERE session_id = \$1 AND deleted_at IS NULL FOR UPDATE/.test(sql)) {
      return [{ agent_status: "idle", user_id: OWNER.userId }];
    }
    return [];
  });
  dbStub = stub;
  const server = await app();
  try {
    const res = await server.inject({
      method: "POST", url: "/v1/sessions/s1/messages", payload: { content: "continue" },
    });
    assert.equal(res.statusCode, 200);
    const lock = stub.seen.findIndex((q) => /FOR UPDATE/.test(q.sql));
    const react = stub.seen.findIndex((q) => /SET status = 'active' WHERE session_id = \$1 AND status = 'archived'/.test(q.sql));
    assert.ok(react > lock && lock >= 0, "reactivation runs after the owner-checked lock");
    assert.equal(stub.seen[react].conn, stub.seen[lock].conn, "on the same transaction connection");
  } finally {
    await server.close();
  }
});
