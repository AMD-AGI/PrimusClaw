// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Execute the drain, retry claim, and identity fences against PostgreSQL. */
import test, { before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { StringCodec } from "nats";
import { handsSessionKey } from "@claw/protocol";

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
      -- The attempt the row belongs to now. The drain projects it so the reader
      -- can tell a handle a previous attempt recorded from this one's.
      attempt_id TEXT,
      -- Settlement nulls attempt_id and moves the value here, and every row the
      -- drain sees is settled -- so this is the column the guard actually reads.
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
  hands = new Map();
  diagnostics = [];
  db.query = (async (sql: string, params: unknown[] = []) => {
    const r = await pg.query(sql, params);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  }) as typeof db.query;
  // Keyed by registry key, which is what the port is handed.
  platformBackfillPorts.readHandsKey = (async (key: string) => {
    const value = hands.get(key);
    return value ? { value: sc.encode(JSON.stringify(value)), operation: "PUT" } : null;
  }) as typeof platformBackfillPorts.readHandsKey;
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
  /** The attempt the row belongs to now; null once it has settled. */
  attemptId?: string | null;
  /** Where settlement moves it. Every row the drain sees has this, not the above. */
  settledAttemptId?: string | null;
  completedAgoMs?: number;
  retryDelayMs?: number;
  attempts?: number;
  resolved?: boolean;
  config?: Record<string, unknown>;
  origin?: string;
}

async function seed(id: string, reason: string, opts: SeedOptions = {}): Promise<void> {
  await pg.query("INSERT INTO claw_sessions VALUES ($1, $2::jsonb)", [id, JSON.stringify(
    opts.config ?? { _server_managed_credentials: true, platform_key: "stamped-key" },
  )]);
  const now = Date.now();
  await pg.query(
    `INSERT INTO claw_tasks (
       task_id, session_id, status, failure_reason, sandbox_workload_id, metadata, completed_at,
       platform_facts_next_retry_at, platform_facts_attempts, platform_facts_resolved_at, origin, created_at,
       attempt_id, settled_attempt_id
     ) VALUES ($1, $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $11, $10, $12, $13)`,
    [id, opts.status ?? "failed", reason,
      opts.handle === undefined ? `wl-${id}` : opts.handle,
      JSON.stringify(opts.metadata ?? {}),
      new Date(now - (opts.completedAgoMs ?? 60_000)),
      opts.retryDelayMs === undefined ? null : new Date(now + opts.retryDelayMs),
      opts.attempts ?? 0, opts.resolved ? new Date(now) : null, new Date(now - 300_000),
      opts.origin ?? "chat",
      opts.attemptId ?? null, opts.settledAttemptId ?? null],
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
  hands.set(handsSessionKey("pending-kv"), {
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
  hands.set(handsSessionKey("pinned"), {
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
  hands.set(handsSessionKey("pinned"), { workloadId: "wl-replacement", platformKey: "replacement-key", createdAt: new Date().toISOString() });
  await pg.exec("UPDATE claw_tasks SET platform_facts_next_retry_at = NOW() - INTERVAL '1 second'");
  assert.equal(await drainPendingPlatformFacts(), 0);
  assert.deepEqual(fetched, ["http://safe.test/api/v1/workloads/wl-original"]);
  assert.ok(diagnostics.some((d) => d.reason === "kv_handle_mismatch"));
  assert.equal((await row("pinned")).platform_facts_resolved_at, null);
});

test("the fallback cannot overwrite ownership that arrives after its KV read", async () => {
  await seed("race", "sandbox_workload_terminal", { handle: null });
  platformBackfillPorts.readHandsKey = (async () => {
    await pg.query(
      "UPDATE claw_tasks SET metadata = $1::jsonb, sandbox_workload_id = $2 WHERE task_id = 'race'",
      [JSON.stringify({ sandbox: { provider: "safe-workload", handle: "wl-authoritative" } }), "wl-authoritative"],
    );
    return { operation: "PUT", value: sc.encode(JSON.stringify({
      workloadId: "wl-stale", createdAt: new Date(Date.now() - 120_000).toISOString(),
    })) };
  }) as typeof platformBackfillPorts.readHandsKey;
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

test("rows that can never name a sandbox neither take the drain's cap nor cost a claim", async () => {
  // reapStaleTasks closes a whole batch of DAG nodes no worker ever claimed as
  // failed/brain_timeout. They hold no workload id and never will -- the row is
  // terminal, and resolveSandbox refuses a non-chat row without one anyway,
  // because a session's latest sandbox cannot establish one node's ownership.
  // Selected, each one spends a claim UPDATE, a diagnostic and one of the fifty
  // slots per tick until it falls out of the hour -- which is how sixty rows
  // that did name a SaFE workload got read zero times across an hour of ticks
  // and then aged out for good.
  for (let i = 0; i < 60; i++) {
    await seed(`node-${i}`, "brain_timeout", {
      handle: null, origin: "dag_node", completedAgoMs: 120_000,
    });
  }
  for (let i = 0; i < 5; i++) await seed(`held-${i}`, "worker_lost", { completedAgoMs: 60_000 });

  assert.equal(await drainPendingPlatformFacts(), 5);
  assert.deepEqual(
    fetched.map((url) => url.slice(url.lastIndexOf("/") + 1)).sort(),
    ["wl-held-0", "wl-held-1", "wl-held-2", "wl-held-3", "wl-held-4"],
    "the rows that name a workload are the ones asked about",
  );
  for (let i = 0; i < 5; i++) {
    assert.ok((await row(`held-${i}`)).platform_facts_resolved_at, `held-${i}`);
  }
  const untouched = await pg.query<{ attempts: number; retries: number }>(
    `SELECT sum(platform_facts_attempts)::int AS attempts,
            count(platform_facts_next_retry_at)::int AS retries
       FROM claw_tasks WHERE task_id LIKE 'node-%'`,
  );
  assert.deepEqual(untouched.rows[0], { attempts: 0, retries: 0 },
    "and the unattributable rows were never claimed or backed off");
  assert.deepEqual(diagnostics.filter((d) => d.reason === "kv_handle_run_unattributed"), []);
});

test("the eligibility clause keeps every row a read could still answer for", async () => {
  // The filter this replaces was `sandbox_workload_id IS NOT NULL`, which also
  // dropped the chat rows the KV fallback exists to recover. Each arm of the
  // replacement is asserted here so a future tightening cannot quietly lose one.
  await seed("dag-with-handle", "worker_lost", { origin: "dag_node" });
  await seed("agent-metadata-only", "sandbox_gone", {
    handle: null, origin: "dag_node",
    metadata: { sandbox: { provider: "agent-sandbox", handle: "agent-session" } },
  });
  await seed("chat-kv-only", "sandbox_workload_terminal", { handle: null, config: {} });
  hands.set(handsSessionKey("chat-kv-only"), {
    workloadId: "wl-from-kv", platformKey: "brain-key",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  });

  assert.equal(await drainPendingPlatformFacts(), 2);
  assert.deepEqual(
    fetched.map((url) => url.slice(url.lastIndexOf("/") + 1)).sort(),
    ["wl-dag-with-handle", "wl-from-kv"],
  );
  assert.ok((await row("dag-with-handle")).platform_facts_resolved_at);
  assert.equal((await row("chat-kv-only")).sandbox_workload_id, "wl-from-kv");
  // Still selected, still refused by the reader rather than by the SELECT: the
  // router has no termination facts, and that refusal is the one being asserted.
  assert.equal((await row("agent-metadata-only")).platform_facts_attempts, 1);
  assert.equal((await row("agent-metadata-only")).platform_facts_resolved_at, null);
  assert.ok(diagnostics.some((d) =>
    d.taskId === "agent-metadata-only" && d.reason === "termination_facts_unavailable"));
});

test("a handle another attempt recorded is not read for the attempt that replaced it", async () => {
  // The row outlives its attempts. Attempt A records its sandbox handle; the
  // delivery is redelivered, B takes the same row over, and A's handle stays on
  // it. Reading it attributes A's ending -- its node, its exit code, its
  // preemption -- to B's failure, which is the same adoption Brain refuses on
  // the KV side by comparing the attempt the pending entry names.
  //
  // Both halves have to be known for the refusal: a handle written before the
  // field existed carries no attempt, and refusing those would refuse every
  // handle the build being replaced wrote.
  await seed("cross-attempt", "worker_lost", {
    handle: null,
    attemptId: "attempt-B",
    metadata: {
      sandbox: { provider: "safe-workload", handle: "workload-of-attempt-A" },
      sandbox_attempt: "attempt-A",
    },
  });

  await drainPendingPlatformFacts();

  const closed = await row("cross-attempt");
  assert.equal(closed.platform_node, null,
    "no facts may be written from a handle this attempt did not record");
  assert.equal(closed.platform_facts_resolved_at, null,
    "and the row stays unresolved rather than being closed with another attempt's ending");
});

test("but its own attempt's handle is read as before", async () => {
  await seed("same-attempt", "worker_lost", {
    handle: null,
    attemptId: "attempt-B",
    metadata: {
      sandbox: { provider: "safe-workload", handle: "workload-of-attempt-B" },
      sandbox_attempt: "attempt-B",
    },
  });

  await drainPendingPlatformFacts();

  assert.notEqual((await row("same-attempt")).platform_facts_attempts, 0,
    "the drain still claims and reads a handle the row's own attempt recorded");
});

test("the guard fires on a settled row, which is the only kind this drain sees", async () => {
  // Twice now this guard shipped inert, and both times the gap was between the
  // value the writer produced and the value this reader could see. The first
  // time no writer wrote it. The second time the reader read `attempt_id`, and
  // settlement nulls that column and moves the value to `settled_attempt_id`
  // (tasks/run-claim.ts) -- while the drain selects `status = 'failed'`, so
  // every row it processes has already settled. The comparison had nothing on
  // one side for its entire population.
  //
  // So this fixture is a SETTLED row, the shape the drain really fetches.
  await seed("settled-cross-attempt", "worker_lost", {
    handle: null,
    attemptId: null,
    settledAttemptId: "attempt-B",
    metadata: {
      sandbox: { provider: "safe-workload", handle: "workload-of-attempt-A" },
      sandbox_attempt: "attempt-A",
    },
  });

  await drainPendingPlatformFacts();

  const closed = await row("settled-cross-attempt");
  assert.equal(closed.platform_node, null,
    "a handle another attempt recorded may not close this row, settled or not");
  assert.equal(closed.platform_facts_resolved_at, null);
});

test("and still reads a settled row's own handle", async () => {
  await seed("settled-same-attempt", "worker_lost", {
    handle: null,
    attemptId: null,
    settledAttemptId: "attempt-B",
    metadata: {
      sandbox: { provider: "safe-workload", handle: "workload-of-attempt-B" },
      sandbox_attempt: "attempt-B",
    },
  });

  await drainPendingPlatformFacts();

  assert.notEqual((await row("settled-same-attempt")).platform_facts_attempts, 0,
    "the guard must not refuse the row's own handle once it has settled");
});
