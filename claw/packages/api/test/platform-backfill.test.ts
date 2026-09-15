// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Terminal platform reads, credential provenance, and sandbox identity fencing. */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";

// Set before the first import of config.ts, which reads the environment once at
// module scope. With it unset the backfill is inert by design -- a deployment
// with no SaFE has nothing to ask -- which would make every assertion below pass
// vacuously.
process.env.SAFE_API_URL = "http://safe.test";

const { db } = await import("../src/infra/db.js");
const { backfillPlatformFacts, platformBackfillPorts } = await import("../src/tasks/platform-backfill.js");
const { reapLostLeases } = await import("../src/tasks/sweeper.js");

const originalQuery = db.query;
const originalFetch = globalThis.fetch;
const originalPorts = { ...platformBackfillPorts };
const sc = StringCodec();
afterEach(() => {
  db.query = originalQuery;
  globalThis.fetch = originalFetch;
  Object.assign(platformBackfillPorts, originalPorts);
});

const DETAIL = {
  phase: "Failed",
  pods: [{
    phase: "Failed",
    failedMessage: "Preempted, the pod was preempted by a higher priority pod",
    adminNodeName: "gpu-node-7",
    endTime: "2026-09-01T10:00:00Z",
    containers: [{ exitCode: 137, reason: "OOMKilled" }],
  }],
};

interface Harness {
  queries: string[];
  updates: unknown[][];
  fetched: string[];
  authorization: string[];
  kvReads: string[];
  handles: unknown[][];
  diagnostics: Array<Record<string, unknown>>;
}

interface HarnessOptions {
  claimed?: Array<Record<string, unknown>>;
  drainRows?: Array<Record<string, unknown>>;
  updated?: number;
  status?: number;
  throws?: boolean;
  detail?: Record<string, unknown>;
  config?: Record<string, unknown>;
  lostLease?: boolean;
  hands?: Record<string, unknown> | null;
  kvError?: boolean;
  kvRaw?: string;
  kvOperation?: "PUT" | "DEL" | "PURGE";
  handleUpdated?: number;
}

function harness(opts: HarnessOptions = {}): Harness {
  const h: Harness = {
    queries: [], updates: [], fetched: [], authorization: [],
    kvReads: [], handles: [], diagnostics: [],
  };
  platformBackfillPorts.readHandsEntry = (async (sessionId: string) => {
    h.kvReads.push(sessionId);
    if (opts.kvError) throw new Error("KV unavailable");
    if (!opts.hands && opts.kvRaw === undefined) return null;
    return {
      value: sc.encode(opts.kvRaw ?? JSON.stringify(opts.hands)),
      operation: opts.kvOperation ?? "PUT",
    };
  }) as typeof platformBackfillPorts.readHandsEntry;
  platformBackfillPorts.cannotRead = (fields) => { h.diagnostics.push(fields); };
  db.query = (async (text: string, params: unknown[] = []) => {
    h.queries.push(text);
    if (opts.lostLease && /lease_expires_at IS NOT NULL/.test(text)) {
      return {
        rows: [{
          task_id: "ktsk_lost",
          session_id: "s1",
          origin: "dag_node",
          lease_owner: "brain-1",
          message_id: null,
          sandbox_workload_id: "wl-lost",
        }],
        rowCount: 1,
      };
    }
    if (/SET platform_facts_attempts/.test(text)) {
      const rows = opts.claimed?.filter((row) => row.task_id === params[0]) ?? [];
      return { rows, rowCount: rows.length };
    }
    if (/jsonb_build_object\('sandbox'/.test(text)) {
      h.handles.push(params);
      return { rows: [], rowCount: opts.handleUpdated ?? 1 };
    }
    if (/SELECT task_id, session_id, sandbox_workload_id/.test(text)) {
      const rows = opts.drainRows ?? [];
      return { rows, rowCount: rows.length };
    }
    if (/FROM claw_sessions/.test(text)) {
      return {
        rows: [{
          config: opts.config ?? {
            platform_key: "pk-1",
            _server_managed_credentials: true,
          },
        }],
        rowCount: 1,
      };
    }
    if (/UPDATE claw_tasks/.test(text)) {
      h.updates.push(params);
      return { rows: [], rowCount: opts.updated ?? 1 };
    }
    throw new Error(`unexpected query: ${text}`);
  }) as typeof db.query;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    h.fetched.push(String(url));
    h.authorization.push(new Headers(init?.headers).get("Authorization") ?? "");
    if (opts.throws) throw new Error("connection refused");
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => opts.detail ?? DETAIL,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return h;
}

test("R1 a swept row with a workload gains the platform's account", async () => {
  const h = harness({
    claimed: [{ task_id: "ktsk_1", session_id: "s1", sandbox_workload_id: "wl-1" }],
  });
  const n = await backfillPlatformFacts([
    { task_id: "ktsk_1", session_id: "s1", sandbox_workload_id: "wl-1" },
  ]);
  assert.equal(n, 1);
  assert.equal(h.fetched.length, 1);
  assert.match(h.fetched[0], /\/api\/v1\/workloads\/wl-1$/);
  assert.deepEqual(h.updates[0], [
    "ktsk_1",
    "Preempted, the pod was preempted by a higher priority pod",
    "gpu-node-7",
    "OOMKilled",
    137,
  ]);
});

test("R2 a row already carrying facts is not overwritten", async () => {
  // A late callback from a Brain that survived may land between the sweep and
  // this read. The resolving UPDATE remains conditional and preserves existing
  // raw fields with COALESCE.
  const h = harness({
    claimed: [{ task_id: "ktsk_2", session_id: "s1", sandbox_workload_id: "wl-2" }],
    updated: 0,
  });
  const n = await backfillPlatformFacts([
    { task_id: "ktsk_2", session_id: "s1", sandbox_workload_id: "wl-2" },
  ]);
  assert.equal(n, 0, "nothing recorded when the guard refused the row");
  assert.equal(h.updates.length, 1, "and it was the database that refused, not us");
});

test("R3 rows with no sandbox are not asked about", async () => {
  const rows = [
    { task_id: "ktsk_3", session_id: "s1", origin: "chat", sandbox_workload_id: null },
    { task_id: "ktsk_4", session_id: "s1", origin: "chat" },
  ];
  const h = harness({ claimed: rows });
  const n = await backfillPlatformFacts(rows);
  assert.equal(n, 0);
  assert.equal(h.fetched.length, 0, "no SaFE call for a run that never had a sandbox");
  assert.equal(h.kvReads.length, 2, "missing row handles are offered to the KV fallback");
  assert.equal(h.diagnostics.filter((d) => d.reason === "missing_sandbox_handle").length, 2);
});

test("R4 a SaFE that is down does not fail the sweep", async () => {
  // The rows are already closed by the time this runs. Whatever happens here,
  // the close stands.
  harness({
    claimed: [{ task_id: "ktsk_5", session_id: "s1", sandbox_workload_id: "wl-5" }],
    throws: true,
  });
  assert.equal(
    await backfillPlatformFacts([
      { task_id: "ktsk_5", session_id: "s1", sandbox_workload_id: "wl-5" },
    ]),
    0,
  );
  harness({
    claimed: [{ task_id: "ktsk_6", session_id: "s1", sandbox_workload_id: "wl-6" }],
    status: 500,
  });
  assert.equal(
    await backfillPlatformFacts([
      { task_id: "ktsk_6", session_id: "s1", sandbox_workload_id: "wl-6" },
    ]),
    0,
  );
});

test("R5 a lost lease backfills the platform account of the dead worker", async () => {
  const h = harness({
    lostLease: true,
    claimed: [{
      task_id: "ktsk_lost",
      session_id: "s1",
      sandbox_workload_id: "wl-lost",
    }],
  });

  assert.equal(await reapLostLeases(), 1);
  assert.deepEqual(h.fetched, ["http://safe.test/api/v1/workloads/wl-lost"]);
  assert.equal(h.updates.length, 1, "the platform facts were not written to the reaped row");
});

// ── The drain: what the per-sweep cap defers ─────────────────────────────────
//
// Swept rows are already terminal, so the sweeper's UPDATE cannot select them
// again. Before the drain existed, anything over the cap was dropped in memory
// and revisited by nothing. It was pinned only by a test that grepped the
// source for the function's name -- which proves it exists, not that it selects
// the right rows. These drive it.

const { drainPendingPlatformFacts } = await import("../src/tasks/platform-backfill.js");

/** Captures the SELECT the drain issues, and hands back rows for it. */
function drainHarness(rows: Array<Record<string, unknown>>) {
  return harness({ drainRows: rows, claimed: rows });
}

test("R6 the drain offers liveness and sandbox failures without requiring a row handle", async () => {
  const h = drainHarness([]);
  await drainPendingPlatformFacts();
  const sel = h.queries.find((t) => /SELECT/i.test(t) && /FROM claw_tasks/.test(t));
  assert.ok(sel, "the drain must issue a select");
  assert.match(sel!, /status = 'failed'/);
  for (const reason of [
    "brain_timeout", "worker_lost", "sandbox_workload_terminal", "sandbox_pending_timeout",
    "sandbox_timed_out", "sandbox_exited_before_ready", "sandbox_gone", "sandbox_status_unreadable",
    "sandbox_health_failed", "sandbox_bootstrap_failed",
  ]) assert.ok(sel!.includes(`'${reason}'`), `missing ${reason}`);
  for (const reason of ["agent_error", "dispatch_failed", "session_deleted"]) {
    assert.ok(!sel!.includes(`'${reason}'`), `unrelated ${reason} must stay out`);
  }
  assert.doesNotMatch(sel!, /sandbox_workload_id IS NOT NULL|sandbox_workload_id <> ''/);
  assert.match(sel!, /platform_facts_resolved_at IS NULL/, "not already resolved");
  assert.match(sel!, /platform_facts_next_retry_at/, "failed reads have a retry gate");
  assert.match(sel!, /LIMIT/, "and bounded, since this runs inside a sweeper tick");
});

test("R7 the drain fairly interleaves new rows and eligible retries", async () => {
  // A permanently failing lane must not starve new platform facts, and a
  // sustained stream of new rows must not starve retries until their pods are
  // garbage-collected.
  const h = drainHarness([]);
  await drainPendingPlatformFacts();
  const sel = h.queries.find((t) => /SELECT/i.test(t) && /FROM claw_tasks/.test(t))!;
  assert.match(sel, /PARTITION BY \(platform_facts_next_retry_at IS NOT NULL\)/);
  assert.match(sel, /ORDER BY lane_position ASC, retried ASC/);
});

test("R8 a drained row is actually asked about and recorded", async () => {
  const h = drainHarness([
    { task_id: "t-drained", session_id: "s-1", sandbox_workload_id: "wl-drained" },
  ]);
  const n = await drainPendingPlatformFacts();
  assert.equal(n, 1, "the row gains facts");
  assert.ok(h.queries.some((t) => /UPDATE claw_tasks/.test(t)), "and they are written");
});

test("R9 an empty backlog costs nothing", async () => {
  const h = drainHarness([]);
  assert.equal(await drainPendingPlatformFacts(), 0);
  assert.equal(h.queries.filter((t) => /FROM claw_sessions/.test(t)).length, 0,
    "no key lookups, no SaFE calls");
});

test("R10 an empty platform message is still recorded as a resolved read", async () => {
  const h = harness({
    claimed: [{ task_id: "t-empty", session_id: "s-1", sandbox_workload_id: "wl-empty" }],
    detail: {
      phase: "Succeeded",
      pods: [{
        phase: "Succeeded",
        failedMessage: "",
        adminNodeName: "node-1",
        containers: [{ exitCode: 0 }],
      }],
    },
  });

  assert.equal(await backfillPlatformFacts([
    { task_id: "t-empty", session_id: "s-1", sandbox_workload_id: "wl-empty" },
  ]), 1);
  assert.equal(h.updates[0]?.[1], "", "empty content must not mean unread");
  assert.ok(
    h.queries.some((query) => /platform_facts_resolved_at = NOW\(\)/.test(query)),
    "the row would be selected again on every tick",
  );
});

test("R11 untrusted session config is never used as a bearer token", async () => {
  const h = harness({
    claimed: [{ task_id: "t-forged", session_id: "s-1", sandbox_workload_id: "wl-forged" }],
    config: { platform_key: "pk-caller-supplied" },
  });

  assert.equal(await backfillPlatformFacts([
    { task_id: "t-forged", session_id: "s-1", sandbox_workload_id: "wl-forged" },
  ]), 0);
  assert.deepEqual(h.fetched, []);
});

test("R12 a definitive missing workload resolves without retrying forever", async () => {
  const h = harness({
    claimed: [{ task_id: "t-gone", session_id: "s-1", sandbox_workload_id: "wl-gone" }],
    status: 404,
  });

  assert.equal(await backfillPlatformFacts([
    { task_id: "t-gone", session_id: "s-1", sandbox_workload_id: "wl-gone" },
  ]), 1);
  assert.ok(
    h.queries.some((query) =>
      /platform_facts_resolved_at = NOW\(\)[\s\S]*platform_facts_next_retry_at = NULL/.test(query)
    ),
  );
});

test("R13 the retry claim prevents another replica from fetching the same row", async () => {
  const h = harness({ claimed: [] });

  assert.equal(await backfillPlatformFacts([
    { task_id: "t-claimed", session_id: "s-1", sandbox_workload_id: "wl-claimed" },
  ]), 0);
  assert.deepEqual(h.fetched, []);
  const claim = h.queries.find((query) => /SET platform_facts_attempts/.test(query));
  assert.match(claim ?? "", /platform_facts_next_retry_at/);
  assert.match(claim ?? "", /1 << LEAST\(platform_facts_attempts, 4\)/);
  assert.match(claim ?? "", /platform_facts_resolved_at IS NULL/);
});

const KV_RUN = {
  task_id: "t-kv",
  session_id: "s-kv",
  origin: "chat",
  created_at: "2026-09-08T11:40:00Z",
  completed_at: "2026-09-08T12:00:00Z",
};
const PENDING_HANDS = {
  status: "pending",
  workloadId: "wl-pending",
  platformKey: "pk-from-brain",
  createdAt: "2026-09-08T11:50:00Z",
};

test("a pending legacy KV handle and its trusted key recover an unstamped chat run", async () => {
  const h = harness({ claimed: [KV_RUN], hands: PENDING_HANDS, config: {} });
  assert.equal(await backfillPlatformFacts([KV_RUN]), 1);
  assert.deepEqual(h.kvReads, ["s-kv"], "handle and key share one KV read");
  assert.deepEqual(h.fetched, ["http://safe.test/api/v1/workloads/wl-pending"]);
  assert.deepEqual(h.authorization, ["Bearer pk-from-brain"]);
  assert.deepEqual(h.handles, [[
    "t-kv", JSON.stringify({ provider: "safe-workload", handle: "wl-pending" }), "wl-pending",
  ]]);
});

test("the stamped session key takes precedence over the matching KV key", async () => {
  const h = harness({ claimed: [KV_RUN], hands: { ...PENDING_HANDS, provider: "safe-workload" } });
  assert.equal(await backfillPlatformFacts([KV_RUN]), 1);
  assert.deepEqual(h.authorization, ["Bearer pk-1"]);
  assert.equal(h.kvReads.length, 1);
});

test("a normalized row handle wins over the legacy column and newer session KV", async () => {
  const row = {
    ...KV_RUN,
    sandbox_workload_id: "wl-legacy",
    metadata: { sandbox: { provider: "safe-workload", handle: "wl-recorded" } },
  };
  const h = harness({ claimed: [row], hands: PENDING_HANDS });
  assert.equal(await backfillPlatformFacts([row]), 1);
  assert.deepEqual(h.fetched, ["http://safe.test/api/v1/workloads/wl-recorded"]);
  assert.deepEqual(h.kvReads, [], "an authoritative handle and key need no KV lookup");
  assert.deepEqual(h.handles, []);
});

test("a sandbox handle remains one encoded URL path segment", async () => {
  const row = { ...KV_RUN, sandbox_workload_id: "workload/part?admin=true#fragment" };
  const h = harness({ claimed: [row] });
  assert.equal(await backfillPlatformFacts([row]), 1);
  assert.deepEqual(h.fetched, [
    "http://safe.test/api/v1/workloads/workload%2Fpart%3Fadmin%3Dtrue%23fragment",
  ]);
});

test("a recorded legacy handle can recover only its own KV credentials", async () => {
  const row = { ...KV_RUN, sandbox_workload_id: "wl-pending" };
  const h = harness({
    claimed: [row], hands: PENDING_HANDS,
    config: { platform_key: "caller-controlled" },
  });
  assert.equal(await backfillPlatformFacts([row]), 1);
  assert.deepEqual(h.authorization, ["Bearer pk-from-brain"]);
  assert.equal(h.kvReads.length, 1);
  assert.deepEqual(h.handles, [], "already-recorded ownership remains unchanged");
});

test("a different handle or provider cannot lend credentials to an old run", async () => {
  const row = { ...KV_RUN, sandbox_workload_id: "wl-recorded" };
  for (const hands of [
    PENDING_HANDS,
    { ...PENDING_HANDS, provider: "agent-sandbox", sessionId: "wl-recorded" },
  ]) {
    const h = harness({ claimed: [row], hands, config: { platform_key: "caller-controlled" } });
    assert.equal(await backfillPlatformFacts([row]), 0);
    assert.deepEqual(h.fetched, []);
    assert.ok(h.diagnostics.some((d) => d.reason === "kv_handle_mismatch"));
    assert.ok(h.diagnostics.some((d) => d.reason === "missing_platform_key"));
  }
});

test("a sandbox outside this run's lifetime cannot become its fallback handle", async () => {
  for (const createdAt of ["2026-09-08T12:00:01Z", "2026-09-08T11:39:59Z", "invalid", undefined]) {
    const h = harness({ claimed: [KV_RUN], hands: { ...PENDING_HANDS, createdAt } });
    assert.equal(await backfillPlatformFacts([KV_RUN]), 0);
    assert.deepEqual(h.fetched, []);
    assert.deepEqual(h.handles, []);
    assert.ok(h.diagnostics.some((d) => d.reason === "kv_handle_outside_run"));
  }
});

test("shared DAG session KV is not evidence of an individual node's ownership", async () => {
  const row = { ...KV_RUN, origin: "dag_node" };
  const h = harness({ claimed: [row], hands: PENDING_HANDS });
  assert.equal(await backfillPlatformFacts([row]), 0);
  assert.deepEqual(h.kvReads, []);
  assert.deepEqual(h.handles, []);
  assert.ok(h.diagnostics.some((d) => d.reason === "kv_handle_run_unattributed"));
});

test("KV fallback refuses rows with no trustworthy completion timestamp", async () => {
  const row = { ...KV_RUN, completed_at: null };
  const h = harness({ claimed: [row], hands: PENDING_HANDS });
  assert.equal(await backfillPlatformFacts([row]), 0);
  assert.deepEqual(h.fetched, []);
  assert.ok(h.diagnostics.some((d) => d.reason === "kv_handle_outside_run"));
});

test("a concurrent ownership report prevents the fallback from fetching its stale snapshot", async () => {
  const h = harness({ claimed: [KV_RUN], hands: PENDING_HANDS, handleUpdated: 0 });
  assert.equal(await backfillPlatformFacts([KV_RUN]), 0);
  assert.deepEqual(h.fetched, []);
  assert.ok(h.diagnostics.some((d) => d.reason === "sandbox_ownership_changed"));
});

test("agent-sandbox is explicitly unreadable and never a resolved empty read", async () => {
  const row = {
    ...KV_RUN,
    sandbox_workload_id: "must-not-use-legacy",
    metadata: { sandbox: { provider: "agent-sandbox", handle: "agent-session" } },
  };
  const h = harness({ claimed: [row] });
  assert.equal(await backfillPlatformFacts([row]), 0);
  assert.deepEqual(h.fetched, []);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.kvReads, []);
  assert.deepEqual(h.diagnostics, [{
    taskId: "t-kv", sessionId: "s-kv", provider: "agent-sandbox", handle: "agent-session",
    reason: "termination_facts_unavailable",
  }]);
});

test("an agent-sandbox KV entry uses sessionId and records an unsupported reader", async () => {
  const h = harness({
    claimed: [KV_RUN],
    hands: { ...PENDING_HANDS, provider: "agent-sandbox", sessionId: "agent-session" },
  });
  assert.equal(await backfillPlatformFacts([KV_RUN]), 0);
  assert.deepEqual(h.handles, [[
    "t-kv", JSON.stringify({ provider: "agent-sandbox", handle: "agent-session" }), null,
  ]]);
  assert.deepEqual(h.fetched, []);
  assert.deepEqual(h.updates, []);
  assert.ok(h.diagnostics.some((d) => d.reason === "termination_facts_unavailable"));
});

test("an unknown provider is not silently treated as a legacy SaFE workload", async () => {
  const h = harness({ claimed: [KV_RUN], hands: { ...PENDING_HANDS, provider: "unknown" } });
  assert.equal(await backfillPlatformFacts([KV_RUN]), 0);
  assert.deepEqual(h.handles, []);
  assert.deepEqual(h.fetched, []);
  assert.ok(h.diagnostics.some((d) => d.reason === "invalid_kv_handle"));
});

test("an invalid recorded handle cannot fall through to a different KV sandbox", async () => {
  const row = { ...KV_RUN, metadata: { sandbox: { provider: "unknown", handle: "bad" } } };
  const h = harness({ claimed: [row], hands: PENDING_HANDS });
  assert.equal(await backfillPlatformFacts([row]), 0);
  assert.deepEqual(h.kvReads, []);
  assert.deepEqual(h.fetched, []);
  assert.ok(h.diagnostics.some((d) => d.reason === "invalid_recorded_handle"));
});

test("KV errors and tombstones stay unresolved without exposing serialized credentials", async () => {
  for (const options of [
    { kvError: true },
    { kvRaw: '{"platformKey":"do-not-log-this", BROKEN' },
    { hands: PENDING_HANDS, kvOperation: "DEL" as const },
    { hands: PENDING_HANDS, kvOperation: "PURGE" as const },
  ]) {
    const h = harness({ claimed: [KV_RUN], ...options });
    assert.equal(await backfillPlatformFacts([KV_RUN]), 0);
    assert.deepEqual(h.fetched, []);
    assert.deepEqual(h.updates, []);
    assert.doesNotMatch(JSON.stringify(h.diagnostics), /do-not-log-this|pk-from-brain|platformKey/);
    assert.ok(h.diagnostics.some((d) => d.reason === "missing_sandbox_handle"));
  }
});

test("HTTP errors are diagnosed while 404 and 410 resolve a confirmed absence", async () => {
  const row = { ...KV_RUN, sandbox_workload_id: "wl-gone" };
  for (const status of [401, 403, 429, 500, 404, 410]) {
    const h = harness({ claimed: [row], status });
    const absent = status === 404 || status === 410;
    assert.equal(await backfillPlatformFacts([row]), absent ? 1 : 0);
    assert.equal(h.updates.length, absent ? 1 : 0);
    if (!absent) assert.ok(h.diagnostics.some((d) => d.reason === "platform_http_error" && d.status === status));
  }
});

test("the per-sweep cap and five-reader concurrency bound also apply to KV fallbacks", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ ...KV_RUN, task_id: `cap-${i}` }));
  const h = harness({ claimed: rows, hands: PENDING_HANDS });
  let active = 0;
  let peak = 0;
  const fetchStub = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await fetchStub(...args);
    } finally {
      active--;
    }
  }) as typeof fetch;
  assert.equal(await backfillPlatformFacts(rows), 50);
  assert.equal(h.fetched.length, 50);
  assert.equal(h.kvReads.length, 50);
  assert.equal(peak, 5);
});
