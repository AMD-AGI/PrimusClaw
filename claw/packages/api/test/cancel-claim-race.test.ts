// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import type pg from "pg";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const WAIT_MS = 10_000;

let harness: AdmissionCluster;
let holder: pg.Client;

async function waitForBlockedWriter(): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const result = await harness.app.db.db.query(
      `SELECT COUNT(*)::int AS n
         FROM pg_locks
        WHERE NOT granted
          AND locktype <> 'advisory'`,
    );
    if (Number(result.rows[0].n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("the cancellation never waited for the concurrent claim");
}

before(async () => {
  if (skip) return;
  harness = await startAdmissionCluster({});
  holder = await harness.connect();
});

after(async () => { await harness?.stop(); });

describe("cancellation decides from the row version it locks", { skip }, () => {
  test("a claim that wins after the initial read turns cancellation into a handshake", async () => {
    await harness.app.db.db.query(
      `INSERT INTO claw_tasks (
         task_id, session_id, name, status, origin, executor, metadata, created_at, queued_at
       ) VALUES (
         'racing','s-race','turn','queued','chat','brain',
         '{"dispatch":"doorbell","message_id":"m-race"}'::jsonb, NOW(), NOW()
       )`,
    );
    await holder.query("BEGIN");
    try {
      await holder.query("SELECT 1 FROM claw_tasks WHERE task_id = 'racing' FOR UPDATE");
      const cancelling = harness.app.lifecycle.cancelTask("racing");
      await waitForBlockedWriter();
      await holder.query(
        `UPDATE claw_tasks
            SET status = 'preparing', lease_owner = 'brain-a',
                lease_expires_at = NOW() + INTERVAL '1 minute', claim_count = 1
          WHERE task_id = 'racing'`,
      );
      await holder.query("COMMIT");
      assert.deepEqual(
        await cancelling,
        { ok: true, cancelled: 1, interrupt_key: "s-race" },
      );
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
    }

    const row = await harness.app.db.db.query(
      "SELECT status, lease_owner, claim_count FROM claw_tasks WHERE task_id = 'racing'",
    );
    assert.deepEqual(row.rows[0], {
      status: "cancelling", lease_owner: "brain-a", claim_count: 1,
    });
  });
});
