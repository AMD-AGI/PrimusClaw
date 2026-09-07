// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The soft ceiling is raceable across two rows, not just two claimers of one.
 *
 * Two claimers of the same row are already refused by the CAS: exactly one
 * UPDATE matches. Two claimers of *different* queued rows contend for headroom
 * instead, and nothing about the rows refuses them -- so if the usage read and
 * the claim are separate statements, both read "one slot free" before either
 * writes, both claim, and two roots prepare over a ceiling of one.
 *
 * The interleaving is forced rather than hoped for: {@link rendezvous} holds
 * every usage read issued on a *pooled* connection until the other arrives,
 * which is the order that breaks a split read-then-claim. A read that shares
 * the claim's transaction never goes out that way, so with the fix in place no
 * claimer reaches the gate at all -- and that is asserted, because "the gate
 * was never reached" is the same statement as "the read and the claim are one
 * transaction".
 *
 * A server, because two connections must hold `pg_advisory_xact_lock` at once
 * and PGlite has one connection.
 */

import assert from "node:assert/strict";
import test, { after, afterEach, before, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

/** `loadUsageWithRoots`, and nothing else: only it aggregates the root set. */
const USAGE_READ = /array_agg\(DISTINCT COALESCE\(dag_root_task_id, task_id\)\)/;

/**
 * A gate `parties` callers pass together, or alone once `timeoutMs` elapses.
 *
 * The timeout is what lets the same probe assert both outcomes: a caller the
 * lock keeps from arriving must not deadlock the one already waiting.
 */
function rendezvous(parties: number, timeoutMs: number) {
  let arrived = 0;
  let open = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let timer: NodeJS.Timeout | undefined;
  return {
    async wait(): Promise<void> {
      if (++arrived >= parties) {
        clearTimeout(timer);
        open();
        return;
      }
      timer ??= setTimeout(open, timeoutMs);
      timer.unref?.();
      await gate;
    },
    arrived: () => arrived,
  };
}

describe("one soft run slot admits one of two queued rows", { skip }, () => {
  let harness: AdmissionCluster;
  let restore: (() => void) | null = null;

  before(async () => {
    harness = await startAdmissionCluster({ ADMIT_SOFT_RUNS: "1" });
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    // The rebuild reads `claw_conversation_turns` and the announcement
    // publishes; neither is what this file is about, and both would need a
    // NATS the cluster has no reason to boot.
    harness.app.runClaim.runClaimPorts.buildHistory = async () => [];
    harness.app.runClaim.runClaimPorts.publishSessionEvent = async () => {};
  });
  after(async () => { await harness?.stop(); });
  afterEach(() => { restore?.(); restore = null; });

  const query = (sql: string, params: unknown[] = []) => harness.app.db.db.query(sql, params);

  /**
   * Hold each pooled usage read at the gate until the other claimer's arrives.
   *
   * Only the pooled path: a usage read on a transaction the claim owns is the
   * shape under test, and pausing that one would stall a lock the other
   * claimer is already waiting behind.
   */
  function pauseUsageReads(gate: { wait(): Promise<void> }): void {
    const db = harness.app.db.db;
    const originalQuery = db.query;
    db.query = (async (text: string, params?: unknown[]) => {
      const result = await originalQuery.call(db, text, params);
      if (USAGE_READ.test(text)) await gate.wait();
      return result;
    }) as typeof db.query;
    restore = () => { db.query = originalQuery; };
  }

  /** A queued doorbell chat row of its own run-tree root, claimable as-is. */
  const seedQueuedDoorbell = async (taskId: string, sessionId: string) => {
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
  };

  const seedPair = async (a: string, b: string) => {
    await query("DELETE FROM claw_tasks");
    await query("DELETE FROM claw_sessions WHERE user_id = 'u-race'");
    await seedQueuedDoorbell(a, `s-${a}`);
    await seedQueuedDoorbell(b, `s-${b}`);
  };

  const executingRoots = async () => Number(
    ((await query(
      `SELECT COUNT(DISTINCT COALESCE(dag_root_task_id, task_id))::int AS n FROM claw_tasks
        WHERE status IN ('preparing','running','cancelling')`,
    )).rows[0] as { n: number }).n,
  );

  const verdict = (r: PromiseSettledResult<unknown>): string => {
    assert.equal(r.status, "fulfilled", `the claim threw: ${(r as PromiseRejectedResult).reason}`);
    const value = (r as PromiseFulfilledResult<unknown>).value;
    return typeof value === "string" ? value : "claimed";
  };

  const raceBoth = async (a: string, b: string) => {
    const gate = rendezvous(2, 400);
    pauseUsageReads(gate);
    const settled = await Promise.allSettled([
      harness.app.runClaim.claimRunById(a, "brain-a"),
      harness.app.runClaim.claimRunById(b, "brain-b"),
    ]);
    return { verdicts: settled.map(verdict), gate };
  };

  test("two rows racing one slot promote one root, not two", async () => {
    await seedPair("race-a", "race-b");

    const { verdicts, gate } = await raceBoth("race-a", "race-b");

    assert.deepEqual([...verdicts].sort(), ["claimed", "deferred"], "one is taken, one waits");
    assert.equal(await executingRoots(), 1, "one root prepares against a ceiling of one");
    assert.equal(
      gate.arrived(), 0,
      "neither usage read went out on a pooled connection, so each shares its claim",
    );
  });

  test("the deferred row keeps its generation and is taken once a slot frees", async () => {
    await seedPair("wait-a", "wait-b");

    const { verdicts } = await raceBoth("wait-a", "wait-b");
    const deferred = verdicts[0] === "deferred" ? "wait-a" : "wait-b";
    const claimed = deferred === "wait-a" ? "wait-b" : "wait-a";

    const parked = (await query(
      "SELECT status, lease_owner, claim_count FROM claw_tasks WHERE task_id = $1",
      [deferred],
    )).rows[0] as { status: string; lease_owner: string | null; claim_count: number };
    assert.equal(parked.status, "queued", "a deferral is not a refusal");
    assert.equal(parked.lease_owner, null);
    assert.equal(parked.claim_count, 0, "a deferred row spends no generation");

    await query(
      "UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = $1",
      [claimed],
    );
    const second = await harness.app.runClaim.claimRunById(deferred, "brain-c");
    assert.notEqual(typeof second, "string", "the freed slot admits the row that waited");
    assert.equal(await executingRoots(), 1);
  });
});
