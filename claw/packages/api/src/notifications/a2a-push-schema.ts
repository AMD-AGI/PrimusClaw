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
 *
 * A notification that keeps failing is set aside after a bounded number of
 * attempts so the ones behind it are sent: its outbox row is closed and a copy
 * goes to `claw_a2a_push_dead_letters`. That table has no key into the
 * configurations, so the record outlives the config (which goes with its
 * task's last notification, and its outbox rows with it).
 */
import type pg from "pg";

/**
 * Attempts a notification gets before it is set aside so the ones behind it can
 * go. With the backoff (routes/a2a-push.ts) that is about twenty minutes of
 * trying; a receiver that is down for longer loses at most one notification per
 * twenty minutes to the dead letters, and gets the rest, in order, when it is
 * back.
 */
export const MAX_DELIVERY_ATTEMPTS = 8;

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
      claims          INT NOT NULL DEFAULT 0,
      unsent_since    TIMESTAMPTZ,
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
  // A claim is counted apart from an attempt (a claim that never reached the
  // receiver uses no attempt). A row written before counted every claim as an
  // attempt, whether or not anything was sent, so its count says how often it
  // was claimed, not how often its receiver was asked: it becomes the row's
  // claims (the claim fence), and an open row keeps at most one attempt short
  // of the limit, so it is sent at least once more before it can be set aside
  // (a row at the limit would otherwise be taken for a send the process died
  // in, and set aside on its first claim without one).
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'claw_a2a_push_outbox' AND column_name = 'claims') THEN
        ALTER TABLE claw_a2a_push_outbox ADD COLUMN claims INT NOT NULL DEFAULT 0;
        UPDATE claw_a2a_push_outbox
           SET claims = attempts,
               attempts = CASE WHEN delivered_at IS NULL AND dropped_at IS NULL
                               THEN LEAST(attempts, ${MAX_DELIVERY_ATTEMPTS - 1}) ELSE attempts END;
      END IF;
    END $$`);
  // Since when every claim of the row has ended before its receiver was asked.
  await client.query("ALTER TABLE claw_a2a_push_outbox ADD COLUMN IF NOT EXISTS unsent_since TIMESTAMPTZ");
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_a2a_push_outbox_due
       ON claw_a2a_push_outbox(next_attempt_at)
       WHERE delivered_at IS NULL AND dropped_at IS NULL`,
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_a2a_push_dead_letters (
      outbox_id      BIGINT PRIMARY KEY,
      task_id        TEXT NOT NULL,
      config_id      TEXT NOT NULL,
      dedupe_key     TEXT NOT NULL,
      payload        JSONB NOT NULL,
      final          BOOLEAN NOT NULL,
      attempts       INT NOT NULL,
      last_status    TEXT,
      created_at     TIMESTAMPTZ NOT NULL,
      quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_a2a_push_dead_letters_quarantined ON claw_a2a_push_dead_letters(quarantined_at)",
  );
}
