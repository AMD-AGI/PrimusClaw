// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A deployment with no `SAFE_API_URL` releases nothing, and must say so.
 *
 * This is the third of the acceptance cases and the one most likely to be
 * dismissed as a misconfiguration rather than an outcome. It is not: the
 * process starts, tasks run, cancellations are accepted, and every sandbox
 * teardown is skipped with a `warn` nobody reads. A caller asking "did the
 * resources go away" gets the same answer it got when they did, for as long as
 * the setting stays missing -- which is exactly the silent GPU leak the
 * `released` field exists to surface.
 *
 * It is a separate file from cancel-release-confirmation.test.ts because
 * `SAFE_API_URL` is read once at module scope, so the two values cannot coexist
 * in one process; see config-blank-env.test.ts for the same reason.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { HandleInfo } from "@claw/protocol";

delete process.env.SAFE_API_URL;

const { SAFE_API_URL } = await import("../src/config.js");
const { db } = await import("../src/infra/db.js");
const { handleRegistry, unreleasedRecord } = await import("../src/tasks/sandbox-stopper.js");
const { cancelTask } = await import("../src/tasks/lifecycle.js");

const originalQuery = db.query;
const originalRegistry = { ...handleRegistry };
const originalRecord = { ...unreleasedRecord };
const originalFetch = globalThis.fetch;
after(() => {
  db.query = originalQuery;
  Object.assign(handleRegistry, originalRegistry);
  Object.assign(unreleasedRecord, originalRecord);
  globalThis.fetch = originalFetch;
});

// In-memory stand-in for the KV-backed record, same contract.
const recorded = new Set<string>();
unreleasedRecord.mark = async (_dag, handle) => { recorded.add(handle); };
unreleasedRecord.clear = async (_dag, handle) => { recorded.delete(handle); };
unreleasedRecord.any = async () => recorded.size > 0;

test("an unset SAFE_API_URL is an unconfirmed release, not a quiet success", async () => {
  assert.equal(SAFE_API_URL, "", "the premise of this file: the setting is absent");

  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT * FROM claw_tasks WHERE task_id")) {
      return {
        rows: [{
          task_id: "t-root",
          session_id: "s-1",
          status: "running",
          dag_node_id: "__dag_root__",
          dag_root_task_id: "t-root",
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT config FROM claw_sessions")) return { rows: [{ config: {} }], rowCount: 1 };
    if (sql.startsWith("UPDATE claw_tasks SET status")) return { rows: [{ task_id: "t-root" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  handleRegistry.listForDag = async (): Promise<Record<string, HandleInfo>> =>
    ({ main: { workload_id: "w-1" } });
  handleRegistry.destroy = async () => "w-1";

  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;

  const r = await cancelTask("t-root");

  assert.equal(called, false, "with nowhere to send it, no stop is attempted");
  assert.equal(
    r.released, "unconfirmed",
    "a handle was held and nothing released it; the caller has to be able to see that",
  );
  assert.equal(r.ok, true, "and the cancellation still stands");
  assert.equal(
    await unreleasedRecord.any("t-root"), true,
    "and it is on record, so the next cancel does not read the emptied map as nothing_held",
  );
});
