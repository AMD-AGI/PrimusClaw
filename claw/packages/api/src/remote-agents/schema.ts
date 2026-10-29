// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Tables behind remote agents. Created only when `CLAW_REMOTE_AGENTS_ENABLED`
 * is on, so a deployment that leaves it off has the same schema it had before.
 *
 * Every row that belongs to a person carries `owner_user_id`, copied from the
 * verified caller and never from a request body, and every read filters on it.
 * The audit table has no foreign key on purpose: it outlives the rows it
 * describes.
 */
import type pg from "pg";

export async function ensureRemoteAgentSchema(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_remote_connectors (
      connector_id   UUID PRIMARY KEY,
      owner_user_id  TEXT NOT NULL,
      name           TEXT NOT NULL,
      version        TEXT,
      -- Last command number handed out. Bumped under this row's lock, so
      -- numbers are assigned, and commit, in order.
      cmd_counter    BIGINT NOT NULL DEFAULT 0,
      heartbeat_at   TIMESTAMPTZ,
      -- Which command stream is current, and when it last proved it was alive.
      -- NULL stream_seen_at means no stream is open.
      stream_conn    TEXT,
      stream_seen_at TIMESTAMPTZ,
      revoked_at     TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_remote_connectors_owner ON claw_remote_connectors(owner_user_id) WHERE revoked_at IS NULL",
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_remote_agents (
      connector_id  UUID NOT NULL REFERENCES claw_remote_connectors(connector_id) ON DELETE CASCADE,
      agent_id      TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      kind          TEXT NOT NULL,
      name          TEXT NOT NULL,
      capabilities  JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (connector_id, agent_id)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_remote_sessions (
      session_id    UUID PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      connector_id  UUID NOT NULL REFERENCES claw_remote_connectors(connector_id) ON DELETE CASCADE,
      agent_id      TEXT NOT NULL,
      cwd           TEXT NOT NULL,
      mode          TEXT,
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_remote_sessions_owner ON claw_remote_sessions(owner_user_id, created_at DESC)",
  );
  // The retention sweep finds the sessions it may delete without reading the live ones.
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_remote_sessions_closed ON claw_remote_sessions(updated_at) WHERE status = 'closed'",
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_remote_events (
      id          BIGSERIAL PRIMARY KEY,
      session_id  UUID NOT NULL REFERENCES claw_remote_sessions(session_id) ON DELETE CASCADE,
      seq         BIGINT NOT NULL,
      type        TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      data        JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, seq)
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_remote_events_session ON claw_remote_events(session_id, id)");
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_remote_commands (
      connector_id UUID NOT NULL REFERENCES claw_remote_connectors(connector_id) ON DELETE CASCADE,
      cmd_seq      BIGINT NOT NULL,
      cmd_id       TEXT NOT NULL,
      session_id   UUID,
      type         TEXT NOT NULL,
      payload      JSONB NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (connector_id, cmd_seq),
      UNIQUE (connector_id, cmd_id)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_remote_audit (
      id            BIGSERIAL PRIMARY KEY,
      ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      owner_user_id TEXT NOT NULL,
      connector_id  UUID,
      agent_id      TEXT,
      session_id    UUID,
      action        TEXT NOT NULL,
      actor         TEXT NOT NULL,
      client        TEXT,
      detail        JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_remote_audit_owner ON claw_remote_audit(owner_user_id, id DESC)",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_remote_audit_rate ON claw_remote_audit(owner_user_id, action, ts)",
  );
  // A command is remembered through its audit row once the queue has forgotten it (an Idempotency-Key
  // retry, a second decision), so finding it must not read the owner's whole trail.
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_remote_audit_cmd ON claw_remote_audit((detail->>'cmd_id')) WHERE action = 'command.issued'",
  );
}
