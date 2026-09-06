// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Two real connections over a schema the production `initDb` built.
 *
 * `scenario-harness.ts` has one PGlite connection and a hand-copied DDL subset,
 * so it can prove which rows a predicate matches and nothing at all about two
 * transactions racing. Everything here exists for the cases it cannot reach:
 * the schema and the uniqueness index are whatever `initDb` produces, and the
 * claim statement under test is the production one, reached by handing
 * `claimRunById` the client that opened the transaction.
 *
 * The application modules are imported dynamically, after `DB_SCHEMA` is set:
 * `db.ts` reads it once at module load to point its pools at the schema, and a
 * static import would run that before this file could choose one.
 */

import type pg from "pg";

import { startPgCluster } from "./support/pg-cluster.js";

type App = {
  initDb: () => Promise<void>;
  assertChatTurnClaimIndex: (q: pg.Client) => Promise<void>;
  chatTurnClaimIndex: string;
  claimFenceLockId: number;
  claimRunById: (
    taskId: string, brainId: string, semantics: number, q: pg.Client,
  ) => Promise<unknown>;
  endPools: () => Promise<void>;
};

export interface SeedTurn {
  taskId: string;
  sessionId: string;
  messageId: string;
  status?: "queued" | "preparing" | "running" | "cancelling";
  claimCount?: number;
  leaseOwner?: string | null;
  ageSeconds?: number;
}

/** What a claim did, with the unique violation folded into the verdict. */
export interface ClaimOutcome {
  verdict: "claimed" | "busy" | "missing" | "unclaimable" | "exhausted";
  /**
   * True when the `23505` surfaced as a thrown error instead of a verdict.
   * The row outcome is identical either way; the difference is whether the
   * claim route can answer `409` or has to answer `500`.
   */
  raisedUniqueViolation: boolean;
}

export interface ConcurrencyHarness {
  app: App;
  a: pg.Client;
  b: pg.Client;
  observer: pg.Client;
  seed(turn: SeedTurn): Promise<void>;
  claim(client: pg.Client, taskId: string, brainId: string): Promise<ClaimOutcome>;
  /** Whether the backend behind `client` is parked on a lock right now. */
  waitingOnLock(client: pg.Client, timeoutMs?: number): Promise<boolean>;
  /** The same question for a backend found some other way, such as the pool's. */
  waitingOnPid(pid: number, timeoutMs?: number): Promise<boolean>;
  /** The pid of the backend waiting on the claim fence, once one is. */
  fenceWaiterPid(timeoutMs?: number): Promise<number>;
  taskRow(taskId: string): Promise<Record<string, unknown>>;
  indexIsValid(): Promise<boolean | null>;
  dropClaimIndex(): Promise<void>;
  /**
   * Leave the index in the state a killed `CREATE INDEX CONCURRENTLY` leaves:
   * present, so `IF NOT EXISTS` would skip it for ever, and enforcing nothing.
   * Written to the catalogue rather than produced by killing a real build,
   * because the state has to be reached deterministically.
   */
  invalidateClaimIndex(): Promise<void>;
  clearTasks(): Promise<void>;
  stop(): Promise<void>;
}

const BACKEND_PID = "SELECT pg_backend_pid() AS pid";

export async function startConcurrencyHarness(): Promise<ConcurrencyHarness> {
  const cluster = await startPgCluster();
  process.env.DB_SCHEMA = cluster.schema;
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

  let started: App | undefined;
  let app: App;
  let a: pg.Client;
  let b: pg.Client;
  let observer: pg.Client;
  const pids = new Map<pg.Client, number>();
  try {
    app = started = await loadApp();
    await app.initDb();
    a = await cluster.connect();
    b = await cluster.connect();
    observer = await cluster.connect();
    for (const client of [a, b, observer]) {
      const r = await client.query<{ pid: number }>(BACKEND_PID);
      pids.set(client, r.rows[0].pid);
    }
  } catch (err) {
    // Open pools and a leftover schema outlive a failed start, and node:test
    // then waits on them instead of reporting why the suite could not begin.
    await started?.endPools().catch(() => {});
    await cluster.end().catch(() => {});
    throw err;
  }

  return {
    app, a, b, observer,
    seed: (turn) => seedTurn(observer, turn),
    claim: (client, taskId, brainId) => claim(app, client, taskId, brainId),
    waitingOnLock: (client, timeoutMs = 5000) =>
      waitingOnLock(observer, pids.get(client)!, timeoutMs),
    waitingOnPid: (pid, timeoutMs = 5000) => waitingOnLock(observer, pid, timeoutMs),
    fenceWaiterPid: (timeoutMs = 10_000) => fenceWaiterPid(observer, timeoutMs),
    async taskRow(taskId) {
      const r = await observer.query(`SELECT * FROM claw_tasks WHERE task_id = $1`, [taskId]);
      if (!r.rowCount) throw new Error(`no claw_tasks row ${taskId}`);
      return r.rows[0] as Record<string, unknown>;
    },
    async indexIsValid() {
      const r = await observer.query<{ indisvalid: boolean }>(
        `SELECT i.indisvalid FROM pg_class c
           JOIN pg_index i ON i.indexrelid = c.oid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = $1 AND n.nspname = $2`,
        [app.chatTurnClaimIndex, cluster.schema],
      );
      return r.rowCount ? r.rows[0].indisvalid : null;
    },
    async dropClaimIndex() {
      await observer.query(`DROP INDEX IF EXISTS "${app.chatTurnClaimIndex}"`);
    },
    async invalidateClaimIndex() {
      const r = await observer.query(
        `UPDATE pg_index SET indisvalid = false
          WHERE indexrelid = ($1 || '.' || $2)::regclass`,
        [cluster.schema, app.chatTurnClaimIndex],
      );
      if (!r.rowCount) throw new Error("could not mark the claim index invalid");
    },
    async clearTasks() {
      await observer.query("TRUNCATE claw_tasks");
    },
    async stop() {
      await app.endPools();
      await cluster.end();
    },
  };
}

async function loadApp(): Promise<App> {
  const db = await import("../src/infra/db.js");
  const runClaim = await import("../src/tasks/run-claim.js");
  const { initUserEnvCrypto } = await import("../src/crypto/user-env.js");
  initUserEnvCrypto();
  // The rebuilt history is a read against a table this harness never fills, and
  // it is not what any of these cases are about.
  runClaim.runClaimPorts.buildHistory = async () => [];
  return {
    initDb: db.initDb,
    assertChatTurnClaimIndex: db.assertChatTurnClaimIndex,
    chatTurnClaimIndex: db.CHAT_TURN_CLAIM_INDEX,
    claimFenceLockId: db.RUN_CLAIM_FENCE_LOCK_ID,
    claimRunById: runClaim.claimRunById as App["claimRunById"],
    endPools: async () => {
      await db.db.pool.end();
      await db.db.lockPool.end();
    },
  };
}

async function seedTurn(client: pg.Client, turn: SeedTurn): Promise<void> {
  const { sealRunCredentials } = await import("../src/tasks/run-secrets.js");
  const input = {
    prompt: "hello",
    credentials: sealRunCredentials({ llm_api_key: "sk-test", platform_key: "pk-test" }),
  };
  await client.query(
    `INSERT INTO claw_tasks (
       task_id, session_id, name, status, origin, executor, prompt, input, metadata,
       claim_count, lease_owner, created_at, queued_at
     ) VALUES (
       $1, $2, 'chat turn', $3, 'chat', 'brain', 'hello', $4::jsonb,
       jsonb_build_object('dispatch', 'doorbell', 'message_id', $5::text, 'doorbell_semantics', 1),
       $6, $7, NOW() - ($8::int * INTERVAL '1 second'), NOW()
     )`,
    [
      turn.taskId, turn.sessionId, turn.status ?? "queued", JSON.stringify(input),
      turn.messageId, turn.claimCount ?? 0, turn.leaseOwner ?? null, turn.ageSeconds ?? 0,
    ],
  );
}

async function claim(
  app: App, client: pg.Client, taskId: string, brainId: string,
): Promise<ClaimOutcome> {
  try {
    const result = await app.claimRunById(taskId, brainId, 1, client);
    if (typeof result === "string") return { verdict: result as ClaimOutcome["verdict"], raisedUniqueViolation: false };
    if (result && (result as { kind?: string }).kind === "exhausted") {
      return { verdict: "exhausted", raisedUniqueViolation: false };
    }
    return { verdict: "claimed", raisedUniqueViolation: false };
  } catch (err) {
    if ((err as { code?: string })?.code !== "23505") throw err;
    return { verdict: "busy", raisedUniqueViolation: true };
  }
}

async function fenceWaiterPid(observer: pg.Client, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`,
    );
    if (r.rowCount) return r.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no backend is waiting on the claim fence");
}

async function waitingOnLock(
  observer: pg.Client, pid: number, timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await observer.query<{ waiting: boolean }>(
      `SELECT state = 'active' AND wait_event_type = 'Lock' AS waiting
         FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (r.rowCount && r.rows[0].waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
