// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The confirmations table as an earlier release left it, brought to the one that holds reviews too: what was pending stays a pending merge, the
 * table learns the new status and the new key, and doing it again changes nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { GITHUB_REVIEW_SCHEMA_SQL } from "../src/github-review/store.js";

const EARLIER_RELEASE = [
  `CREATE TABLE claw_github_confirmations (
      confirmation_id   UUID PRIMARY KEY,
      session_id        TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      actor_user_id     TEXT NOT NULL,
      repo              TEXT NOT NULL,
      pr                INTEGER NOT NULL,
      head_sha          TEXT NOT NULL,
      title             TEXT NOT NULL DEFAULT '',
      author            TEXT NOT NULL DEFAULT '',
      reasons           JSONB NOT NULL DEFAULT '[]'::jsonb,
      checks            JSONB NOT NULL DEFAULT '{}'::jsonb,
      status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'merging', 'merged', 'denied', 'stale', 'expired', 'refused')),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL,
      decided_at        TIMESTAMPTZ,
      decided_by        TEXT,
      decided_via       JSONB,
      result            JSONB
    )`,
  `CREATE UNIQUE INDEX uq_github_confirmations_pending ON claw_github_confirmations(session_id, repo, pr, head_sha) WHERE status = 'pending'`,
];

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const insert = (n: number, kind: string, key: string, status = "pending") =>
  `INSERT INTO claw_github_confirmations (confirmation_id, session_id, requester_user_id, actor_user_id, repo, pr, head_sha, expires_at, kind, action_key, status)
   VALUES ('${ID(n)}', 's-1', 'u-alice', 'u-bob', 'AMD-AGI/demo', 7, '${"1".repeat(40)}', NOW() + INTERVAL '1 hour', '${kind}', '${key}', '${status}')`;

test("a table an earlier release made is upgraded in place, and upgrading twice is the same as once", async () => {
  const pg = new PGlite();
  try {
    for (const sql of EARLIER_RELEASE) await pg.exec(sql);
    await pg.exec(`INSERT INTO claw_github_confirmations (confirmation_id, session_id, requester_user_id, actor_user_id, repo, pr, head_sha, expires_at)
                   VALUES ('${ID(1)}', 's-0', 'u-alice', 'u-bob', 'AMD-AGI/demo', 3, '${"2".repeat(40)}', NOW() + INTERVAL '1 hour')`);
    for (let round = 1; round <= 2; round++) {
      for (const sql of GITHUB_REVIEW_SCHEMA_SQL) await pg.exec(sql);
      const old = (await pg.query("SELECT kind, review, action_key, status FROM claw_github_confirmations WHERE confirmation_id = $1", [ID(1)])).rows[0];
      assert.deepEqual(old, { kind: "merge", review: null, action_key: "", status: "pending" }, `round ${round}: what was pending is a pending merge`);
    }
    const indexes = ((await pg.query("SELECT indexname FROM pg_indexes WHERE tablename = 'claw_github_confirmations'")).rows as Array<{ indexname: string }>).map((r) => r.indexname);
    assert.equal(indexes.includes("uq_github_confirmations_pending"), false, "the index on the commit alone is gone");
    assert.equal(indexes.includes("uq_github_confirmations_pending_write"), true);
    // A merge and a review of one head commit are two pending rows; the same write twice is refused by the index.
    await pg.exec(insert(2, "merge", ""));
    await pg.exec(insert(3, "review", "COMMENT:aaaaaaaaaaaa"));
    await pg.exec(insert(4, "review", "COMMENT:bbbbbbbbbbbb"));
    await assert.rejects(pg.exec(insert(5, "review", "COMMENT:aaaaaaaaaaaa")), /uq_github_confirmations_pending_write/);
    await assert.rejects(pg.exec(insert(6, "merge", "")), /uq_github_confirmations_pending_write/);
    // The new end of a held review is a status the table takes; one it does not know still is refused.
    await pg.exec(insert(7, "review", "COMMENT:cccccccccccc", "submitted"));
    await assert.rejects(pg.exec(insert(8, "review", "COMMENT:dddddddddddd", "posted")), /status_check/);
    // And so is the end of a merge that put the pull request in the base branch's merge queue.
    await pg.exec(insert(9, "merge", "", "queued"));
  } finally {
    await pg.close();
  }
});

test("a table that already takes 'submitted' but not 'queued' (an earlier head of this release) learns 'queued' too, and a table that has it is left alone", async () => {
  const pg = new PGlite();
  try {
    for (const sql of EARLIER_RELEASE) await pg.exec(sql);
    for (const sql of GITHUB_REVIEW_SCHEMA_SQL) await pg.exec(sql);
    // The constraint as that head wrote it: 'submitted' in, 'queued' not.
    await pg.exec(`ALTER TABLE claw_github_confirmations DROP CONSTRAINT claw_github_confirmations_status_check`);
    await pg.exec(`ALTER TABLE claw_github_confirmations ADD CONSTRAINT claw_github_confirmations_status_check
                   CHECK (status IN ('pending', 'merging', 'merged', 'submitted', 'denied', 'stale', 'expired', 'refused'))`);
    await assert.rejects(pg.exec(insert(1, "merge", "", "queued")), /status_check/);
    for (let round = 1; round <= 2; round++) {
      for (const sql of GITHUB_REVIEW_SCHEMA_SQL) await pg.exec(sql);
      await pg.exec(`DELETE FROM claw_github_confirmations`);
      await pg.exec(insert(2, "merge", "", "queued"));
      await pg.exec(insert(3, "review", "COMMENT:cccccccccccc", "submitted"));
      await assert.rejects(pg.exec(insert(4, "merge", "", "posted")), /status_check/, `round ${round}`);
    }
  } finally {
    await pg.close();
  }
});
