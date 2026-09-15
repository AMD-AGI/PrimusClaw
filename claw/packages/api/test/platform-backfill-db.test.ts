// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Execute the drain, retry claim, and identity fences against PostgreSQL. */
import test, { before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { StringCodec } from "nats";

process.env.SAFE_API_URL = "http://safe.test";
const { db } = await import("../src/infra/db.js");
const { backfillPlatformFacts, drainPendingPlatformFacts, platformBackfillPorts } =
  await import("../src/tasks/platform-backfill.js");

const originalQuery = db.query;
const originalFetch = globalThis.fetch;
const originalPorts = { ...platformBackfillPorts };
const sc = StringCodec();
let pg: PGlite;
let fetched: string[];
let hands: Map<string, Record<string, unknown>>;
let diagnostics: Array<Record<string, unknown>>;

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
  hands = new Map();
  diagnostics = [];
  db.query = (async (sql: string, params: unknown[] = []) => {
    const r = await pg.query(sql, params);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  }) as typeof db.query;
  platformBackfillPorts.readHandsEntry = (async (sessionId: string) => {
    const value = hands.get(sessionId);
    return value ? { value: sc.encode(JSON.stringify(value)), operation: "PUT" } : null;
  }) as typeof platformBackfillPorts.readHandsEntry;
  platformBackfillPorts.cannotRead = (fields) => { diagnostics.push(fields); };
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    return Response.json({
      phase: "Failed",
      pods: [{
        phase: "Failed", failedMessage: "Evicted, resource pressure", adminNodeName: "node-7",
        containers: [{ exitCode: 137, reason: "Error" }],
      }],
    });
  }) as typeof fetch;
});

afterEach(() => {
  db.query = originalQuery;
  globalThis.fetch = originalFetch;
  Object.assign(platformBackfillPorts, originalPorts);
});
after(async () => { await pg.close(); });

interface SeedOptions {
  status?: string;
  handle?: string | null;
  metadata?: Record<string, unknown>;
  completedAgoMs?: number;
  retryDelayMs?: number;
  attempts?: number;
  resolved?: boolean;
  config?: Record<string, unknown>;
}

async function seed(id: string, reason: string, opts: SeedOptions = {}): Promise<void> {
  await pg.query("INSERT INTO claw_sessions VALUES ($1, $2::jsonb)", [id, JSON.stringify(
    opts.config ?? { _server_managed_credentials: true, platform_key: "stamped-key" },
  )]);
  const now = Date.now();
  await pg.query(
    `INSERT INTO claw_tasks (
       task_id, session_id, status, failure_reason, sandbox_workload_id, metadata, completed_at,
       platform_facts_next_retry_at, platform_facts_attempts, platform_facts_resolved_at, origin, created_at
     ) VALUES ($1, $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 'chat', $10)`,
    [id, opts.status ?? "failed", reason,
      opts.handle === undefined ? `wl-${id}` : opts.handle,
      JSON.stringify(opts.metadata ?? {}),
      new Date(now - (opts.completedAgoMs ?? 60_000)),
      opts.retryDelayMs === undefined ? null : new Date(now + opts.retryDelayMs),
      opts.attempts ?? 0, opts.resolved ? new Date(now) : null, new Date(now - 300_000)],
  );
}

async function row(id: string): Promise<Record<string, unknown>> {
  const r = await pg.query("SELECT * FROM claw_tasks WHERE task_id = $1", [id]);
  return r.rows[0] as Record<string, unknown>;
}

test("the drain selects actual sandbox failures, including KV-only rows, and excludes unrelated endings", async () => {
  const reasons = [
    "brain_timeout", "worker_lost", "sandbox_workload_terminal", "sandbox_pending_timeout",
    "sandbox_timed_out", "sandbox_exited_before_ready", "sandbox_gone", "sandbox_status_unreadable",
    "sandbox_health_failed", "sandbox_bootstrap_failed",
  ];
  for (const reason of reasons) await seed(reason, reason);
  await seed("pending-kv", "sandbox_workload_terminal", { handle: null, config: {} });
  hands.set("pending-kv", {
    status: "pending", workloadId: "wl-pending", platformKey: "brain-key",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  });
  for (const reason of ["agent_error", "dispatch_failed", "session_deleted"]) await seed(reason, reason);
  await seed("running", "worker_lost", { status: "running" });
  await seed("cancelled", "worker_lost", { status: "cancelled" });
  await seed("old", "worker_lost", { completedAgoMs: 7_200_000 });
  await seed("resolved", "worker_lost", { resolved: true });
  await seed("backoff", "worker_lost", { retryDelayMs: 60_000, attempts: 1 });
  await seed("agent", "worker_lost", {
    handle: null, metadata: { sandbox: { provider: "agent-sandbox", handle: "agent-session" } },
  });

  assert.equal(await drainPendingPlatformFacts(), 11);
  assert.equal(fetched.length, 11);
  for (const id of [...reasons, "pending-kv"]) {
    const actual = await row(id);
    assert.equal(actual.platform_facts_attempts, 1, id);
    assert.equal(actual.platform_message, "Evicted, resource pressure", id);
    assert.ok(actual.platform_facts_resolved_at, id);
    assert.equal(actual.platform_facts_next_retry_at, null, id);
  }
  const pending = await row("pending-kv");
  assert.equal(pending.sandbox_workload_id, "wl-pending");
  assert.deepEqual(pending.metadata, { sandbox: { provider: "safe-workload", handle: "wl-pending" } });
  for (const id of ["agent_error", "dispatch_failed", "session_deleted", "running", "cancelled", "old", "resolved"]) {
    assert.equal((await row(id)).platform_facts_attempts, 0, id);
  }
  assert.equal((await row("backoff")).platform_facts_attempts, 1);
  assert.equal((await row("agent")).platform_facts_attempts, 1);
  assert.equal((await row("agent")).platform_facts_resolved_at, null);
  assert.ok(diagnostics.some((d) => d.taskId === "agent" && d.reason === "termination_facts_unavailable"));
});

test("concurrent claims fetch once and transient failures obey exponential backoff", async () => {
  await seed("retry", "worker_lost");
  globalThis.fetch = (async (url) => {
    fetched.push(String(url));
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  const offered = [{ task_id: "retry", session_id: "retry" }];
  assert.deepEqual(await Promise.all([backfillPlatformFacts(offered), backfillPlatformFacts(offered)]), [0, 0]);
  assert.equal(fetched.length, 1);
  let actual = await row("retry");
  assert.equal(actual.platform_facts_attempts, 1);
  assert.equal(actual.platform_facts_resolved_at, null);
  let delay = new Date(actual.platform_facts_next_retry_at as string).getTime() - Date.now();
  assert.ok(delay > 55_000 && delay <= 60_000, String(delay));
  assert.equal(await backfillPlatformFacts(offered), 0);
  assert.equal(fetched.length, 1, "a pending retry cannot refetch");

  await pg.exec("UPDATE claw_tasks SET platform_facts_next_retry_at = NOW() - INTERVAL '1 second'");
  assert.equal(await backfillPlatformFacts(offered), 0);
  actual = await row("retry");
  assert.equal(actual.platform_facts_attempts, 2);
  delay = new Date(actual.platform_facts_next_retry_at as string).getTime() - Date.now();
  assert.ok(delay > 115_000 && delay <= 120_000, String(delay));
});

test("a retry keeps the pinned handle when the session KV moves to a replacement", async () => {
  await seed("pinned", "sandbox_workload_terminal", { handle: null, config: {}, metadata: { other: "kept" } });
  hands.set("pinned", {
    workloadId: "wl-original", platformKey: "original-key",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  });
  globalThis.fetch = (async (url) => {
    fetched.push(String(url));
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  assert.equal(await drainPendingPlatformFacts(), 0);
  assert.deepEqual((await row("pinned")).metadata, {
    other: "kept", sandbox: { provider: "safe-workload", handle: "wl-original" },
  });
  hands.set("pinned", { workloadId: "wl-replacement", platformKey: "replacement-key", createdAt: new Date().toISOString() });
  await pg.exec("UPDATE claw_tasks SET platform_facts_next_retry_at = NOW() - INTERVAL '1 second'");
  assert.equal(await drainPendingPlatformFacts(), 0);
  assert.deepEqual(fetched, ["http://safe.test/api/v1/workloads/wl-original"]);
  assert.ok(diagnostics.some((d) => d.reason === "kv_handle_mismatch"));
  assert.equal((await row("pinned")).platform_facts_resolved_at, null);
});

test("the fallback cannot overwrite ownership that arrives after its KV read", async () => {
  await seed("race", "sandbox_workload_terminal", { handle: null });
  platformBackfillPorts.readHandsEntry = (async () => {
    await pg.query(
      "UPDATE claw_tasks SET metadata = $1::jsonb, sandbox_workload_id = $2 WHERE task_id = 'race'",
      [JSON.stringify({ sandbox: { provider: "safe-workload", handle: "wl-authoritative" } }), "wl-authoritative"],
    );
    return { operation: "PUT", value: sc.encode(JSON.stringify({
      workloadId: "wl-stale", createdAt: new Date(Date.now() - 120_000).toISOString(),
    })) };
  }) as typeof platformBackfillPorts.readHandsEntry;
  assert.equal(await drainPendingPlatformFacts(), 0);
  assert.deepEqual(fetched, []);
  assert.equal((await row("race")).sandbox_workload_id, "wl-authoritative");
  assert.ok(diagnostics.some((d) => d.reason === "sandbox_ownership_changed"));
});

test("the drain's cap makes progress on both new rows and old eligible retries", async () => {
  for (let i = 0; i < 30; i++) {
    await seed(`new-${i}`, "worker_lost");
    await seed(`retry-${i}`, "worker_lost", { retryDelayMs: -60_000, attempts: 1 });
  }
  assert.equal(await drainPendingPlatformFacts(), 50);
  const counts = await pg.query<{ lane: string; resolved: number }>(
    `SELECT split_part(task_id, '-', 1) AS lane,
            count(*) FILTER (WHERE platform_facts_resolved_at IS NOT NULL)::int AS resolved
       FROM claw_tasks GROUP BY lane ORDER BY lane`,
  );
  assert.deepEqual(counts.rows, [{ lane: "new", resolved: 25 }, { lane: "retry", resolved: 25 }]);
  assert.equal(await drainPendingPlatformFacts(), 10);
  assert.equal(fetched.length, 60);
});
