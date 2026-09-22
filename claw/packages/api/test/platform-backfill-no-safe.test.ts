// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The backfill on a deployment that has no SaFE to ask.
 *
 * Its own header calls it best-effort and inert without SAFE_API_URL, and this
 * is the only file that can hold it to that: config.ts reads the environment
 * once at module scope, so a suite that sets the variable -- every other
 * platform-backfill suite does -- can never observe the unset branch. Kept in
 * its own process for that reason, and the variable is deleted rather than
 * merely left alone so an ambient one in CI cannot make these assertions
 * vacuous in the other direction.
 */
import test, { before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

delete process.env.SAFE_API_URL;
const { SAFE_API_URL } = await import("../src/config.js");
const { db } = await import("../src/infra/db.js");
const { backfillPlatformFacts, drainPendingPlatformFacts, platformBackfillPorts } =
  await import("../src/tasks/platform-backfill.js");

const originalQuery = db.query;
const originalFetch = globalThis.fetch;
const originalPorts = { ...platformBackfillPorts };
let pg: PGlite;
let fetched: string[];
let selects: number;

before(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TABLE claw_sessions (session_id TEXT PRIMARY KEY, config JSONB);
    CREATE TABLE claw_tasks (
      task_id TEXT PRIMARY KEY,
      session_id TEXT,
      status TEXT NOT NULL,
      failure_reason TEXT,
      origin TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      sandbox_workload_id TEXT,
      -- The attempt the row belongs to now. The drain projects it so the reader
      -- can tell a handle a previous attempt recorded from this one's.
      attempt_id TEXT,
      settled_attempt_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      platform_message TEXT,
      platform_node TEXT,
      platform_container_reason TEXT,
      platform_exit_code INT,
      platform_facts_attempts INT NOT NULL DEFAULT 0,
      platform_facts_next_retry_at TIMESTAMPTZ,
      platform_facts_resolved_at TIMESTAMPTZ
    );
  `);
});

beforeEach(async () => {
  await pg.exec("TRUNCATE claw_tasks, claw_sessions");
  fetched = [];
  selects = 0;
  db.query = (async (sql: string, params: unknown[] = []) => {
    if (/WITH eligible AS/.test(sql)) selects++;
    const r = await pg.query(sql, params);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  }) as typeof db.query;
  platformBackfillPorts.cannotRead = () => { /* counted through the row below */ };
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    throw new Error("a deployment without SaFE has no endpoint to reach");
  }) as typeof fetch;
});

afterEach(() => {
  db.query = originalQuery;
  globalThis.fetch = originalFetch;
  Object.assign(platformBackfillPorts, originalPorts);
});
after(async () => { await pg.close(); });

async function seedTerminal(id: string): Promise<void> {
  await pg.query("INSERT INTO claw_sessions VALUES ($1, $2::jsonb)",
    [id, JSON.stringify({ _server_managed_credentials: true, platform_key: "stamped-key" })]);
  await pg.query(
    `INSERT INTO claw_tasks (task_id, session_id, status, failure_reason, origin,
       sandbox_workload_id, completed_at, created_at)
     VALUES ($1, $1, 'failed', 'worker_lost', 'chat', $2, $3, $4)`,
    [id, `wl-${id}`, new Date(Date.now() - 60_000), new Date(Date.now() - 300_000)],
  );
}

async function row(id: string): Promise<Record<string, unknown>> {
  const r = await pg.query("SELECT * FROM claw_tasks WHERE task_id = $1", [id]);
  return r.rows[0] as Record<string, unknown>;
}

test("the module is inert, not merely unsuccessful, without SAFE_API_URL", async () => {
  // Without the guard the drain still selects the row and still claims it: the
  // attempt count goes up and the retry is deferred by up to RETRY_MAX_SEC on
  // every tick, and the only thing the writes record is that a read nobody
  // could have made was tried. The row itself is what proves which happened.
  assert.equal(SAFE_API_URL, "", "this suite is meaningless with SaFE configured");
  await seedTerminal("no-safe");

  assert.equal(await drainPendingPlatformFacts(), 0);
  assert.equal(selects, 1, "the drain did run and had this row to offer");
  const after = await row("no-safe");
  assert.equal(after.platform_facts_attempts, 0, "no claim was spent");
  assert.equal(after.platform_facts_next_retry_at, null, "and no retry was deferred");
  assert.equal(after.platform_facts_resolved_at, null, "the row keeps its honest unknown");
  assert.deepEqual(fetched, []);
});

test("a sweeper offer costs nothing either", async () => {
  await seedTerminal("offered");
  assert.equal(await backfillPlatformFacts([
    { task_id: "offered", session_id: "offered", sandbox_workload_id: "wl-offered" },
  ]), 0);
  const after = await row("offered");
  assert.equal(after.platform_facts_attempts, 0);
  assert.equal(after.platform_facts_next_retry_at, null);
  assert.deepEqual(fetched, []);
});
