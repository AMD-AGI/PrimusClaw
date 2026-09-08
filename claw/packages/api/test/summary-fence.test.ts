// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

import { db } from "../src/infra/db.js";
import { withCompletionLock } from "../src/events/completion-lock.js";
import { publishSummaryIfCurrent } from "../src/events/summary.js";

const originalQuery = db.query;
const originalConnect = db.lockPool.connect;
const heldLocks = new Set<number>();
const statements: string[] = [];
let pg: PGlite;

before(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TABLE claw_conversation_turns (
      session_id TEXT NOT NULL,
      turn_index INT NOT NULL,
      is_placeholder BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    );
    CREATE TABLE claw_session_summaries (
      session_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      summarized_up_to INT NOT NULL,
      token_count INT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  db.query = (async (sql: string, params?: unknown[]) => {
    statements.push(sql);
    const result = await pg.query(sql, params as never[]);
    return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
  }) as typeof db.query;
  db.lockPool.connect = (async () => ({
    query: async (sql: string, params: unknown[]) => {
      const lockId = Number(params[0]);
      if (sql.includes("pg_try_advisory_lock")) {
        if (heldLocks.has(lockId)) return { rows: [{ ok: false }] };
        heldLocks.add(lockId);
        return { rows: [{ ok: true }] };
      }
      return { rows: [{ released: heldLocks.delete(lockId) }] };
    },
    release: () => {},
  })) as unknown as typeof db.lockPool.connect;
});

beforeEach(async () => {
  heldLocks.clear();
  statements.length = 0;
  await pg.exec(`
    TRUNCATE claw_conversation_turns, claw_session_summaries;
    INSERT INTO claw_conversation_turns (session_id, turn_index, is_placeholder)
      VALUES ('s-1', 1, FALSE), ('s-1', 2, TRUE), ('s-1', 4, FALSE);
  `);
});

after(async () => {
  db.query = originalQuery;
  db.lockPool.connect = originalConnect;
  await pg?.close();
});

async function storedSummaries(): Promise<unknown[]> {
  return (await pg.query("SELECT summary FROM claw_session_summaries ORDER BY session_id")).rows;
}

test("a summary whose captured placeholders are unchanged can be published", async () => {
  assert.equal(await publishSummaryIfCurrent("s-1", "The worker was lost.", 3, 1), true);
  assert.deepEqual(await storedSummaries(), [{ summary: "The worker was lost." }]);
});

test("a summary generated before a placeholder correction cannot recreate it", async () => {
  await pg.exec("UPDATE claw_conversation_turns SET is_placeholder = FALSE WHERE session_id = 's-1' AND turn_index = 2");

  assert.equal(await publishSummaryIfCurrent("s-1", "The worker was lost.", 3, 1), false);
  assert.deepEqual(await storedSummaries(), []);
  assert.equal(await publishSummaryIfCurrent("s-1", "The worker finished the task.", 3, 0), true);
  assert.deepEqual(await storedSummaries(), [{ summary: "The worker finished the task." }]);
});

test("a stale candidate does not replace an already refreshed summary", async () => {
  await pg.exec("UPDATE claw_conversation_turns SET is_placeholder = FALSE WHERE session_id = 's-1'");
  assert.equal(await publishSummaryIfCurrent("s-1", "The result was saved.", 3, 0), true);

  assert.equal(await publishSummaryIfCurrent("s-1", "The worker was lost.", 3, 1), false);
  assert.deepEqual(await storedSummaries(), [{ summary: "The result was saved." }]);
});

test("placeholder validation is limited to the captured live session prefix", async () => {
  await pg.exec(`
    UPDATE claw_conversation_turns SET is_placeholder = TRUE WHERE turn_index = 4;
    INSERT INTO claw_conversation_turns (session_id, turn_index, is_placeholder, deleted_at)
      VALUES ('s-2', 2, TRUE, NULL), ('s-1', 0, TRUE, NOW());
  `);

  assert.equal(await publishSummaryIfCurrent("s-1", "Earlier work.", 3, 1), true);
  assert.deepEqual(await storedSummaries(), [{ summary: "Earlier work." }]);
});

test("a completion holding the session lock defers summary publication", async () => {
  let entered!: () => void;
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const finish = new Promise<void>((resolve) => { release = resolve; });
  const completion = withCompletionLock("s-1", async () => {
    entered();
    await finish;
    await pg.exec("UPDATE claw_conversation_turns SET is_placeholder = FALSE WHERE session_id = 's-1' AND turn_index = 2");
  });
  await acquired;
  try {
    assert.equal(await publishSummaryIfCurrent("s-1", "The worker was lost.", 3, 1), false);
    assert.equal(statements.length, 0, "publication must not read or write through the held completion lock");
    assert.deepEqual(await storedSummaries(), []);
  } finally {
    release();
    await completion;
  }

  assert.equal(await publishSummaryIfCurrent("s-1", "The worker was lost.", 3, 1), false);
  assert.equal(await publishSummaryIfCurrent("s-1", "The task completed.", 3, 0), true);
  assert.deepEqual(await storedSummaries(), [{ summary: "The task completed." }]);
});
