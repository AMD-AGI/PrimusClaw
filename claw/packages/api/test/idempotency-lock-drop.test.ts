// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a session create does when the connection carrying its idempotency lock
 * drops underneath it.
 *
 * `acquireIdempotencyLock` takes a session-scoped advisory lock on a dedicated
 * `lockPool` connection and holds it for the whole create, which is the only
 * thing stopping two same-key retries from both creating a session. The server
 * releases that lock the instant the backend goes, and db.ts publishes the drop
 * (`connectionLost`) precisely because the holder cannot see it otherwise: the
 * create's own work runs on the main pool, which the drop does not touch.
 *
 * Until the caller honours it, the drop was invisible in the direction that
 * costs the most. The request went on to insert the session row and dispatch
 * its first turn under a lock the server had already given away, answered 200,
 * and then failed the one statement whose absence is expensive -- the
 * idempotency record, written on the corpse of the lock connection and
 * swallowed by the best-effort catch. The client's retry then missed the cache
 * and created a SECOND session, while the first one's run was still executing
 * in its sandbox with nobody holding its id.
 *
 * So the two halves are asserted separately, because they must end differently:
 *
 *   A the drop lands before anything durable -- the request has to refuse,
 *     leaving no session and no run, so the retry creates exactly one.
 *   B the drop lands after the session exists and its run is live -- the
 *     request has to finish and answer 200 (a create cannot be un-created, and
 *     a late 503 would send the client to start a second one), and the record
 *     the retry replays has to survive on the main pool.
 *
 * The lock connection is a real Postgres backend on `DATABASE_URL` and the drop
 * is a real `pg_terminate_backend`, with a rival connection asserting the
 * premise each time: the lock really was free for someone else. The create's
 * own statements are stubbed, which is the shape they have in the cluster --
 * a different pool, unaffected by the drop -- except the idempotency table
 * itself, which is forwarded to the same real database both paths write to.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach } from "node:test";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

import type { UserInfo } from "../src/auth/models.js";
import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { connectionLost, db } from "../src/infra/db.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { sessionDispatchPorts } from "../src/sessions/dispatch.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";
import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const KEY = "create-under-a-dropped-lock";
const CALLER: UserInfo = {
  userId: "u-caller",
  userName: "u-caller",
  roles: ["default"],
  platformKey: "pk",
  virtualKey: "vk-caller",
};

const skip = postgresSkipReason();

let cluster: PgCluster | undefined;
/** Terminates backends, and takes the lock to prove it was released. */
let admin: pg.Client;
let rival: pg.Client;
/** The real database behind `claw_idempotency_keys` for both write paths. */
let store: pg.Client;

const originalPorts = { ...sessionDispatchPorts };
const originalQuery = db.query;
const originalPoolConnect = db.pool.connect;
const originalLockConnect = db.lockPool.connect;

/** Every statement the create sent to the main pool, in order. */
let mainSql: string[] = [];
/** Runs the stubbed dispatch opened, one id per call. */
let opened: string[] = [];
/** Whether a second connection could take this key's lock mid-request. */
let rivalTookIt = false;

interface LockHandout {
  client: pg.Client;
  pid: number;
  destroyed: boolean;
}
let handouts: LockHandout[] = [];

/** Kill a backend and wait until db.ts has recorded the loss on its client. */
async function dropBackend(handout: LockHandout): Promise<void> {
  await admin.query("SELECT pg_terminate_backend($1)", [handout.pid]);
  for (let i = 0; i < 200 && !connectionLost(handout.client); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(connectionLost(handout.client), "the drop never reached db.ts's per-client record");
}

/** Take and release this key's lock from another connection. */
async function rivalTakesLock(scope: string, key: string): Promise<void> {
  const took = await rival.query(
    "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok",
    [scope, key],
  );
  rivalTookIt = took.rows[0].ok === true;
  await rival.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [scope, key]);
}

/**
 * A `lockPool` handing out real backends on the test database.
 *
 * Wired through the pool's own 'connect' event, because that is where db.ts
 * attaches the listener that records a drop for `connectionLost` -- going
 * around it would be testing a fake of the very thing under test.
 *
 * `dropAfterRead` drops the moment the cache read has answered: the last lock
 * statement before the session row is inserted, which is where the reviewer's
 * reproduction put it.
 */
function realLockPool(opts: { dropAfterRead: boolean }): void {
  db.lockPool.connect = (async () => {
    const client = new pg.Client({ connectionString: cluster!.url });
    await client.connect();
    const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const handout: LockHandout = { client, pid, destroyed: false };
    handouts.push(handout);
    (client as unknown as { release: (destroy?: boolean) => void }).release = (destroy?: boolean) => {
      handout.destroyed = handout.destroyed || !!destroy;
      client.end().catch(() => {});
    };
    (db.lockPool as unknown as EventEmitter).emit("connect", client);

    const send = client.query.bind(client);
    let scope = "";
    let dropped = false;
    (client as unknown as { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult> })
      .query = async (sql: string, params: unknown[] = []) => {
        if (sql.includes("pg_advisory_lock(")) scope = String(params[0]);
        const r = await send(sql, params as never[]);
        if (opts.dropAfterRead && !dropped && /FROM claw_idempotency_keys/.test(sql)) {
          dropped = true;
          await dropBackend(handout);
          await rivalTakesLock(scope, KEY);
        }
        return r;
      };
    return client;
  }) as unknown as typeof db.lockPool.connect;
}

/**
 * The main pool as the create sees it: a different pool of different
 * connections, so the drop does not touch it.
 *
 * `claw_idempotency_keys` is the exception and is forwarded to the real
 * database, because the whole question is whether the record the retry reads
 * off the lock connection is there -- an answer a map in this file could give
 * whichever way the write went.
 *
 * `onSessionInsert` is where case B drops: the session row exists from that
 * statement onwards, which is the moment after which the request can no longer
 * change its mind.
 */
function stubMainPool(onSessionInsert?: () => Promise<void>): void {
  const run = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    mainSql.push(sql);
    if (/claw_idempotency_keys/.test(sql)) {
      const r = await store.query(text, params as never[]);
      return { rows: r.rows, rowCount: r.rowCount };
    }
    if (/INSERT INTO claw_sessions/.test(sql) && onSessionInsert) await onSessionInsert();
    if (/FROM claw_workspace_refs r/.test(sql)) {
      return {
        rows: [{
          workspace_id: "kws_1",
          owner_user_id: CALLER.userId,
          storage_prefix: `users/${CALLER.userId}/`,
          version: "0",
          writer_run_id: null,
          retention_expires_at: null,
          deleted_at: null,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  db.query = ((text: string, params?: unknown[]) => run(text, params)) as typeof db.query;
  db.pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => run(text, params),
    release: () => {},
  })) as unknown as typeof db.pool.connect;
}

/** A dispatch that opens a fresh run per call and publishes cleanly. */
function dispatchOpensRuns(): void {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.openChatRun = (async () => {
    const taskId = `ktsk_${opened.length + 1}`;
    opened.push(taskId);
    return { taskId };
  }) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.recordPublishState = async () => {};
  sessionDispatchPorts.recordDispatchSeq = async () => {};
  sessionDispatchPorts.noteRefusedPublish = async () => {};
  // Answers the sequence the publisher hands back, because the dispatch reads
  // it: `async () => {}` compiles under tsx and is a type error under tsc.
  sessionDispatchPorts.publishTask = async () => 1;
}

async function app(): Promise<FastifyInstance> {
  const instance = Fastify();
  instance.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = CALLER;
  });
  await registerSessionRoutes(instance);
  await instance.ready();
  return instance;
}

interface CreateAnswer {
  statusCode: number;
  body: { ok?: boolean; error?: string; data?: { session_id?: string; message?: { run_id?: string } } };
}

async function create(server: FastifyInstance): Promise<CreateAnswer> {
  const res = await server.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { "idempotency-key": KEY },
    payload: { name: "s", message: { content: "summarise the logs" } },
  });
  return { statusCode: res.statusCode, body: res.json() as CreateAnswer["body"] };
}

/** How many session rows the run actually wrote. */
function sessionInserts(): number {
  return mainSql.filter((sql) => /INSERT INTO claw_sessions/.test(sql)).length;
}

before(async () => {
  if (skip) return;
  cluster = await startPgCluster();
  admin = await cluster.connect();
  rival = await cluster.connect();
  store = await cluster.connect();
  await store.query(`CREATE TABLE claw_idempotency_keys (
    idem_key     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    route        TEXT NOT NULL,
    status_code  INT  NOT NULL,
    response     JSONB NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, route, idem_key)
  )`);
});

beforeEach(async () => {
  if (skip) return;
  mainSql = [];
  opened = [];
  handouts = [];
  rivalTookIt = false;
  await store.query("DELETE FROM claw_idempotency_keys");
  dispatchOpensRuns();
});

afterEach(() => {
  if (skip) return;
  Object.assign(sessionDispatchPorts, originalPorts);
  db.query = originalQuery;
  db.pool.connect = originalPoolConnect;
  db.lockPool.connect = originalLockConnect;
});

after(async () => {
  if (skip) return;
  await cluster?.end();
});

test("a create whose lock connection drops before the insert creates nothing, and the "
  + "retry creates exactly one session", { skip }, async () => {
  realLockPool({ dropAfterRead: true });
  stubMainPool();
  const server = await app();
  try {
    const first = await create(server);

    assert.ok(rivalTookIt,
      "the premise: the server released this key's lock while the create was still running, "
      + "so a concurrent same-key retry was free to take it and create alongside this one");
    assert.equal(first.statusCode, 503,
      "a create that is no longer holding the lock its de-duplication depends on answered "
      + "success, so the client has a session id it can never get back");
    assert.equal(first.body.error, "lock_connection_lost");
    assert.equal(sessionInserts(), 0, "a request that refused still wrote a session row");
    assert.deepEqual(opened, [], "and started a run for it");

    // The retry the 503 asks for, on a lock connection that is really held.
    realLockPool({ dropAfterRead: false });
    const retry = await create(server);

    assert.equal(retry.statusCode, 200);
    assert.equal(sessionInserts(), 1, "the client's retry is the one and only create");
    assert.deepEqual(opened, ["ktsk_1"], "which started exactly one run");
  } finally {
    await server.close();
  }
});

test("a create whose lock connection drops after the dispatch keeps its live run and still "
  + "de-duplicates the retry", { skip }, async () => {
  // The session row is in and its first turn is a run in a sandbox, so there is
  // nothing to refuse: the answer is the 200 the create earned. What the drop
  // would otherwise take is the record that makes the retry a replay.
  let dropped = false;
  realLockPool({ dropAfterRead: false });
  stubMainPool(async () => {
    if (dropped) return;
    dropped = true;
    await dropBackend(handouts[handouts.length - 1]);
    await rivalTakesLock(`${CALLER.userId}:POST /v1/sessions`, KEY);
  });
  const server = await app();
  try {
    const first = await create(server);

    assert.ok(rivalTookIt, "the premise: the lock was released while the create still ran");
    assert.equal(first.statusCode, 200, "the create that already dispatched answers what it did");
    assert.deepEqual(opened, ["ktsk_1"], "its run was opened");
    assert.equal(sessionInserts(), 1);
    assert.equal(
      mainSql.filter((sql) => /DELETE FROM claw_sessions/.test(sql)).length, 0,
      "and the session carrying that live run was not rolled back under it",
    );

    const retry = await create(server);

    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.data?.session_id, first.body.data?.session_id,
      "the retry got a different session -- a second one was created while the first one's "
      + "run was still executing in its sandbox with nobody holding its id");
    assert.equal(retry.body.data?.message?.run_id, first.body.data?.message?.run_id,
      "and a second run alongside the one that is still executing");
    assert.equal(sessionInserts(), 1, "the retry wrote a second session row");
    assert.deepEqual(opened, ["ktsk_1"], "and opened a second run");

    // The mechanism behind that replay: the record went out on the main pool
    // rather than on the connection the drop took with it.
    const saved = await store.query("SELECT status_code FROM claw_idempotency_keys");
    assert.equal(saved.rowCount, 1, "the create's result never reached the cache");
  } finally {
    await server.close();
  }
});
