// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a completion leaves behind when the lock under it is released and the
 * completion is not.
 *
 * `withCompletionLock` is the one caller of `withLeaderLock` whose body has no
 * loop boundary: it reads `processed_at`, runs `handleComplete`, and writes
 * `processed_at`. It asks whether the lock is still held twice -- once in front
 * of those writes and once in front of the marker -- so a loss recorded before
 * the body reaches them skips them, while one recorded after still leaves the
 * work done and only the marker withheld. The whole argument for letting a
 * lost hold throw there -- see the header of events/completion-lock.ts -- is
 * that the throw becomes a nak, the nak becomes a redelivery, and the
 * redelivery finds `processed_at` still NULL and redoes the completion under a
 * lock that is really held. That is the only repair that exists for a
 * completion two holders may both have run: a duplicate terminalization and a
 * second `recordCompletionTurns` at the same turn index cannot be undone, they
 * can only be redone correctly once.
 *
 * The repair is reachable only if the durable done-marker is not written by the
 * pass that lost the lock. So the fact under test is a row value, not a log
 * line: after a real `pg_terminate_backend` of the real backend the advisory
 * lock sits on, `claw_session_events.processed_at` has to still be NULL, and
 * the next delivery has to run `handleComplete` again rather than read a stamp
 * the lost pass wrote and ack.
 *
 * The lock connection is a real Postgres backend on `DATABASE_URL`; the
 * completion's own work runs on the PGlite harness, which is the shape it has
 * in the cluster -- `db.query` on the main pool, untouched by the drop, which
 * is precisely why the drop is invisible to the body.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { EventEmitter } from "node:events";

import pg from "pg";

import { consumeEventDelivery, tombstoneReader } from "../src/events/consumer.js";
import { connectionLost, db } from "../src/infra/db.js";
import { sc } from "../src/infra/nats.js";
import { resetDeletedSessionCache } from "../src/sessions/deleted-cache.js";
import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";
import { startHarness, seedRun, seedSession, type Harness } from "./scenario-harness.js";

const SESSION = "completion-lock-drop";
const MESSAGE = "message-under-the-drop";
const skip = postgresSkipReason();

let cluster: PgCluster | undefined;
let h: Harness;
let admin: pg.Client;
let rival: pg.Client;
const originalLockConnect = db.lockPool.connect;
const originalTombstone = tombstoneReader.has;

/** Every client the code under test checked out of `lockPool`, in order. */
interface LockHandout {
  client: pg.Client;
  /** The lock id it asked for, as the production code computed it. */
  lockId?: number;
  /** Whether it was handed back with the destroy flag. */
  destroyed: boolean;
}

let handouts: LockHandout[] = [];
/** Terminate the next checked-out backend the moment it has taken the lock. */
let dropOnAcquire = false;
/** Whether a second connection could take the lock while the body still ran. */
let rivalTookItMidBody = false;

/**
 * A `lockPool` that hands out real backends on the test database.
 *
 * Wired through the pool's own 'connect' event, because that is where db.ts
 * attaches the listener that records a drop for `connectionLost` -- going
 * around it would be testing a fake of the very thing under test.
 */
function realLockPool(): void {
  db.lockPool.connect = (async () => {
    const client = new pg.Client({ connectionString: cluster!.url });
    await client.connect();
    const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const handout: LockHandout = { client, destroyed: false };
    handouts.push(handout);
    (client as unknown as { release: (destroy?: boolean) => void }).release = (destroy?: boolean) => {
      handout.destroyed = handout.destroyed || !!destroy;
      client.end().catch(() => {});
    };
    (db.lockPool as unknown as EventEmitter).emit("connect", client);

    const send = client.query.bind(client);
    (client as unknown as { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult> })
      .query = async (sql: string, params: unknown[] = []) => {
        const r = await send(sql, params as never[]);
        if (sql.includes("pg_try_advisory_lock") && r.rows[0]?.ok === true) {
          handout.lockId = Number(params[0]);
          if (dropOnAcquire) {
            dropOnAcquire = false;
            await dropBackend(client, pid);
            // The premise, asserted rather than assumed: the server really did
            // release the lock, so a second replica really was free to run the
            // same decide-then-act on the same completion.
            const took = await rival.query("SELECT pg_try_advisory_lock($1) AS ok", [params[0]]);
            rivalTookItMidBody = took.rows[0].ok === true;
            await rival.query("SELECT pg_advisory_unlock($1)", [params[0]]);
          }
        }
        return r;
      };
    return client;
  }) as unknown as typeof db.lockPool.connect;
}

/** Kill the backend and wait until db.ts has recorded the loss on this client. */
async function dropBackend(client: pg.Client, pid: number): Promise<void> {
  await admin.query("SELECT pg_terminate_backend($1)", [pid]);
  for (let i = 0; i < 200 && !connectionLost(client); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(connectionLost(client), "the drop never reached db.ts's per-client record");
}

before(async () => {
  if (skip) return;
  cluster = await startPgCluster();
  admin = await cluster.connect();
  rival = await cluster.connect();
  h = await startHarness();
  // The drain `handleComplete` runs reads every column the dispatcher needs,
  // and the harness DDL carries the subset the other scenarios use. Without
  // these the drain throws, the delivery naks on that instead of on the lost
  // lock, and this file would assert nothing about either.
  await h.sql(`ALTER TABLE claw_pending_messages
    ADD COLUMN plugin_id INTEGER,
    ADD COLUMN tool_ids JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN workspace_id TEXT,
    ADD COLUMN platform_key TEXT,
    ADD COLUMN llm_api_key TEXT,
    ADD COLUMN credentials_blob TEXT,
    ADD COLUMN image TEXT,
    ADD COLUMN resources JSONB,
    ADD COLUMN timeout INTEGER,
    ADD COLUMN user_env JSONB,
    ADD COLUMN session_env JSONB,
    ADD COLUMN topology JSONB`);
});

beforeEach(async () => {
  if (skip) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.reset();
  handouts = [];
  dropOnAcquire = false;
  rivalTookItMidBody = false;
  realLockPool();
  tombstoneReader.has = async () => false;
  resetDeletedSessionCache();
  await seedSession(h, SESSION, { gateOwner: MESSAGE });
  await seedRun(h, "run-dropped", SESSION, { status: "running", messageId: MESSAGE });
});

after(async () => {
  if (skip) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.close();
  db.lockPool.connect = originalLockConnect;
  tombstoneReader.has = originalTombstone;
  resetDeletedSessionCache();
  await cluster?.end();
});

function completion(): Record<string, unknown> {
  return {
    type: "exec_complete", session_id: SESSION, task_id: "run-dropped", user_id: "u-1",
    message_id: MESSAGE, prompt: "Do the work", final_text: "The work is done.",
    failed: false, error_count: 0, skills_used: {},
  };
}

async function deliver(event: Record<string, unknown>, sequence: number) {
  let acks = 0;
  const naks: Array<number | undefined> = [];
  await consumeEventDelivery({
    subject: `events.${SESSION}`, data: sc.encode(JSON.stringify(event)), seq: sequence,
    ack: () => { acks++; }, nak: (delay) => { naks.push(delay); },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.sql("SELECT 1");
  return { acks, naks };
}

async function processedAt(sequence: number): Promise<unknown> {
  const rows = await h.sql(
    "SELECT processed_at FROM claw_session_events WHERE event_id = $1 AND session_id = $2",
    [`claw-${sequence}`, SESSION],
  );
  assert.equal(rows.length, 1, "the audit row is written whatever the completion did");
  return rows[0].processed_at;
}

/** The statements only `handleComplete` sends, as a witness that it ran. */
function completionWork(): string[] {
  return h.statements.filter((sql) => sql.startsWith("UPDATE claw_tasks")
    || sql.startsWith("INSERT INTO claw_conversation_turns"));
}

test("a completion that lost its lock leaves processed_at NULL, so the redelivery redoes it", {
  skip,
}, async () => {
  dropOnAcquire = true;
  const lost = await deliver(completion(), 1);

  assert.ok(rivalTookItMidBody,
    "the premise: the server released the lock while this completion was still running, "
    + "so a second holder could have run handleComplete for the same event");
  assert.deepEqual(lost, { acks: 0, naks: [10_000] },
    "a pass that was not exclusive has to be naked, not acked");
  assert.equal(handouts.length, 1);
  assert.equal(handouts[0].destroyed, true, "a dropped session is not handed to the next caller");
  assert.deepEqual(completionWork(), [],
    "a loss that is already recorded when the body reaches its writes stops them outright, "
    + "so the duplicate handleComplete this repair exists to redo is never run in the first "
    + "place. A drop that lands after that check still leaves the work done and only the "
    + "done-marker withheld, which is the case the nak and redelivery below repair.");

  assert.equal(
    await processedAt(1), null,
    "the pass that lost its lock wrote the durable done-marker anyway, so the redelivery "
    + "its own nak asked for is short-circuited and the duplicate handleComplete it may "
    + "have raced is never repaired",
  );

  // The redelivery the nak asked for, under a lock this replica really holds.
  h.statements.length = 0;
  const redelivered = await deliver(completion(), 1);

  assert.deepEqual(redelivered, { acks: 1, naks: [] });
  assert.equal(handouts.length, 2, "the redelivery took the lock again");
  assert.ok(
    completionWork().length > 0,
    "the redelivery acked without redoing the completion -- the only repair that exists "
    + "for a completion two holders may both have run",
  );
  assert.notEqual(await processedAt(1), null,
    "and the pass that really was exclusive is the one that marks the event done");
});

test("an ordinary completion under a lock that is never lost behaves exactly as before", {
  skip,
}, async () => {
  const outcome = await deliver(completion(), 7);

  assert.deepEqual(outcome, { acks: 1, naks: [] });
  assert.equal(handouts.length, 1);
  assert.equal(handouts[0].destroyed, false, "a clean hold costs no connection");
  assert.notEqual(await processedAt(7), null, "a completion that ran alone is marked done");
  assert.ok(completionWork().length > 0);

  // And the marker is what makes the next delivery of the same event a no-op.
  h.statements.length = 0;
  const again = await deliver(completion(), 7);
  assert.deepEqual(again, { acks: 1, naks: [] });
  assert.deepEqual(completionWork(), [], "a completion already marked done is not redone");
});
