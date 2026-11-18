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
import { ensurePairingSchema } from "./pairing.js";

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
  // Presence as the sweep last judged it (`presence.ts`), and how the last command stream ended. Added
  // columns, so a deployment that had the table before gets them in place. Asked first: every heartbeat
  // updates this table, and an ALTER would take its exclusive lock on every start for nothing.
  const missing = (await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'claw_remote_connectors' AND column_name = 'presence_episode'`,
  )).rows.length === 0;
  if (missing) await client.query(`
    ALTER TABLE claw_remote_connectors
      ADD COLUMN IF NOT EXISTS stream_closed_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS stream_end_reason TEXT,
      ADD COLUMN IF NOT EXISTS presence_state    TEXT,
      ADD COLUMN IF NOT EXISTS presence_since    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS offline_since     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS offline_reason    TEXT,
      ADD COLUMN IF NOT EXISTS offline_notice    TEXT,
      ADD COLUMN IF NOT EXISTS presence_episode  BIGINT
  `);
  // Conversations on a machine its owner hid from their lists (`store.setHidden`): never deleted on the machine, only not listed.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_remote_hidden (
      owner_user_id TEXT NOT NULL,
      connector_id  UUID NOT NULL REFERENCES claw_remote_connectors(connector_id) ON DELETE CASCADE,
      ref           TEXT NOT NULL,
      title         TEXT NOT NULL DEFAULT '',
      hidden_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, connector_id, ref)
    )
  `);
  // Every change of presence the sweep saw. No owner index: it is read per connector.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_remote_connector_transitions (
      id            BIGSERIAL PRIMARY KEY,
      connector_id  UUID NOT NULL REFERENCES claw_remote_connectors(connector_id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL,
      from_state    TEXT,
      to_state      TEXT NOT NULL,
      reason        TEXT,
      last_seen_at  TIMESTAMPTZ,
      at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_remote_connector_transitions ON claw_remote_connector_transitions(connector_id, id)",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS idx_remote_connector_transitions_at ON claw_remote_connector_transitions(at)",
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
  // A session a connector opened to carry the approvals a conversation open in a terminal asks for (`origin` 'terminal_hook', `ref`
  // the conversation): NULL for every session a user opens. Asked first, as for the connector columns above.
  const noOrigin = (await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'claw_remote_sessions' AND column_name = 'origin'`,
  )).rows.length === 0;
  if (noOrigin) await client.query(`
    ALTER TABLE claw_remote_sessions
      ADD COLUMN IF NOT EXISTS origin TEXT,
      ADD COLUMN IF NOT EXISTS ref    TEXT
  `);
  // One open terminal-hook session per conversation of a connector: two hooks of one conversation opening at once find the same.
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_sessions_terminal_ref ON claw_remote_sessions(connector_id, ref)
      WHERE origin = 'terminal_hook' AND status = 'active'`,
  );
  // Whether an owner wants a terminal's approvals on the phone (`/approvals on|off`). No row: on.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_remote_approval_settings (
      owner_user_id TEXT PRIMARY KEY,
      enabled       BOOLEAN NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
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
  // A conversation open in a terminal that waits for its person, one row per waiting episode (`terminal-waits.ts`): since when the
  // sweep saw it wait, and when its owner was told. Gone when it stops waiting.
  await client.query(`
    CREATE TABLE IF NOT EXISTS claw_remote_terminal_waits (
      connector_id  UUID NOT NULL REFERENCES claw_remote_connectors(connector_id) ON DELETE CASCADE,
      agent_id      TEXT NOT NULL,
      ref           TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      since         TIMESTAMPTZ NOT NULL,
      told_at       TIMESTAMPTZ,
      PRIMARY KEY (connector_id, agent_id, ref)
    )
  `);
  // Pairing a machine with a one-time code, and the grants the codes were traded for (`pairing.ts`).
  await ensurePairingSchema((text, params) => client.query(text, params));
}
