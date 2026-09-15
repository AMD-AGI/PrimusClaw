// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";

import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const TOKEN = "cluster-internal-token";

let harness: AdmissionCluster;
let client: pg.Client;
let app: FastifyInstance;
let credentials: string;

async function seedDoorbell(taskId: string, semantics?: number, priority = 0): Promise<void> {
  const metadata: Record<string, unknown> = {
    dispatch: "doorbell",
    message_id: `message-${taskId}`,
  };
  if (semantics !== undefined) metadata.doorbell_semantics = semantics;
  await client.query(
    `INSERT INTO claw_tasks (
       task_id, session_id, name, status, origin, executor, priority,
       input, metadata, created_at, queued_at
     ) VALUES ($1, $2, 'turn', 'queued', 'chat', 'brain', $3, $4::jsonb, $5::jsonb, NOW(), NOW())`,
    [
      taskId,
      `session-${taskId}`,
      priority,
      JSON.stringify({ prompt: "hello", user_id: "u-1", credentials }),
      JSON.stringify(metadata),
    ],
  );
}

function post(url: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-legacy" },
  });
}

before(async () => {
  if (skip) return;
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  harness = await startAdmissionCluster({});
  client = await harness.connect();
  const { initUserEnvCrypto } = await import("../src/crypto/user-env.js");
  const { sealRunCredentials } = await import("../src/tasks/run-secrets.js");
  initUserEnvCrypto();
  credentials = sealRunCredentials({ llm_api_key: "sk-test", platform_key: "pk-test" });
  harness.app.runClaim.runClaimPorts.buildHistory = async () => [];
  const { registerInternalRunRoutes } = await import("../src/routes/internal-runs.js");
  app = Fastify();
  await registerInternalRunRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  if (skip) return;
  await client.query("TRUNCATE claw_tasks");
});

after(async () => {
  if (skip) return;
  await app.close();
  await harness.stop();
});

describe("legacy claim clients are filtered by their implicit version", { skip }, () => {
  test("claim-by-id accepts a legacy row and refuses an above-capability row", async () => {
    await seedDoorbell("legacy");
    assert.equal((await post("/v1/internal/tasks/legacy/claim")).statusCode, 200);

    await seedDoorbell("future", DOORBELL_SEMANTICS_VERSION + 1);
    const future = await post("/v1/internal/tasks/future/claim");
    assert.equal(future.statusCode, 409);
    assert.equal(future.json().error, "busy");
  });

  test("claim-next skips an above-capability row and returns the legacy row behind it", async () => {
    await seedDoorbell("future", DOORBELL_SEMANTICS_VERSION + 1, 10);
    await seedDoorbell("legacy", undefined, 1);

    const claimed = await post("/v1/internal/runs/claim-next");
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.json().request.task_id, "legacy");

    const none = await post("/v1/internal/runs/claim-next");
    assert.equal(none.statusCode, 200);
    assert.equal(none.json().request, null);
    const future = await client.query(
      "SELECT status, claim_count FROM claw_tasks WHERE task_id = 'future'",
    );
    assert.deepEqual(future.rows[0], { status: "queued", claim_count: 0 });
  });
});
