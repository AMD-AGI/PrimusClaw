// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The sweeper asks the platform on behalf of runs nobody was left to ask.
 *
 * A node reclaim takes the sandbox and the Brain worker together, so the run
 * sends no callback and the row is closed by the sweeper with `brain_timeout`.
 * That is the run whose ending matters most to name and the one arriving with
 * nothing on it, so the sweep reads the pod's own account while the pod is still
 * there to have one.
 *
 * Coverage:
 *   R1 a swept row with a workload gains the platform's account
 *   R2 a row whose columns are already filled is not overwritten
 *   R3 rows with no sandbox are not asked about
 *   R4 a SaFE that is down does not fail the sweep
 *   R5 the lost-lease reaper asks while the workload detail still exists
 *   R6-R9 the drain selects, orders, records, and skips empty backlogs
 *   R10 empty content is still a resolved read
 *   R11 caller-controlled config is never used as a bearer token
 *   R12 definitive absence is resolved without permanent retries
 *   R13 retry claims prevent duplicate reads across replicas
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

// Set before the first import of config.ts, which reads the environment once at
// module scope. With it unset the backfill is inert by design -- a deployment
// with no SaFE has nothing to ask -- which would make every assertion below pass
// vacuously.
process.env.SAFE_API_URL = "http://safe.test";

const { db } = await import("../src/infra/db.js");
const { backfillPlatformFacts } = await import("../src/tasks/platform-backfill.js");
const { reapLostLeases } = await import("../src/tasks/sweeper.js");

const originalQuery = db.query;
const originalFetch = globalThis.fetch;
afterEach(() => { db.query = originalQuery; globalThis.fetch = originalFetch; });

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
}

function harness(opts: HarnessOptions = {}): Harness {
  const h: Harness = { queries: [], updates: [], fetched: [] };
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
      const rows = opts.claimed ?? [];
      return { rows, rowCount: rows.length };
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
  globalThis.fetch = (async (url: string) => {
    h.fetched.push(String(url));
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
  const h = harness();
  const n = await backfillPlatformFacts([
    { task_id: "ktsk_3", session_id: "s1", sandbox_workload_id: null },
    { task_id: "ktsk_4", session_id: "s1" },
  ]);
  assert.equal(n, 0);
  assert.equal(h.fetched.length, 0, "no SaFE call for a run that never had a sandbox");
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

test("R6 the drain asks only for terminal rows that still have no account", async () => {
  // Each clause is load-bearing: a non-terminal row is still running and must
  // not be answered for; a row with no workload id has nothing to ask about;
  // a row that already carries facts has been answered, possibly by a late
  // Brain callback that must win.
  const h = drainHarness([]);
  await drainPendingPlatformFacts();
  const sel = h.queries.find((t) => /SELECT/i.test(t) && /FROM claw_tasks/.test(t));
  assert.ok(sel, "the drain must issue a select");
  assert.match(sel!, /status = 'failed'/, "liveness failures only");
  assert.match(sel!, /failure_reason IN \('brain_timeout', 'worker_lost'\)/);
  assert.match(sel!, /sandbox_workload_id IS NOT NULL/, "something to ask about");
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
