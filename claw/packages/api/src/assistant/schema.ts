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

  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_work_item_events (
      id          BIGSERIAL PRIMARY KEY,
      item_id     TEXT NOT NULL,
      -- created | run_started | progress | waiting | ready | blocked | failed | dropped | accepted | stopped
      kind        TEXT NOT NULL,
      -- worker | turn_end | sweep | user | router
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

  // What a router turn may act on: the user's message it answers, as received, with how the request that carried
  // it was authenticated. Written in the transaction that accepts the message, keyed by the id of the turn that
  // will carry it, so a turn can never read a message it does not answer. A report the server queued has no row.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_assistant_messages (
      session_id       TEXT NOT NULL,
      message_id       TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      content          TEXT NOT NULL,
      -- {kind: "person"} or {kind: "service", client_id, act_sub} when an identity-provider token carried it; NULL otherwise.
      attended_via     JSONB,
      -- What the channel sent beside the text (people, actions, repos, channel_message_id), already bounded.
      channel_context  JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, message_id)
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_assistant_messages_received ON claw_assistant_messages(received_at)",
  );
}
