// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { startHarness, type Harness } from "./scenario-harness.js";

const TASK_ID = "run-1";
const TASK_TOKEN = randomBytes(32).toString("hex");
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;
let app: FastifyInstance;
let h: Harness;

before(async () => {
  delete process.env.AUTH_INTERNAL_TOKEN;
  h = await startHarness();
  await h.sql("ALTER TABLE claw_tasks ADD COLUMN brain_id TEXT");
  app = Fastify();
  await registerInternalTaskRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  await h.reset();
  await h.sql(
    `INSERT INTO claw_tasks
       (task_id, session_id, status, origin, callback_url, internal_token_hash)
     VALUES ($1, 'session-1', 'running', 'chat', NULL, $2)`,
    [TASK_ID, createHash("sha256").update(TASK_TOKEN).digest("hex")],
  );
});

after(async () => {
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await app?.close();
  await h?.close();
});

async function renew(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/v1/internal/tasks/${TASK_ID}/lease`,
    headers: { authorization: `Bearer ${TASK_TOKEN}` },
    payload: { lease_seconds: 45, ...body },
  });
}

async function storedRun() {
  const rows = await h.sql(
    `SELECT status, origin, callback_url, brain_id, lease_owner,
            lease_expires_at, heartbeat_at, metadata,
            lease_expires_at > NOW() AS lease_live
       FROM claw_tasks WHERE task_id = $1`,
    [TASK_ID],
  );
  assert.equal(rows.length, 1);
  return rows[0]!;
}

async function setLeaseOwner(owner: string, expiresInSeconds: number, status = "running") {
  await h.sql(
    `UPDATE claw_tasks
        SET brain_id = $2, lease_owner = $2,
            lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
            status = $4
      WHERE task_id = $1`,
    [TASK_ID, owner, expiresInSeconds, status],
  );
}

test("a chat run's lease token records the worker without a callback URL", async () => {
  const res = await renew({ brain_id: "worker-a" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running" });
  const run = await storedRun();
  assert.equal(run.origin, "chat");
  assert.equal(run.callback_url, null);
  assert.equal(run.status, "running");
  assert.equal(run.brain_id, "worker-a");
  assert.equal(run.lease_owner, "worker-a");
  assert.equal(run.lease_live, true);
  assert.ok(run.heartbeat_at);
});

test("the current lease owner can refresh the recorded worker identity", async () => {
  await setLeaseOwner("worker-a", 600);
  await h.sql("UPDATE claw_tasks SET brain_id = NULL WHERE task_id = $1", [TASK_ID]);

  const res = await renew({ brain_id: "worker-a" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running" });
  const run = await storedRun();
  assert.equal(run.brain_id, "worker-a");
  assert.equal(run.lease_owner, "worker-a");
  assert.equal(run.lease_live, true);
});

test("a renewal without a worker identity preserves the recorded owner", async () => {
  await setLeaseOwner("worker-a", -60);

  const res = await renew({});

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running" });
  const run = await storedRun();
  assert.equal(run.brain_id, "worker-a");
  assert.equal(run.lease_owner, "worker-a");
  assert.equal(run.lease_live, true);
});

test("another worker cannot replace the owner of an unexpired lease", async () => {
  await setLeaseOwner("worker-a", 600);
  const original = await storedRun();

  const res = await renew({ brain_id: "worker-b" });

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { ok: false, error: "run is not active", reason: "superseded" });
  assert.deepEqual(await storedRun(), original);
});

test("an expired lease transfers both ownership fields to the new worker", async () => {
  await setLeaseOwner("worker-a", -60);

  const res = await renew({ brain_id: "worker-b" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running" });
  const run = await storedRun();
  assert.equal(run.brain_id, "worker-b");
  assert.equal(run.lease_owner, "worker-b");
  assert.equal(run.status, "running");
  assert.equal(run.lease_live, true);
  assert.ok(run.heartbeat_at);
});

for (const status of ["completed", "failed", "cancelled"]) {
  test(`a ${status} run refuses a late ownership update`, async () => {
    await setLeaseOwner("worker-a", -60, status);
    const original = await storedRun();

    const res = await renew({ brain_id: "worker-b" });

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { ok: false, error: "run is not active", reason: "terminal" });
    assert.deepEqual(await storedRun(), original);
  });
}
