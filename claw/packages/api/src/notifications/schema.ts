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
      -- The chat surface the receiver delivers to ('teams', 'slack', ...): where an assistant message goes (surfaces.ts).
      surface              TEXT NOT NULL DEFAULT 'teams',
      consecutive_failures INT NOT NULL DEFAULT 0,
      failing_since        TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query("ALTER TABLE claw_notification_subscriptions ADD COLUMN IF NOT EXISTS failing_since TIMESTAMPTZ");
  await client.query("ALTER TABLE claw_notification_subscriptions ADD COLUMN IF NOT EXISTS auto_disabled BOOLEAN NOT NULL DEFAULT FALSE");
  // Every subscription made before the label delivered to Teams, which is what the default says of it.
  await client.query("ALTER TABLE claw_notification_subscriptions ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'teams'");
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
  // Deleting a subscription keeps its rows, with no subscription, for its owner's next one (`adoptOrphanedRows`, outbox.ts): the
  // cascade a table made before this deleted every notice queued for a receiver that made its subscription again. Changed once,
  // when the key still cascades; NOT VALID, as every row there already references a subscription.
  await client.query(`
    DO $$
    DECLARE c RECORD;
    BEGIN
      FOR c IN SELECT conname FROM pg_constraint
                WHERE conrelid = 'claw_notification_outbox'::regclass AND contype = 'f' AND confdeltype <> 'n' LOOP
        EXECUTE format('ALTER TABLE claw_notification_outbox DROP CONSTRAINT %I', c.conname);
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'claw_notification_outbox'::regclass AND contype = 'f') THEN
        ALTER TABLE claw_notification_outbox ALTER COLUMN subscription_id DROP NOT NULL;
        ALTER TABLE claw_notification_outbox ADD CONSTRAINT claw_notification_outbox_subscription_id_fkey
          FOREIGN KEY (subscription_id) REFERENCES claw_notification_subscriptions(subscription_id) ON DELETE SET NULL NOT VALID;
      END IF;
    END $$
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_notification_outbox_orphans
       ON claw_notification_outbox(created_at)
       WHERE subscription_id IS NULL AND delivered_at IS NULL AND dropped_at IS NULL`,
  );
}
