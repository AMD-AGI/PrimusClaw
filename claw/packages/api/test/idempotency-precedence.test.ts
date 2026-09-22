// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which of two same-key writes the idempotency cache keeps, when the two
 * requests raced and only one of them left a run executing.
 *
 * The key's advisory lock is session-scoped, so the server hands it away the
 * instant a lock connection drops. From that moment two requests are live on
 * the same key: the one that lost the lock (writing its result through the main
 * pool -- the fallback, which exists because losing that row loses the only
 * handle anyone has on a live run) and the one that took the freed lock. Both
 * read the cache when it was empty, both decide what to store at the end, and
 * the order their two statements arrive in is not something either can see.
 *
 * The cache row is not a log of who got there first. It is the handle every
 * later retry on that key is answered from, so the only question it can be
 * asked is which of the two results is worth handing back -- and exactly one of
 * them names a session and a run that exist. A 2xx create response carries
 * `session_id` and `message.run_id`; every failure this route caches carries
 * neither, by contract (`DispatchResult`: no failing kind has a run id, because
 * `rejected` and `publish_failed` have rolled their row back and
 * `publish_unknown` names nothing in its body). So a cached failure sitting on
 * top of a live create does not merely lose a race: it answers every retry on
 * that key with a failure for a run that is executing in a sandbox, which
 * nobody can name any more, for as long as the entry lives.
 *
 * These are the orderings where the loser is the create that really happened:
 *
 *   1 the lock HOLDER's live create writes second, behind a lockless failure
 *     from the request that dropped off the key;
 *   2 the LOCKLESS live create writes second, behind the holder's own failure
 *     -- the mirror image, and the reason precedence cannot be "the holder
 *     wins": here the holder is the one that created nothing;
 *   3 the same as 2 with nobody holding the lock at all, which is the state the
 *     fallback was added for: a rule that reads lock ownership has no answer
 *     here, and degenerates to "whoever wrote first", which is the defect.
 *
 * Each asserts what the client's NEXT retry on the key is handed and what the
 * run behind it actually is -- not which row won. The interleaving is driven by
 * hooking the statements themselves (the rival writes between this request's
 * decision and this request's INSERT), never by timing.
 *
 * The lock connection is a real Postgres backend on `DATABASE_URL`, the drop is
 * a real `pg_terminate_backend`, and the rival is a second real connection, so
 * "the lock was free" / "the lock was held" is asserted against the server
 * rather than assumed. The create's own statements are stubbed, which is the
 * shape they have in the cluster -- a different pool, unaffected by the drop --
 * except `claw_idempotency_keys`, which is forwarded to the same real database
 * both write paths land in.
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

const KEY = "two-creates-one-key";
const ROUTE = "POST /v1/sessions";
const CALLER: UserInfo = {
  userId: "u-caller",
  userName: "u-caller",
  roles: ["default"],
  platformKey: "pk",
  virtualKey: "vk-caller",
};
const LOCK_SCOPE = `${CALLER.userId}:${ROUTE}`;

/** The failure the rival request caches: the body this route caches verbatim. */
const RIVAL_FAILURE = { ok: false, error: "task dispatch failed", detail: "no stream leader" };

const skip = postgresSkipReason();

let cluster: PgCluster | undefined;
/** Terminates backends, and probes the advisory lock to prove who holds it. */
let admin: pg.Client;
/** The other pod: takes the lock when it is free, and writes its own result. */
let rival: pg.Client;
/** The real database behind `claw_idempotency_keys` for both write paths. */
let store: pg.Client;

const originalPorts = { ...sessionDispatchPorts };
const originalQuery = db.query;
const originalPoolConnect = db.pool.connect;
const originalLockConnect = db.lockPool.connect;

/** Every statement the create sent to the main pool, in order. */
let mainSql: string[] = [];
/** Runs the stubbed dispatch actually opened, one id per call. */
let opened: string[] = [];
/** Whether the rival could take this key's advisory lock when it tried. */
let rivalHeldLock: boolean | undefined;
/** What the key held at the moment this request's own INSERT was about to go. */
let keyBeforeOurWrite: number | undefined;

interface LockHandout {
  client: pg.Client;
  pid: number;
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

/**
 * The other pod's create, reaching the cache first.
 *
 * `asHolder` is the whole difference between orderings 2 and 3, and it is
 * asserted against the server rather than assumed: as the holder it must
 * actually get the lock this request lost, and with no holder the lock must
 * actually be free to anyone -- which is what makes 3 the no-holder case and
 * not just a rival that forgot to lock.
 */
async function rivalCachesFailure(opts: { asHolder: boolean }): Promise<void> {
  const took = await rival.query(
    "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok",
    [LOCK_SCOPE, KEY],
  );
  rivalHeldLock = took.rows[0].ok === true;
  if (!opts.asHolder) {
    // Not the rival's lock to hold in this ordering; the probe above only
    // establishes whether anybody held it, so give it straight back.
    await rival.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [LOCK_SCOPE, KEY]);
  }
  const miss = await rival.query(
    "SELECT status_code FROM claw_idempotency_keys WHERE user_id = $1 AND route = $2 "
    + "AND idem_key = $3 AND expires_at > NOW()",
    [CALLER.userId, ROUTE, KEY],
  );
  assert.equal(miss.rowCount, 0,
    "the premise: the rival create found no cached result, so the failure it writes next is "
    + "the first record this key has ever had and is nobody's replay of anything");
  await rival.query(
    `INSERT INTO claw_idempotency_keys (idem_key, user_id, route, status_code, response, expires_at)
     VALUES ($1, $2, $3, 503, $4::jsonb, NOW() + INTERVAL '24 hours')`,
    [KEY, CALLER.userId, ROUTE, JSON.stringify(RIVAL_FAILURE)],
  );
  if (opts.asHolder) {
    await rival.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [LOCK_SCOPE, KEY]);
  }
}

/**
 * A `lockPool` handing out real backends on the test database.
 *
 * Wired through the pool's own 'connect' event, because that is where db.ts
 * attaches the listener that records a drop for `connectionLost` -- going
 * around it would be testing a fake of the very thing under test.
 *
 * `beforeStatement` runs on the lock connection immediately before a statement
 * is forwarded, which is how ordering 1 puts the rival's write strictly between
 * this request's decision to cache a 200 and the INSERT that caches it.
 */
function realLockPool(
  beforeStatement?: (sql: string, handout: LockHandout) => Promise<void>,
): void {
  db.lockPool.connect = (async () => {
    const client = new pg.Client({ connectionString: cluster!.url });
    await client.connect();
    const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const handout: LockHandout = { client, pid };
    handouts.push(handout);
    (client as unknown as { release: (destroy?: boolean) => void }).release = () => {
      client.end().catch(() => {});
    };
    (db.lockPool as unknown as EventEmitter).emit("connect", client);

    const send = client.query.bind(client);
    (client as unknown as { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult> })
      .query = async (sql: string, params: unknown[] = []) => {
        if (beforeStatement) await beforeStatement(sql, handout);
        return await send(sql, params as never[]);
      };
    return client;
  }) as unknown as typeof db.lockPool.connect;
}

/**
 * The main pool as the create sees it: a different pool of different
 * connections, so the drop does not touch it.
 *
 * `claw_idempotency_keys` is the exception and is forwarded to the real
 * database, because the whole question is which record the retry reads back --
 * an answer a map in this file could give whichever way the write went.
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

/** A dispatch that opens its run and then cannot publish it. */
function dispatchFailsToPublish(): void {
  sessionDispatchPorts.publishTask = async () => {
    throw new Error("no stream leader");
  };
  // 'closed' = the compensation settled the row, which is what earns the
  // caller's rollback and the `publish_failed` the route turns into its 503.
  sessionDispatchPorts.failChatRunDispatch = (async () => "closed") as
    typeof sessionDispatchPorts.failChatRunDispatch;
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
  body: {
    ok?: boolean;
    error?: string;
    data?: { session_id?: string; message?: { run_id?: string } };
  };
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

/** How many of them were rolled back out again. */
function sessionDeletes(): number {
  return mainSql.filter((sql) => /DELETE FROM claw_sessions/.test(sql)).length;
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
  rivalHeldLock = undefined;
  keyBeforeOurWrite = undefined;
  await store.query("DELETE FROM claw_idempotency_keys");
  dispatchOpensRuns();
});

afterEach(async () => {
  if (skip) return;
  Object.assign(sessionDispatchPorts, originalPorts);
  db.query = originalQuery;
  db.pool.connect = originalPoolConnect;
  db.lockPool.connect = originalLockConnect;
  // The rival is a long-lived session; a lock it still holds would be inherited
  // by the next test as a premise nobody stated.
  await rival.query("SELECT pg_advisory_unlock_all()").catch(() => {});
});

after(async () => {
  if (skip) return;
  await cluster?.end();
});

/** What the key holds right now, as the next retry would read it. */
async function cachedStatus(): Promise<number | undefined> {
  const r = await store.query(
    "SELECT status_code FROM claw_idempotency_keys WHERE user_id = $1 AND route = $2 "
    + "AND idem_key = $3 AND expires_at > NOW()",
    [CALLER.userId, ROUTE, KEY],
  );
  return r.rows[0]?.status_code as number | undefined;
}

test("1: the retry names the run the lock holder created, even though a lockless failure "
  + "reached the key first", { skip }, async () => {
  // This request holds a healthy lock for its whole create and its run really
  // is executing. The rival is the request that dropped off this key earlier:
  // it holds nothing (asserted -- the lock is ours), its own create failed and
  // left nothing behind, and its fallback write lands in the one window that
  // matters, between this request deciding to cache its 200 and the INSERT that
  // does it.
  let rivalWrote = false;
  realLockPool(async (sql) => {
    if (rivalWrote || !/INSERT INTO claw_idempotency_keys/.test(sql)) return;
    rivalWrote = true;
    await rivalCachesFailure({ asHolder: false });
    keyBeforeOurWrite = await cachedStatus();
  });
  stubMainPool();
  const server = await app();
  try {
    const first = await create(server);

    assert.ok(rivalWrote, "the interleaving never happened: nothing wrote before this request");
    assert.equal(rivalHeldLock, false,
      "the premise: this request was supposed to be holding this key's lock, and the rival "
      + "took it, so the create under test was never the holder at all");
    assert.equal(keyBeforeOurWrite, 503,
      "the premise: the lockless failure was supposed to be sitting on the key already when "
      + "this request wrote");
    assert.equal(first.statusCode, 200, "this request's own create really did succeed");
    assert.deepEqual(opened, ["ktsk_1"], "and opened exactly one run");
    assert.equal(sessionDeletes(), 0, "whose session was never rolled back under it");

    // What the client's next retry on this key is handed.
    const retry = await create(server);

    assert.equal(retry.statusCode, 200,
      "the retry is answered with the other request's failure: a 503 for a create that did "
      + "not happen, while the run this one started goes on executing in its sandbox");
    assert.equal(retry.body.data?.session_id, first.body.data?.session_id,
      "the retry no longer names the session whose run is live");
    assert.equal(retry.body.data?.message?.run_id, first.body.data?.message?.run_id,
      "and the id of that live run is not recoverable by replay any more");
    assert.ok(opened.includes(retry.body.data?.message?.run_id ?? ""),
      "the retry named a run nothing ever opened");
    assert.equal(sessionInserts(), 1, "the retry built a second session beside the live run");
    assert.deepEqual(opened, ["ktsk_1"], "and started a second run");
  } finally {
    await server.close();
  }
});

test("2: the retry names the run the lockless create started, even though the lock holder's "
  + "failure reached the key first", { skip }, async () => {
  // The mirror image, and the case a "the holder wins" rule gets backwards. The
  // lock drops at the session insert, the pod that takes the freed lock is the
  // one whose create fails and rolls itself back, and it caches that failure
  // while nothing better exists -- which is allowed, and is the right answer
  // right up until this request finishes the create it had already started.
  let interrupted = false;
  realLockPool();
  stubMainPool(async () => {
    if (interrupted) return;
    interrupted = true;
    await dropBackend(handouts[handouts.length - 1]);
    await rivalCachesFailure({ asHolder: true });
    keyBeforeOurWrite = await cachedStatus();
  });
  const server = await app();
  try {
    const first = await create(server);

    assert.ok(interrupted, "the interleaving never happened");
    assert.equal(rivalHeldLock, true,
      "the premise: the server was supposed to release this key's lock with the dropped "
      + "connection, so the rival pod really is the holder while this request is not");
    assert.equal(keyBeforeOurWrite, 503,
      "the premise: the holder's failure was supposed to be on the key before this request "
      + "wrote its own result");
    assert.equal(first.statusCode, 200,
      "a create whose session row is in and whose first turn is running answered failure");
    assert.deepEqual(opened, ["ktsk_1"]);
    assert.equal(sessionDeletes(), 0, "its session was rolled back under a live run");

    const retry = await create(server);

    assert.equal(retry.statusCode, 200,
      "the retry is answered with the holder's failure, though the holder created nothing "
      + "and this request's run is the only thing that exists on this key");
    assert.equal(retry.body.data?.session_id, first.body.data?.session_id,
      "the retry no longer names the session whose run is live");
    assert.equal(retry.body.data?.message?.run_id, first.body.data?.message?.run_id,
      "and the id of that live run is not recoverable by replay any more");
    assert.ok(opened.includes(retry.body.data?.message?.run_id ?? ""),
      "the retry named a run nothing ever opened");
    assert.equal(sessionInserts(), 1, "the retry built a second session beside the live run");
    assert.deepEqual(opened, ["ktsk_1"], "and started a second run");
  } finally {
    await server.close();
  }
});

test("3: with nobody holding the lock, the retry still names the run that exists rather than "
  + "the failure that got there first", { skip }, async () => {
  // The state the fallback was added for, taken to both sides: the lock is gone
  // for everyone, so neither write carries any authority at all and a rule that
  // reads ownership has nothing to read. Whoever arrives first cannot be the
  // answer, because one of these two requests has a run in a sandbox and the
  // other has nothing.
  let interrupted = false;
  realLockPool();
  stubMainPool(async () => {
    if (interrupted) return;
    interrupted = true;
    await dropBackend(handouts[handouts.length - 1]);
    await rivalCachesFailure({ asHolder: false });
    keyBeforeOurWrite = await cachedStatus();
  });
  const server = await app();
  try {
    const first = await create(server);

    assert.ok(interrupted, "the interleaving never happened");
    assert.equal(rivalHeldLock, true,
      "the premise: with this request's connection dropped the key's lock is supposed to be "
      + "free to anyone, so neither writer is the holder");
    assert.equal(keyBeforeOurWrite, 503,
      "the premise: the other lockless failure was supposed to be on the key first");
    assert.equal(first.statusCode, 200);
    assert.deepEqual(opened, ["ktsk_1"]);
    assert.equal(sessionDeletes(), 0, "its session was rolled back under a live run");

    const retry = await create(server);

    assert.equal(retry.statusCode, 200,
      "with no holder to appeal to the key kept whichever write arrived first, and that one "
      + "was the failure: the retry is told a create failed while its run is executing");
    assert.equal(retry.body.data?.session_id, first.body.data?.session_id,
      "the retry no longer names the session whose run is live");
    assert.equal(retry.body.data?.message?.run_id, first.body.data?.message?.run_id,
      "and the id of that live run is not recoverable by replay any more");
    assert.ok(opened.includes(retry.body.data?.message?.run_id ?? ""),
      "the retry named a run nothing ever opened");
    assert.equal(sessionInserts(), 1, "the retry built a second session beside the live run");
  } finally {
    await server.close();
  }
});

test("a create that genuinely failed still records its failure, and the retry replays it "
  + "instead of dispatching again", { skip }, async () => {
  // The other half of the rule, and the one that must not be traded away for
  // the three above: when nothing better exists the failure IS the best record
  // of this key, and it has to be stored. If it were not, every retry would go
  // all the way through to a dispatch that is already known to be failing --
  // a client retry loop turned into load on a system that is actually broken.
  realLockPool();
  stubMainPool();
  dispatchFailsToPublish();
  const server = await app();
  try {
    const first = await create(server);

    assert.equal(first.statusCode, 503, "this request's own dispatch really did fail");
    assert.equal(first.body.error, "task dispatch failed");
    assert.equal(await cachedStatus(), 503,
      "the failure was not recorded, so nothing stands between a retry loop and a dispatch "
      + "that is already known to be failing");

    const retry = await create(server);

    assert.equal(retry.statusCode, 503, "the retry was not answered from the cache");
    assert.equal(retry.body.error, "task dispatch failed");
    assert.equal(sessionInserts(), 1,
      "the retry created a second session and attempted the failing dispatch again");
  } finally {
    await server.close();
  }
});
