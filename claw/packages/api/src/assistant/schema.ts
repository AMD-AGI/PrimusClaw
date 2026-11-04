// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Tables behind the assistant: one router session per user, the work items the
 * assistant took on, the log of what happened to each, and what the assistant
 * said. Created only when `CLAW_ASSISTANT_ENABLED` is on, so a deployment that
 * leaves it off has the same schema it had before.
 *
 * Nothing here points at a row of `claw_sessions` with a foreign key: a user may
 * delete a session from the web UI, and the item that ran in it, the log and the
 * says all outlive it.
 */
import type pg from "pg";

export async function ensureAssistantSchema(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistants (
      user_id       TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL UNIQUE,
      router_model  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_work_items (
      item_id            TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL,
      -- The #N the user sees, counted per user.
      seq                INT NOT NULL,
      title              TEXT NOT NULL,
      summary            TEXT NOT NULL DEFAULT '',
      -- in_progress | needs_you | done
      board_state        TEXT NOT NULL,
      -- progress | waiting | ready | blocked | failed | dropped
      last_report_kind   TEXT,
      pending_question   TEXT,
      -- accepted | dropped | stopped, only on a done item
      outcome            TEXT,
      worker_session_id  TEXT NOT NULL,
      -- Fencing token: bumped when a new turn starts, so a report from a turn
      -- that is no longer the current one matches nothing.
      generation         INT NOT NULL DEFAULT 0,
      -- Bumped by every 'ready' report; an acceptance names the version it saw.
      result_version     INT NOT NULL DEFAULT 0,
      accepted_version   INT,
      -- Bumped each time the item enters needs_you.
      attention_seq      INT NOT NULL DEFAULT 0,
      repo               JSONB,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at          TIMESTAMPTZ,
      UNIQUE (user_id, seq)
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_work_items_board ON claw_work_items(user_id, board_state, updated_at DESC)",
  );
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_worker_session ON claw_work_items(worker_session_id)",
  );
  // What the item is: `task`, done by a worker that reports, or `review`, a GitHub review on someone's behalf whose
  // state is read off what it did (`review-items.ts`). `params` is what a review was asked with.
  await client.query("ALTER TABLE claw_work_items ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'task'");
  await client.query("ALTER TABLE claw_work_items ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb");
  // One open review of a pull request at a time, whoever asked: two sessions reviewing it could both write to it.
  // GitHub's names are not case sensitive, and neither is this.
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open_review_pr ON claw_work_items(
       lower(params->'pr'->>'owner'), lower(params->'pr'->>'repo'), (params->'pr'->>'number'))
     WHERE kind = 'review' AND board_state <> 'done'`,
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_work_item_events (
      id          BIGSERIAL PRIMARY KEY,
      item_id     TEXT NOT NULL,
      -- created | run_started | progress | waiting | ready | blocked | failed | dropped | accepted | stopped
      kind        TEXT NOT NULL,
      -- worker | turn_end | sweep | user | router | policy (a review's state, read off what it did)
      source      TEXT NOT NULL,
      generation  INT NOT NULL,
      run_id      TEXT,
      summary     TEXT,
      question    TEXT,
      result      JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_work_item_events_item ON claw_work_item_events(item_id, id DESC)",
  );
  // A redelivered start or turn end must not count twice.
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_events_run_started
       ON claw_work_item_events(item_id, run_id, kind) WHERE kind = 'run_started'`,
  );
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_events_turn_end
       ON claw_work_item_events(item_id, run_id) WHERE source = 'turn_end'`,
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_says (
      say_id              UUID PRIMARY KEY,
      user_id             TEXT NOT NULL,
      item_id             TEXT,
      item_attention_seq  INT,
      text                TEXT NOT NULL,
      -- Written by the system, not the model, because nobody said anything.
      fallback            BOOLEAN NOT NULL DEFAULT FALSE,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at        TIMESTAMPTZ
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_assistant_says_user ON claw_assistant_says(user_id, created_at DESC)",
  );
  // At most one system fallback per time an item needed the user. Ordinary says
  // are not limited: the assistant may speak about one item more than once.
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_says_fallback
       ON claw_assistant_says(item_id, item_attention_seq) WHERE fallback`,
  );
}
