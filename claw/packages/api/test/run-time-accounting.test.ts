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
import { db } from "../src/infra/db.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { releaseClaim } from "../src/tasks/run-claim.js";
import { transitionStatus } from "../src/tasks/db.js";
import { applyAgentDone } from "../src/tasks/lifecycle.js";
import { applyToLedger, settleTerminalRuns } from "../src/tasks/run-time-ledger.js";
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

async function ledgerOf(taskId: string): Promise<RunTimeLedgerEntry | null> {
  const rows = await h.sql(
    `SELECT metadata->'run_phase'->'ledger' AS ledger FROM claw_tasks WHERE task_id = $1`, [taskId]);
  return (rows[0]?.ledger as RunTimeLedgerEntry | null) ?? null;
}

const queuedMsOf = async (taskId: string) => Number((await runRow(h, taskId)).queued_ms_accrued);

// ── AC1: the queue is banked by the table, whatever ends the segment ─────────

test("AC1 every exit off the queue banks the segment, including the ones with no reporter", async () => {
  // Table-driven over statements rather than over call sites: the trigger reads
  // OLD, so what is being asserted is that a row leaving `queued` banks its wait
  // whether or not the statement's author knew accounting existed.
  const exits: Array<[string, (taskId: string) => Promise<unknown>]> = [
    ["dispatch CAS", (id) => transitionStatus(id, ["queued"], "preparing")],
    ["cancellation", (id) => transitionStatus(id, ["queued"], "cancelled")],
    ["queue-timeout reap", (id) => db.query(
      `UPDATE claw_tasks SET status='failed', failure_reason='queue_timeout', completed_at=NOW()
        WHERE task_id=$1`, [id])],
    ["session deletion", (id) => db.query(
      `UPDATE claw_tasks SET status='cancelled', completed_at=NOW() WHERE task_id=$1`, [id])],
    ["queued -> queued re-stamp", (id) => db.query(
      `UPDATE claw_tasks SET status='queued', queued_at=NOW() WHERE task_id=$1`, [id])],
  ];

  for (const [name, exit] of exits) {
    const taskId = `ktsk-${name.replace(/\W+/g, "-")}`;
    await seedRun(h, taskId, SESSION, { status: "queued", queuedAgoSec: 3 });
    assert.equal(await queuedMsOf(taskId), 0, `${name}: nothing banked while still queued`);
    await exit(taskId);
    const banked = await queuedMsOf(taskId);
    assert.ok(banked >= 3_000 && banked < 10_000, `${name}: expected ~3s banked, got ${banked}ms`);
  }
});

test("AC1 a row that never sat in the queue banks nothing", async () => {
  await seedRun(h, "ktsk-fat", SESSION, { status: "preparing", dispatch: "fat", queuedAgoSec: null });
  await transitionStatus("ktsk-fat", ["preparing"], "running");
  assert.equal(await queuedMsOf("ktsk-fat"), 0);
});

test("AC1 three queue segments are banked as their sum, and no more", async () => {
  const requeue = (id: string) => db.query(
    `UPDATE claw_tasks SET status='queued', queued_at=NOW() WHERE task_id=$1`, [id]);
  const dequeue = (id: string, next: string) => db.query(
    `UPDATE claw_tasks SET status=$2 WHERE task_id=$1`, [id, next]);

  await seedRun(h, "ktsk-3seg", SESSION, { status: "queued", queuedAgoSec: 2 });
  // A contention-only claim that unclaimed before any ownership write ran.
  await dequeue("ktsk-3seg", "preparing");
  await requeue("ktsk-3seg");
  await sleep(200);
  // A bind-failure requeue.
  await dequeue("ktsk-3seg", "preparing");
  await requeue("ktsk-3seg");
  await sleep(200);
  // The dispatch that executes.
  await dequeue("ktsk-3seg", "running");

  const banked = await queuedMsOf("ktsk-3seg");
  assert.ok(banked >= 2_400 && banked < 8_000, `expected the three waits summed, got ${banked}ms`);
});

// ── AC1/B21: the queued interval reaches the ledger, generation or not ───────

test("a run that timed out in the queue banks its wait, having never had an attempt", async () => {
  // The gap a report-driven ledger cannot close: a report needs an attempt id,
  // and this run never got one. The banking is driven by the row's own total
  // instead, so the settle pass can do it for a run nobody ever executed.
  await seedRun(h, "ktsk-qt", SESSION, { status: "queued", queuedAgoSec: 4 });
  await db.query(
    `UPDATE claw_tasks SET status='failed', failure_reason='queue_timeout', completed_at=NOW()
      WHERE task_id=$1`, ["ktsk-qt"]);
  // The entry does not exist yet either: nothing ever renewed this run's lease.
  await db.query(
    `UPDATE claw_tasks SET metadata = jsonb_set(metadata, '{run_phase}', '{}'::jsonb, true)
      WHERE task_id=$1`, ["ktsk-qt"]);

  assert.equal(await settleTerminalRuns(), 1);
  const ledger = await ledgerOf("ktsk-qt");
  assert.ok(ledger, "the settle pass creates the entry a run with no reporter never got");
  assert.ok(ledger!.knownMsByState.queued >= 4_000,
    `queued must be a real, banked state; got ${ledger!.knownMsByState.queued}ms`);
  assert.equal(ledger!.watermarkMs, ledger!.knownMsByState.queued);
  assert.equal(ledger!.attempts.length, 0, "no attempt was ever allocated for it");
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

  const released = await releaseClaim("ktsk-stale", BRAIN, 2, "stale", {
    report: coverage("ktsk-stale", "att-1", token, 5_000) as never,
  });
  assert.equal(released, false, "the release's own fence matched no row");
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

// ── AC5: a real attempt survives a contention-only claim ─────────────────────

test("AC5 a contention-only claim between two real attempts leaves the first intact", async () => {
  await seedRun(h, "ktsk-gen", SESSION, {
    status: "running", claimCount: 1, leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const claimsBefore = Number((await runRow(h, "ktsk-gen")).claim_count);

  // Real attempt 1: the ownership write allocates its generation.
  await app.inject({
    method: "POST", url: "/v1/internal/tasks/ktsk-gen/event",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {
      type: "statusUpdate", agent_status: "running", brain_id: BRAIN,
      attempt_id: "att-1", claim_count: 1, delivery_seq: 0, delivery_count: 0,
    },
  });
  const afterFirst = await runRow(h, "ktsk-gen");
  assert.equal(Number(afterFirst.attempt_generation), 1);

  await releaseClaim("ktsk-gen", BRAIN, 1, "handover", {
    attempt: {
      attemptId: "att-1", attemptGeneration: 1,
      startedAtDb: new Date(Date.now() - 1_000).toISOString(), renewed: false,
    },
  });
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

  // Real attempt 2.
  await db.query(`UPDATE claw_tasks SET claim_count=claim_count+1 WHERE task_id=$1`, ["ktsk-gen"]);
  await app.inject({
    method: "POST", url: "/v1/internal/tasks/ktsk-gen/event",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {
      type: "statusUpdate", agent_status: "running", brain_id: BRAIN,
      attempt_id: "att-2", claim_count: 3, delivery_seq: 0, delivery_count: 0,
    },
  });
  await releaseClaim("ktsk-gen", BRAIN, 3, "done", {
    attempt: {
      attemptId: "att-2", attemptGeneration: 2,
      startedAtDb: new Date(Date.now() - 500).toISOString(), renewed: false,
    },
  });

  const row = await runRow(h, "ktsk-gen");
  const ledger = await ledgerOf("ktsk-gen");
  assert.equal(Number(row.attempt_generation), 2);
  assert.equal(ledger!.attempts.length, 2, "the record is appended, never overwritten");
  assert.deepEqual(ledger!.attempts.map((a) => a.attemptId), ["att-1", "att-2"]);
  assert.equal(ledger!.attempts[0].attemptGeneration, 1, "the first record is untouched");
  assert.ok(Number(row.claim_count) - claimsBefore > Number(row.attempt_generation) - 0 - 1,
    "the contention claim shows only as a claim_count delta");
});

// ── AC6: recovery loss, per class, at a real boundary ────────────────────────

test("AC6 an attempt closed at its release carries a computed loss", async () => {
  await seedRun(h, "ktsk-loss", SESSION, {
    status: "running", claimCount: 1, leaseOwner: BRAIN, leaseExpiresInSec: 45, queuedAgoSec: 1,
  });
  const startedAtDb = new Date(Date.now() - 2_000).toISOString();
  await releaseClaim("ktsk-loss", BRAIN, 1, "handover", {
    attempt: { attemptId: "att-1", attemptGeneration: 1, startedAtDb, renewed: false },
  });
  const record = (await ledgerOf("ktsk-loss"))!.attempts[0];
  assert.equal(record.recoveryLoss.computable, true);
  assert.ok((record.recoveryLoss.lossMs ?? 0) >= 2_000,
    "measured from started_at, which is the anchor this class actually has");
  assert.ok(record.endedAtDb, "and the boundary instant is recorded with it");
});
