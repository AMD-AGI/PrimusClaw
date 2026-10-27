// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Tables behind outbound notifications. Created only when
 * `CLAW_NOTIFICATIONS_ENABLED` is on, so a deployment that leaves it off has the
 * same schema it had before.
 */
import type pg from "pg";

export async function ensureNotificationSchema(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_notification_subscriptions (
      subscription_id      UUID PRIMARY KEY,
      owner_user_id        TEXT NOT NULL,
      url                  TEXT NOT NULL,
      secret_enc           TEXT NOT NULL,
      event_types          TEXT[] NOT NULL DEFAULT ARRAY['run.completed','run.failed'],
      sources              TEXT[] NOT NULL DEFAULT ARRAY['trigger','long_run'],
      enabled              BOOLEAN NOT NULL DEFAULT TRUE,
      consecutive_failures INT NOT NULL DEFAULT 0,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_notification_subs_owner ON claw_notification_subscriptions(owner_user_id) WHERE enabled",
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_notification_outbox (
      id              BIGSERIAL PRIMARY KEY,
      event_id        TEXT NOT NULL,
      subscription_id UUID NOT NULL REFERENCES claw_notification_subscriptions(subscription_id) ON DELETE CASCADE,
      payload         JSONB NOT NULL,
      attempts        INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at    TIMESTAMPTZ,
      dropped_at      TIMESTAMPTZ,
      last_status     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_id, subscription_id)
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
       ON claw_notification_outbox(next_attempt_at)
       WHERE delivered_at IS NULL AND dropped_at IS NULL`,
  );
}
