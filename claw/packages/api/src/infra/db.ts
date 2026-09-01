// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import pg from "pg";
import { DATABASE_URL, envInt } from "../config.js";
import pino from "pino";
import {
  REQUIRED_SCHEMA,
  missingSchemaObjects,
  type PresentColumn,
} from "./schema-guard.js";

const logger = pino({ name: "db" });
// SCHEMA names are validated against a strict identifier whitelist before
// being interpolated into `SET search_path`. Postgres has no parameter form
// for identifiers, so naive string concat would be SQL-injectable if the env
// is operator-controlled. Allow only [A-Za-z_][A-Za-z0-9_]{0,62}.
function safeSchemaName(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(trimmed)) {
    logger.error({ raw }, "db.schema.invalid_identifier");
    throw new Error(`DB_SCHEMA must match /^[A-Za-z_][A-Za-z0-9_]{0,62}$/, got: ${raw}`);
  }
  return trimmed;
}
const DB_SCHEMA = safeSchemaName(process.env.DB_SCHEMA);
// PG_SSL_NO_VERIFY: opt-in dev flag for connecting to a cluster PG through
// a port-forward where the server presents a self-signed cert. Production
// behavior (driven by the DATABASE_URL heuristics) is unchanged when unset.
// Shared pg.Pool config. The main pool and the dedicated advisory-lock pool
// differ only in `max`; every other knob (timeouts, server-side safety valves,
// SSL) is identical.
const commonPoolConfig: pg.PoolConfig = {
  connectionString: DATABASE_URL,
  // Fail fast when the pool is saturated. node-postgres defaults to
  // connectionTimeoutMillis=0 (queue forever); under a client retry storm that
  // lets callers park indefinitely on pool.connect(), so one slow downstream
  // drains every connection and stalls unrelated routes. A finite acquire
  // timeout turns that silent cascade into a bounded, fast error.
  connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECT_TIMEOUT_MS) || 5000,
  // Recycle idle connections so a fleet of replicas doesn't pin the server's
  // max_connections budget with permanently-open idle sockets. Connections in
  // use (or holding an advisory lock) are never idle, so they're unaffected.
  idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_TIMEOUT_MS) || 30000,
  // Server-side safety valves applied at connection startup (libpq options),
  // so a single pathological statement or a transaction left open without
  // commit/rollback cannot pin a pooled connection (and, for the latter, hold
  // row locks). Thresholds sit well above normal query/tx durations and are
  // env-overridable.
  options:
    `-c statement_timeout=${Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 30000} ` +
    `-c idle_in_transaction_session_timeout=${Number(process.env.PG_IDLE_TX_TIMEOUT_MS) || 60000}`,
  ssl:
    DATABASE_URL.includes("svc.cluster.local") ||
    DATABASE_URL.includes("ssl=true") ||
    process.env.PG_SSL_NO_VERIFY === "true"
      ? { rejectUnauthorized: false }
      : undefined,
};

// Main pool: all reads and business writes. Capped and env-overridable so ops
// can tune each replica against the server's max_connections budget.
const PG_POOL_MAX = Number(process.env.PG_POOL_MAX) || 20;
const pool = new pg.Pool({
  ...commonPoolConfig,
  max: PG_POOL_MAX,
});

// Bulkhead: a dedicated pool used ONLY to acquire the per-idempotency-key
// advisory lock (see acquireIdempotencyLock in routes/sessions.ts). Physically
// separating it means a same-key create retry storm — or a slow dispatch held
// under the lock — can at worst saturate THIS pool; the main pool keeps its
// connections, so reads and unrelated writes never starve on a lock wait.
// Defaults to the main pool's size so it does NOT cap normal (distinct-key)
// create concurrency; ops can shrink it via PG_LOCK_POOL_MAX. NOTE: per-replica
// connections total (PG_POOL_MAX + PG_LOCK_POOL_MAX); keep the fleet sum under
// the server's max_connections budget.
const lockPool = new pg.Pool({
  ...commonPoolConfig,
  max: Number(process.env.PG_LOCK_POOL_MAX) || PG_POOL_MAX,
});

// Surface idle-client errors (server restart, network blip, ...) instead of
// letting node-postgres emit an unhandled 'error' event that can crash the
// process. The pool transparently re-establishes connections afterwards.
pool.on("error", (err) => logger.error({ err }, "db.pool.idle_client_error"));
lockPool.on("error", (err) => logger.error({ err }, "db.lockPool.idle_client_error"));

if (DB_SCHEMA) {
  const setSearchPath = (client: pg.PoolClient): void => {
    client.query(`SET search_path TO "${DB_SCHEMA}"`);
  };
  pool.on("connect", setSearchPath);
  lockPool.on("connect", setSearchPath);
}

export const db = {
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  pool,
  lockPool,
};

/** How a caller inside a transaction sends its statements. */
export type Querier = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

/**
 * Run a sequence of statements as one transaction.
 *
 * `db.query` takes a connection per call, so a `BEGIN` sent through it fences
 * nothing: the statements after it are free to land on other connections, and
 * the `COMMIT` commits an empty transaction while their writes have already
 * committed on their own. Anything whose point is that a partial result is
 * impossible has to hold one connection for the whole sequence, which is what
 * this is for.
 *
 * The connection is destroyed rather than returned when the rollback itself
 * failed, because a connection that may still have a transaction open would
 * otherwise be handed to the next caller, whose first statement joins it.
 */
export async function inTransaction<T>(run: (query: Querier) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    try {
      // Inside the catch that rolls back, because a `BEGIN` that failed on the
      // client may still have run on the server -- which is the connection this
      // is careful not to hand on.
      await client.query("BEGIN");
      const result = await run((text, params) => client.query(text, params));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
        broken = true;
        logger.warn({ err: (rollbackErr as Error)?.message }, "db.rollback_failed");
      });
      throw err;
    }
  } finally {
    client.release(broken);
  }
}

/**
 * Advisory lock id held for the whole of `initDb`.
 *
 * Every replica runs the same DDL at boot, so a rollout has N of them issuing
 * `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` against one
 * database at once. `IF NOT EXISTS` is not a substitute for a lock: it checks
 * and acts non-atomically, so two replicas can both find a column absent and
 * both try to add it, and the loser's error was then discarded by the catch
 * that follows most of these statements. Serialising the whole sequence costs
 * one round trip on a path that runs once per process start.
 *
 * The number is arbitrary but must never be reused for another purpose in this
 * database; advisory locks share one namespace.
 */
const SCHEMA_MIGRATION_LOCK_ID = 8_264_179_233_001;

// Pooled connections carry a 30s statement_timeout, which is right for serving
// requests and wrong for migrating: waiting on the lock behind another
// replica, or building an index on a table that has been accumulating rows for
// months, legitimately takes longer than any request may. The migration
// connection gets its own budget and is then discarded rather than returned to
// the pool carrying it.
//
// This budget is only real if the startupProbe allows it. `initDb` runs before
// the server listens, so nothing answers /health while a migration is in flight,
// on the replica doing the migrating and on every replica blocked on the lock
// behind it. The chart's api startupProbe is sized for this on purpose --
// failureThreshold 120 at periodSeconds 3, i.e. 360s against the 300s here --
// and lowering either number below the other silently reintroduces the case
// where the longest statement the code permits can never finish. Progress is not
// lost when a pod is killed mid-sequence, since each statement commits on its
// own and the re-run skips what already exists, but a single statement that
// outlives the probe's window will be started again and killed again.
const MIGRATION_STATEMENT_TIMEOUT_MS =
  envInt("PG_MIGRATION_STATEMENT_TIMEOUT_MS", 300_000);

/**
 * Fail startup when the schema the code needs is not the schema that exists.
 *
 * Most DDL above discards its error, which is right for a race between
 * replicas and wrong for everything else, and the two are not distinguishable
 * at the statement. So the outcome is checked instead of the statements: if a
 * column a request path needs is absent, the process refuses to serve rather
 * than starting and failing later on whichever request touches it first.
 */
async function assertSchema(client: pg.PoolClient): Promise<void> {
  const tables = REQUIRED_SCHEMA.map((r) => r.table);
  const present = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = CURRENT_SCHEMA()
        AND table_name = ANY($1)`,
    [tables],
  );
  const problems = missingSchemaObjects(REQUIRED_SCHEMA, present.rows as PresentColumn[]);
  if (problems.length > 0) {
    logger.error({ problems }, "db.schema_incomplete");
    throw new Error(`database schema is incomplete after migration: ${problems.join("; ")}`);
  }
}

/** Run schema migrations on startup. */
export async function initDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${MIGRATION_STATEMENT_TIMEOUT_MS}`);
    await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_MIGRATION_LOCK_ID]);
    // Base tables. Historically these were created by the V1 backend; on a
    // standalone V2 deployment they must be provisioned here. CREATE TABLE
    // IF NOT EXISTS is a no-op when V1 already owns the table, and the
    // subsequent ALTER TABLE ADD COLUMN IF NOT EXISTS statements fill in
    // any V2-only columns that may be missing from a V1-era table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_sessions (
        session_id     TEXT PRIMARY KEY,
        name           TEXT DEFAULT '',
        user_id        TEXT DEFAULT 'default',
        mode           TEXT DEFAULT '',
        agent_status   TEXT DEFAULT 'idle',
        agent_id       TEXT DEFAULT '',
        system_prompt  TEXT DEFAULT '',
        status         TEXT DEFAULT 'active',
        config         JSONB DEFAULT '{}'::jsonb,
        brain_id       TEXT DEFAULT '',
        hands_id       TEXT DEFAULT '',
        brain_url      TEXT DEFAULT '',
        hands_url      TEXT DEFAULT '',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        deleted_at     TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_session_events (
        id          SERIAL PRIMARY KEY,
        event_id    TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        UNIQUE (event_id, session_id),
        event       TEXT NOT NULL,
        data        JSONB DEFAULT '{}'::jsonb,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        deleted_at  TIMESTAMPTZ
      )
    `);

    // Idempotency cache for POST /v1/sessions (and any future create-then-side-effect
    // endpoint).  Key is scoped by (user_id, route) so two different users sending
    // the same client-generated UUID don't collide.  Status code + response body are
    // replayed verbatim on the second hit so retries are safe even after partial
    // failures.  Expired rows are ignored on read and can be swept later.
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_idempotency_keys (
        idem_key     TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        route        TEXT NOT NULL,
        status_code  INT  NOT NULL,
        response     JSONB NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        expires_at   TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (user_id, route, idem_key)
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_idem_expires ON claw_idempotency_keys(expires_at)",
    ).catch(() => {});

    // Idempotently add V2 columns when the base table pre-exists from V1.
    const addCol = async (col: string, type: string) => {
      await client.query(`ALTER TABLE claw_sessions ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
    };
    await addCol("user_id", "TEXT DEFAULT 'default'");
    await addCol("mode", "TEXT DEFAULT ''");
    await addCol("agent_status", "TEXT DEFAULT 'idle'");
    await addCol("brain_id", "TEXT DEFAULT ''");
    await addCol("hands_id", "TEXT DEFAULT ''");
    await addCol("brain_url", "TEXT DEFAULT ''");
    await addCol("hands_url", "TEXT DEFAULT ''");
    await addCol("context_id", "TEXT DEFAULT ''");
    await addCol("a2a_caller_id", "TEXT DEFAULT ''");
    await addCol("parent_session_id", "TEXT");
    await addCol("team_role", "TEXT DEFAULT ''");
    await client.query("CREATE INDEX IF NOT EXISTS idx_sessions_user ON claw_sessions(user_id, created_at DESC)").catch(() => {});
    await client.query("CREATE INDEX IF NOT EXISTS idx_sessions_context ON claw_sessions(context_id) WHERE context_id != ''").catch(() => {});
    await client.query("CREATE INDEX IF NOT EXISTS idx_sessions_a2a_caller ON claw_sessions(a2a_caller_id) WHERE a2a_caller_id != ''").catch(() => {});
    await client.query("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON claw_sessions(parent_session_id) WHERE parent_session_id IS NOT NULL").catch(() => {});

    // V2-only tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_conversation_turns (
        id           SERIAL PRIMARY KEY,
        session_id   TEXT NOT NULL,
        turn_index   INT NOT NULL,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        tool_calls   JSONB DEFAULT '[]',
        tool_results JSONB DEFAULT '[]',
        token_count  INT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_turns_session ON claw_conversation_turns(session_id, turn_index)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_session_summaries (
        session_id       TEXT PRIMARY KEY,
        summary          TEXT NOT NULL,
        summarized_up_to INT NOT NULL DEFAULT 0,
        token_count      INT,
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_pending_messages (
        id          SERIAL PRIMARY KEY,
        session_id  TEXT NOT NULL,
        content     TEXT NOT NULL,
        user_id     TEXT DEFAULT 'default',
        priority    TEXT DEFAULT 'normal',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pending_session ON claw_pending_messages(session_id, created_at)`);
    await client.query(`ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS plugin_id INTEGER`).catch(() => {});
    await client.query(
      `ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS tool_ids JSONB DEFAULT '[]'::jsonb`,
    ).catch(() => {});
    // workspace_id: SaFE workspace (== K8s namespace) the next-turn task should
    // target. Nullable so older queued rows keep working (Brain falls back to
    // SANDBOX_NAMESPACE when the replayed task has no workspace_id).
    await client.query(
      `ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS workspace_id TEXT`,
    ).catch(() => {});
    // SaFE platform API key + inference virtual key at enqueue time (replay has no HTTP auth context).
    await client.query(
      `ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS platform_key TEXT`,
    ).catch(() => {});
    await client.query(
      `ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS llm_api_key TEXT`,
    ).catch(() => {});
    await client.query(
      `ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS credentials_blob TEXT`,
    ).catch(() => {});
    await client.query(
      `ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS image TEXT`,
    ).catch(() => {});
    await client.query(
      `ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS resources JSONB`,
    ).catch(() => {});
    await client.query(
      `ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS timeout INTEGER`,
    ).catch(() => {});
    // The declared environment topology, frozen with the rest of the request.
    // A queued message is dispatched later from this row alone, so a column
    // the queue does not carry is a field that silently disappears for anyone
    // who sent a second message while the first was still running -- and for
    // this field, disappearing means running a 64-node job on one node.
    await client.query(
      `ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS topology JSONB`,
    ).catch(() => {});
    // How many times replaying this message has been refused a workspace.
    //
    // The replay is driven by a redelivered completion event, which the consumer
    // naks for ten seconds and has no delivery ceiling, so a refusal that is not
    // going to clear on its own -- a partial migration, a broken unique index --
    // turns one queued message into a permanent loop. Counted on the row because
    // the row is the only thing that survives the nak: `created_at` cannot stand
    // in for it, since a queued message legitimately waits hours behind the turn
    // in front of it before the first attempt is even made.
    await client.query(
      `ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS bind_attempts INTEGER NOT NULL DEFAULT 0`,
    ).catch(() => {});

    // Long-term memory entries (Phase 1)
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_memory_entries (
        id              SERIAL PRIMARY KEY,
        user_id         TEXT NOT NULL,
        category        TEXT NOT NULL,
        content         TEXT NOT NULL,
        content_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
        importance      REAL DEFAULT 0.5,
        source_session  TEXT,
        source_type     TEXT DEFAULT 'auto',
        access_count    INT DEFAULT 0,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        last_accessed   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query("ALTER TABLE claw_memory_entries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL").catch(() => {});
    // NULL marks a plain user-memory row, which is what time-based decay acts on.
    // Non-NULL marks a KB row whose lifecycle is driven by supersession instead.
    await client.query("ALTER TABLE claw_memory_entries ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT NULL").catch(() => {});
    await client.query("CREATE INDEX IF NOT EXISTS idx_memory_user ON claw_memory_entries(user_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_memory_importance ON claw_memory_entries(user_id, importance DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_memory_tsv ON claw_memory_entries USING GIN(content_tsv)");
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_user_profile
      ON claw_memory_entries(user_id) WHERE category = 'user_profile'
    `).catch(() => {});

    // Skill storage + version management (Phase 3)
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_skills (
        id              SERIAL PRIMARY KEY,
        skill_name      TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        version         INT NOT NULL DEFAULT 1,
        content         TEXT NOT NULL,
        source          TEXT DEFAULT 'auto',
        status          TEXT DEFAULT 'active',
        change_reason   TEXT,
        source_session  TEXT,
        analysis        JSONB DEFAULT '{}',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(skill_name, user_id, version)
      )
    `);
    await client.query("ALTER TABLE claw_skills ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL").catch(() => {});
    // inject_count: incremented every time the skill is loaded into a task's context
    // (NOT the same as actually-used; that's tracked via positive/negative/neutral_count below)
    await client.query("ALTER TABLE claw_skills ADD COLUMN IF NOT EXISTS inject_count INT DEFAULT 0").catch(() => {});
    await client.query("ALTER TABLE claw_skills ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ DEFAULT NOW()").catch(() => {});
    // Migrate from legacy access_count name if it exists, then drop the old column.
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'claw_skills' AND column_name = 'access_count') THEN
          UPDATE claw_skills SET inject_count = GREATEST(inject_count, access_count);
          ALTER TABLE claw_skills DROP COLUMN access_count;
        END IF;
      END $$;
    `).catch(() => {});
    // Phase B: effectiveness tracking
    await client.query("ALTER TABLE claw_skills ADD COLUMN IF NOT EXISTS positive_count INT DEFAULT 0").catch(() => {});
    await client.query("ALTER TABLE claw_skills ADD COLUMN IF NOT EXISTS negative_count INT DEFAULT 0").catch(() => {});
    await client.query("ALTER TABLE claw_skills ADD COLUMN IF NOT EXISTS neutral_count INT DEFAULT 0").catch(() => {});
    await client.query("ALTER TABLE claw_skills ADD COLUMN IF NOT EXISTS effectiveness REAL DEFAULT 0.5").catch(() => {});
    // Phase C: structured frontmatter metadata
    await client.query("ALTER TABLE claw_skills ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''").catch(() => {});
    await client.query("CREATE INDEX IF NOT EXISTS idx_skills_user ON claw_skills(user_id, status)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_skills_name ON claw_skills(skill_name, user_id, version DESC)");

    // Soft-delete support
    const addDeleted = async (table: string) => {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`).catch(() => {});
    };
    await addDeleted("claw_sessions");
    await addDeleted("claw_session_events");
    await addDeleted("claw_conversation_turns");
    await addDeleted("claw_session_summaries");
    await client.query("CREATE INDEX IF NOT EXISTS idx_sessions_not_deleted ON claw_sessions(deleted_at) WHERE deleted_at IS NULL").catch(() => {});
    await client.query("CREATE INDEX IF NOT EXISTS idx_events_not_deleted ON claw_session_events(deleted_at) WHERE deleted_at IS NULL").catch(() => {});
    await client.query("CREATE INDEX IF NOT EXISTS idx_turns_not_deleted ON claw_conversation_turns(deleted_at) WHERE deleted_at IS NULL").catch(() => {});

    // v3.5 #1: split "persisted" from "processed". Without this, a NATS retry after
    // handleComplete crashed would silently skip handleComplete on retry because the
    // event_id row already exists (ON CONFLICT DO NOTHING → isNewEvent=false). Now
    // processed_at marks completion: NULL = pending, NOT NULL = handleComplete done.
    await client.query("ALTER TABLE claw_session_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ DEFAULT NULL").catch(() => {});
    await client.query("CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON claw_session_events(event) WHERE processed_at IS NULL AND deleted_at IS NULL").catch(() => {});

    // The turn a completion produced, named by the message that asked for it.
    //
    // The gate above recognises one published event delivered twice, which is
    // not the only way a completion arrives twice: a run resumed after being
    // interrupted publishes exec_complete again, and a new publish means a new
    // stream sequence, a new event_id, a row that conflicts with nothing and
    // handleComplete running a second time. The visible result was the user's
    // message and the assistant's reply appearing twice in the history -- in the
    // transcript, and in the context every later prompt is built from.
    //
    // message_id is the same across every delivery and every re-publish of one
    // turn, so it is what the rows can be made unique on. Nullable and the index
    // partial on it, because turns written before this column existed have no
    // message id and are not comparable to each other.
    await client.query("ALTER TABLE claw_conversation_turns ADD COLUMN IF NOT EXISTS message_id TEXT").catch(() => {});
    // Not swallowed, unlike the indexes above: this one is a constraint, and the
    // `ON CONFLICT DO NOTHING` that depends on it silently degrades into an
    // ordinary insert without it -- which is the duplicate, back again, on a
    // deployment that looks healthy.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_turns_message_role
         ON claw_conversation_turns(session_id, message_id, role)
       WHERE message_id IS NOT NULL AND deleted_at IS NULL`,
    );
    // Asked once per completion, to find out whether an earlier delivery of the
    // same turn was already processed.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_events_completion
         ON claw_session_events(session_id, (data->>'message_id'))
       WHERE event = 'exec_complete' AND deleted_at IS NULL`,
    ).catch(() => {});

    // checkpoint-architecture-redesign §5.3 / INV-8: monotonic wall-clock for
    // taskInterrupted/taskResumed events. handleStatusEvent gates updates on
    //   $newEventAt::bigint > COALESCE(status_event_at, 0)
    // so an out-of-order replay of an older event cannot revert agent_status.
    // Project convention: claw_sessions schema lives in this initDb() block
    // (no standalone migration runner); the ALTER below is the authoritative
    // applier and is idempotent across restarts.
    await client.query("ALTER TABLE claw_sessions ADD COLUMN IF NOT EXISTS status_event_at BIGINT").catch(() => {});
    await client.query("CREATE INDEX IF NOT EXISTS idx_claw_sessions_status_event_at ON claw_sessions(status_event_at)").catch(() => {});

    // What is left to do about a session the user has deleted.
    //
    // A delete hides the session and drops its rows in one transaction, and
    // everything outside this database -- the tombstone, the sandbox, the event
    // stream, the objects in S3 -- is finished afterwards, by the request when it
    // can and by the sweeper when it cannot (see sessions/teardown.ts). These four
    // columns are that work item, and they are on the session row rather than in
    // a table of their own because marking the deletion and recording the work
    // have to be one atomic write: a separate insert can be the statement that
    // fails, and then the session is deleted with nothing left to remember that
    // its files were not.
    //
    // `cleanup_state` is NULL for every session nobody has deleted, 'pending'
    // while the work is outstanding and 'done' once it is finished. Not dropped
    // on completion, because the difference between "finished" and "never asked
    // for" is what a partial backfill and an operator's query both read.
    for (const [col, type] of [
      ["cleanup_state", "TEXT"],
      ["cleanup_attempts", "INT NOT NULL DEFAULT 0"],
      ["cleanup_next_at", "TIMESTAMPTZ"],
      ["cleanup_error", "TEXT"],
    ]) {
      await client.query(
        `ALTER TABLE claw_sessions ADD COLUMN IF NOT EXISTS ${col} ${type}`,
      ).catch(() => {});
    }
    // Partial, so the sweeper's "anything due?" question costs an index seek
    // over the outstanding items rather than a scan of every session ever
    // deleted -- which on a healthy cluster is an empty set.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_sessions_cleanup_due
         ON claw_sessions(cleanup_next_at) WHERE cleanup_state = 'pending'`,
    ).catch(() => {});
    // The other question asked of the same set, which the index above cannot
    // serve because it is keyed on the schedule: the stuck report wants the
    // oldest deletion by `deleted_at`. Free while the pending set is empty, and
    // the reason it is here is the case where it is not -- the backfill below
    // makes every session ever deleted pending, and that report runs every tick
    // while the backlog drains.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_sessions_cleanup_oldest
         ON claw_sessions(deleted_at) WHERE cleanup_state = 'pending'`,
    ).catch(() => {});
    // Sessions deleted before this existed had their cleanup attempted exactly
    // once, inside the request, and whatever failed there was logged and left.
    // The objects of those sessions are still in the bucket, which is the leak
    // this column set exists to close, so they are handed to the sweeper too.
    // One indexless UPDATE over the deleted sessions of the whole history, on a
    // migration connection whose statement timeout is raised for exactly this
    // kind of thing; what the sweeper then does with them is a batch per tick,
    // so the first boot after an upgrade is not the pass that walks a year of
    // prefixes.
    //
    // Runs on every start and matches nothing after the first, since the only
    // rows it selects are deleted sessions with no state at all, and both the
    // delete path and the sweeper always write one.
    await client.query(
      `UPDATE claw_sessions
          SET cleanup_state = 'pending', cleanup_next_at = NOW()
        WHERE deleted_at IS NOT NULL AND cleanup_state IS NULL`,
    ).catch(() => {});

    // Per-session recency lookup. The sweeper's stuck-session reaper asks
    // "has this session emitted an event lately", which without this index is a
    // scan of the whole event table per candidate row.
    //
    // CONCURRENTLY so the first build does not take SHARE and block INSERT:
    // the event-consumer writes this table for every Brain event, and a lock
    // here is a conversation that stops producing tokens. Each statement in
    // this function commits on its own, which is what CONCURRENTLY requires.
    // A killed build leaves an INVALID index that IF NOT EXISTS then skips;
    // dropping only that leftover lets the next boot retry.
    try {
      await client.query(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_session_recent ON claw_session_events(session_id, created_at DESC)",
      );
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "db.idx_events_session_recent_failed");
      const leftover = await client.query(
        `SELECT indisvalid FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'idx_events_session_recent'`,
      ).catch(() => ({ rows: [] as Array<{ indisvalid: boolean }> }));
      if (leftover.rows[0]?.indisvalid === false) {
        await client.query(
          "DROP INDEX CONCURRENTLY IF EXISTS idx_events_session_recent",
        ).catch(() => {});
      }
    }

    // E2: skill sub-files (multi-file skill support).
    // No FK on purpose — soft-delete the parent skill, orphan rows cleaned by
    // a periodic job. user_id is denormalized for fast filtering / cross-user safety.
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_skill_files (
        id           SERIAL PRIMARY KEY,
        skill_id     INT NOT NULL,
        user_id      TEXT NOT NULL,
        file_path    TEXT NOT NULL,
        content      TEXT NOT NULL,
        is_binary    BOOLEAN DEFAULT FALSE,
        size_bytes   INT NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(skill_id, file_path)
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_skill_files_skill ON claw_skill_files(skill_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_skill_files_user ON claw_skill_files(user_id)");

    // E3: task pattern aggregation. Replaces single-task-driven auto-create.
    // A pattern is a hash of the tool-sequence + user intent prefix; once it occurs
    // N>=3 times for the same user, we trigger LLM extraction into a skill.
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_skill_patterns (
        id                   SERIAL PRIMARY KEY,
        user_id              TEXT NOT NULL,
        pattern_hash         TEXT NOT NULL,
        signature            TEXT NOT NULL,
        occurrences          INT DEFAULT 1,
        first_seen_at        TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at         TIMESTAMPTZ DEFAULT NOW(),
        promoted_to_skill_id INT DEFAULT NULL,
        example_session_ids  JSONB DEFAULT '[]',
        UNIQUE(user_id, pattern_hash)
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_patterns_user ON claw_skill_patterns(user_id, occurrences DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_patterns_pending ON claw_skill_patterns(user_id) WHERE promoted_to_skill_id IS NULL");

    // --- Durable evolution job queue ---
    // exec_complete used to schedule maybeEvolveSkill via setImmediate, which
    // dropped on the floor whenever the API process crashed between the event
    // ack and the LLM call. This table is the durable inbox: every
    // exec_complete enqueues one row (capturing the full event payload), and
    // a background worker (marketplace/evolve-worker.ts) atomically claims pending jobs
    // with FOR UPDATE SKIP LOCKED so multiple API replicas can safely share
    // the queue. Failed jobs are retried up to MAX_ATTEMPTS before being
    // marked permanently failed.
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_evolution_jobs (
        id          BIGSERIAL PRIMARY KEY,
        session_id  TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        event_data  JSONB NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        attempts    INT NOT NULL DEFAULT 0,
        last_error  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at  TIMESTAMPTZ,
        finished_at TIMESTAMPTZ
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_evolution_jobs_pending ON claw_evolution_jobs(created_at) WHERE status = 'pending'"
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_evolution_jobs_running ON claw_evolution_jobs(started_at) WHERE status = 'running'"
    );

    // --- Marketplace (ported from the original Python implementation) ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS tools (
        id BIGSERIAL PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        name VARCHAR(255) NOT NULL,
        version VARCHAR(255) NOT NULL,
        display_name VARCHAR(255),
        description TEXT NOT NULL DEFAULT '',
        tags JSONB NOT NULL DEFAULT '[]',
        icon_url TEXT,
        author VARCHAR(255),
        config JSONB NOT NULL DEFAULT '{}',
        tool_source VARCHAR(50) NOT NULL DEFAULT 'upload',
        tool_source_url TEXT,
        owner_user_id VARCHAR(255),
        is_public BOOLEAN NOT NULL DEFAULT true,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_tools_type ON tools(type)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(name)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_tools_owner ON tools(owner_user_id)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_tools_status ON tools(status)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_tools_deleted_at ON tools(deleted_at)",
    ).catch(() => {});
    // One live row per (name, version); many versions per name remain allowed.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_tools_name_version_active
       ON tools (name, version) WHERE deleted_at IS NULL AND status = 'active'`,
    ).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS plugins (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        version VARCHAR(255) NOT NULL DEFAULT '',
        -- Superseded by images, and no longer read or written. Kept so a
        -- rollback to a build that reads it still finds its data, which is
        -- what the legacy resources column is kept for too.
        image VARCHAR(1024) NOT NULL DEFAULT '',
        images JSONB NOT NULL DEFAULT '[]',
        tools JSONB NOT NULL DEFAULT '[]',
        resource JSONB NOT NULL DEFAULT '{}',
        owner_user_id VARCHAR(255),
        author VARCHAR(255),
        is_public BOOLEAN NOT NULL DEFAULT true,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_plugins_owner ON plugins(owner_user_id)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_plugins_status ON plugins(status)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_plugins_version ON plugins(version)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_plugins_deleted_at ON plugins(deleted_at)",
    ).catch(() => {});
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_plugins_name_version_active
       ON plugins (name, version) WHERE deleted_at IS NULL AND status = 'active'`,
    ).catch(() => {});
    // Idempotent column additions for older DBs that predate these columns.
    await client.query(
      `ALTER TABLE plugins ADD COLUMN IF NOT EXISTS image VARCHAR(1024) NOT NULL DEFAULT ''`,
    ).catch(() => {});
    await client.query(
      `ALTER TABLE plugins ADD COLUMN IF NOT EXISTS resource JSONB NOT NULL DEFAULT '{}'::jsonb`,
    ).catch(() => {});
    // `images` replaces the single `image` column: a plugin now declares one
    // repo per framework, and the dispatch chain takes the first usable one.
    // No backfill from `image`: it defaulted to '' on every row that never set
    // it, and a row that did set it keeps the value for a rollback to read.
    await client.query(
      `ALTER TABLE plugins ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb`,
    ).catch(() => {});
    // Anthropic Managed Agents compat (design doc §9.5.1): independent
    // optimistic-lock counter for `agents.update()`. Deliberately NOT
    // `plugins.version` (free-form string used by pluginActiveByNameAndVersion/
    // new-version for picking an active version by name) — the two counters
    // serve different clients and must not be conflated.
    await client.query(
      `ALTER TABLE plugins ADD COLUMN IF NOT EXISTS anthropic_agent_version INT NOT NULL DEFAULT 1`,
    ).catch(() => {});
    // Schema v2 cleanup: drop legacy V1 array column. No rollback path back
    // to V1 — V2 only uses ``resource`` (object).
    await client.query(`ALTER TABLE plugins DROP COLUMN IF EXISTS resources`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS resources (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL DEFAULT '',
        type VARCHAR(16) NOT NULL DEFAULT '',
        image VARCHAR(1024) NOT NULL DEFAULT '',
        resource JSONB NOT NULL DEFAULT '{}'::jsonb,
        owner_user_id VARCHAR(255),
        author VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    // Idempotent column additions for older DBs that predate these columns.
    await client.query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS type VARCHAR(16) NOT NULL DEFAULT ''`).catch(() => {});
    await client.query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS resource JSONB NOT NULL DEFAULT '{}'::jsonb`).catch(() => {});
    // Anthropic Managed Agents compat (design doc §9.5.2): `resources` doubles
    // as the backing store for compat Environment rows (type='anthropic_env').
    // `archived_at` is distinct from `deleted_at` so archive (reversible) and
    // delete (permanent) don't collapse into the same operation.
    await client.query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`).catch(() => {});
    // Schema v2 cleanup: drop legacy V1 columns. No rollback path back to V1.
    // Indexes that reference dropped columns are removed automatically.
    await client.query(`ALTER TABLE resources DROP COLUMN IF EXISTS env`).catch(() => {});
    await client.query(`ALTER TABLE resources DROP COLUMN IF EXISTS version`).catch(() => {});
    await client.query(`ALTER TABLE resources DROP COLUMN IF EXISTS resources`).catch(() => {});
    await client.query(`ALTER TABLE resources DROP COLUMN IF EXISTS timeout`).catch(() => {});
    await client.query(`ALTER TABLE resources DROP COLUMN IF EXISTS labels`).catch(() => {});
    await client.query(`ALTER TABLE resources DROP COLUMN IF EXISTS annotations`).catch(() => {});
    await client.query(`ALTER TABLE resources DROP COLUMN IF EXISTS is_public`).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources(owner_user_id)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_resources_deleted_at ON resources(deleted_at)",
    ).catch(() => {});

    // Bottom rung of the image/resource resolution chain (agent-server-design.md
    // §"metadata > plugin row > default"). Seeded unconditionally, because the
    // row carries two independent things and only one of them is optional.
    //
    // This used to be gated on DEFAULT_SANDBOX_IMAGE being non-empty, on the
    // reasoning that a caller naming an image inline could get by without the
    // row. That is not what happens: cpu/memory bottom out at the same row, so
    // with the chart's shipped `defaultSandbox.image: ""` no row existed, and
    // every sandbox-touching tool failed with "workload resources are missing
    // or invalid" -- including for a request that did name an image. A fresh
    // install could not execute a single tool call until an operator found the
    // chart value. Seeding always means the resources are there either way and
    // an empty image simply leaves the image to the caller, which is what the
    // chart's own documentation already claims it does.
    //
    // Still skipped once any default row exists, so an operator's later edits
    // are not reverted on the next migration.
    await client.query(
      `INSERT INTO resources (name, type, image, resource, author)
       SELECT 'default', 'default', $1, $2::jsonb, 'chart'
       WHERE NOT EXISTS (
         SELECT 1 FROM resources WHERE type = 'default' AND deleted_at IS NULL
       )`,
      [
        (process.env.DEFAULT_SANDBOX_IMAGE || "").trim(),
        JSON.stringify({
          cpu: (process.env.DEFAULT_SANDBOX_CPU || "2").trim(),
          memory: (process.env.DEFAULT_SANDBOX_MEMORY || "4Gi").trim(),
        }),
      ],
    );

    // --- Task DAG core tables (task-design.md §4, §6, §6.3) -----------------
    // Project rule: only base tables + indexes; no FKs / views / triggers /
    // procedures. Cross-row integrity is enforced in admission code instead.

    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_task_dags (
        dag_id          TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        version         TEXT NOT NULL DEFAULT '1.0.0',
        description     TEXT,
        plugin_id       BIGINT,
        trust_level     TEXT NOT NULL DEFAULT 'user',
        input_schema    JSONB NOT NULL DEFAULT '{}'::jsonb,
        nodes           JSONB NOT NULL DEFAULT '[]'::jsonb,
        batch_aggregator JSONB,
        metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
        owner_user_id   TEXT,
        is_public       BOOLEAN NOT NULL DEFAULT true,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at      TIMESTAMPTZ
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_task_dags_name_version_active
       ON claw_task_dags(name, version) WHERE deleted_at IS NULL AND status='active'`,
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_task_dags_plugin ON claw_task_dags(plugin_id)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_task_dags_status ON claw_task_dags(status)",
    ).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_batches (
        batch_id        TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        user_id         TEXT,
        dag_id          TEXT,
        size            INT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'running',
        metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at    TIMESTAMPTZ
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_batches_session ON claw_batches(session_id)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_batches_status ON claw_batches(status)",
    ).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_tasks (
        task_id              TEXT PRIMARY KEY,
        session_id           TEXT NOT NULL,
        parent_task_id       TEXT,
        batch_id             TEXT,
        dag_id               TEXT,
        dag_node_id          TEXT,
        dag_root_task_id     TEXT,
        plugin_id            BIGINT,
        name                 TEXT NOT NULL,
        input                JSONB NOT NULL DEFAULT '{}'::jsonb,
        prompt               TEXT,
        script               JSONB,
        depends_on           TEXT[] NOT NULL DEFAULT '{}',
        priority             INT NOT NULL DEFAULT 0,
        executor             TEXT NOT NULL DEFAULT 'brain',
        mode                 TEXT NOT NULL DEFAULT 'llm',
        model                TEXT,
        tools_allowlist      JSONB NOT NULL DEFAULT '[]'::jsonb,
        skills               JSONB NOT NULL DEFAULT '[]'::jsonb,
        rules_text           TEXT,
        agent_hooks          JSONB NOT NULL DEFAULT '{}'::jsonb,
        sandbox_spec         JSONB,
        callback_url         TEXT,
        backend_mcp_url      TEXT,
        internal_token_hash  TEXT,
        brain_id             TEXT,
        sandbox_workload_id  TEXT,
        status               TEXT NOT NULL,
        failure_reason       TEXT,
        error_message        TEXT,
        output               TEXT,
        artifacts            JSONB NOT NULL DEFAULT '[]'::jsonb,
        captures             JSONB NOT NULL DEFAULT '{}'::jsonb,
        tool_stats           JSONB,
        token_usage          JSONB,
        turns                INT,
        metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
        origin               TEXT,
        workspace_id         TEXT,
        lease_owner          TEXT,
        lease_expires_at     TIMESTAMPTZ,
        heartbeat_at         TIMESTAMPTZ,
        event_seq            BIGINT NOT NULL DEFAULT 0,
        claim_count          INT NOT NULL DEFAULT 0,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        queued_at            TIMESTAMPTZ,
        started_at           TIMESTAMPTZ,
        deadline_at          TIMESTAMPTZ,
        completed_at         TIMESTAMPTZ
      )
    `);
    // Existing deployments predate deadline_at. Rows without one keep falling
    // back to the old started_at + BRAIN_TASK_TIMEOUT_SEC rule in the sweeper.
    await client.query(
      "ALTER TABLE claw_tasks ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ",
    ).catch(() => {});

    // Columns that turn this table into a record of runs rather than only of
    // DAG tasks. Chat turns are about to start writing rows here, and a chat
    // turn currently has no persisted identity at all: nothing to sweep when
    // it hangs, nothing for the workspace collector to check ownership
    // against, nothing to count when asking how many runs a tenant has in
    // flight. Every one of them arrives empty and unread -- nullable, or in
    // `event_seq`'s case defaulted -- so this step only adds.
    //
    // Deliberately not added, though the design lists them:
    //   - `run_id`. `task_id` is already a ULID primary key and is what every
    //     index, foreign reference and CAS is built on; a second identifier
    //     for the same row would be two things to keep agreeing. The design's
    //     objection was to `claw-${Date.now()}`, which is the chat message id
    //     and was never a candidate for this column.
    //   - `root_run_id`. `dag_root_task_id` already is it. Adding a synonym
    //     before the two can differ just creates a question about which one to
    //     trust; it can be renamed when the DAG columns are split out.
    //   - `on_child_failure` / `topology`. Policy for features not built yet.
    const addTaskCol = async (col: string, type: string) => {
      await client.query(
        `ALTER TABLE claw_tasks ADD COLUMN IF NOT EXISTS ${col} ${type}`,
      ).catch(() => {});
    };
    // What produced this run: 'chat', 'task' (the standalone task API) or
    // 'dag_node'. Until now the kind was inferred from whether
    // `dag_root_task_id` was set, which cannot separate the first two -- and
    // gets the answer wrong for a standalone task, handing a batch job the
    // budget meant for a conversational turn. Nullable, because rows written
    // before this column exist and the inference stays as the fallback.
    await addTaskCol("origin", "TEXT");
    // Which workspace the run's files live in. The collector currently infers
    // ownership from paths, which is why it cannot safely delete anything.
    await addTaskCol("workspace_id", "TEXT");
    // Who is executing the run. Declared in CREATE TABLE since the table
    // existed but never written to until now, and a deployment old enough to
    // predate the declaration would fail the write rather than skip it.
    await addTaskCol("brain_id", "TEXT");
    await addTaskCol("sandbox_workload_id", "TEXT");
    // Worker liveness, the half of the old timeout that was never about how
    // long a run may take. Renewed by heartbeat; a lease that expires means
    // the worker is gone, which is knowable in seconds rather than hours.
    await addTaskCol("lease_owner", "TEXT");
    await addTaskCol("lease_expires_at", "TIMESTAMPTZ");
    await addTaskCol("heartbeat_at", "TIMESTAMPTZ");
    // Monotonic per-run event counter, so a reconnecting reader can say what
    // it has already seen instead of receiving the stream from the top.
    await addTaskCol("event_seq", "BIGINT NOT NULL DEFAULT 0");
    // What the platform did to this run, captured when it ended.
    //
    // Recorded rather than fetched on read. A dispatcher above Claw polls a couple
    // of hundred live runs every thirty seconds; resolving each one against SaFE at
    // that point would be two hundred calls per sweep, and it would be asking for
    // facts that stopped changing when the run did. Written once at the terminal,
    // the batch read is one query.
    //
    // `platform_kill_reason` is the field the whole thing is for: only the platform
    // knows it, and without it a reclaimed node is indistinguishable from a crash.
    await addTaskCol("platform_kill_reason", "TEXT");
    await addTaskCol("platform_exit_code", "INT");
    await addTaskCol("platform_node", "TEXT");
    // The pod's own account, kept verbatim. The reason above is a reading of it,
    // and a reading that turns out to be wrong is worth being able to re-derive.
    await addTaskCol("platform_message", "TEXT");
    // The container's own termination reason. Separate from the message above
    // because the pod-level one describes the kills decided above the container
    // and is empty for an OOM -- which is the ending exit code 137 alone cannot
    // tell from an eviction or a deliberate stop.
    await addTaskCol("platform_container_reason", "TEXT");
    // How many times a doorbell run has been claimed. The poison delivery
    // budget for fat messages; without it a crash-looping chat run is
    // reclaimed until deadline_at.
    await addTaskCol("claim_count", "INT NOT NULL DEFAULT 0");
    // What admission counts. It reads the fleet on every chat dispatch -- twice
    // when a ceiling is set -- and filters on the four occupying statuses,
    // which no other index covers, so the planner had nothing to choose but a
    // sequential scan. `claw_tasks` is never pruned, so that scan grows with
    // total history rather than with work in flight. Partial on the same
    // statuses, so the index stays the size of the in-flight set.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_tasks_occupying ON claw_tasks(executor)
         WHERE status IN ('queued','preparing','running','cancelling')`,
    ).catch(() => {});

    // Reclaiming runs whose worker died. Partial for the same reason as the
    // deadline index: terminal rows are almost all of the table.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_tasks_lease ON claw_tasks(lease_expires_at)
       WHERE lease_expires_at IS NOT NULL
         AND status IN ('preparing','running','cancelling')`,
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON claw_tasks(workspace_id) WHERE workspace_id IS NOT NULL",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_tasks_session ON claw_tasks(session_id)",
    ).catch(() => {});
    // The sweeper's backstop scan: non-terminal rows ordered by when their
    // budget runs out. Partial, because rows past their deadline are the rare
    // case and terminal rows are the overwhelming majority of the table.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON claw_tasks(deadline_at)
       WHERE deadline_at IS NOT NULL
         AND status IN ('preparing','running','cancelling')`,
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_tasks_dag_root ON claw_tasks(dag_root_task_id)",
    ).catch(() => {});
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_tasks_status_waiting ON claw_tasks(status)
       WHERE status IN ('waiting_deps','waiting_external','queued')`,
    ).catch(() => {});
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_tasks_status_active ON claw_tasks(status)
       WHERE status IN ('preparing','running')`,
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_tasks_batch ON claw_tasks(batch_id) WHERE batch_id IS NOT NULL",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_tasks_plugin ON claw_tasks(plugin_id) WHERE plugin_id IS NOT NULL",
    ).catch(() => {});
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_task_edges (
        id                BIGSERIAL PRIMARY KEY,
        dag_root_task_id  TEXT NOT NULL,
        from_task_id      TEXT NOT NULL,
        to_task_id        TEXT NOT NULL
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_edges_from_to
       ON claw_task_edges(from_task_id, to_task_id)`,
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_edges_to ON claw_task_edges(to_task_id)",
    ).catch(() => {});
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_edges_root ON claw_task_edges(dag_root_task_id)",
    ).catch(() => {});

    // A workspace: the files a run works on, as a thing in its own right.
    //
    // Until now a workspace has been a naming convention. The files live under
    // `users/<u>/sessions/<sid>/` and that path is the only record that they
    // exist: nothing says who owns them, whether anything still needs them, or
    // whether two runs are writing them at once. Every consequence of that is a
    // separate-looking problem. The collector has to guess from directory mtime
    // and the absence of a lock, so it dares delete almost nothing. A session
    // deleted while a run is in flight takes the files with it. Two runs sharing
    // a session write the same directory with no one the wiser.
    //
    // The row gives the files an identity, a reference list, a retention lease
    // and a writer version. `storage_prefix` is deliberately the path that is
    // already in use, so creating these rows moves no data and changes no
    // layout -- the first step only records what is already true.
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_workspaces (
        workspace_id         TEXT PRIMARY KEY,
        owner_user_id        TEXT NOT NULL,
        name                 TEXT,
        storage_prefix       TEXT NOT NULL,
        version              BIGINT NOT NULL DEFAULT 0,
        writer_run_id        TEXT,
        writer_expires_at    TIMESTAMPTZ,
        retention_expires_at TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at           TIMESTAMPTZ
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON claw_workspaces(owner_user_id) WHERE deleted_at IS NULL",
    ).catch(() => {});
    // Collectible workspaces: nothing references them and the retention lease
    // has run out. Partial, because that is the rare state.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_workspaces_retention ON claw_workspaces(retention_expires_at)
       WHERE retention_expires_at IS NOT NULL AND deleted_at IS NULL`,
    ).catch(() => {});

    // Who is using a workspace. Rows rather than a counter, because a counter
    // drifts and cannot be audited: with rows, "is anything using this?" and
    // "what exactly?" are the same query, and a leaked reference names the
    // session or run that leaked it.
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_workspace_refs (
        workspace_id TEXT NOT NULL,
        ref_kind     TEXT NOT NULL,
        ref_id       TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_at  TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, ref_kind, ref_id)
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_refs_live ON claw_workspace_refs(workspace_id)
       WHERE released_at IS NULL`,
    ).catch(() => {});
    // One live reference per (kind, id), which is the rule the whole gate rests
    // on: a session must resolve to one workspace, or two of its runs take
    // different gate keys, overlap, and `rsync --delete` each other's files.
    //
    // The primary key cannot express it. Each concurrent caller mints its own
    // workspace id first, so two racing dispatches for one session insert rows
    // that differ in `workspace_id` and neither conflicts -- the loser was
    // supposed to lose here and instead both won, persistently, because
    // `workspaceForSession` then picks whichever row it finds first.
    //
    // Duplicates are released before the index is built so a cluster that has
    // already split a session can adopt the rule rather than fail to boot with
    // it. Keeping the earliest is arbitrary but stable: both rows describe the
    // same storage prefix, so neither is more correct, and once the loser's
    // reference is released `workspaceForSession` stops being able to find it.
    await client.query(`
      UPDATE claw_workspace_refs r
         SET released_at = NOW()
       WHERE r.released_at IS NULL
         AND EXISTS (
           SELECT 1 FROM claw_workspace_refs k
            WHERE k.ref_kind = r.ref_kind
              AND k.ref_id = r.ref_id
              AND k.released_at IS NULL
              AND (k.created_at, k.workspace_id) < (r.created_at, r.workspace_id)
         )
    `);
    await client.query("DROP INDEX IF EXISTS idx_workspace_refs_ref");
    // Not swallowed, unlike the indexes above: they are there for speed, this
    // one is a constraint, and a deployment running without it looks healthy
    // right up to the point where it loses a user's files.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_refs_live_ref
         ON claw_workspace_refs(ref_kind, ref_id) WHERE released_at IS NULL`,
    );
    // The same two columns without the predicate, for the question that asks
    // about released references: where do this session's files live, rather than
    // what is it using. The index above cannot answer it -- released rows are
    // the ones it leaves out -- so every caller scans the whole table instead,
    // and the table grows by a row for every session and every run ever
    // dispatched. Three ask it, two of them constantly: a returning session
    // re-adopting its own directory, the collector deciding whether these files
    // may go, and a session delete working out which gate keys its files had.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_workspace_refs_ref_any
         ON claw_workspace_refs(ref_kind, ref_id)`,
    ).catch(() => {});

    // Legacy Kernel Arena tables (`claw_kernel_*`) are no longer created or
    // referenced by the Claw API. Existing deployments keep those historical
    // rows untouched; a destructive DROP belongs in a separate data-migration PR.

    // Per-user env vars (user-env-vars-design.md v1.5 §4)
    // Encrypted value blob holds AES-256-GCM(version || nonce || ct || tag),
    // base64-encoded. `enc_version` is reserved for future key rotation
    // (v2 algorithm or key swap). One row per (user_id, key_name).
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_user_env_vars (
        user_id        TEXT NOT NULL,
        key_name       TEXT NOT NULL,
        key_value_enc  TEXT NOT NULL,
        enc_version    SMALLINT NOT NULL DEFAULT 1,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, key_name)
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_user_env_user ON claw_user_env_vars(user_id)",
    ).catch(() => {});
    // Snapshot column on pending_messages — caller decrypts user env once at
    // POST /messages time and freezes the plaintext map here so Brain can
    // pull it without re-touching the encrypted store / master key.
    await client.query(
      "ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS user_env JSONB DEFAULT '{}'::jsonb",
    ).catch(() => {});
    await client.query(
      "ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS session_env JSONB DEFAULT '{}'::jsonb",
    ).catch(() => {});

    // System-level env vars (admin-managed, global). Same AES-256-GCM blob
    // format as claw_user_env_vars but WITHOUT user_id — these apply to every
    // sandbox as a fallback layer (see system-env-design.md). One row per
    // key_name; key_name is the primary key.
    await client.query(`
      CREATE TABLE IF NOT EXISTS claw_system_env_vars (
        key_name       TEXT PRIMARY KEY,
        key_value_enc  TEXT NOT NULL,
        enc_version    SMALLINT NOT NULL DEFAULT 1,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await assertSchema(client);
    logger.info("db.migrated");
  } finally {
    // Destroyed, not returned to the pool. The session holds an advisory lock
    // and a migration-sized statement_timeout, and ending it drops both --
    // whereas returning it would hand the next caller a connection with a
    // five-minute timeout, and would leave the lock held if the explicit
    // unlock were the thing that failed. One connection per process start is
    // not worth being clever about.
    client.release(true);
  }
}

/** Row shapes from tools/plugins/resources (JSONB columns parsed). */
export type JsonObject = Record<string, unknown>;

/** Marketplace persistence layer — ported from the original Python implementation (Postgres only). */
export const MarketplaceDb = {
  async toolGetById(
    id: number,
    includeDeleted = false,
  ): Promise<JsonObject | null> {
    const del = includeDeleted ? "" : " AND deleted_at IS NULL";
    const r = await db.query(`SELECT * FROM tools WHERE id = $1${del}`, [id]);
    return (r.rows[0] as JsonObject) ?? null;
  },

  /**
   * Batch variant of {@link toolGetById}: fetch many tools in a single query
   * to avoid N+1 round-trips (used by ``formatPluginRow`` reference enrichment).
   * Returns rows in arbitrary order; callers should index by ``id``.
   */
  async toolsGetByIds(
    ids: number[],
    includeDeleted = false,
  ): Promise<JsonObject[]> {
    const uniq = Array.from(new Set(ids.filter((n) => Number.isFinite(n))));
    if (!uniq.length) return [];
    const del = includeDeleted ? "" : " AND deleted_at IS NULL";
    const r = await db.query(
      `SELECT * FROM tools WHERE id = ANY($1::bigint[])${del}`,
      [uniq],
    );
    return r.rows as JsonObject[];
  },

  /** Matches ``uq_tools_name_version_active`` (one active row per name+version). */
  async toolActiveByNameAndVersion(name: string, version: string): Promise<JsonObject | null> {
    const r = await db.query(
      `SELECT * FROM tools WHERE name = $1 AND version = $2 AND deleted_at IS NULL AND status = 'active' LIMIT 1`,
      [name, version],
    );
    return (r.rows[0] as JsonObject) ?? null;
  },

  async toolsActiveByName(name: string): Promise<JsonObject[]> {
    const r = await db.query(
      `SELECT * FROM tools WHERE name = $1 AND deleted_at IS NULL AND status = 'active' ORDER BY created_at DESC`,
      [name],
    );
    return r.rows as JsonObject[];
  },

  async pluginsActiveByName(name: string): Promise<JsonObject[]> {
    const r = await db.query(
      `SELECT * FROM plugins WHERE name = $1 AND deleted_at IS NULL AND status = 'active' ORDER BY created_at DESC`,
      [name],
    );
    return r.rows as JsonObject[];
  },

  /**
   * Non-deleted plugins whose ``tools`` JSON array contains an entry with ``id`` equal to ``toolId``
   * (same shape as ``formatPluginRow`` / list-plugins ``tools[].id``).
   */
  async pluginsListReferencingToolId(toolId: number): Promise<JsonObject[]> {
    const r = await db.query(
      `SELECT id, name, version FROM plugins p
       WHERE p.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(p.tools, '[]'::jsonb)) AS elem
         WHERE elem ? 'id' AND (elem->>'id')::bigint = $1::bigint
       )
       ORDER BY p.id ASC`,
      [toolId],
    );
    return r.rows as JsonObject[];
  },

  async toolInsert(payload: JsonObject): Promise<JsonObject> {
    const r = await db.query(
      `INSERT INTO tools (
        type, name, version, display_name, description, tags, icon_url, author, config,
        tool_source, tool_source_url, owner_user_id, is_public, status
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
      RETURNING *`,
      [
        payload.type,
        payload.name,
        payload.version,
        payload.display_name ?? null,
        payload.description ?? "",
        JSON.stringify(payload.tags ?? []),
        payload.icon_url ?? null,
        payload.author ?? null,
        JSON.stringify(payload.config ?? {}),
        payload.tool_source ?? "upload",
        payload.tool_source_url ?? null,
        payload.owner_user_id ?? null,
        payload.is_public ?? true,
        payload.status ?? "active",
      ],
    );
    return r.rows[0] as JsonObject;
  },

  async toolUpdate(id: number, patch: JsonObject): Promise<JsonObject | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = $${i++}`);
      vals.push(v);
    };
    if ("type" in patch) add("type", patch.type);
    if ("name" in patch) add("name", patch.name);
    if ("version" in patch) add("version", patch.version);
    if ("display_name" in patch) add("display_name", patch.display_name);
    if ("description" in patch) add("description", patch.description);
    if ("tags" in patch) add("tags", JSON.stringify(patch.tags ?? []));
    if ("icon_url" in patch) add("icon_url", patch.icon_url);
    if ("author" in patch) add("author", patch.author);
    if ("config" in patch) add("config", JSON.stringify(patch.config ?? {}));
    if ("tool_source" in patch) add("tool_source", patch.tool_source);
    if ("tool_source_url" in patch) add("tool_source_url", patch.tool_source_url);
    if ("owner_user_id" in patch) add("owner_user_id", patch.owner_user_id);
    if ("is_public" in patch) add("is_public", patch.is_public);
    if ("status" in patch) add("status", patch.status);
    if ("deleted_at" in patch) add("deleted_at", patch.deleted_at);
    if (!sets.length) {
      const cur = await this.toolGetById(id, true);
      return cur;
    }
    add("updated_at", new Date());
    vals.push(id);
    const r = await db.query(
      `UPDATE tools SET ${sets.join(", ")} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`,
      vals,
    );
    return (r.rows[0] as JsonObject) ?? null;
  },

  async toolSoftDelete(id: number): Promise<boolean> {
    const r = await db.query(
      `UPDATE tools SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return (r.rowCount ?? 0) > 0;
  },

  async pluginGetById(id: number, includeDeleted = false): Promise<JsonObject | null> {
    const del = includeDeleted ? "" : " AND deleted_at IS NULL";
    const r = await db.query(`SELECT * FROM plugins WHERE id = $1${del}`, [id]);
    return (r.rows[0] as JsonObject) ?? null;
  },

  async pluginActiveByNameAndVersion(name: string, version: string): Promise<JsonObject | null> {
    const r = await db.query(
      `SELECT * FROM plugins WHERE name = $1 AND version = $2 AND deleted_at IS NULL AND status = 'active' LIMIT 1`,
      [name, version],
    );
    return (r.rows[0] as JsonObject) ?? null;
  },

  async pluginInsert(payload: JsonObject): Promise<JsonObject> {
    // V2 writes `resource` (object). Legacy `resources` (array) column is
    // intentionally not written here so V1 can keep its data untouched.
    const r = await db.query(
      `INSERT INTO plugins (
        name, description, version, images, tools, resource, owner_user_id, author, is_public, status
      ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10) RETURNING *`,
      [
        payload.name,
        payload.description ?? "",
        payload.version,
        JSON.stringify(payload.images ?? []),
        JSON.stringify(payload.tools ?? []),
        JSON.stringify(payload.resource ?? {}),
        payload.owner_user_id ?? null,
        payload.author ?? null,
        payload.is_public ?? true,
        payload.status ?? "active",
      ],
    );
    return r.rows[0] as JsonObject;
  },

  async pluginUpdate(id: number, patch: JsonObject): Promise<JsonObject | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = $${i++}`);
      vals.push(v);
    };
    if ("name" in patch) add("name", patch.name);
    if ("description" in patch) add("description", patch.description);
    if ("version" in patch) add("version", patch.version);
    if ("images" in patch) add("images", JSON.stringify(patch.images ?? []));
    if ("tools" in patch) add("tools", JSON.stringify(patch.tools ?? []));
    if ("resource" in patch) add("resource", JSON.stringify(patch.resource ?? {}));
    if ("owner_user_id" in patch) add("owner_user_id", patch.owner_user_id);
    if ("author" in patch) add("author", patch.author);
    if ("is_public" in patch) add("is_public", patch.is_public);
    if ("status" in patch) add("status", patch.status);
    if ("deleted_at" in patch) add("deleted_at", patch.deleted_at);
    if (!sets.length) return this.pluginGetById(id, true);
    add("updated_at", new Date());
    vals.push(id);
    const r = await db.query(
      `UPDATE plugins SET ${sets.join(", ")} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`,
      vals,
    );
    return (r.rows[0] as JsonObject) ?? null;
  },

  async pluginSoftDelete(id: number): Promise<boolean> {
    const r = await db.query(
      `UPDATE plugins SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /**
   * Atomic optimistic-lock update for `agents.update()` (design doc §9.5.1,
   * v0.16 §9.5.1 atomicity note). Single `UPDATE ... WHERE anthropic_agent_version
   * = $expected RETURNING ...` — no separate SELECT-then-UPDATE, so concurrent
   * callers with a stale `expected` value cannot both succeed. Returns null on
   * version mismatch (caller maps that to HTTP 409) or missing/deleted row.
   */
  async pluginUpdateWithVersionCheck(
    id: number,
    expectedVersion: number,
    patch: JsonObject,
  ): Promise<JsonObject | null> {
    const sets: string[] = ["anthropic_agent_version = anthropic_agent_version + 1", "updated_at = NOW()"];
    const vals: unknown[] = [];
    let i = 1;
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = $${i++}`);
      vals.push(v);
    };
    if ("name" in patch) add("name", patch.name);
    if ("description" in patch) add("description", patch.description);
    if ("tools" in patch) add("tools", JSON.stringify(patch.tools ?? []));
    if ("resource" in patch) add("resource", JSON.stringify(patch.resource ?? {}));
    vals.push(id, expectedVersion);
    const r = await db.query(
      `UPDATE plugins SET ${sets.join(", ")}
       WHERE id = $${i++} AND anthropic_agent_version = $${i} AND deleted_at IS NULL
       RETURNING *`,
      vals,
    );
    return (r.rows[0] as JsonObject) ?? null;
  },

  async resourceGetById(id: number, includeDeleted = false): Promise<JsonObject | null> {
    const del = includeDeleted ? "" : " AND deleted_at IS NULL";
    const r = await db.query(`SELECT * FROM resources WHERE id = $1${del}`, [id]);
    return (r.rows[0] as JsonObject) ?? null;
  },

  /**
   * Latest live row of the given workload `type` (e.g. 'default', 'cpu', 'gpu').
   * Used by the API/event-consumer fallback chain to resolve the per-task
   * `image` and `resource` payload when neither the request body nor the
   * referenced plugin row supplies them. Operations are responsible for
   * provisioning at least one row with type='default'.
   */
  async resourceFirstByType(type: string): Promise<JsonObject | null> {
    const r = await db.query(
      `SELECT * FROM resources WHERE type = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [type],
    );
    return (r.rows[0] as JsonObject) ?? null;
  },

  async resourceInsert(payload: JsonObject): Promise<JsonObject> {
    // ``type`` is preserved for the default-resource fallback chain in
    // POST /v1/messages (resourceFirstByType('default')).
    const r = await db.query(
      `INSERT INTO resources (
        name, type, image, resource, owner_user_id, author
      ) VALUES ($1,$2,$3,$4::jsonb,$5,$6)
      RETURNING *`,
      [
        payload.name,
        payload.type ?? "",
        payload.image ?? "",
        JSON.stringify(payload.resource ?? {}),
        payload.owner_user_id ?? null,
        payload.author ?? null,
      ],
    );
    return r.rows[0] as JsonObject;
  },

  async resourceUpdate(id: number, patch: JsonObject): Promise<JsonObject | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = $${i++}`);
      vals.push(v);
    };
    if ("name" in patch) add("name", patch.name);
    if ("type" in patch) add("type", patch.type);
    if ("image" in patch) add("image", patch.image);
    if ("resource" in patch) add("resource", JSON.stringify(patch.resource ?? {}));
    if ("owner_user_id" in patch) add("owner_user_id", patch.owner_user_id);
    if ("author" in patch) add("author", patch.author);
    if ("deleted_at" in patch) add("deleted_at", patch.deleted_at);
    if ("archived_at" in patch) add("archived_at", patch.archived_at);
    if (!sets.length) return this.resourceGetById(id, true);
    add("updated_at", new Date());
    vals.push(id);
    const r = await db.query(
      `UPDATE resources SET ${sets.join(", ")} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`,
      vals,
    );
    return (r.rows[0] as JsonObject) ?? null;
  },

  async resourceSoftDelete(id: number): Promise<boolean> {
    const r = await db.query(
      `UPDATE resources SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return (r.rowCount ?? 0) > 0;
  },

  /**
   * List tools with visibility filters (subset of list_tools_repository).
   */
  async listToolsRepo(params: {
    toolType?: string;
    status?: string;
    owner?: string;
    tag?: string;
    viewerUserId?: string;
    isAdmin: boolean;
    includeDeleted: boolean;
    nameExact?: string;
    latestPerName: boolean;
    sortField: "created_at" | "updated_at";
    sortOrder: "asc" | "desc";
    offset: number;
    limit: number;
  }): Promise<{ rows: JsonObject[]; total: number }> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    const p = () => `$${i++}`;

    if (!params.includeDeleted) conds.push("deleted_at IS NULL");
    if (params.toolType) {
      conds.push(`type = ${p()}`);
      args.push(params.toolType);
    }
    if (params.status) {
      conds.push(`status = ${p()}`);
      args.push(params.status);
    }
    if (params.tag?.trim()) {
      conds.push(
        `EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) AS e WHERE strpos(lower(e), lower(${p()})) > 0)`,
      );
      args.push(params.tag.trim());
    }
    if (params.owner === "me" && params.viewerUserId) {
      conds.push(`owner_user_id = ${p()}`);
      args.push(params.viewerUserId);
    } else if (params.owner && params.owner !== "me") {
      conds.push(`owner_user_id = ${p()}`);
      args.push(params.owner);
    }
    if (!params.isAdmin) {
      const uid = params.viewerUserId || "";
      if (uid) {
        conds.push(`(is_public = true OR owner_user_id = ${p()})`);
        args.push(uid);
      } else {
        conds.push("is_public = true");
      }
    }
    if (params.nameExact) {
      conds.push(`name = ${p()}`);
      args.push(params.nameExact);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const sortCol = params.sortField === "updated_at" ? "updated_at" : "created_at";
    const ord = params.sortOrder === "asc" ? "ASC" : "DESC";

    const baseFrom = params.latestPerName
      ? `(SELECT DISTINCT ON (name) * FROM tools ${where} ORDER BY name, ${sortCol} DESC, id DESC) t`
      : `(SELECT * FROM tools ${where}) t`;

    const cnt = await db.query(`SELECT COUNT(*)::int AS c FROM ${baseFrom}`, args);
    const total = (cnt.rows[0] as { c: number }).c;

    const off = p();
    const lim = p();
    args.push(params.offset, params.limit);
    const data = await db.query(
      `SELECT * FROM ${baseFrom} ORDER BY ${sortCol} ${ord}, id ${ord} OFFSET ${off} LIMIT ${lim}`,
      args,
    );
    return { rows: data.rows as JsonObject[], total };
  },

  /** Keyword search on name and description (search_tools_keyword). */
  async searchToolsKeyword(
    qtext: string,
    params: {
      toolType?: string;
      limit: number;
      offset: number;
      viewerUserId?: string;
      isAdmin: boolean;
    },
  ): Promise<{ rows: JsonObject[]; total: number }> {
    const term = (qtext || "").trim();
    const conds: string[] = ["deleted_at IS NULL"];
    const args: unknown[] = [];
    let i = 1;
    const p = () => `$${i++}`;
    if (params.toolType) {
      conds.push(`type = ${p()}`);
      args.push(params.toolType);
    }
    if (!params.isAdmin) {
      const uid = params.viewerUserId || "";
      if (uid) {
        conds.push(`(is_public = true OR owner_user_id = ${p()})`);
        args.push(uid);
      } else {
        conds.push("is_public = true");
      }
    }
    if (term) {
      conds.push(
        `(name ILIKE ${p()} OR description ILIKE ${p()})`,
      );
      const like = `%${term}%`;
      args.push(like, like);
    }
    const where = `WHERE ${conds.join(" AND ")}`;
    const cnt = await db.query(
      `SELECT COUNT(*)::int AS c FROM tools ${where}`,
      args,
    );
    const total = (cnt.rows[0] as { c: number }).c;
    const off = p();
    const lim = p();
    args.push(params.offset, params.limit);
    const data = await db.query(
      `SELECT * FROM tools ${where} ORDER BY id DESC OFFSET ${off} LIMIT ${lim}`,
      args,
    );
    return { rows: data.rows as JsonObject[], total };
  },

  async listPluginsRepo(params: {
    status?: string;
    owner?: string;
    viewerUserId?: string;
    isAdmin: boolean;
    includeDeleted: boolean;
    nameExact?: string;
    nameContains?: string;
    latestPerName: boolean;
    sortField: "created_at" | "updated_at";
    sortOrder: "asc" | "desc";
    offset: number;
    limit: number;
  }): Promise<{ rows: JsonObject[]; total: number }> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    const p = () => `$${i++}`;
    if (!params.includeDeleted) conds.push("deleted_at IS NULL");
    if (params.status) {
      conds.push(`status = ${p()}`);
      args.push(params.status);
    }
    if (params.owner === "me" && params.viewerUserId) {
      conds.push(`owner_user_id = ${p()}`);
      args.push(params.viewerUserId);
    } else if (params.owner && params.owner !== "me") {
      conds.push(`owner_user_id = ${p()}`);
      args.push(params.owner);
    }
    if (!params.isAdmin) {
      const uid = params.viewerUserId || "";
      if (uid) {
        conds.push(`(is_public = true OR owner_user_id = ${p()})`);
        args.push(uid);
      } else conds.push("is_public = true");
    }
    if (params.nameExact?.trim()) {
      conds.push(`name = ${p()}`);
      args.push(params.nameExact.trim());
    } else if (params.nameContains?.trim()) {
      conds.push(`name ILIKE ${p()}`);
      args.push(`%${params.nameContains.trim()}%`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const sortCol = params.sortField === "updated_at" ? "updated_at" : "created_at";
    const ord = params.sortOrder === "asc" ? "ASC" : "DESC";
    const baseFrom = params.latestPerName
      ? `(SELECT DISTINCT ON (name) * FROM plugins ${where} ORDER BY name, ${sortCol} DESC, id DESC) t`
      : `(SELECT * FROM plugins ${where}) t`;
    const cnt = await db.query(`SELECT COUNT(*)::int AS c FROM ${baseFrom}`, args);
    const total = (cnt.rows[0] as { c: number }).c;
    const off = p();
    const lim = p();
    args.push(params.offset, params.limit);
    const data = await db.query(
      `SELECT * FROM ${baseFrom} ORDER BY ${sortCol} ${ord}, id ${ord} OFFSET ${off} LIMIT ${lim}`,
      args,
    );
    return { rows: data.rows as JsonObject[], total };
  },

  async listResourcesRepo(params: {
    includeDeleted: boolean;
    type?: string;
    excludeType?: string;
    ownerUserId?: string;
    isAdmin?: boolean;
    offset: number;
    limit: number;
  }): Promise<{ rows: JsonObject[]; total: number }> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    const p = () => `$${i++}`;
    if (!params.includeDeleted) conds.push("deleted_at IS NULL");
    if (params.type) {
      conds.push(`type = ${p()}`);
      args.push(params.type);
    } else if (params.excludeType) {
      // Default-exclude compat rows (e.g. Anthropic Environment views, type=
      // 'anthropic_env') from the native resource picker when no explicit
      // `type` was requested — see design doc §9.5.2/§12.
      conds.push(`type IS DISTINCT FROM ${p()}`);
      args.push(params.excludeType);
    }
    // Tenant isolation: when a non-admin viewer is supplied, restrict to rows
    // they own. Admins are exempt; callers that omit ownerUserId (e.g. the
    // native resource picker) are unaffected.
    if (params.ownerUserId && !params.isAdmin) {
      conds.push(`owner_user_id = ${p()}`);
      args.push(params.ownerUserId);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const cnt = await db.query(`SELECT COUNT(*)::int AS c FROM resources ${where}`, args);
    const total = (cnt.rows[0] as { c: number }).c;
    const off = p();
    const lim = p();
    args.push(params.offset, params.limit);
    const data = await db.query(
      `SELECT * FROM resources ${where} ORDER BY created_at DESC OFFSET ${off} LIMIT ${lim}`,
      args,
    );
    return { rows: data.rows as JsonObject[], total };
  },
};
