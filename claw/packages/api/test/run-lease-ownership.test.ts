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

/** The row's physical tuple, which a write replaces even when no value changes. */
async function rowVersion(): Promise<unknown> {
  const rows = await h.sql("SELECT ctid::text AS version FROM claw_tasks WHERE task_id = $1", [TASK_ID]);
  assert.equal(rows.length, 1);
  return rows[0]!.version;
}

/**
 * Renew, reading the row's tuple either side of the sandbox write itself.
 *
 * The statements around it write the row too -- the renewal ahead of it, the
 * run-time ledger behind it -- so the tuple has to be read where the write is,
 * not where the request ends.
 */
async function renewAroundSandboxWrite(body: Record<string, unknown>) {
  const query = db.query;
  let before: unknown;
  let after: unknown;
  db.query = (async (sql: string, params?: unknown[]) => {
    if (!(sql.includes("'{sandbox}'") && sql.includes("FOR UPDATE"))) return query(sql, params);
    before = await rowVersion();
    const result = await query(sql, params);
    after = await rowVersion();
    return result;
  }) as typeof db.query;
  try {
    const res = await renew(body);
    return { res, before, after };
  } finally {
    db.query = query;
  }
}

/** Accept the delivery the way a fat chat row's first lease does. */
async function acceptDelivery(brainId = "worker-a") {
  const res = await postTaskRoute("lease", { brain_id: brainId, lease_seconds: 45, accept: true });
  assert.equal(res.statusCode, 200);
  return res.json() as { claim_count: number };
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
    // A pristine fat chat row's first lease is an acceptance, not a renewal,
    // and an acceptance issues the generation it answers with -- so the body
    // carries the `claim_count` this holder must quote from here on.
    assert.deepEqual(res.json(), { ok: true, status: "running", claim_count: 1 });
    const run = await storedRun();
    // The acceptance records the holder in `lease_owner` only. `brain_id` is
    // the executing worker and is stamped by the first renewal or by the
    // `running` status event -- acquireFatLease deliberately claims neither it
    // nor an `attempt_id`, because accepting a delivery is not yet running it.
    assert.equal(run.lease_owner, "worker-a");
    assert.equal(run.brain_id, null);
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
  test(`a sandbox with ${label} is dropped without refusing the renewal`, async () => {
    await setLeaseOwner("worker-a", 600);
    await setSandbox(SAFE_SANDBOX);
    const original = await storedRun();

    const res = await renew({ brain_id: "worker-a", sandbox: value });

    // The lease is the request; the sandbox names what is running it. Answered
    // 400, this renewal reaches `askRunLease` as `unresolved`, the worker
    // never renews again, and a healthy run is reaped as `worker_lost` over a
    // field that only ever fed a diagnostic.
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, status: "running" });
    const run = await storedRun();
    // Renewed, on this worker's own lease rather than the 600s one it had.
    assert.notDeepEqual(run.lease_expires_at, original.lease_expires_at);
    assert.equal(run.lease_live, true);
    // And dropped rather than stored: nothing unparsed reached the row.
    assert.equal(run.sandbox_workload_id, SAFE_SANDBOX.handle);
    assert.deepEqual((run.metadata as Record<string, unknown>).sandbox, SAFE_SANDBOX);
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

  // An undecided write is answered 5xx rather than a 2xx carrying
  // `status: "unknown"`: `askRunLease` reads any 2xx as `{kind: "granted"}`
  // whatever the status says, so a 200 here would hand a delivery a lease
  // nobody granted. A 5xx classifies as `unresolved`, which is what this is.
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { ok: false, status: "unknown" });
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

// A fat chat delivery is accepted before any attempt exists, so the acceptance
// is what mints the row's generation and the Brain's attempt token carries a
// zero for the whole turn. Fencing the sandbox write on that zero is fencing
// on a generation the row stopped carrying at acceptance.
test("a fat delivery's first heartbeat records the sandbox it is holding", async () => {
  const accepted = await acceptDelivery("worker-a");
  assert.equal(accepted.claim_count, 1);

  const res = await renew({
    brain_id: "worker-a", run_claim: accepted.claim_count, sandbox: SAFE_SANDBOX,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running" });
  const run = await storedRun();
  assert.equal(run.sandbox_workload_id, SAFE_SANDBOX.handle);
  assert.deepEqual((run.metadata as Record<string, unknown>).sandbox, SAFE_SANDBOX);
});

test("a fat delivery's later heartbeats keep the sandbox they recorded", async () => {
  const accepted = await acceptDelivery("worker-a");
  await renew({ brain_id: "worker-a", run_claim: accepted.claim_count, sandbox: SAFE_SANDBOX });

  const second = await renew({
    brain_id: "worker-a", run_claim: accepted.claim_count, sandbox: SAFE_SANDBOX,
  });

  assert.equal(second.statusCode, 200);
  const run = await storedRun();
  assert.equal(run.sandbox_workload_id, SAFE_SANDBOX.handle);
  assert.deepEqual((run.metadata as Record<string, unknown>).sandbox, SAFE_SANDBOX);
});

test("a heartbeat repeating the recorded sandbox leaves the row's tuple alone", async () => {
  const accepted = await acceptDelivery("worker-a");
  const first = await renewAroundSandboxWrite({
    brain_id: "worker-a", run_claim: accepted.claim_count, sandbox: SAFE_SANDBOX,
  });
  assert.equal(first.res.statusCode, 200);
  // The handle was not there and the write put it there.
  assert.notEqual(first.before, undefined);
  assert.notEqual(first.after, first.before);

  const second = await renewAroundSandboxWrite({
    brain_id: "worker-a", run_claim: accepted.claim_count, sandbox: SAFE_SANDBOX,
  });

  assert.equal(second.res.statusCode, 200);
  // Renewals arrive every few seconds for the whole fleet and the handle
  // changes at most once a turn: repeating it must leave no new tuple version.
  assert.notEqual(second.before, undefined);
  assert.equal(second.after, second.before);
  assert.equal((await storedRun()).sandbox_workload_id, SAFE_SANDBOX.handle);
});

test("an acceptance taking over a settled attempt records its sandbox", async () => {
  // What a fat retry leaves behind: the lease released, the spent attempt
  // remembered, and a generation already issued. `acquireFatLease` clears
  // `attempt_id` and none of the rest, so a fence reading the generation or
  // the settled attempt as evidence of "no attempt open" refuses the taker.
  await h.sql(
    `UPDATE claw_tasks
        SET lease_owner = NULL,
            lease_expires_at = NOW() - INTERVAL '1 second',
            claim_count = 1,
            attempt_generation = 1,
            attempt_id = NULL,
            settled_attempt_id = 'attempt-1',
            metadata = jsonb_build_object('lease_fenced', true)
      WHERE task_id = $1`,
    [TASK_ID],
  );

  const res = await postTaskRoute("lease", {
    brain_id: "worker-b", lease_seconds: 45, accept: true, sandbox: SAFE_SANDBOX,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running", claim_count: 2 });
  const run = await storedRun();
  assert.equal(run.sandbox_workload_id, SAFE_SANDBOX.handle);
  assert.deepEqual((run.metadata as Record<string, unknown>).sandbox, SAFE_SANDBOX);
});

// A pre-gate acceptance is the fat chat row's first lease, and it names no
// sandbox: `createFatPreGate`'s body() sets no such field, and nothing is
// provisioned before the execution gate. This pins the shape the acquisition's
// sandbox write is commented against, so a Brain that starts sending one -- or
// a change that deletes the write on the grounds that nobody does -- is visible
// here rather than as a handle that quietly stops being recorded.
test("a pre-gate acceptance records no sandbox, because it names none", async () => {
  const res = await postTaskRoute("lease", {
    brain_id: "worker-a", lease_seconds: 45, phase: "waiting", waited_ms: 0, waits: 0,
    accept: true,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running", claim_count: 1 });
  const run = await storedRun();
  assert.equal(run.lease_owner, "worker-a");
  assert.equal(run.sandbox_workload_id, null);
  assert.equal((run.metadata as Record<string, unknown>).sandbox, undefined);
});

// `renewLegacyRunLease` writes `brain_id = $2` and `lease_owner = $2` bare,
// with no COALESCE, so a renewal that reached it without naming a worker would
// NULL both. Nothing can: a body with no attempt token is routed there only by
// `isLegacyRunLease`, which demands a non-blank string. These are the shapes
// that would otherwise arrive, refused at the route before either statement --
// which is the guarantee the bare bind rests on, and the reason it is not a
// COALESCE.
for (const [label, brainId] of [
  ["omits brain_id", undefined],
  ["sends a null brain_id", null],
  ["sends an empty brain_id", ""],
  ["sends a blank brain_id", " \t "],
  ["sends a non-string brain_id", 7],
] as const) {
  test(`a legacy renewal that ${label} cannot clear the recorded worker`, async () => {
    // Lapsed, which is the shape the legacy bridge's takeover arm accepts: if
    // one of these bodies ever reached the statement, it would match there and
    // write both identity columns NULL.
    await setLeaseOwner("worker-a", -60);
    await setSandbox(SAFE_SANDBOX);
    const original = await storedRun();

    const res = await postTaskRoute("lease", {
      lease_seconds: 45,
      ...(brainId === undefined ? {} : { brain_id: brainId }),
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), {
      ok: false, error: "attempt token incomplete: attempt_id is required",
    });
    // Nothing was written at all: not the identity, not the lease it would
    // have extended on its way to clearing one.
    assert.deepEqual(await storedRun(), original);
  });
}

test("the writer that records a handle records the attempt beside it", async () => {
  // The invariant, asserted on the WRITER. A row outlives its attempts, so a
  // handle recorded without the attempt that minted it is a handle the next
  // attempt inherits -- and the backfill then credits it with that attempt's
  // node, exit code and preemption.
  //
  // This test exists because the reader's guard shipped without it and was
  // inert: `writeRunOwnership` lands first with the same handle bytes, so the
  // lease writer's change predicate saw nothing to do and the attempt was never
  // stamped. Nothing in the suite asserted that any writer produced the field,
  // so the guard passed its own tests while never firing in production.
  const res = await reportRunningEvent({
    brain_id: "worker-a", attempt_id: "attempt-1",
    sandbox_workload_id: SAFE_SANDBOX.handle,
  });
  assert.equal(res.statusCode, 200);

  const run = await storedRun();
  assert.equal(run.sandbox_workload_id, SAFE_SANDBOX.handle);
  const metadata = run.metadata as Record<string, unknown>;
  assert.deepEqual(metadata.sandbox, SAFE_SANDBOX);
  assert.equal(
    metadata.sandbox_attempt, "attempt-1",
    "the handle and its attempt have to arrive together, or the reader's guard "
    + "has nothing to compare and silently permits the inheritance",
  );
});

test("and a later attempt reusing the same handle re-stamps it", async () => {
  // Why comparing the handle pair alone was not enough: a redelivery that
  // reuses the SAME sandbox writes an identical handle, so a predicate keyed on
  // the handle sees no change and leaves the previous attempt's stamp in place
  // -- which then refuses this row's own legitimate handle.
  await reportRunningEvent({
    brain_id: "worker-a", attempt_id: "attempt-1",
    sandbox_workload_id: SAFE_SANDBOX.handle,
  });
  await reportRunningEvent({
    brain_id: "worker-a", attempt_id: "attempt-2",
    sandbox_workload_id: SAFE_SANDBOX.handle,
  });

  const metadata = (await storedRun()).metadata as Record<string, unknown>;
  assert.equal(
    metadata.sandbox_attempt, "attempt-2",
    "the stamp follows the attempt that now owns the row",
  );
});

test("an ownership report with no attempt does not clear a valid stamp", async () => {
  // Reverted once, reintroduced, and reproduced end to end against Postgres:
  // attempt A records handle W and its stamp; an ownership report arrives for
  // the same handle carrying no attempt_id; the stamp is nulled; B settles; the
  // backfill then reads W -- A's workload -- and writes A's node and exit code
  // onto B's row. The reader treats a JSON null as pre-rollout data and permits
  // it, so nulling a stamp is not neutral: it switches the guard off.
  //
  // The handle is unchanged here, so the stamp still describes the handle the
  // row carries. Absent is not a correction.
  await reportRunningEvent({
    brain_id: "worker-a", attempt_id: "attempt-1",
    sandbox_workload_id: SAFE_SANDBOX.handle,
  });
  await reportRunningEvent({
    brain_id: "worker-a", sandbox_workload_id: SAFE_SANDBOX.handle,
  });

  const metadata = (await storedRun()).metadata as Record<string, unknown>;
  assert.equal(
    metadata.sandbox_attempt, "attempt-1",
    "a report that cannot name an attempt may not erase the one on record",
  );
});

test("but a NEW handle with no attempt drops the stamp that described the old one", async () => {
  // The other direction, and why "leave it alone" is not the whole rule. A
  // stamp naming attempt A beside a handle A never held is worse than no stamp:
  // the guard refuses the row's own legitimate handle and the ending is never
  // recorded at all. Reproduced as handle C / stamp A / settled C.
  await reportRunningEvent({
    brain_id: "worker-a", attempt_id: "attempt-1",
    sandbox_workload_id: SAFE_SANDBOX.handle,
  });
  await reportRunningEvent({
    brain_id: "worker-a", sandbox_workload_id: "workload-replacement",
  });

  const metadata = (await storedRun()).metadata as Record<string, unknown>;
  assert.deepEqual(
    metadata.sandbox, { provider: "safe-workload", handle: "workload-replacement" },
    "the new handle is recorded",
  );
  assert.equal(
    metadata.sandbox_attempt, undefined,
    "and the stamp that described the handle it replaced goes with it",
  );
});
