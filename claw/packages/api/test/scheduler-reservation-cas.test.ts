// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The soft-ceiling scheduler reserves only rows that are still queued.
 *
 * The reservation is a compare-and-set from `queued`, and that list of allowed
 * prior states is the whole exclusivity of the slot. The selection that fed it
 * took no row lock, so under READ COMMITTED another writer can move the row
 * between the pick and the write -- the sweep that fails a queued row, a Stop,
 * or the plain dispatch path on another replica taking it to `preparing`.
 * Widen the list to include `preparing` and the CAS matches anyway: the
 * scheduler dispatches a row somebody else already owns, and one task goes to
 * Brain twice.
 *
 * A server rather than PGlite, because the theft has to commit on a second
 * connection while the reservation's transaction is open.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import type pg from "pg";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { seedRun, startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

/** The statement the reservation pages through; the theft rides its return. */
const PICK_QUEUED = /origin IS DISTINCT FROM 'chat'/;

/**
 * Let a second writer commit between the pick and the CAS, on the very
 * connection the reservation holds its lock on.
 *
 * This is the interleaving itself rather than a simulation of it: whatever the
 * reservation selected, the theft lands before it writes. Only the
 * argument-less checkout is wrapped -- `pool.query` reaches the same method
 * with a callback, and answering that with a promise would hang every
 * statement in the process.
 */
function stealAfterPick(
  pool: pg.Pool, thief: pg.Client, sql: string, params: unknown[],
): () => void {
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  let taken = false;
  (pool as { connect: unknown }).connect = (...outer: unknown[]) => {
    if (outer.length) return connect(...outer);
    return (connect() as Promise<pg.PoolClient>).then((client) => {
      const query = client.query.bind(client) as (...a: unknown[]) => unknown;
      (client as { query: unknown }).query = async (...args: unknown[]) => {
        const first = args[0];
        const text = typeof first === "string"
          ? first
          : String((first as { text?: string })?.text ?? "");
        const result = await query(...args);
        if (!taken && PICK_QUEUED.test(text)) {
          taken = true;
          await thief.query(sql, params);
        }
        return result;
      };
      return client;
    });
  };
  return () => { (pool as { connect: unknown }).connect = connect; };
}

describe("the scheduler reserves only what is still queued", { skip }, () => {
  let h: AdmissionCluster;
  let thief: pg.Client;

  before(async () => {
    h = await startAdmissionCluster({
      ADMIT_SOFT_RUNS: "8",
      ADMIT_HARD_RUNS: "8",
      TASK_DISPATCH_PUBLISH_TIMEOUT_MS: "1000",
      TASK_DISPATCH_STAGE_TIMEOUT_MS: "2000",
      TASK_SCHEDULER_DISPATCH_TIMEOUT_MS: "5000",
    });
    thief = await h.connect();
  });
  after(async () => { await h?.stop(); });

  test("a queued row another writer reserved first is not published a second time", async () => {
    const q = h.app.db.db;
    await q.query("DELETE FROM claw_tasks");
    await q.query("DELETE FROM claw_sessions WHERE session_id = 's-cas'");
    // Credentials the dispatcher will trust, so a reservation that should not
    // have happened gets all the way to the publish rather than dying on
    // setup and looking like the refusal under test.
    await q.query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, config)
       VALUES ('s-cas', 'dag', 'u-cas', 'claw', $1::jsonb)`,
      [JSON.stringify({
        _server_managed_credentials: true, platform_key: "pk-cas", llm_api_key: "sk-cas",
      })],
    );
    await seedRun(q as never, { taskId: "cas-row", sessionId: "s-cas", status: "queued" });

    const dispatcher = await import("../src/tasks/dispatcher.js");
    const published: string[] = [];
    const originalPublish = dispatcher.taskPublisher.publish;
    dispatcher.taskPublisher.publish = async (payload: string) => { published.push(payload); };
    const restore = stealAfterPick(
      q.pool, thief,
      "UPDATE claw_tasks SET status = 'preparing', started_at = NOW() WHERE task_id = $1",
      ["cas-row"],
    );
    try {
      await h.app.scheduler.schedulerTick();
    } finally {
      restore();
      dispatcher.taskPublisher.publish = originalPublish;
    }

    assert.deepEqual(published, [], "the row its owner is already preparing is not sent again");
    const row = (await q.query(
      "SELECT status, internal_token_hash FROM claw_tasks WHERE task_id = 'cas-row'",
    )).rows[0] as { status: string; internal_token_hash: string | null };
    assert.equal(row.status, "preparing", "the theft stands");
    assert.equal(
      row.internal_token_hash, null,
      "and the scheduler minted no second token for a run it does not own",
    );
  });
});
