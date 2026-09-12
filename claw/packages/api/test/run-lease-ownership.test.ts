// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { parseSandboxHandle, type SandboxHandle } from "../src/tasks/sandbox-handle.js";
import { startHarness, type Harness } from "./scenario-harness.js";

const TASK_ID = "run-1";
const TASK_TOKEN = randomBytes(32).toString("hex");
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;
const SAFE_SANDBOX: SandboxHandle = { provider: "safe-workload", handle: "workload-a" };
const AGENT_SANDBOX: SandboxHandle = { provider: "agent-sandbox", handle: "pool/agent:a" };
let app: FastifyInstance;
let h: Harness;

before(async () => {
  delete process.env.AUTH_INTERNAL_TOKEN;
  h = await startHarness();
  app = Fastify();
  await registerInternalTaskRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  await h.reset();
  await h.sql(
    `INSERT INTO claw_tasks
       (task_id, session_id, name, status, origin, callback_url, internal_token_hash)
     VALUES ($1, 'session-1', 'chat', 'running', 'chat', NULL, $2)`,
    [TASK_ID, createHash("sha256").update(TASK_TOKEN).digest("hex")],
  );
});

after(async () => {
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await app?.close();
  await h?.close();
});

async function postTaskRoute(route: "lease" | "event", payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/v1/internal/tasks/${TASK_ID}/${route}`,
    headers: { authorization: `Bearer ${TASK_TOKEN}` },
    payload,
  });
}

async function renew(body: Record<string, unknown>) {
  return postTaskRoute("lease", {
    lease_seconds: 45, attempt_id: "attempt-1", claim_count: 0, delivery_seq: 0, delivery_count: 0,
    ...body,
  });
}

async function reportRunningEvent(body: Record<string, unknown>) {
  await h.sql("UPDATE claw_tasks SET callback_url = $2 WHERE task_id = $1", [TASK_ID, "https://api.example.com/callback"]);
  return postTaskRoute("event", { type: "statusUpdate", agent_status: "running", ...body });
}

async function storedRun() {
  const rows = await h.sql(
    `SELECT status, origin, callback_url, brain_id, lease_owner, sandbox_workload_id,
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

async function setSandbox(sandbox: SandboxHandle) {
  await h.sql(
    `UPDATE claw_tasks SET sandbox_workload_id = $2, metadata = $3::jsonb WHERE task_id = $1`,
    [
      TASK_ID,
      sandbox.provider === "safe-workload" ? sandbox.handle : null,
      JSON.stringify({ sandbox, context: "retained" }),
    ],
  );
}

async function renewAtLeaseBoundary(
  body: Record<string, unknown>,
  hooks: { before?: () => Promise<void>; after?: () => Promise<void> },
) {
  const query = db.query;
  let intercepted = false;
  db.query = (async (sql: string, params?: unknown[]) => {
    if (intercepted || !sql.includes("SET lease_owner")) return query(sql, params);
    intercepted = true;
    await hooks.before?.();
    const result = await query(sql, params);
    await hooks.after?.();
    return result;
  }) as typeof db.query;
  try {
    return await renew(body);
  } finally {
    db.query = query;
  }
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
  await setSandbox(SAFE_SANDBOX);
  const original = await storedRun();

  const res = await renew({ brain_id: "worker-b", sandbox: AGENT_SANDBOX });

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { ok: false, error: "run is not active", reason: "superseded" });
  assert.deepEqual(await storedRun(), original);
});

test("an expired lease transfers both ownership fields to the new worker", async () => {
  await setLeaseOwner("worker-a", -60);
  await setSandbox(SAFE_SANDBOX);

  const res = await renew({ brain_id: "worker-b", sandbox: AGENT_SANDBOX });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running" });
  const run = await storedRun();
  assert.equal(run.brain_id, "worker-b");
  assert.equal(run.lease_owner, "worker-b");
  assert.equal(run.status, "running");
  assert.equal(run.lease_live, true);
  assert.ok(run.heartbeat_at);
  assert.equal(run.sandbox_workload_id, null);
  assert.deepEqual((run.metadata as Record<string, unknown>).sandbox, AGENT_SANDBOX);
});

for (const status of ["completed", "failed", "cancelled"]) {
  test(`a ${status} run refuses a late ownership update`, async () => {
    await setLeaseOwner("worker-a", -60, status);
    await setSandbox(SAFE_SANDBOX);
    const original = await storedRun();

    const res = await renew({ brain_id: "worker-b", sandbox: AGENT_SANDBOX });

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { ok: false, error: "run is not active", reason: "terminal" });
    assert.deepEqual(await storedRun(), original);
  });
}

for (const sandbox of [SAFE_SANDBOX, AGENT_SANDBOX]) {
  test(`a chat lease records a ${sandbox.provider} sandbox with its scoped token`, async () => {
    await setSandbox({ provider: "safe-workload", handle: "workload-old" });

    const res = await renew({ brain_id: "worker-a", sandbox });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, status: "running" });
    const run = await storedRun();
    assert.equal(run.callback_url, null);
    assert.equal(run.brain_id, "worker-a");
    assert.equal(run.lease_owner, "worker-a");
    assert.equal(run.sandbox_workload_id, sandbox.provider === "safe-workload" ? sandbox.handle : null);
    const metadata = run.metadata as Record<string, unknown>;
    assert.deepEqual(metadata.sandbox, sandbox);
    assert.equal(metadata.context, "retained");
    assert.equal((metadata.run_phase as Record<string, unknown>).phase, "executing");
  });

  test(`a legacy lease body preserves the recorded ${sandbox.provider} sandbox`, async () => {
    await setLeaseOwner("worker-a", 600);
    await setSandbox(sandbox);
    const original = await storedRun();

    const res = await postTaskRoute("lease", { brain_id: "worker-a", lease_seconds: 45 });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, status: "running" });
    const run = await storedRun();
    assert.equal(run.sandbox_workload_id, original.sandbox_workload_id);
    assert.deepEqual((run.metadata as Record<string, unknown>).sandbox, sandbox);
  });

  test(`a legacy lease records the worker and its ${sandbox.provider} sandbox`, async () => {
    const res = await postTaskRoute("lease", { brain_id: "worker-a", lease_seconds: 45, sandbox });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, status: "running" });
    const run = await storedRun();
    assert.equal(run.brain_id, "worker-a");
    assert.equal(run.lease_owner, "worker-a");
    assert.equal(run.sandbox_workload_id, sandbox.provider === "safe-workload" ? sandbox.handle : null);
    assert.deepEqual((run.metadata as Record<string, unknown>).sandbox, sandbox);
  });
}

test("an unidentified renewal cannot attach a new sandbox", async () => {
  await setLeaseOwner("worker-a", -60);
  await setSandbox(SAFE_SANDBOX);

  const res = await renew({ sandbox: AGENT_SANDBOX });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running" });
  const run = await storedRun();
  assert.equal(run.brain_id, "worker-a");
  assert.equal(run.lease_owner, "worker-a");
  assert.equal(run.sandbox_workload_id, SAFE_SANDBOX.handle);
  assert.deepEqual((run.metadata as Record<string, unknown>).sandbox, SAFE_SANDBOX);
});

const INVALID_SANDBOXES = [
  { label: "null", value: null },
  { label: "a string", value: "agent-sandbox" },
  { label: "an array", value: [AGENT_SANDBOX] },
  { label: "an unknown provider", value: { provider: "unknown", handle: "sandbox-a" } },
  { label: "a missing provider", value: { handle: "sandbox-a" } },
  { label: "a missing handle", value: { provider: "agent-sandbox" } },
  { label: "a numeric handle", value: { provider: "agent-sandbox", handle: 7 } },
  { label: "an empty handle", value: { provider: "safe-workload", handle: "" } },
  { label: "a blank handle", value: { provider: "agent-sandbox", handle: " \t " } },
  { label: "a current-directory handle", value: { provider: "safe-workload", handle: "." } },
  { label: "a parent-directory handle", value: { provider: "agent-sandbox", handle: ".." } },
  { label: "a control character", value: { provider: "safe-workload", handle: "workload\n" } },
  { label: "a delete character", value: { provider: "agent-sandbox", handle: "agent\u007f" } },
  { label: "an oversized handle", value: { provider: "safe-workload", handle: "x".repeat(1025) } },
];

for (const { label, value } of INVALID_SANDBOXES) {
  test(`a sandbox with ${label} is rejected before lease renewal`, async () => {
    const original = await storedRun();

    const res = await renew({ brain_id: "worker-a", sandbox: value });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().ok, false);
    assert.match(res.json().error, /sandbox\.provider.*safe-workload.*agent-sandbox/);
    assert.match(res.json().error, /sandbox\.handle.*non-empty string.*1024/);
    assert.deepEqual(await storedRun(), original);
  });
}

test("a handle at the maximum length remains an opaque value", async () => {
  const sandbox = { provider: "agent-sandbox", handle: ` /:${"x".repeat(1020)} ` };

  const res = await renew({ brain_id: "worker-a", sandbox });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running" });
  assert.deepEqual(((await storedRun()).metadata as Record<string, unknown>).sandbox, sandbox);
});

for (const successorBrain of ["worker-a", "worker-b"]) {
  test(`a takeover by ${successorBrain} between lease renewal and sandbox storage keeps the successor's identity`, async () => {
    await setLeaseOwner("worker-a", 600);
    await setSandbox(SAFE_SANDBOX);
    let successor: Record<string, unknown> | undefined;

    const res = await renewAtLeaseBoundary({ brain_id: "worker-a", sandbox: SAFE_SANDBOX }, {
      after: async () => {
        await h.sql("UPDATE claw_tasks SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE task_id = $1", [TASK_ID]);
        const takeover = await renew({
          brain_id: successorBrain, sandbox: AGENT_SANDBOX, attempt_id: "attempt-2", delivery_seq: 1,
        });
        assert.equal(takeover.statusCode, 200);
        assert.deepEqual(takeover.json(), { ok: true, status: "running" });
        successor = await storedRun();
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, status: "running" });
    assert.ok(successor);
    assert.equal(successor.brain_id, successorBrain);
    assert.deepEqual((successor.metadata as Record<string, unknown>).sandbox, AGENT_SANDBOX);
    assert.deepEqual(await storedRun(), successor);
  });
}

test("a run completed between lease renewal and sandbox storage keeps its last sandbox", async () => {
  await setLeaseOwner("worker-a", 600);
  await setSandbox(SAFE_SANDBOX);

  const res = await renewAtLeaseBoundary({ brain_id: "worker-a", sandbox: AGENT_SANDBOX }, {
    after: async () => {
      await h.sql("UPDATE claw_tasks SET status = 'completed' WHERE task_id = $1", [TASK_ID]);
    },
  });

  assert.equal(res.statusCode, 200);
  const run = await storedRun();
  assert.equal(run.status, "completed");
  assert.equal(run.sandbox_workload_id, SAFE_SANDBOX.handle);
  assert.deepEqual((run.metadata as Record<string, unknown>).sandbox, SAFE_SANDBOX);
});

test("an uncertain lease result cannot attach a sandbox even for the recorded owner", async () => {
  await setLeaseOwner("worker-a", 600);
  await setSandbox(SAFE_SANDBOX);
  const original = await storedRun();

  const res = await renewAtLeaseBoundary({ brain_id: "worker-a", sandbox: AGENT_SANDBOX }, {
    before: async () => { throw new Error("temporary database failure"); },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "unknown" });
  assert.deepEqual(await storedRun(), original);
});

test("a dispatched event keeps sandbox metadata consistent with its legacy workload field", async () => {
  await setSandbox(AGENT_SANDBOX);

  const res = await reportRunningEvent({
    brain_id: "worker-a", sandbox_workload_id: SAFE_SANDBOX.handle,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  const run = await storedRun();
  assert.equal(run.brain_id, "worker-a");
  assert.equal(run.sandbox_workload_id, SAFE_SANDBOX.handle);
  const metadata = run.metadata as Record<string, unknown>;
  assert.deepEqual(metadata.sandbox, SAFE_SANDBOX);
  assert.equal(metadata.context, "retained");
});

test("a dispatched event without a workload preserves the existing sandbox", async () => {
  await setSandbox(AGENT_SANDBOX);

  const res = await reportRunningEvent({ brain_id: "worker-a" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  const run = await storedRun();
  assert.equal(run.brain_id, "worker-a");
  assert.equal(run.sandbox_workload_id, null);
  assert.deepEqual((run.metadata as Record<string, unknown>).sandbox, AGENT_SANDBOX);
});

test("sandbox metadata from older rows can be absent or malformed", () => {
  for (const value of [undefined, ...INVALID_SANDBOXES.map(({ value }) => value)]) {
    assert.equal(parseSandboxHandle(value), null);
  }
  assert.deepEqual(parseSandboxHandle(SAFE_SANDBOX), SAFE_SANDBOX);
  assert.deepEqual(parseSandboxHandle(AGENT_SANDBOX), AGENT_SANDBOX);
});
