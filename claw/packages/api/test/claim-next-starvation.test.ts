// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import type pg from "pg";

import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

let harness: AdmissionCluster;
let client: pg.Client;
let credentials: string;

async function seedDoorbell(
  taskId: string,
  priority: number,
  sandbox: boolean,
  status = "queued",
): Promise<void> {
  await client.query(
    `INSERT INTO claw_tasks (
       task_id, session_id, name, status, origin, executor, priority,
       sandbox_spec, input, metadata, created_at, queued_at
     ) VALUES (
       $1, $2, 'turn', $3, 'chat', 'brain', $4, $5::jsonb, $6::jsonb,
       jsonb_build_object(
         'dispatch', 'doorbell', 'message_id', $7::text,
         'doorbell_semantics', $8::int, 'queued_since', NOW()::text
       ), NOW(), NOW()
     )`,
    [
      taskId,
      `session-${taskId}`,
      status,
      priority,
      sandbox ? '"default"' : null,
      JSON.stringify({ prompt: "hello", user_id: "u-1", credentials }),
      `message-${taskId}`,
      DOORBELL_SEMANTICS_VERSION,
    ],
  );
}

before(async () => {
  if (skip) return;
  harness = await startAdmissionCluster({ ADMIT_SOFT_SANDBOXES: "1" });
  client = await harness.connect();
  const { initUserEnvCrypto } = await import("../src/crypto/user-env.js");
  const { sealRunCredentials } = await import("../src/tasks/run-secrets.js");
  initUserEnvCrypto();
  credentials = sealRunCredentials({ llm_api_key: "sk-test", platform_key: "pk-test" });
  harness.app.runClaim.runClaimPorts.buildHistory = async () => [];
});

after(async () => { await harness?.stop(); });

describe("claim-next scans past rows that the soft ceiling defers", { skip }, () => {
  test("zero sandbox headroom does not hide a sandboxless row behind twenty sandbox rows", async () => {
    await seedDoorbell("occupying", 100, true, "running");
    for (let i = 0; i < 20; i++) {
      await seedDoorbell(`blocked-${i}`, 50 - i, true);
    }
    await seedDoorbell("fits", 1, false);

    const diagnostics: import("../src/tasks/run-claim.js").ClaimNextDiagnostics = {
      skipped: [], outcome: "empty",
    };
    const claimed = await harness.app.runClaim.claimNextRun(
      "brain-free", DOORBELL_SEMANTICS_VERSION, diagnostics,
    );

    assert.ok(claimed);
    assert.equal(claimed.request.task_id, "fits");
    assert.equal(diagnostics.outcome, "claimed");
    assert.equal(
      diagnostics.skipped.filter((entry) => entry.cause === "deferred").length,
      20,
    );
    const blocked = await client.query(
      "SELECT count(*)::int AS n FROM claw_tasks WHERE task_id LIKE 'blocked-%' AND status = 'queued'",
    );
    assert.equal(Number(blocked.rows[0].n), 20);
  });
});
