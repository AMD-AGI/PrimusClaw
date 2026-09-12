// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The soft ceiling is raceable across two rows, not just two claimers of one.
 *
 * Two claimers of the same row are already refused by the CAS: exactly one
 * UPDATE matches. Two claimers of *different* queued rows contend for headroom
 * instead, and nothing about the rows refuses them -- so a usage read and a
 * claim in separate statements let both read "one slot free" before either
 * writes, and two roots prepare over a ceiling of one.
 *
 * The contention is produced rather than hoped for, and Postgres is the witness
 * both times. One case takes the admission lock on a separate connection and
 * holds it until `pg_locks` reports both claimers *waiting* on it; a claim path
 * that never takes the lock blocks nobody and fails there. The other parks the
 * first claim inside its own critical section with a row lock its CAS must
 * wait for, and requires the second claimer to be blocked on the admission lock
 * while that is true -- which is only so if the read and the CAS are one
 * transaction. Release the read early and the second claimer sails past it into
 * a fleet that still looks empty, and claims a second root.
 *
 * The same transaction owes one more thing. A queue exit is a metric, and
 * nothing rolls a metric back, so recording the claim inside the transaction
 * reports a row as claimed that a failed `COMMIT` left at `queued`.
 *
 * A server, because a held advisory lock has to be contended by other sessions
 * and PGlite has one connection.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import type pg from "pg";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

/** How long to wait for Postgres to report the claimers as blocked. */
const BLOCKED_TIMEOUT_MS = 10_000;

type Harness = () => AdmissionCluster;

const queryOn = (h: AdmissionCluster) =>
  (sql: string, params: unknown[] = []) => h.app.db.db.query(sql, params);

/** A queued doorbell chat row of its own run-tree root, claimable as-is. */
async function seedQueuedDoorbell(
  h: AdmissionCluster, taskId: string, sessionId: string,
): Promise<void> {
  const query = queryOn(h);
  const { sealRunCredentials } = await import("../src/tasks/run-secrets.js");
  await query(
    `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status)
     VALUES ($1, 'turn', 'u-race', 'claw', 'running')`,
    [sessionId],
  );
  await query(
    `INSERT INTO claw_tasks (
       task_id, session_id, name, status, origin, executor, prompt, input, metadata,
       claim_count, created_at, queued_at
     ) VALUES (
       $1, $2, 'chat turn', 'queued', 'chat', 'brain', 'hello', $3::jsonb,
       jsonb_build_object('dispatch','doorbell','message_id',$4::text,'doorbell_semantics',1),
       0, NOW(), NOW()
     )`,
    [
      taskId, sessionId,
      JSON.stringify({
        prompt: "hello",
        user_id: "u-race",
        credentials: sealRunCredentials({ llm_api_key: "sk-test", platform_key: "pk-test" }),
      }),
      `m-${taskId}`,
    ],
  );
}

async function seedPair(h: AdmissionCluster, a: string, b: string): Promise<void> {
  const query = queryOn(h);
  await query("DELETE FROM claw_tasks");
  await query("DELETE FROM claw_sessions WHERE user_id = 'u-race'");
  await seedQueuedDoorbell(h, a, `s-${a}`);
  await seedQueuedDoorbell(h, b, `s-${b}`);
}

/** Backends parked on an advisory lock somebody else holds. */
async function advisoryWaiters(h: AdmissionCluster): Promise<number> {
  const r = await queryOn(h)(
    "SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
  );
  return Number((r.rows[0] as { n: number }).n);
}

/** Backends parked on a row another transaction is holding. */
async function rowWaiters(h: AdmissionCluster): Promise<number> {
  const r = await queryOn(h)(
    "SELECT COUNT(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype <> 'advisory'",
  );
  return Number((r.rows[0] as { n: number }).n);
}

/**
 * Wait until `probe` reports `want` blocked backends, or fail saying what did not.
 *
 * Failing rather than proceeding is the point: every case here is about a
 * claimer being unable to run, and continuing on a timeout would turn the
 * absence of that block into a passing race.
 */
async function awaitBlocked(
  probe: () => Promise<number>, want: number, what: string,
): Promise<void> {
  const deadline = Date.now() + BLOCKED_TIMEOUT_MS;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = await probe();
    if (seen >= want) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`expected ${want} backends ${what}, saw ${seen}`);
}

/** `Promise.allSettled` for one promise, attached now so nothing goes unhandled. */
const settle = <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> => p.then(
  (value) => ({ status: "fulfilled", value } as const),
  (reason: unknown) => ({ status: "rejected", reason } as const),
);

const verdictOf = (r: PromiseSettledResult<unknown>): string => {
  assert.equal(r.status, "fulfilled", `the claim threw: ${(r as PromiseRejectedResult).reason}`);
  const value = (r as PromiseFulfilledResult<unknown>).value;
  return typeof value === "string" ? value : "claimed";
};

const executingRoots = async (h: AdmissionCluster): Promise<number> => Number(
  ((await queryOn(h)(
    `SELECT COUNT(DISTINCT COALESCE(dag_root_task_id, task_id))::int AS n FROM claw_tasks
      WHERE status IN ('preparing','running','cancelling')`,
  )).rows[0] as { n: number }).n,
);

/**
 * Start both claims behind a held admission lock, then release them together.
 *
 * `holder` owns the lock for as long as this takes; the claims cannot begin
 * their own critical section until it commits, so the moment they are released
 * is one instant for both.
 */
async function raceBehindHeldLock(
  h: AdmissionCluster, holder: pg.Client, a: string, b: string,
): Promise<string[]> {
  await holder.query("BEGIN");
  try {
    await holder.query("SELECT pg_advisory_xact_lock($1)", [h.app.admission.ADMISSION_LOCK_KEY]);
    const claims = Promise.allSettled([
      h.app.runClaim.claimRunById(a, "brain-a"),
      h.app.runClaim.claimRunById(b, "brain-b"),
    ]);
    await awaitBlocked(
      () => advisoryWaiters(h), 2,
      "blocked on the admission lock: the claim path is not taking it",
    );
    await holder.query("COMMIT");
    return (await claims).map(verdictOf);
  } finally {
    // A case that failed before its COMMIT still holds the lock, and every
    // later case would then time out instead of reporting its own verdict.
    await holder.query("ROLLBACK").catch(() => {});
  }
}

function registerLockContentionCases(harness: Harness, holder: () => pg.Client): void {
  test("both claimers block on the admission lock while it is held elsewhere", async () => {
    const h = harness();
    await seedPair(h, "held-a", "held-b");
    assert.equal(await advisoryWaiters(h), 0, "nothing is contended before the race");

    const verdicts = await raceBehindHeldLock(h, holder(), "held-a", "held-b");

    assert.deepEqual([...verdicts].sort(), ["claimed", "deferred"], "one is taken, one waits");
    assert.equal(await executingRoots(h), 1, "one root prepares against a ceiling of one");
  });

  test("the lock is given back, so a later claim is never left waiting", async () => {
    const h = harness();
    await seedPair(h, "freed-a", "freed-b");
    await raceBehindHeldLock(h, holder(), "freed-a", "freed-b");

    assert.equal(await advisoryWaiters(h), 0, "no backend still parked on the lock");
    // A row that does not exist still takes the lock on its way to the verdict,
    // so answering at all is the proof that the race gave the lock back.
    const third = await h.app.runClaim.claimRunById("no-such-row", "brain-c");
    assert.equal(third, "missing");
  });
}

/**
 * A claim parked mid-CAS still owns the admission lock, so nobody reads past it.
 *
 * The row lock is what makes this deterministic. It stops the first claim
 * between its usage read and its write, and only a claim whose read and write
 * share one transaction is still holding the admission lock at that moment.
 */
function registerCriticalSectionCases(harness: Harness, rowLocker: () => pg.Client): void {
  test("a claim blocked mid-write still holds the lock, so the second claimer waits", async () => {
    const h = harness();
    await seedPair(h, "cas-a", "cas-b");
    await rowLocker().query("BEGIN");
    let verdicts: string[];
    try {
      await rowLocker().query("SELECT 1 FROM claw_tasks WHERE task_id = 'cas-a' FOR UPDATE");

      const first = settle(h.app.runClaim.claimRunById("cas-a", "brain-a"));
      await awaitBlocked(() => rowWaiters(h), 1, "waiting to write the row they claimed");

      const second = settle(h.app.runClaim.claimRunById("cas-b", "brain-b"));
      await awaitBlocked(
        () => advisoryWaiters(h), 1,
        "blocked on the admission lock while the first claim is mid-write: "
        + "the read and the write are not one transaction",
      );

      await rowLocker().query("COMMIT");
      verdicts = (await Promise.all([first, second])).map(verdictOf);
    } finally {
      await rowLocker().query("ROLLBACK").catch(() => {});
    }

    assert.deepEqual([...verdicts].sort(), ["claimed", "deferred"]);
    assert.equal(await executingRoots(h), 1, "the second claimer read the first one's row");
  });
}

function registerDeferralCases(harness: Harness, holder: () => pg.Client): void {
  test("the deferred row keeps its generation and is taken once a slot frees", async () => {
    const h = harness();
    await seedPair(h, "wait-a", "wait-b");

    const verdicts = await raceBehindHeldLock(h, holder(), "wait-a", "wait-b");
    const deferred = verdicts[0] === "deferred" ? "wait-a" : "wait-b";
    const claimed = deferred === "wait-a" ? "wait-b" : "wait-a";

    const parked = (await queryOn(h)(
      "SELECT status, lease_owner, claim_count FROM claw_tasks WHERE task_id = $1",
      [deferred],
    )).rows[0] as { status: string; lease_owner: string | null; claim_count: number };
    assert.equal(parked.status, "queued", "a deferral is not a refusal");
    assert.equal(parked.lease_owner, null);
    assert.equal(parked.claim_count, 0, "a deferred row spends no generation");

    await queryOn(h)(
      "UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = $1",
      [claimed],
    );
    const second = await h.app.runClaim.claimRunById(deferred, "brain-c");
    assert.notEqual(typeof second, "string", "the freed slot admits the row that waited");
    assert.equal(await executingRoots(h), 1);
  });
}

/** The value of one counter sample, by family and labels. */
async function sampleOf(
  h: AdmissionCluster, name: string, labels: Record<string, string>,
): Promise<number> {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of (await h.app.metrics.registry.metrics()).split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    const head = line.slice(0, line.lastIndexOf(" "));
    if (!wanted.every((pair) => head.includes(pair))) continue;
    return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return 0;
}

/**
 * Fail the transaction's `COMMIT`, leaving everything before it succeeding.
 *
 * Every other call is forwarded with its arguments untouched, callback form
 * included: `pool.query` checks a connection out through here too, and a
 * wrapper that answered it with a promise alone would never call it back.
 */
function failNextCommit(h: AdmissionCluster): () => void {
  const pool = h.app.db.db.pool;
  const original = pool.connect;
  pool.connect = (async () => {
    const client = await original.call(pool);
    const clientQuery = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      const first = args[0];
      const text = typeof first === "string" ? first : String((first as { text?: string })?.text ?? "");
      if (/^COMMIT/.test(text.trim())) return Promise.reject(new Error("commit refused"));
      return clientQuery(...args);
    }) as typeof client.query;
    return client;
  }) as typeof pool.connect;
  return () => { pool.connect = original; };
}

function registerCommitOrderingCases(harness: Harness): void {
  test("a claim whose commit fails records no queue exit and leaves the row queued", async () => {
    const h = harness();
    await seedPair(h, "uncommitted-a", "uncommitted-b");
    const EXITED = "claw_api_run_queue_exited_total";
    const before = await sampleOf(h, EXITED, { outcome: "claimed" });

    const restore = failNextCommit(h);
    try {
      await assert.rejects(
        () => h.app.runClaim.claimRunById("uncommitted-a", "brain-a"),
        /commit refused/,
      );
    } finally {
      restore();
    }

    const row = (await queryOn(h)(
      "SELECT status FROM claw_tasks WHERE task_id = $1", ["uncommitted-a"],
    )).rows[0] as { status: string };
    assert.equal(row.status, "queued", "the rollback put the claim back");
    assert.equal(
      await sampleOf(h, EXITED, { outcome: "claimed" }), before,
      "so nothing left the queue, and nothing says it did",
    );
  });
}

describe("one soft run slot admits one of two queued rows", { skip }, () => {
  let harness: AdmissionCluster;
  let holder: pg.Client;
  let rowLocker: pg.Client;

  before(async () => {
    harness = await startAdmissionCluster({ ADMIT_SOFT_RUNS: "1" });
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    holder = await harness.connect();
    rowLocker = await harness.connect();
    // The rebuild reads `claw_conversation_turns` and the announcement
    // publishes; neither is what this file is about, and both would need a
    // NATS the cluster has no reason to boot.
    harness.app.runClaim.runClaimPorts.buildHistory = async () => [];
    harness.app.runClaim.runClaimPorts.publishSessionEvent = async () => {};
  });
  after(async () => { await harness?.stop(); });

  registerLockContentionCases(() => harness, () => holder);
  registerCriticalSectionCases(() => harness, () => rowLocker);
  registerDeferralCases(() => harness, () => holder);
  registerCommitOrderingCases(() => harness);
});
