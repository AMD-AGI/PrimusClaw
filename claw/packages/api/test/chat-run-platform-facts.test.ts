// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { KvEntry } from "nats";
import type { Harness } from "./scenario-harness.js";

process.env.SAFE_API_URL = "http://platform.test";
const { startHarness, seedSession } = await import("./scenario-harness.js");
const { registerInternalTaskRoutes } = await import("../src/routes/internal-tasks.js");
const { registerRunRoutes } = await import("../src/runs/routes.js");
const { drainPendingPlatformFacts, platformBackfillPorts } = await import("../src/tasks/platform-backfill.js");

const TOKEN = "run-lease-token";
const PLATFORM_KEY = "test-platform-key";
const originalFetch = globalThis.fetch;
const originalPorts = { ...platformBackfillPorts };
let app: FastifyInstance;
let h: Harness;

before(async () => {
  h = await startHarness();
  await h.sql("ALTER TABLE claw_sessions ADD COLUMN config JSONB");
  app = Fastify();
  app.addHook("onRequest", async (req) => {
    Object.assign(req, { user: { userId: "user-1", roles: [] } });
  });
  await registerInternalTaskRoutes(app);
  await registerRunRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  await h.reset();
  await seedSession(h, "session-1", { userId: "user-1" });
  await h.sql("UPDATE claw_sessions SET config = $1::jsonb", [{
    platform_key: PLATFORM_KEY, _server_managed_credentials: true,
  }]);
  await h.sql(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, internal_token_hash)
     VALUES ('run-1', 'session-1', 'chat', 'running', 'chat', $1)`,
    [createHash("sha256").update(TOKEN).digest("hex")],
  );
  platformBackfillPorts.readHandsEntry = async () => assert.fail("persisted ownership needs no KV lookup");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(platformBackfillPorts, originalPorts);
});

after(async () => {
  await app?.close();
  await h?.close();
});

function platformAnswers(message: string, containerReason: string): () => number {
  let reads = 0;
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "http://platform.test/api/v1/workloads/workload-1");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${PLATFORM_KEY}`);
    reads++;
    return Response.json({
      phase: "Failed",
      pods: [{
        phase: "Failed", failedMessage: message, adminNodeName: "node-1",
        containers: [{ exitCode: 137, reason: containerReason }],
      }],
    });
  }) as typeof fetch;
  return () => reads;
}

async function finishRun(reason: string) {
  await h.sql(
    "UPDATE claw_tasks SET status = 'failed', failure_reason = $1, completed_at = NOW()",
    [reason],
  );
}

async function listedRun() {
  const response = await app.inject({ method: "GET", url: "/v1/runs?state=terminal&limit=1000" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.runs.length, 1);
  return body.runs[0];
}

for (const [message, containerReason, expected] of [
  ["Preempted, reclaimed", "Error", "preempted"],
  ["NodeLost, unreachable", "", "node_lost"],
  ["", "OOMKilled", "oom"],
  ["DeadlineExceeded, runtime limit", "", "deadline"],
]) {
  test(`a shadow run's lease and backfill make ${expected} visible on GET /v1/runs`, async () => {
    const response = await app.inject({
      method: "POST", url: "/v1/internal/tasks/run-1/lease",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        brain_id: "worker-1", lease_seconds: 45,
        attempt_id: "attempt-1", claim_count: 0, delivery_seq: 0, delivery_count: 0,
        sandbox: { provider: "safe-workload", handle: "workload-1" },
      },
    });
    assert.equal(response.statusCode, 200);
    const [ownership] = await h.sql("SELECT brain_id, sandbox_workload_id, callback_url FROM claw_tasks");
    assert.deepEqual(ownership, {
      brain_id: "worker-1", sandbox_workload_id: "workload-1", callback_url: null,
    });
    await finishRun("worker_lost");
    assert.equal((await listedRun()).terminal.kill_reason, "");
    const reads = platformAnswers(message!, containerReason!);

    assert.equal(await drainPendingPlatformFacts(), 1);

    const run = await listedRun();
    assert.equal(run.terminal.class, "killed");
    assert.equal(run.terminal.kill_reason, expected);
    assert.equal(run.placement.workload_id, "workload-1");
    assert.equal(await drainPendingPlatformFacts(), 0);
    assert.equal(reads(), 1);
  });
}

test("a retained pending KV handle reaches the run view without a callback or stamped key", async () => {
  await h.sql("UPDATE claw_sessions SET config = '{}'::jsonb");
  await h.sql("UPDATE claw_tasks SET created_at = NOW() - INTERVAL '2 minutes'");
  let kvReads = 0;
  platformBackfillPorts.readHandsEntry = async () => {
    kvReads++;
    return {
      operation: "PUT",
      value: new TextEncoder().encode(JSON.stringify({
        status: "pending", workloadId: "workload-1", platformKey: PLATFORM_KEY,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      })),
    } as KvEntry;
  };
  await finishRun("sandbox_workload_terminal");
  platformAnswers("Preempted, reclaimed during startup", "Error");

  assert.equal(await drainPendingPlatformFacts(), 1);

  assert.equal((await listedRun()).terminal.kill_reason, "preempted");
  assert.equal(kvReads, 1);
});
