// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Tables behind A2A push notifications. Created only when
 * `CLAW_A2A_PUSH_ENABLED` is on, so a deployment that leaves it off has the
 * same schema it had before.
 *
 * A configuration belongs to one task (one run) and is named within it: the id
 * a client picks is the client's, so two callers (or two tasks of one caller)
 * can both use `webhook`, and one cannot learn that another holds a name. The
 * outbox holds one row per (configuration, notification), unique on a key
 * derived from the event that caused it so a redelivered event records nothing
 * twice.
 */
import type pg from "pg";

/**
 * The first shape of these tables keyed a configuration by `config_id` alone.
 * A database that holds it is brought to the keyed-by-task shape in place, in
 * one statement, so a start-up that stops half way leaves the old shape intact.
 */
const MOVE_TO_TASK_KEYED = `
  DO $$
  BEGIN
    IF to_regclass('claw_a2a_push_outbox') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'claw_a2a_push_outbox' AND column_name = 'task_id') THEN
      ALTER TABLE claw_a2a_push_outbox ADD COLUMN task_id TEXT;
      UPDATE claw_a2a_push_outbox o SET task_id = c.task_id
        FROM claw_a2a_push_configs c WHERE c.config_id = o.config_id;
      ALTER TABLE claw_a2a_push_outbox ALTER COLUMN task_id SET NOT NULL;
      ALTER TABLE claw_a2a_push_outbox DROP CONSTRAINT claw_a2a_push_outbox_config_id_fkey;
      ALTER TABLE claw_a2a_push_outbox DROP CONSTRAINT claw_a2a_push_outbox_config_id_dedupe_key_key;
      ALTER TABLE claw_a2a_push_configs DROP CONSTRAINT claw_a2a_push_configs_pkey;
      ALTER TABLE claw_a2a_push_configs ADD PRIMARY KEY (task_id, config_id);
      ALTER TABLE claw_a2a_push_outbox ADD FOREIGN KEY (task_id, config_id)
        REFERENCES claw_a2a_push_configs (task_id, config_id) ON DELETE CASCADE;
      ALTER TABLE claw_a2a_push_outbox ADD UNIQUE (task_id, config_id, dedupe_key);
    END IF;
  END $$`;

export async function ensureA2aPushSchema(client: pg.PoolClient): Promise<void> {
  await client.query(MOVE_TO_TASK_KEYED);
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_a2a_push_configs (
      task_id              TEXT NOT NULL,
      config_id            TEXT NOT NULL,
      session_id           TEXT NOT NULL,
      owner                TEXT NOT NULL,
      url                  TEXT NOT NULL,
      token_enc            TEXT,
      auth_scheme          TEXT,
      auth_credentials_enc TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (task_id, config_id)
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_a2a_push_configs_session ON claw_a2a_push_configs(session_id)");
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_a2a_push_outbox (
      id              BIGSERIAL PRIMARY KEY,
      task_id         TEXT NOT NULL,
      config_id       TEXT NOT NULL,
      dedupe_key      TEXT NOT NULL,
      payload         JSONB NOT NULL,
      final           BOOLEAN NOT NULL DEFAULT FALSE,
      attempts        INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at    TIMESTAMPTZ,
      dropped_at      TIMESTAMPTZ,
      last_status     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (task_id, config_id)
        REFERENCES claw_a2a_push_configs (task_id, config_id) ON DELETE CASCADE,
      UNIQUE (task_id, config_id, dedupe_key)
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_a2a_push_outbox_due
       ON claw_a2a_push_outbox(next_attempt_at)
       WHERE delivered_at IS NULL AND dropped_at IS NULL`,
  );
}
