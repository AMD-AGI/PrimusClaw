// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Tables behind A2A push notifications. Created only when
 * `CLAW_A2A_PUSH_ENABLED` is on, so a deployment that leaves it off has the
 * same schema it had before.
 *
 * A configuration belongs to one task (one run); the outbox holds one row per
 * (configuration, notification), unique on a key derived from the event that
 * caused it so a redelivered event records nothing twice.
 */
import type pg from "pg";

export async function ensureA2aPushSchema(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_a2a_push_configs (
      config_id            TEXT PRIMARY KEY,
      task_id              TEXT NOT NULL,
      session_id           TEXT NOT NULL,
      owner                TEXT NOT NULL,
      url                  TEXT NOT NULL,
      token_enc            TEXT,
      auth_scheme          TEXT,
      auth_credentials_enc TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_a2a_push_configs_task ON claw_a2a_push_configs(task_id)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_a2a_push_configs_session ON claw_a2a_push_configs(session_id)");
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_a2a_push_outbox (
      id              BIGSERIAL PRIMARY KEY,
      config_id       TEXT NOT NULL REFERENCES claw_a2a_push_configs(config_id) ON DELETE CASCADE,
      dedupe_key      TEXT NOT NULL,
      payload         JSONB NOT NULL,
      final           BOOLEAN NOT NULL DEFAULT FALSE,
      attempts        INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at    TIMESTAMPTZ,
      dropped_at      TIMESTAMPTZ,
      last_status     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (config_id, dedupe_key)
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_a2a_push_outbox_due
       ON claw_a2a_push_outbox(next_attempt_at)
       WHERE delivered_at IS NULL AND dropped_at IS NULL`,
  );
}
