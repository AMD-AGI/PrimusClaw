// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A real Postgres for the run-doorbell scenarios.
 *
 * The unit tests under `packages/*//*test` assert on the SQL *text* a reaper
 * builds -- they stub `db.query` and match the statement with a regex. That
 * catches a predicate that was never written, and nothing else: a predicate
 * that is written and matches the wrong rows passes every one of them. Six of
 * the eight defects these scenarios cover are exactly that shape.
 *
 * So this harness runs the statements. PGlite is Postgres compiled to WASM, so
 * `jsonb ->>`, `NOT EXISTS`, `INTERVAL` arithmetic and `NOW()` all behave the
 * way they will in the cluster, and a scenario can assert on the rows a reaper
 * left behind rather than on the string it sent.
 *
 * The DDL is a hand-copied subset, which is a standing hazard: a column the
 * real table has and this one omits, or names differently, turns a statement
 * the code under test relies on into a silent failure and the scenario passes
 * for the wrong reason. `claw_workspace_refs` did exactly that -- its key
 * column was `kind` here and `ref_kind` in db.ts, so every `releaseRunUse` in
 * every scenario threw and was swallowed. When a scenario depends on a table,
 * check its columns against db.ts rather than against what the scenario needs.
 *
 * Not a replacement for the cluster: there is no NATS here, no Brain, and no
 * concurrency. What it proves is that a given row state leads to a given row
 * state. Anything about delivery, timing between replicas, or what a worker
 * does with a claim belongs in the live environment.
 */

import { db } from "../src/infra/db.js";
import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { sealRunCredentials } from "../src/tasks/run-secrets.js";

import { PGlite } from "@electric-sql/pglite";

export interface Harness {
  /** Every statement run since the last reset, whitespace-normalised. */
  statements: string[];
  /** Truncate every table, leaving the schema in place. */
  reset(): Promise<void>;
  /** Read rows back for assertions, outside the code under test. */
  sql(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/**
 * The columns the run-doorbell paths actually read or write, copied from
 * `initDb` in packages/api/src/infra/db.ts. Kept as a subset on purpose: a scenario
 * that needs a column this omits should add it here, so the drift shows up as
 * a missing column rather than as a silently different table.
 */
const DDL = `
CREATE TABLE claw_sessions (
  session_id     TEXT PRIMARY KEY,
  user_id        TEXT DEFAULT 'default',
  agent_status   TEXT DEFAULT 'idle',
  status         TEXT DEFAULT 'active',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);

CREATE TABLE claw_session_events (
  id          SERIAL PRIMARY KEY,
  event_id    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  UNIQUE (event_id, session_id),
  event       TEXT NOT NULL,
  data        JSONB DEFAULT '{}'::jsonb,
  -- The completion handler reads both of these before it will do any work:
  -- without them completionAlreadyProcessed throws, the delivery is treated as
  -- a duplicate, and every scenario that drives a completion silently
  -- exercises nothing at all. (No backticks here: this whole schema is a
  -- template literal.)
  processed_at TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE claw_pending_messages (
  id          SERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  content     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE claw_tasks (
  task_id              TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  dag_root_task_id     TEXT,
  dag_node_id          TEXT,
  plugin_id            BIGINT,
  name                 TEXT NOT NULL DEFAULT 'chat',
  input                JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt               TEXT,
  priority             INT NOT NULL DEFAULT 0,
  executor             TEXT NOT NULL DEFAULT 'brain',
  sandbox_spec         JSONB,
  callback_url         TEXT,
  internal_token_hash  TEXT,
  status               TEXT NOT NULL,
  failure_reason       TEXT,
  error_message        TEXT,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  origin               TEXT,
  workspace_id         TEXT,
  sandbox_workload_id  TEXT,
  lease_owner          TEXT,
  lease_expires_at     TIMESTAMPTZ,
  heartbeat_at         TIMESTAMPTZ,
  claim_count          INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  queued_at            TIMESTAMPTZ,
  started_at           TIMESTAMPTZ,
  deadline_at          TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ
);

CREATE TABLE claw_conversation_turns (
  session_id   TEXT NOT NULL,
  turn_index   INT NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT,
  tool_calls   JSONB,
  tool_results JSONB,
  token_count  INT,
  -- Real schema carries this (db.ts adds it, plus an index on
  -- (session_id, message_id, role)); the claim's rebuild reads the table, so
  -- the fixture must not be narrower than what production queries can see.
  message_id   TEXT,
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE claw_session_summaries (
  session_id       TEXT PRIMARY KEY,
  summary          TEXT NOT NULL,
  summarized_up_to INT NOT NULL DEFAULT 0,
  token_count      INT,
  deleted_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE claw_memory_entries (
  id             SERIAL PRIMARY KEY,
  user_id        TEXT NOT NULL,
  category       TEXT NOT NULL,
  content        TEXT NOT NULL,
  importance     REAL DEFAULT 0.5,
  source_session TEXT,
  source_type    TEXT DEFAULT 'auto',
  access_count   INT DEFAULT 0,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  last_accessed  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE claw_workspaces (
  workspace_id  TEXT PRIMARY KEY,
  session_id    TEXT,
  user_id       TEXT,
  writer_run_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Read by injectLiveUserEnv on every claim: the vault is re-read at claim
-- time rather than carried on the row, so a claim scenario needs it present
-- even when empty.
CREATE TABLE claw_user_env_vars (
  user_id        TEXT NOT NULL,
  key_name       TEXT NOT NULL,
  key_value_enc  TEXT NOT NULL,
  enc_version    SMALLINT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key_name)
);

CREATE TABLE claw_workspace_refs (
  workspace_id  TEXT NOT NULL,
  ref_kind      TEXT NOT NULL,
  ref_id        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at   TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, ref_kind, ref_id)
);
`;

const TABLES = [
  "claw_tasks",
  "claw_sessions",
  "claw_session_events",
  "claw_pending_messages",
  "claw_workspaces",
  "claw_workspace_refs",
  "claw_user_env_vars",
  "claw_conversation_turns",
  "claw_session_summaries",
  "claw_memory_entries",
];

/**
 * Point the app's `db` at PGlite and hand back the controls.
 *
 * The app reaches Postgres through the single `db.query` in db.ts, so
 * replacing that one function is enough to redirect every reaper, route and
 * store in the process -- the same seam the unit tests already use, pointed at
 * something that executes instead of something that records.
 */
export async function startHarness(): Promise<Harness> {
  // Scenarios that seed a claimable row need the envelope key; harmless for
  // the ones that do not.
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  initUserEnvCrypto();
  const pg = await PGlite.create();
  await pg.exec(DDL);

  const original = db.query;
  const statements: string[] = [];
  db.query = (async (text: string, params?: unknown[]) => {
    statements.push(text.replace(/\s+/g, " ").trim());
    const r = await pg.query(text, params as never[]) as {
      rows?: unknown[]; affectedRows?: number;
    };
    // `affectedRows` first, and only then the row count. Deriving the count
    // from `rows.length` is right for a SELECT and wrong for every UPDATE or
    // DELETE without RETURNING: pg reports what it changed, PGlite returns no
    // rows, and the caller reads zero. Anything that branches on `rowCount` --
    // "did this CAS match?" -- then takes the did-not-match path in every
    // scenario, which is a test harness quietly answering the question the
    // test was written to ask.
    const rows = r.rows ?? [];
    return { rows, rowCount: rows.length || r.affectedRows || 0 };
  }) as typeof db.query;

  return {
    /** Every statement this harness has run since the last reset. */
    statements,
    async reset() {
      statements.length = 0;
      await pg.exec(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY`);
    },
    async sql(text: string, params: unknown[] = []) {
      const r = await pg.query(text, params as never[]);
      return (r.rows ?? []) as Record<string, unknown>[];
    },
    async close() {
      db.query = original;
      await pg.close();
    },
  };
}

/** Seed a session at the gate state a live turn would leave it in. */
export async function seedSession(
  h: Harness,
  sessionId: string,
  opts: { agentStatus?: string; updatedAgoSec?: number; userId?: string } = {},
): Promise<void> {
  await h.sql(
    `INSERT INTO claw_sessions (session_id, user_id, agent_status, updated_at)
     VALUES ($1, $2, $3, NOW() - ($4::int * INTERVAL '1 second'))`,
    [sessionId, opts.userId ?? "u-1", opts.agentStatus ?? "running", opts.updatedAgoSec ?? 0],
  );
}

export interface SeedRunOpts {
  /**
   * Seal a real credentials blob onto the row, so a claim can hydrate it.
   *
   * Without one, `hydrateExecuteRequest` throws `missing_credentials` and the
   * claim comes back "unclaimable" -- which several scenarios were quietly
   * asserting around, reporting a run "unaffected" while the row they named
   * had in fact been failed.
   */
  claimable?: boolean;
  /** A spec built by the real producer, sealed and stored as-is. */
  spec?: Record<string, unknown>;
  /** The turn's text, in the `prompt` column -- what the claim rebuilds around. */
  prompt?: string;
  status?: string;
  /** 'doorbell' writes metadata.dispatch; 'fat' deliberately leaves it unset. */
  dispatch?: "doorbell" | "fat";
  leaseOwner?: string | null;
  leaseExpiresInSec?: number | null;
  queuedAgoSec?: number | null;
  startedAgoSec?: number | null;
  deadlineInSec?: number | null;
  claimCount?: number;
  messageId?: string;
  origin?: string;
}

/**
 * Seed one run row.
 *
 * `dispatch: "fat"` is the case the scoping fixes are about: the pre-doorbell
 * path opens at `preparing` with no lease owner until the worker's first
 * renewal, which is indistinguishable from an unclaimed doorbell row on
 * status alone. That is the confusion every scoping scenario here reproduces.
 */
export async function seedRun(
  h: Harness,
  taskId: string,
  sessionId: string,
  opts: SeedRunOpts = {},
): Promise<void> {
  const meta: Record<string, unknown> = { message_id: opts.messageId ?? `msg-${taskId}`, user_id: "u-1" };
  if ((opts.dispatch ?? "doorbell") === "doorbell") meta.dispatch = "doorbell";
  const supplied = opts.spec
    ? { ...opts.spec, credentials: sealRunCredentials({ llm_api_key: "sk-scenario", platform_key: "pk-scenario" }) }
    : null;
  const spec = supplied ? JSON.stringify(supplied) : opts.claimable
    ? JSON.stringify({
      prompt: "scenario",
      session_id: sessionId,
      user_id: "u-1",
      credentials: sealRunCredentials({ llm_api_key: "sk-scenario", platform_key: "pk-scenario" }),
    })
    : "{}";
  await h.sql(
    `INSERT INTO claw_tasks (
       task_id, session_id, name, status, origin, executor, metadata, input, prompt,
       lease_owner,
       lease_expires_at,
       queued_at,
       started_at,
       deadline_at,
       claim_count
     ) VALUES (
       $1, $2, 'chat', $3, $4, 'brain', $5::jsonb, $12::jsonb, $13,
       $6,
       CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() + ($7::int * INTERVAL '1 second') END,
       CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() - ($8::int * INTERVAL '1 second') END,
       CASE WHEN $9::int IS NULL THEN NULL ELSE NOW() - ($9::int * INTERVAL '1 second') END,
       CASE WHEN $10::int IS NULL THEN NULL ELSE NOW() + ($10::int * INTERVAL '1 second') END,
       $11
     )`,
    [
      taskId,
      sessionId,
      opts.status ?? "queued",
      opts.origin ?? "chat",
      JSON.stringify(meta),
      opts.leaseOwner ?? null,
      opts.leaseExpiresInSec ?? null,
      opts.queuedAgoSec ?? null,
      opts.startedAgoSec ?? null,
      opts.deadlineInSec ?? null,
      opts.claimCount ?? 0,
      spec,
      opts.prompt ?? null,
    ],
  );
}

export async function runRow(h: Harness, taskId: string): Promise<Record<string, unknown>> {
  const rows = await h.sql(`SELECT * FROM claw_tasks WHERE task_id = $1`, [taskId]);
  if (!rows[0]) throw new Error(`no row ${taskId}`);
  return rows[0];
}

export async function sessionRow(h: Harness, sessionId: string): Promise<Record<string, unknown>> {
  const rows = await h.sql(`SELECT * FROM claw_sessions WHERE session_id = $1`, [sessionId]);
  if (!rows[0]) throw new Error(`no session ${sessionId}`);
  return rows[0];
}

/** Record a finished conversation turn, the way event-consumer does. */
export async function seedTurn(
  h: Harness,
  sessionId: string,
  turnIndex: number,
  role: "user" | "assistant",
  content: string,
  opts: { deleted?: boolean } = {},
): Promise<void> {
  await h.sql(
    `INSERT INTO claw_conversation_turns (session_id, turn_index, role, content, token_count, deleted_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::bool THEN NOW() ELSE NULL END)`,
    [sessionId, turnIndex, role, content, Math.ceil(content.length / 4), opts.deleted ?? false],
  );
}
