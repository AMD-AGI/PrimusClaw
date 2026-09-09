// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { newRunTimeLedgerEntry } from "@claw/protocol";
import { db } from "../src/infra/db.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { registerInternalRunRoutes } from "../src/routes/internal-runs.js";
import { claimRunById } from "../src/tasks/run-claim.js";
import { reapLostLeases, requeueLostDoorbellLeases } from "../src/tasks/sweeper.js";
import { startHarness, seedRun, seedSession, runRow, type Harness, type SeedRunOpts } from "./scenario-harness.js";

const CLUSTER_TOKEN = "cluster-internal-token";
const LEASE_TOKEN = "legacy-run-token";
const SESSION = "lease-compat-session";
const BRAIN = "legacy-brain";
const LEGACY_RENEWAL = {
  brain_id: BRAIN, lease_seconds: 45, phase: "executing",
  wait_reason: null, waited_ms: 0, waits: 0,
};
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;
let h: Harness;
let app: FastifyInstance;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = CLUSTER_TOKEN;
  h = await startHarness();
  app = Fastify();
  await registerInternalTaskRoutes(app);
  await registerInternalRunRoutes(app);
  await app.ready();
});

after(async () => {
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await app.close();
  await h.close();
});

beforeEach(async () => { await h.reset(); await seedSession(h, SESSION); });

async function seedLegacyRun(taskId: string, options: SeedRunOpts = {}): Promise<void> {
  await seedRun(h, taskId, SESSION, {
    status: "running", dispatch: "fat", leaseOwner: BRAIN, leaseExpiresInSec: 45, ...options,
  });
  await h.sql("UPDATE claw_tasks SET internal_token_hash = $2 WHERE task_id = $1",
    [taskId, createHash("sha256").update(LEASE_TOKEN).digest("hex")]);
}

function post(taskId: string, action: string, body: Record<string, unknown>, bearer = CLUSTER_TOKEN) {
  return app.inject({
    method: "POST", url: `/v1/internal/tasks/${taskId}/${action}`,
    headers: { authorization: `Bearer ${bearer}` }, payload: body,
  });
}

function renew(taskId: string, bearer = LEASE_TOKEN, body: Record<string, unknown> = {}) {
  return post(taskId, "lease", { ...LEGACY_RENEWAL, ...body }, bearer);
}

async function claimDoorbell(taskId: string) {
  const claim = await claimRunById(taskId, BRAIN);
  assert.ok(typeof claim === "object" && "claimCount" in claim);
  assert.ok(claim.request.run_lease?.token);
  return { count: claim.claimCount, bearer: claim.request.run_lease.token };
}

const expireLease = (taskId: string) => h.sql(
  "UPDATE claw_tasks SET lease_expires_at = clock_timestamp() - INTERVAL '1 day' WHERE task_id = $1",
  [taskId]);

test("an old-shaped callback renews an existing run without banking ledger coverage", async () => {
  const taskId = "legacy-inflight";
  await seedLegacyRun(taskId);
  const ledger = newRunTimeLedgerEntry({ key: taskId, source: "task_id" }, new Date().toISOString());
  await h.sql("UPDATE claw_tasks SET metadata = metadata || $2::jsonb WHERE task_id = $1",
    [taskId, JSON.stringify({ run_phase: { ledger } })]);
  const before = await runRow(h, taskId);
  await expireLease(taskId);

  const res = await renew(taskId);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running" });
  assert.equal(await reapLostLeases(), 0, "the old worker is still alive after the API upgrades");
  const row = await runRow(h, taskId);
  assert.equal(row.lease_owner, BRAIN);
  assert.ok((row.lease_expires_at as Date) > new Date());
  assert.ok(row.heartbeat_at);
  assert.equal(row.attempt_id, null);
  assert.equal(Number(row.attempt_generation), 0);
  assert.equal(row.ledger_version, before.ledger_version);
  assert.equal(row.queued_ms_accrued, before.queued_ms_accrued);
  assert.deepEqual((row.metadata as { run_phase: { ledger: unknown } }).run_phase.ledger, ledger);
});

test("an old worker can open the first lease of a freshly dispatched fat run", async () => {
  const taskId = "legacy-first-lease";
  await seedLegacyRun(taskId, { status: "preparing", leaseOwner: null, leaseExpiresInSec: null });

  assert.equal((await renew(taskId)).statusCode, 200);

  const row = await runRow(h, taskId);
  assert.equal(row.status, "preparing");
  assert.equal(row.lease_owner, BRAIN);
  assert.equal(row.attempt_id, null);
  assert.equal(Number(row.attempt_generation), 0);
  assert.equal((row.metadata as { run_phase: { ledger?: unknown } }).run_phase.ledger, undefined);
});

test("an old doorbell holder renews with the bearer issued by its real claim", async () => {
  const taskId = "legacy-doorbell";
  await seedRun(h, taskId, SESSION, { claimable: true });
  const claim = await claimDoorbell(taskId);
  assert.equal(claim.count, 1);
  await expireLease(taskId);

  assert.equal((await renew(taskId, claim.bearer)).statusCode, 200);

  assert.equal(await requeueLostDoorbellLeases(), 0);
  assert.equal(Number((await runRow(h, taskId)).attempt_generation), 0);
  assert.equal((await renew(taskId, claim.bearer, { brain_id: "different-brain" })).statusCode, 409);
});

test("legacy renewal refuses a live rival and terminal rows", async () => {
  for (const state of ["rival", "completed", "cancelled"] as const) {
    const taskId = `legacy-${state}`;
    await seedLegacyRun(taskId, {
      status: state === "rival" ? "running" : state,
      leaseOwner: state === "rival" ? "different-brain" : BRAIN,
    });
    const before = await runRow(h, taskId);

    const res = await renew(taskId);

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().reason, state === "rival" ? "superseded" : "terminal");
    assert.deepEqual(await runRow(h, taskId), before);
  }
});

test("legacy fat redelivery can take over an expired lease", async () => {
  const taskId = "legacy-fat-redelivery";
  await seedLegacyRun(taskId, { leaseOwner: "different-brain", leaseExpiresInSec: -45 });

  assert.equal((await renew(taskId)).statusCode, 200);

  assert.equal((await runRow(h, taskId)).lease_owner, BRAIN);
});

test("cluster authentication alone cannot bypass the legacy claim fence", async () => {
  const taskId = "legacy-cluster-token";
  await seedLegacyRun(taskId);
  const before = await runRow(h, taskId);

  assert.equal((await renew(taskId, CLUSTER_TOKEN)).statusCode, 409);

  assert.deepEqual(await runRow(h, taskId), before);
});

test("partial modern tokens and tokenless coverage never enter the legacy bridge", async () => {
  const taskId = "legacy-partial-token";
  await seedLegacyRun(taskId);
  const before = await runRow(h, taskId);
  for (const [field, value] of Object.entries({
    attempt_id: "att-1", claim_count: 0, delivery_seq: 0, delivery_count: 0, run_time: {},
  })) {
    for (const supplied of [value, null]) {
      const res = await renew(taskId, LEASE_TOKEN, { [field]: supplied });
      assert.equal(res.statusCode, 400, `${field}=${JSON.stringify(supplied)} is not an old callback`);
    }
  }
  assert.deepEqual(await runRow(h, taskId), before);
});

test("claim token rotation after authentication still rejects the old legacy renewal", async () => {
  const taskId = "legacy-auth-race";
  await seedRun(h, taskId, SESSION, { claimable: true });
  const first = await claimDoorbell(taskId);
  assert.equal((await renew(taskId, first.bearer)).statusCode, 200);
  let current: Awaited<ReturnType<typeof claimDoorbell>> | undefined;
  let held: Record<string, unknown> | undefined;
  const realQuery = db.query;
  db.query = (async (sql: string, params?: unknown[]) => {
    const result = await realQuery(sql, params);
    if (sql.includes("SELECT internal_token_hash, callback_url") && params?.[0] === taskId) {
      db.query = realQuery;
      await expireLease(taskId);
      assert.equal(await requeueLostDoorbellLeases(), 1);
      current = await claimDoorbell(taskId);
      held = await runRow(h, taskId);
    }
    return result;
  }) as typeof db.query;
  let res;
  try {
    res = await renew(taskId, first.bearer);
  } finally {
    db.query = realQuery;
  }

  assert.ok(current && held);
  assert.equal(current.count, 2);
  assert.equal(res.statusCode, 409, "the old bearer passed auth before the claim rotated it");
  assert.deepEqual(await runRow(h, taskId), held);
  assert.equal((await renew(taskId, first.bearer)).statusCode, 401);
  assert.equal((await renew(taskId, current.bearer)).statusCode, 200);
});

for (const allocation of ["ownership", "renewal"] as const) {
  test(`modern ${allocation} closes the legacy bridge permanently across release and reclaim`, async () => {
    const taskId = `legacy-after-${allocation}`;
    await seedRun(h, taskId, SESSION, { claimable: true });
    const first = await claimDoorbell(taskId);
    const token = { attempt_id: "att-1", claim_count: first.count, delivery_seq: 0, delivery_count: 0 };
    const allocated = allocation === "renewal"
      ? await renew(taskId, first.bearer, token)
      : await post(taskId, "event", { ...token, brain_id: BRAIN, type: "statusUpdate", agent_status: "running" });
    assert.equal(allocated.statusCode, 200);
    assert.equal((await post(taskId, "unclaim", { brain_id: BRAIN, claim_count: first.count })).statusCode, 200);
    const second = await claimDoorbell(taskId);
    const held = await runRow(h, taskId);
    assert.equal(held.attempt_id, null);
    assert.equal(held.settled_attempt_id, null);
    assert.equal(Number(held.attempt_generation), 1);

    assert.equal((await renew(taskId, second.bearer)).statusCode, 409);

    assert.deepEqual(await runRow(h, taskId), held);
    assert.equal((await renew(taskId, second.bearer, { ...token, attempt_id: "att-2", claim_count: second.count })).statusCode, 200);
  });
}

test("a late legacy callback cannot restore a settled modern fat attempt", async () => {
  const taskId = "legacy-after-settle";
  await seedLegacyRun(taskId);
  const token = { attempt_id: "att-1", claim_count: 0, delivery_seq: 0, delivery_count: 0 };
  assert.equal((await renew(taskId, LEASE_TOKEN, token)).statusCode, 200);
  assert.equal((await post(taskId, "settle-attempt", {
    brain_id: BRAIN, claim_count: 0, release_lease: true,
  })).statusCode, 200);
  const settled = await runRow(h, taskId);
  assert.equal(settled.attempt_id, null);
  assert.equal(settled.settled_attempt_id, token.attempt_id);

  assert.equal((await renew(taskId)).statusCode, 409);

  assert.deepEqual(await runRow(h, taskId), settled);
});
