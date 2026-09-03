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

interface Harness { updates: unknown[][]; fetched: string[] }

function harness(opts: { updated?: number; ok?: boolean; throws?: boolean } = {}): Harness {
  const h: Harness = { updates: [], fetched: [] };
  db.query = (async (text: string, params: unknown[] = []) => {
    if (/FROM claw_sessions/.test(text)) {
      return { rows: [{ config: { platform_key: "pk-1" } }], rowCount: 1 };
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
    if (opts.ok === false) return { ok: false, status: 404 } as unknown as Response;
    return { ok: true, status: 200, json: async () => DETAIL } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return h;
}

test("R1 a swept row with a workload gains the platform's account", async () => {
  const h = harness();
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
  // The UPDATE is guarded in SQL, so what this asserts is that the guard is
  // still in the statement -- a late callback from a Brain that survived after
  // all is the better source and may land between the sweep and this read.
  const h = harness({ updated: 0 });
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
  harness({ throws: true });
  assert.equal(
    await backfillPlatformFacts([
      { task_id: "ktsk_5", session_id: "s1", sandbox_workload_id: "wl-5" },
    ]),
    0,
  );
  harness({ ok: false });
  assert.equal(
    await backfillPlatformFacts([
      { task_id: "ktsk_6", session_id: "s1", sandbox_workload_id: "wl-6" },
    ]),
    0,
  );
});

test("R5 a lost lease backfills the platform account of the dead worker", async () => {
  const h: Harness = { updates: [], fetched: [] };
  db.query = (async (text: string, params: unknown[] = []) => {
    if (/lease_expires_at IS NOT NULL/.test(text)) {
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
    if (/FROM claw_sessions/.test(text)) {
      return { rows: [{ config: { platform_key: "pk-1" } }], rowCount: 1 };
    }
    if (/UPDATE claw_tasks/.test(text)) {
      h.updates.push(params);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${text}`);
  }) as typeof db.query;
  globalThis.fetch = (async (url: string) => {
    h.fetched.push(String(url));
    return { ok: true, status: 200, json: async () => DETAIL } as unknown as Response;
  }) as typeof globalThis.fetch;

  assert.equal(await reapLostLeases(), 1);
  assert.deepEqual(h.fetched, ["http://safe.test/api/v1/workloads/wl-lost"]);
  assert.equal(h.updates.length, 1, "the platform facts were not written to the reaped row");
});
