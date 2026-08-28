-- Copyright Advanced Micro Devices, Inc.
-- SPDX-License-Identifier: MIT
--
-- Synthetic V1 compatibility fixture. This repository has no release tags from
-- which to export an authoritative schema, so this captures the minimum legacy
-- table shapes that initDb() explicitly claims to upgrade in place.

CREATE TABLE claw_sessions (
  session_id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  agent_id TEXT DEFAULT '',
  system_prompt TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE claw_session_events (
  id SERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (event_id, session_id)
);

CREATE TABLE claw_pending_messages (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  user_id TEXT DEFAULT 'default',
  priority TEXT DEFAULT 'normal',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO claw_sessions (session_id, name, config)
VALUES ('legacy-session', 'preserve-me', '{"legacy":true}'::jsonb);
INSERT INTO claw_pending_messages (session_id, content)
VALUES ('legacy-session', 'preserve-this-message');
