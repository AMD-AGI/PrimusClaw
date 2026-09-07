// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Run time accounting against a real Postgres.
 *
 * The rules these exercise are all about statements: which of them bank queue
 * time, which renewals a row accepts, and whether a merge and the transition
 * beside it commit together. A test that asserted on SQL text would pass for
 * every one of them while the predicate matched the wrong rows, so these run
 * the statements and read the rows back.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mergeRunTimeReport, runTimeTotals, type RunTimeLedgerEntry } from "@claw/protocol";
import { db, inTransaction } from "../src/infra/db.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { registerInternalRunRoutes } from "../src/routes/internal-runs.js";
import { releaseClaim } from "../src/tasks/run-claim.js";
import { applyTaskStatusTransition, transitionStatus } from "../src/tasks/db.js";
import { cancelTask } from "../src/tasks/lifecycle.js";
import { interruptUnstartedChatRuns } from "../src/tasks/chat-run.js";
import { reapExpiredQueuedRuns } from "../src/tasks/sweeper.js";
import { RUN_QUEUE_MAX_SEC } from "../src/tasks/run-budget.js";
import { applyAgentDone, retryTask } from "../src/tasks/lifecycle.js";
import {
  applyToLedger, mergeRenewal, openAttemptRecordFor, settleTerminalRuns,
} from "../src/tasks/run-time-ledger.js";
import { reapLostLeases } from "../src/tasks/sweeper.js";
import { startHarness, seedRun, seedSession, runRow, type Harness } from "./scenario-harness.js";

const TOKEN = "cluster-internal-token";
const SESSION = "s-acct";
const BRAIN = "brain-1";

let h: Harness;
let app: FastifyInstance;
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TokenFields {
  attempt_id?: string; claim_count?: number; delivery_seq?: number; delivery_count?: number;
}

async function renew(taskId: string, body: Record<string, unknown> & TokenFields) {
  return app.inject({
    method: "POST",
    url: `/v1/internal/tasks/${taskId}/lease`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: BRAIN, lease_seconds: 45, phase: "executing", ...body },
  });
}

function coverage(taskId: string, attemptId: string, token: TokenFields, executingMs: number) {
  return {
    key: taskId,
    attemptId,
    claimCount: token.claim_count ?? 0,
    deliverySeq: token.delivery_seq ?? 0,
    deliveryCount: token.delivery_count ?? 0,
    basis: { kind: "same_domain", domain: "brain" },
    cumulativeStateMs: { executing: executingMs },
  };
}

/** The running signal a brain sends when its attempt starts executing. */
async function announceRunning(
  taskId: string, attemptId: string, token: TokenFields = {},
): Promise<number> {
  const res = await app.inject({
    method: "POST", url: `/v1/internal/tasks/${taskId}/event`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {
      type: "statusUpdate", agent_status: "running", brain_id: BRAIN,
      attempt_id: attemptId, claim_count: token.claim_count ?? 0,
      delivery_seq: token.delivery_seq ?? 0, delivery_count: token.delivery_count ?? 0,
    },
  });
  return res.statusCode;
}

/** The release a holder issues through the endpoint the brain actually calls. */
async function unclaim(taskId: string, claimCount: number, runTime?: unknown): Promise<number> {
  const res = await app.inject({
    method: "POST", url: `/v1/internal/tasks/${taskId}/unclaim`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: BRAIN, claim_count: claimCount, reason: "retry", run_time: runTime },
  });
  return res.statusCode;
}

async function ledgerOf(taskId: string): Promise<RunTimeLedgerEntry | null> {
  const rows = await h.sql(
    `SELECT metadata->'run_phase'->'ledger' AS ledger FROM claw_tasks WHERE task_id = $1`, [taskId]);
  return (rows[0]?.ledger as RunTimeLedgerEntry | null) ?? null;
}

const queuedMsOf = async (taskId: string) => Number((await runRow(h, taskId)).queued_ms_accrued);

/** Put the lease far enough in the past to clear the reaper's whole grace. */
const expireLease = (taskId: string) => db.query(
  `UPDATE claw_tasks SET lease_expires_at = clock_timestamp() - INTERVAL '1 day'
    WHERE task_id = $1`, [taskId]);

// ── AC1: the queue is banked by the table, whatever ends the segment ─────────

test("AC1 every exit off the queue banks the segment, including the ones with no reporter", async () => {
  // Table-driven over the writers themselves, not over hand-written SQL: the
  // accrual rides on the one function that changes a status, so what is being
  // asserted is that each of these callers goes through it.
  const exits: Array<[string, (taskId: string) => Promise<unknown>]> = [
    ["dispatch CAS", (id) => transitionStatus(id, ["queued"], "preparing")],
    ["cancellation", (id) => cancelTask(id)],
    ["queue-timeout reap", () => reapExpiredQueuedRuns()],
    ["session interrupt", () => interruptUnstartedChatRuns(SESSION)],
    ["release, queued -> queued", (id) => releaseClaim(id, BRAIN, undefined, "retry")],
  ];

  for (const [name, exit] of exits) {
    const taskId = `ktsk-${name.replace(/\W+/g, "-")}`;
    await seedRun(h, taskId, SESSION, {
      status: "queued", queuedAgoSec: 3, leaseOwner: BRAIN,
      // The queue reaper judges the wait against RUN_QUEUE_MAX_SEC; only that
      // one needs a row old enough for it to act on.
      ...(name === "queue-timeout reap" ? { queuedAgoSec: RUN_QUEUE_MAX_SEC + 5 } : {}),
    });
    const before = await queuedMsOf(taskId);
    assert.equal(before, 0, `${name}: nothing banked while still queued`);
    await exit(taskId);
    const banked = await queuedMsOf(taskId);
    assert.ok(banked >= 3_000, `${name}: expected the wait banked, got ${banked}ms`);
  }
});

test("AC1 a row that never sat in the queue banks nothing", async () => {
  await seedRun(h, "ktsk-fat", SESSION, { status: "preparing", dispatch: "fat", queuedAgoSec: null });
  await transitionStatus("ktsk-fat", ["preparing"], "running");
  assert.equal(await queuedMsOf("ktsk-fat"), 0);
});

test("AC1 three queue segments are banked as their sum, and no more", async () => {
  // A contention-only claim, a bind-failure requeue, and a dispatch that
  // executes -- each through the writer that performs it in production.
  await seedRun(h, "ktsk-3seg", SESSION, {
    status: "queued", queuedAgoSec: 2, leaseOwner: BRAIN, claimCount: 1,
  });
  await transitionStatus("ktsk-3seg", ["queued"], "preparing");
  await releaseClaim("ktsk-3seg", BRAIN, undefined, "lock_contention");
  await sleep(200);
  await transitionStatus("ktsk-3seg", ["queued"], "preparing");
  await transitionStatus("ktsk-3seg", ["preparing"], "queued");
  await sleep(200);
  await transitionStatus("ktsk-3seg", ["queued"], "preparing");

  const banked = await queuedMsOf("ktsk-3seg");
  assert.ok(banked >= 2_400 && banked < 8_000, `expected the three waits summed, got ${banked}ms`);
});

// ── AC1/B21: the queued interval reaches the ledger, generation or not ───────

test("a run that timed out in the queue banks its wait, having never had an attempt", async () => {
  // The gap a report-driven ledger cannot close: a report needs an attempt id,
  // and this run never got one. The banking is driven by the row's own total
  // instead, so the settle pass can do it for a run nobody ever executed.
  await seedRun(h, "ktsk-qt", SESSION, {
    status: "queued", queuedAgoSec: RUN_QUEUE_MAX_SEC + 5,
  });
  assert.equal(await reapExpiredQueuedRuns(), 1, "the reaper closes a run nobody claimed");
  // Nothing seeds `run_phase`: this run never had a reporter, so the subtree
  // does not exist and the settle pass has to create the entry itself.
  assert.ok(await queuedMsOf("ktsk-qt") >= 4_000, "the reap banked the wait on the row");

  assert.ok(await settleTerminalRuns() >= 1);
  const ledger = await ledgerOf("ktsk-qt");
  assert.ok(ledger, "the settle pass creates the entry a run with no reporter never got");
  assert.ok(ledger!.knownMsByState.queued >= 4_000,
    `queued must be a real, banked state; got ${ledger!.knownMsByState.queued}ms`);
  assert.equal(ledger!.watermarkMs, ledger!.knownMsByState.queued);
  assert.ok(ledger!.attempts.every((a) => a.attemptId === null),
    "no attempt was ever allocated for it");
  assert.equal(ledger!.settled, true);
  assert.ok(ledger!.terminalAtDb, "and its terminal instant is pinned");
});

test("AC1 the settle pass stops unbanked time growing and leaves the queue total alone", async () => {
  await seedRun(h, "ktsk-settle", SESSION, { status: "running", queuedAgoSec: 2, leaseOwner: BRAIN });
  const token = { attempt_id: "att-1", claim_count: 0, delivery_seq: 1, delivery_count: 1 };
  await renew("ktsk-settle", { ...token, run_time: coverage("ktsk-settle", "att-1", token, 500) });
  await transitionStatus("ktsk-settle", ["running"], "completed");

  await settleTerminalRuns();
  const first = await ledgerOf("ktsk-settle");
  const queuedAfterSettle = first!.knownMsByState.queued;
  await sleep(30);
  await settleTerminalRuns();
  const second = await ledgerOf("ktsk-settle");

  assert.equal(second!.terminalAtDb, first!.terminalAtDb, "a settled entry is written once");
  assert.equal(second!.knownMsByState.queued, queuedAfterSettle,
    "the unreported tail is not relabelled as queue time");
});

test("a transaction that opened before the row was queued still banks the wait", async () => {
  // The accrual is an accounting instant. Read at transaction start it would be
  // earlier than a `queued_at` the row acquired afterwards, so a real wait
  // subtracts to a negative number and floors to nothing.
  await seedRun(h, "ktsk-skew", SESSION, { status: "preparing", queuedAgoSec: null });
  const banked = await inTransaction(async (query) => {
    // The transaction is open; only now does the row enter the queue, from
    // another statement, and wait a measurable interval there.
    await transitionStatus("ktsk-skew", ["preparing"], "queued");
    await sleep(100);
    await applyTaskStatusTransition("preparing", {
      expected: ["queued"], params: ["ktsk-skew"], query,
    });
    const r = await query(`SELECT queued_ms_accrued FROM claw_tasks WHERE task_id=$1`, ["ktsk-skew"]);
    return Number((r.rows[0] as { queued_ms_accrued: string }).queued_ms_accrued);
  });
  assert.ok(banked >= 80, `a 100ms wait must be banked, not floored to ${banked}ms`);
});

test("an insert that names no queued_at still opens its segment at the insert", async () => {
  // The column default is what retires the gap for every insert helper, present
  // or future: a row that reached `queued` with a NULL stamp is invisible to
  // every queue predicate and measures as no wait at all.
  await h.sql(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor)
     VALUES ('ktsk-nodefault', $1, 'chat', 'queued', 'chat', 'brain')`, [SESSION]);
  const row = await runRow(h, "ktsk-nodefault");
  assert.ok(row.queued_at, "an insert that omits the stamp must not open its segment at NULL");

  await sleep(120);
  await transitionStatus("ktsk-nodefault", ["queued"], "preparing");
  const banked = await queuedMsOf("ktsk-nodefault");
  assert.ok(banked >= 100, `the wait measures from the insert, got ${banked}ms`);
});

test("a row that never queued keeps the null the column is allowed to hold", async () => {
  // NOT NULL is deliberately not added: a row opening straight at `preparing`
  // never queued, and insertTask writes NULL for exactly that case.
  await h.sql(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, queued_at)
     VALUES ('ktsk-nullq', $1, 'chat', 'preparing', 'chat', 'brain', NULL)`, [SESSION]);
  assert.equal((await runRow(h, "ktsk-nullq")).queued_at, null,
    "the schema must still accept the honest answer for a row that never waited");
  await transitionStatus("ktsk-nullq", ["preparing"], "running");
  assert.equal(await queuedMsOf("ktsk-nullq"), 0);
});

test("a retried run neither inherits the ledger it replaces nor its queue age", async () => {
  await seedRun(h, "ktsk-orig", SESSION, {
    status: "running", origin: "task", dispatch: "fat", leaseOwner: BRAIN,
    leaseExpiresInSec: 45, queuedAgoSec: 4,
  });
  const token = { attempt_id: "att-1", claim_count: 0, delivery_seq: 1, delivery_count: 1 };
  await renew("ktsk-orig", { ...token, run_time: coverage("ktsk-orig", "att-1", token, 300) });
  await db.query(
    `UPDATE claw_tasks SET status='failed', failure_reason='agent_error', completed_at=NOW()
      WHERE task_id=$1`, ["ktsk-orig"]);
  await settleTerminalRuns();
  assert.ok((await ledgerOf("ktsk-orig"))!.settled, "the original ends settled");

  const retried = await retryTask("ktsk-orig");
  assert.equal(retried.ok, true);
  const replacement = retried.new_task_id!;

  assert.equal(await ledgerOf(replacement), null,
    "a replacement carrying the other run's settled ledger is another run's accounting");
  const row = await runRow(h, replacement);
  assert.ok(row.queued_at, "and it is visible to every predicate that reads queued_at");
  const queuedForMs = Date.now() - (row.queued_at as Date).getTime();
  assert.ok(queuedForMs < 2_000,
    `its wait starts now, not ${Math.round(queuedForMs / 1000)}s ago with the run it replaces`);
});

// ── AC4: the attempt-token fence ─────────────────────────────────────────────

test("AC4 a heartbeat that outlived its attempt cannot revive the lease", async () => {
  await seedRun(h, "ktsk-late", SESSION, {
    status: "running", claimCount: 1, leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-1", claim_count: 1, delivery_seq: 0, delivery_count: 0 };
  assert.equal((await renew("ktsk-late", token)).statusCode, 200);

  assert.equal(await releaseClaim("ktsk-late", BRAIN, 1, "handover"), true);
  const released = await runRow(h, "ktsk-late");
  assert.equal(released.heartbeat_at, null);
  assert.equal(released.lease_expires_at, null);

  const late = await renew("ktsk-late", token);
  assert.equal(late.statusCode, 409, "a released row is not renewable by the attempt that held it");
  const after = await runRow(h, "ktsk-late");
  assert.equal(after.heartbeat_at, null, "and no timestamp is revived");
  assert.equal(after.lease_expires_at, null);
});

test("AC4 a contention-only claim refuses the previous attempt without spending a generation", async () => {
  await seedRun(h, "ktsk-cont", SESSION, {
    status: "running", claimCount: 1, leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-1", claim_count: 1, delivery_seq: 0, delivery_count: 0 };
  await renew("ktsk-cont", token);
  const generationBefore = Number((await runRow(h, "ktsk-cont")).attempt_generation);

  // What a contention-only claim leaves behind: the row back at `preparing`
  // under the same pod name, one more claim, and no attempt id.
  await db.query(
    `UPDATE claw_tasks SET status='preparing', claim_count=claim_count+1, attempt_id=NULL,
            lease_owner=$2, lease_expires_at=NOW() + INTERVAL '45 seconds'
      WHERE task_id=$1`, ["ktsk-cont", BRAIN]);

  const late = await renew("ktsk-cont", token);
  assert.equal(late.statusCode, 409, "status and owner match again; only the claim count refuses it");
  assert.equal(Number((await runRow(h, "ktsk-cont")).attempt_generation), generationBefore,
    "no generation was consumed to achieve the refusal");
});

test("AC4 a renewal that omits a token field is rejected, not accepted unfenced", async () => {
  await seedRun(h, "ktsk-notok", SESSION, { status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45 });
  for (const missing of ["attempt_id", "claim_count", "delivery_seq", "delivery_count"] as const) {
    const token: Record<string, unknown> = {
      attempt_id: "att-1", claim_count: 0, delivery_seq: 1, delivery_count: 1,
    };
    delete token[missing];
    const res = await renew("ktsk-notok", token);
    assert.equal(res.statusCode, 400, `${missing} must be required`);
  }
});

test("a fat-path attempt whose allocating write was lost still adopts and renews", async () => {
  // The fat path takes no claim, so its claim_count is the column's 0 default
  // on both sides. A fence that could not compare that would leave the
  // documented adoption arm unreachable for every fat run there is.
  await seedRun(h, "ktsk-fat1", SESSION, {
    status: "running", dispatch: "fat", leaseOwner: null, leaseExpiresInSec: null, queuedAgoSec: 1,
  });
  const first = { attempt_id: "att-f1", claim_count: 0, delivery_seq: 9, delivery_count: 1 };
  assert.equal((await renew("ktsk-fat1", first)).statusCode, 200);
  let row = await runRow(h, "ktsk-fat1");
  assert.equal(row.attempt_id, "att-f1", "the first renewal establishes the token itself");
  assert.equal(Number(row.attempt_generation), 1, "and bumps the generation exactly once");
  assert.equal(Number(row.delivery_seq), 9);

  assert.equal((await renew("ktsk-fat1", first)).statusCode, 200, "and keeps renewing");
  assert.equal(Number((await runRow(h, "ktsk-fat1")).attempt_generation), 1,
    "the same attempt renewing adopts nothing and counts nothing");

  // Its predecessor, still presenting the pair the row has moved past.
  const stale = { attempt_id: "att-f0", claim_count: 0, delivery_seq: 8, delivery_count: 1 };
  assert.equal((await renew("ktsk-fat1", stale)).statusCode, 409);

  // A genuinely newer delivery, arriving while the incumbent's lease is live.
  const duplicate = { attempt_id: "att-f2", claim_count: 0, delivery_seq: 9, delivery_count: 1 };
  assert.equal((await renew("ktsk-fat1", duplicate)).statusCode, 409,
    "a duplicate of the same delivery is refused while the incumbent is renewing");

  await db.query(`UPDATE claw_tasks SET lease_expires_at = NOW() - INTERVAL '1 second'
                   WHERE task_id=$1`, ["ktsk-fat1"]);
  assert.equal((await renew("ktsk-fat1", stale)).statusCode, 409,
    "with no live lease anywhere, the delivery pair alone refuses the stale attempt");
  const redelivery = { attempt_id: "att-f2", claim_count: 0, delivery_seq: 9, delivery_count: 2 };
  assert.equal((await renew("ktsk-fat1", redelivery)).statusCode, 200,
    "while a strictly newer delivery adopts in that same state");
  row = await runRow(h, "ktsk-fat1");
  assert.equal(row.attempt_id, "att-f2");
  assert.equal(Number(row.attempt_generation), 2);
});

test("AC4 the final report and the terminal transition commit together", async () => {
  await seedRun(h, "ktsk-atomic", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-1", claim_count: 0, delivery_seq: 1, delivery_count: 1 };
  await renew("ktsk-atomic", { ...token, run_time: coverage("ktsk-atomic", "att-1", token, 100) });

  // A duplicate callback: the transition no-ops, so the report that came with
  // it must not be banked into a ledger somebody else now owns.
  await transitionStatus("ktsk-atomic", ["running"], "completed");
  const before = await ledgerOf("ktsk-atomic");
  await applyAgentDone("ktsk-atomic", {
    task_id: "ktsk-atomic", abort_reason: "completed",
    run_time: coverage("ktsk-atomic", "att-1", token, 900),
  });
  const after = await ledgerOf("ktsk-atomic");
  assert.deepEqual(after!.knownMsByState, before!.knownMsByState,
    "neither the merge nor the transition may land on its own");
});

test("AC4 a stale holder's release rolls its final report back with it", async () => {
  await seedRun(h, "ktsk-stale", SESSION, {
    status: "running", claimCount: 3, leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-1", claim_count: 3, delivery_seq: 0, delivery_count: 0 };
  await renew("ktsk-stale", { ...token, run_time: coverage("ktsk-stale", "att-1", token, 50) });
  const before = await ledgerOf("ktsk-stale");

  const released = await unclaim("ktsk-stale", 2, coverage("ktsk-stale", "att-1", token, 5_000));
  assert.equal(released, 409, "the release's own fence matched no row");
  const after = await ledgerOf("ktsk-stale");
  assert.deepEqual(after!.knownMsByState, before!.knownMsByState);
  assert.equal((await runRow(h, "ktsk-stale")).status, "running", "and the row did not move");
});

test("AC4 a run terminated by a path with no reporter still settles", async () => {
  await seedRun(h, "ktsk-noreport", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 2,
  });
  const token = { attempt_id: "att-1", claim_count: 0, delivery_seq: 1, delivery_count: 1 };
  await renew("ktsk-noreport", { ...token, run_time: coverage("ktsk-noreport", "att-1", token, 100) });
  await sleep(40);
  await db.query(
    `UPDATE claw_tasks SET status='cancelled', failure_reason='cancelled', completed_at=NOW()
      WHERE task_id=$1`, ["ktsk-noreport"]);

  await settleTerminalRuns();
  const ledger = await ledgerOf("ktsk-noreport");
  assert.ok(ledger!.terminalAtDb, "pinned from completed_at, with nothing hooked to do it");
  const uncovered = Date.parse(ledger!.terminalAtDb!) - Date.parse(ledger!.lastAcceptedInstantDb);
  assert.ok(uncovered > 0, "what no report covered stays unbanked");
  assert.equal(ledger!.knownMsByState.executing, 100, "and is not attributed to a state");
});

test("AC3 a report on a stale attempt token contributes nothing at all", async () => {
  await seedRun(h, "ktsk-stalerep", SESSION, {
    status: "running", claimCount: 2, leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const live = { attempt_id: "att-2", claim_count: 2, delivery_seq: 0, delivery_count: 0 };
  await renew("ktsk-stalerep", { ...live, run_time: coverage("ktsk-stalerep", "att-2", live, 200) });
  const before = await ledgerOf("ktsk-stalerep");

  const stale = { attempt_id: "att-1", claim_count: 1, delivery_seq: 0, delivery_count: 0 };
  const res = await renew("ktsk-stalerep", {
    ...stale, run_time: coverage("ktsk-stalerep", "att-1", stale, 9_000),
  });

  assert.equal(res.statusCode, 409);
  const after = await ledgerOf("ktsk-stalerep");
  assert.deepEqual(after!.knownMsByState, before!.knownMsByState);
  assert.equal(after!.lastAcceptedInstantDb, before!.lastAcceptedInstantDb, "the anchor stands still");
  assert.equal(after!.coverageSeen.attemptId, "att-2", "coverage stays keyed to the current attempt");
});

test("AC7 two merges racing on one entry keep both reports' accepted amounts", async () => {
  await seedRun(h, "ktsk-cas", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-1", claim_count: 0, delivery_seq: 1, delivery_count: 1 };
  await renew("ktsk-cas", token);
  await sleep(60);

  await Promise.all([
    applyToLedger("ktsk-cas", { key: "ktsk-cas", source: "task_id" }, (row) =>
      mergeRunTimeReport(row.entry, {
        ...coverage("ktsk-cas", "att-1", token, 20), cumulativeStateMs: { executing: 20 },
      } as never, row.readAtDb)),
    applyToLedger("ktsk-cas", { key: "ktsk-cas", source: "task_id" }, (row) =>
      mergeRunTimeReport(row.entry, {
        ...coverage("ktsk-cas", "att-1", token, 0), cumulativeStateMs: { waiting_background: 25 },
      } as never, row.readAtDb)),
  ]);

  const ledger = await ledgerOf("ktsk-cas");
  assert.equal(ledger!.knownMsByState.executing, 20, "one writer's amount is not lost to the other");
  assert.equal(ledger!.knownMsByState.waiting_background, 25);
  assert.equal(ledger!.watermarkMs, 45);
});

test("AC1 a closing transaction that overlaps a heartbeat merge stays consistent", async () => {
  // `NOW()` is fixed at transaction start, so a transaction that opened earlier
  // and commits later can pair its own older instant with an anchor a later
  // one already advanced -- a negative budget, or a terminal instant behind the
  // anchor. Every accounting instant is clock_timestamp(), and completed_at is
  // clamped upward, so neither can happen.
  await seedRun(h, "ktsk-overlap", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-1", claim_count: 0, delivery_seq: 1, delivery_count: 1 };
  await renew("ktsk-overlap", token);
  await sleep(40);
  await renew("ktsk-overlap", { ...token, run_time: coverage("ktsk-overlap", "att-1", token, 40) });

  // A terminal stamp taken from an instant already behind the anchor.
  await db.query(
    `UPDATE claw_tasks SET status='completed',
            completed_at = NOW() - INTERVAL '10 seconds' WHERE task_id=$1`, ["ktsk-overlap"]);
  await settleTerminalRuns();

  const ledger = await ledgerOf("ktsk-overlap");
  assert.ok(Date.parse(ledger!.terminalAtDb!) >= Date.parse(ledger!.lastAcceptedInstantDb),
    "a terminal instant behind the anchor would make the budget negative");
  const totals = runTimeTotals(ledger!, ledger!.terminalAtDb!);
  assert.ok(totals.unbankedMs >= 0);
});

test("AC2 liveness is judged inside the database, never against a caller's clock", () => {
  // A brain- or API-pod instant subtracted from heartbeat_at is a cross-domain
  // comparison with nothing bounding it. Every reader of that column compares
  // it in SQL instead.
  const roots = [
    fileURLToPath(new URL("../src/routes/internal-tasks.ts", import.meta.url)),
    fileURLToPath(new URL("../src/tasks/sweeper.ts", import.meta.url)),
    fileURLToPath(new URL("../src/tasks/run-claim.ts", import.meta.url)),
  ];
  for (const file of roots) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/Date\.now\(\)\s*-\s*.*heartbeat/i.test(text), `${file} subtracts a pod clock from heartbeat_at`);
    assert.ok(!/heartbeat_at.*\.getTime\(\)/.test(text), `${file} parses heartbeat_at into a pod-clock number`);
  }
});

test("AC4.11 the delivery pair advances as one value, never key by key", async () => {
  // Two independent maxima store a pair no delivery ever presented, and the
  // legitimate delivery that follows is then refused for travelling backwards.
  await seedRun(h, "ktsk-pair", SESSION, {
    status: "running", dispatch: "fat", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  await db.query(
    `UPDATE claw_tasks SET delivery_seq=100, delivery_count=5, attempt_id='att-a'
      WHERE task_id=$1`, ["ktsk-pair"]);
  await expireLease("ktsk-pair");

  const newer = { attempt_id: "att-b", claim_count: 0, delivery_seq: 101, delivery_count: 1 };
  assert.equal((await renew("ktsk-pair", newer)).statusCode, 200, "(101,1) is strictly newer");
  const row = await runRow(h, "ktsk-pair");
  assert.equal(Number(row.delivery_seq), 101);
  assert.equal(Number(row.delivery_count), 1,
    "an independent maximum would store the hybrid (101,5), which no delivery presented");

  assert.equal((await renew("ktsk-pair", newer)).statusCode, 200,
    "and the same delivery's next renewal is not refused for travelling backwards");
});

test("AC4 a heartbeat racing the run's end banks nothing after it", async () => {
  // A heartbeat whose fenced UPDATE won a moment earlier still has coverage to
  // merge afterwards. `agent_done` ends the run without touching `attempt_id`,
  // so the attempt is still the row's own and status is the whole answer.
  await seedRun(h, "ktsk-relrace", SESSION, {
    status: "running", claimCount: 1, leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-1", claim_count: 1, delivery_seq: 0, delivery_count: 0 };
  await announceRunning("ktsk-relrace", "att-1", { claim_count: 1 });
  await renew("ktsk-relrace", { ...token, run_time: coverage("ktsk-relrace", "att-1", token, 30) });
  const before = await ledgerOf("ktsk-relrace");

  await applyAgentDone("ktsk-relrace", { task_id: "ktsk-relrace", abort_reason: "completed" });
  const ended = await runRow(h, "ktsk-relrace");
  assert.equal(ended.status, "completed");
  assert.equal(ended.attempt_id, "att-1", "the run ended without rotating the token");

  const outcome = await mergeRenewal(
    "ktsk-relrace", "att-1", coverage("ktsk-relrace", "att-1", token, 9_000) as never);

  assert.equal(outcome, "stale", "a run that has ended is not this attempt's to write");
  assert.deepEqual((await ledgerOf("ktsk-relrace"))!.knownMsByState, before!.knownMsByState);
});

test("AC4 a release clears the attempt token with the status it changes", async () => {
  // The other half of the same race: a release returns the row to the queue,
  // where a heartbeat presenting the old attempt must find nothing to renew.
  await seedRun(h, "ktsk-relclear", SESSION, {
    status: "running", claimCount: 1, leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  await announceRunning("ktsk-relclear", "att-1", { claim_count: 1 });
  assert.equal(await unclaim("ktsk-relclear", 1), 200);

  const row = await runRow(h, "ktsk-relclear");
  assert.equal(row.status, "queued");
  assert.equal(row.attempt_id, null, "the token goes with the status, in one statement");
});

test("a release closes the attempt record even when it carries no report", async () => {
  await seedRun(h, "ktsk-noreport-close", SESSION, {
    status: "running", claimCount: 1, leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  await announceRunning("ktsk-noreport-close", "att-1", { claim_count: 1 });
  assert.equal((await ledgerOf("ktsk-noreport-close"))!.attempts[0].endedAtDb, undefined,
    "the record is open while the attempt runs");

  assert.equal(await unclaim("ktsk-noreport-close", 1), 200, "released with no run_time at all");

  const record = (await ledgerOf("ktsk-noreport-close"))!.attempts[0];
  assert.ok(record.endedAtDb, "an attempt must not end with its record still open");
  assert.equal(record.recoveryLoss.computable, true);
});

test("a running event for a row that has been released opens no attempt record", async () => {
  // Not terminal -- the row is back on the queue for somebody else -- so the
  // terminal guard cannot help. What refuses it is the ownership write itself
  // matching no row, which is the same predicate that decides ownership.
  await seedRun(h, "ktsk-requeued", SESSION, {
    status: "queued", claimCount: 1, queuedAgoSec: 1,
  });
  await announceRunning("ktsk-requeued", "att-1", { claim_count: 1 });

  assert.equal((await runRow(h, "ktsk-requeued")).attempt_id, null,
    "the ownership write does not touch a row that is back on the queue");
  assert.equal(await ledgerOf("ktsk-requeued"), null,
    "an event the row does not own writes nothing to its ledger at all");
});

test("a merge the store could not write is surfaced, not reported as success", async () => {
  // Flattening it here would hide it from the caller that logs it, which is the
  // only place a failed accounting write becomes visible at all.
  await seedRun(h, "ktsk-mergefail", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const realQuery = db.query;
  db.query = (async (text: string, params?: unknown[]) => {
    if (/run_phase/.test(text)) throw new Error("connection reset");
    return realQuery(text, params);
  }) as typeof db.query;
  try {
    await assert.rejects(
      mergeRenewal("ktsk-mergefail", "att-1", undefined),
      /connection reset/,
    );
  } finally {
    db.query = realQuery;
  }
});

test("an attempt record is not opened on a row that has already ended", async () => {
  // The guard on the write itself, not on the caller that usually gates it:
  // a late allocation reaching this directly must still be refused.
  await seedRun(h, "ktsk-openterm", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  await announceRunning("ktsk-openterm", "att-1");
  await applyAgentDone("ktsk-openterm", { task_id: "ktsk-openterm", abort_reason: "completed" });
  const before = (await ledgerOf("ktsk-openterm"))!.attempts.length;

  await db.query(`UPDATE claw_tasks SET attempt_id = 'att-2' WHERE task_id = $1`, ["ktsk-openterm"]);
  await openAttemptRecordFor("ktsk-openterm", "att-2");

  assert.equal((await ledgerOf("ktsk-openterm"))!.attempts.length, before,
    "a terminal row has no attempt left to begin");
});

test("AC4.11 the delivery pair advances as one value on the allocation path too", async () => {
  // The same corruption as the renewal case, through the write that allocates
  // the attempt: two independent maxima store a pair nothing presented.
  await seedRun(h, "ktsk-allocpair", SESSION, {
    status: "running", dispatch: "fat", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  await db.query(
    `UPDATE claw_tasks SET delivery_seq=100, delivery_count=5 WHERE task_id=$1`, ["ktsk-allocpair"]);

  await announceRunning("ktsk-allocpair", "att-b", { delivery_seq: 101, delivery_count: 1 });
  const row = await runRow(h, "ktsk-allocpair");
  assert.equal(Number(row.delivery_seq), 101);
  assert.equal(Number(row.delivery_count), 1,
    "an independent maximum would store the hybrid (101,5), which no delivery presented");

  // And a pair below the row's does not drag either half backwards.
  await announceRunning("ktsk-allocpair", "att-c", { delivery_seq: 100, delivery_count: 9 });
  const after = await runRow(h, "ktsk-allocpair");
  assert.equal(Number(after.delivery_seq), 101);
  assert.equal(Number(after.delivery_count), 1);
});

test("a duplicate running event does not reopen an attempt on a run that ended", async () => {
  await seedRun(h, "ktsk-dup", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  await announceRunning("ktsk-dup", "att-1");
  assert.equal((await ledgerOf("ktsk-dup"))!.attempts.length, 1);

  await applyAgentDone("ktsk-dup", { task_id: "ktsk-dup", abort_reason: "completed" });
  assert.equal((await runRow(h, "ktsk-dup")).status, "completed");

  await announceRunning("ktsk-dup", "att-1");
  assert.equal((await ledgerOf("ktsk-dup"))!.attempts.length, 1,
    "a late duplicate must not open a second, never-closed record");
});

test("AC4 a body whose nested report names another attempt is refused whole", async () => {
  // The lease body carries two tokens and the UPDATE fences only one of them.
  // A body that contradicts itself is a caller this endpoint does not
  // understand, so none of its coverage is taken -- not even the half that
  // would have matched.
  await seedRun(h, "ktsk-nested", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-current", claim_count: 0, delivery_seq: 1, delivery_count: 1 };

  const res = await renew("ktsk-nested", {
    ...token,
    run_time: { ...coverage("ktsk-nested", "att-stale", token, 5_000), attemptId: "att-stale" },
  });

  assert.equal(res.statusCode, 200, "the lease itself is the current attempt's and is renewed");
  assert.equal(await ledgerOf("ktsk-nested"), null,
    "a self-contradicting body is rejected at the boundary, before any ledger work");

  // The same renewal, agreeing with itself, is taken in full.
  await renew("ktsk-nested", { ...token, run_time: coverage("ktsk-nested", "att-current", token, 40) });
  const after = await ledgerOf("ktsk-nested");
  assert.equal(after!.coverageSeen.attemptId, "att-current");
  assert.equal(after!.knownMsByState.executing, 40);
});

test("AC4 coverage is refused once the row has moved on between fence and merge", async () => {
  await seedRun(h, "ktsk-race", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-1", claim_count: 0, delivery_seq: 1, delivery_count: 1 };
  await renew("ktsk-race", token);
  const before = await ledgerOf("ktsk-race");

  // The takeover that lands between the fenced UPDATE and the merge that
  // follows it: the merge has to read the row again, not trust the fence.
  await db.query(`UPDATE claw_tasks SET attempt_id='att-2' WHERE task_id=$1`, ["ktsk-race"]);
  const outcome = await mergeRenewal(
    "ktsk-race", "att-1", coverage("ktsk-race", "att-1", token, 5_000) as never);

  assert.equal(outcome, "stale");
  assert.deepEqual((await ledgerOf("ktsk-race"))!.knownMsByState, before!.knownMsByState);
});

test("AC4 a renewal the database could not answer banks nothing", async () => {
  await seedRun(h, "ktsk-dberr", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-1", claim_count: 0, delivery_seq: 1, delivery_count: 1 };
  await renew("ktsk-dberr", token);
  const before = await ledgerOf("ktsk-dberr");

  const realQuery = db.query;
  db.query = (async (text: string, params?: unknown[]) => {
    if (/^\s*UPDATE claw_tasks\s+SET lease_owner/.test(text)) throw new Error("connection reset");
    return realQuery(text, params);
  }) as typeof db.query;
  let res;
  try {
    res = await renew("ktsk-dberr", { ...token, run_time: coverage("ktsk-dberr", "att-1", token, 5_000) });
  } finally {
    db.query = realQuery;
  }

  assert.equal(res!.statusCode, 200, "a database hiccup is not evidence the run has ended");
  assert.equal(res!.json().status, "unknown");
  assert.deepEqual((await ledgerOf("ktsk-dberr"))!.knownMsByState, before!.knownMsByState,
    "but the fence never ran, so nothing may be banked against it");
});

test("AC4 agent_done from a superseded attempt neither banks nor terminates", async () => {
  await seedRun(h, "ktsk-done", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const current = { attempt_id: "att-current", claim_count: 0, delivery_seq: 2, delivery_count: 1 };
  await renew("ktsk-done", { ...current, run_time: coverage("ktsk-done", "att-current", current, 100) });
  const before = await ledgerOf("ktsk-done");

  const stale = { attempt_id: "att-stale", claim_count: 0, delivery_seq: 1, delivery_count: 1 };
  await applyAgentDone("ktsk-done", {
    task_id: "ktsk-done", abort_reason: "completed",
    run_time: coverage("ktsk-done", "att-stale", stale, 9_000),
  });

  assert.equal((await runRow(h, "ktsk-done")).status, "running",
    "a superseded attempt must not end a run somebody else is executing");
  assert.deepEqual((await ledgerOf("ktsk-done"))!.knownMsByState, before!.knownMsByState);
});

test("a waiting_external transition keeps the final report it commits with", async () => {
  await seedRun(h, "ktsk-wx", SESSION, {
    status: "running", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const token = { attempt_id: "att-1", claim_count: 0, delivery_seq: 1, delivery_count: 1 };
  await renew("ktsk-wx", { ...token, run_time: coverage("ktsk-wx", "att-1", token, 10) });
  await sleep(40);

  await applyAgentDone("ktsk-wx", {
    task_id: "ktsk-wx", abort_reason: "wait_external",
    metadata: { external_id: "ext-1" },
    run_time: coverage("ktsk-wx", "att-1", token, 30),
  });

  const row = await runRow(h, "ktsk-wx");
  assert.equal(row.status, "waiting_external");
  assert.equal((row.metadata as Record<string, Record<string, string>>).derived.external_id, "ext-1");
  const ledger = await ledgerOf("ktsk-wx");
  assert.ok(ledger, "the branch writes metadata wholesale; the ledger must survive it");
  assert.equal(ledger!.knownMsByState.executing, 30,
    "the merge committed in this transaction must not be overwritten by its own patch");
});

// ── AC5: a real attempt survives a contention-only claim ─────────────────────

test("AC5 a contention-only claim between two real attempts leaves the first intact", async () => {
  await seedRun(h, "ktsk-gen", SESSION, {
    status: "running", claimCount: 1, leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const claimsBefore = Number((await runRow(h, "ktsk-gen")).claim_count);

  await announceRunning("ktsk-gen", "att-1", { claim_count: 1 });
  const afterFirst = await runRow(h, "ktsk-gen");
  assert.equal(Number(afterFirst.attempt_generation), 1);
  assert.equal((await ledgerOf("ktsk-gen"))!.attempts.length, 1,
    "the allocating write opens the attempt's record; nothing else has to");

  const firstToken = { attempt_id: "att-1", claim_count: 1, delivery_seq: 0, delivery_count: 0 };
  assert.equal(await unclaim("ktsk-gen", 1, coverage("ktsk-gen", "att-1", firstToken, 40)), 200);
  assert.equal((await runRow(h, "ktsk-gen")).completed_at, null,
    "a release is an attempt boundary, not the run's end");
  assert.equal((await ledgerOf("ktsk-gen"))!.settled, false);

  // The contention-only claim: one more claim, no attempt, no generation.
  await db.query(
    `UPDATE claw_tasks SET status='preparing', claim_count=claim_count+1, attempt_id=NULL,
            lease_owner=$2, lease_expires_at=NOW() + INTERVAL '45 seconds'
      WHERE task_id=$1`, ["ktsk-gen", BRAIN]);
  assert.equal(Number((await runRow(h, "ktsk-gen")).attempt_generation), 1,
    "a claim that never reached execution consumes no generation");

  await db.query(`UPDATE claw_tasks SET claim_count=claim_count+1 WHERE task_id=$1`, ["ktsk-gen"]);
  await announceRunning("ktsk-gen", "att-2", { claim_count: 3 });
  const secondToken = { attempt_id: "att-2", claim_count: 3, delivery_seq: 0, delivery_count: 0 };
  assert.equal(await unclaim("ktsk-gen", 3, coverage("ktsk-gen", "att-2", secondToken, 20)), 200);

  const row = await runRow(h, "ktsk-gen");
  const ledger = await ledgerOf("ktsk-gen");
  assert.equal(Number(row.attempt_generation), 2);
  assert.equal(ledger!.attempts.length, 2, "the record is appended, never overwritten");
  assert.deepEqual(ledger!.attempts.map((a) => a.attemptId), ["att-1", "att-2"]);
  assert.equal(ledger!.attempts[0].attemptGeneration, 1, "the first record is untouched");
  assert.ok(ledger!.attempts.every((a) => a.endedAtDb), "and both were closed at their release");
  assert.ok(Number(row.claim_count) - claimsBefore > Number(row.attempt_generation) - 1,
    "the contention claim shows only as a claim_count delta");
});

// ── AC6: recovery loss, per class, at a real boundary ────────────────────────

test("AC6 an attempt's loss is measured from its own start, not the run's", async () => {
  // `takeClaim` COALESCEs `started_at`, so after a redelivery the column names
  // attempt 1's start. Charging attempt 2 from there overstates its loss by
  // every second its predecessors were alive.
  // Fat dispatch, because the lost-lease reaper hands live doorbell rows to
  // the requeue pass instead of closing them.
  await seedRun(h, "ktsk-anchor", SESSION, {
    status: "running", dispatch: "fat", claimCount: 1, leaseOwner: BRAIN,
    leaseExpiresInSec: 45, queuedAgoSec: 1, startedAgoSec: 30,
  });
  await announceRunning("ktsk-anchor", "att-1", { claim_count: 1 });
  const firstToken = { attempt_id: "att-1", claim_count: 1, delivery_seq: 0, delivery_count: 0 };
  await unclaim("ktsk-anchor", 1, coverage("ktsk-anchor", "att-1", firstToken, 10));

  await db.query(
    `UPDATE claw_tasks SET status='running', claim_count=2, attempt_id=NULL
      WHERE task_id=$1`, ["ktsk-anchor"]);
  await announceRunning("ktsk-anchor", "att-2", { claim_count: 2 });
  const startedAt = Number((await runRow(h, "ktsk-anchor")).started_at instanceof Date
    ? ((await runRow(h, "ktsk-anchor")).started_at as Date).getTime() : 0);
  assert.ok(Date.now() - startedAt > 25_000, "the row's own started_at is attempt 1's");

  await sleep(60);
  await expireLease("ktsk-anchor");
  assert.equal(await reapLostLeases(), 1);

  const record = (await ledgerOf("ktsk-anchor"))!.attempts.find((a) => a.attemptId === "att-2")!;
  assert.equal(record.recoveryLoss.computable, true);
  assert.ok((record.recoveryLoss.lossMs ?? 0) < 20_000,
    `attempt 2 lived under a second; a loss of ${record.recoveryLoss.lossMs}ms is attempt 1's lifetime`);
  assert.ok((record.recoveryLoss.lossMs ?? 0) >= 50, "and it is not zero either");
});

test("AC6 an attempt that never reached its allocating write is not computable", async () => {
  await seedRun(h, "ktsk-slotless", SESSION, {
    status: "running", dispatch: "fat", leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  await expireLease("ktsk-slotless");
  assert.equal(await reapLostLeases(), 1);
  const record = (await ledgerOf("ktsk-slotless"))!.attempts[0];
  assert.deepEqual(record.recoveryLoss, { computable: false, lossMs: null });
  assert.notEqual(record.recoveryLoss.lossMs, 0, "an unknowable loss must not read as no loss");
});
