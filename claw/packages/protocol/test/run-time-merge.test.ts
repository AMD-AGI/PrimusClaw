// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The rule that decides what a reported reading of a run's time is worth.
 *
 * Everything the row stores about wall time goes through `mergeRunTimeReport`,
 * and the properties it has to hold are all invariants rather than examples:
 * the identity is exact after every merge, the watermark only rises, a report
 * cannot claim more time than has elapsed, and a reason is a breakdown of a
 * state rather than a second interval.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MAX_ATTEMPT_RECORDS,
  RUN_TIME_ACCOUNTING_SKEW_BOUND_SEC,
  RUN_TIME_KNOWN_STATES,
  appendAttemptRecord,
  bankQueuedMs,
  clockOffsetOf,
  decodeRunTimeReport,
  mergeRunTimeReport,
  newRunTimeLedgerEntry,
  recoveryLossForAttempt,
  runTimeTotals,
  type AttemptRecord,
  type RunTimeLedgerEntry,
  type RunTimeReport,
} from "../src/run-time.js";

const EPOCH = "2026-01-01T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(EPOCH) + ms).toISOString();
const IDENTITY = { key: "ktsk_1", source: "task_id" as const };

const entry = (): RunTimeLedgerEntry => newRunTimeLedgerEntry(IDENTITY, EPOCH);

function report(over: Partial<RunTimeReport> = {}): RunTimeReport {
  return {
    key: "ktsk_1",
    attemptId: "att-1",
    claimCount: 0,
    deliverySeq: 1,
    deliveryCount: 1,
    basis: { kind: "same_domain", domain: "brain" },
    ...over,
  };
}

const knownOf = (e: RunTimeLedgerEntry) =>
  RUN_TIME_KNOWN_STATES.reduce((sum, s) => sum + e.knownMsByState[s], 0);

/** wall = known + unknown + unbanked, with no tolerance at all. */
function assertIdentity(e: RunTimeLedgerEntry, readAtDb: string): void {
  const totals = runTimeTotals(e, readAtDb);
  const end = e.terminalAtDb ?? readAtDb;
  const wall = Date.parse(end) - Date.parse(e.epochInstantDb);
  assert.equal(totals.knownMs + totals.unknownMs + totals.unbankedMs, wall,
    "a deterministic run has no skew to bound, so the identity is exact or it is wrong");
  assert.equal(totals.wallMs, wall);
}

test("AC1 the identity is exact after every merge, and the anchor moves by what was banked", () => {
  let e = entry();
  assertIdentity(e, at(1_000));

  e = mergeRunTimeReport(e, report({ cumulativeStateMs: { executing: 400 } }), at(1_000));
  assert.equal(e.knownMsByState.executing, 400);
  assert.equal(e.lastAcceptedInstantDb, at(400), "the anchor advances by exactly what was banked");
  assertIdentity(e, at(1_000));

  e = mergeRunTimeReport(e, report({
    cumulativeStateMs: { executing: 400, waiting_background: 300 },
    cumulativeReasonMs: { background_command: 300 },
  }), at(2_000));
  assert.equal(e.knownMsByState.waiting_background, 300);
  assert.equal(e.knownMsByReason.background_command, 300);
  assert.equal(runTimeTotals(e, at(2_000)).unbankedMs, 1_300,
    "the tail nobody reported stays visible rather than being guessed at");
  assertIdentity(e, at(2_000));
});

test("AC1 the seven named states carry the run, and unknown has one home", () => {
  let e = entry();
  const cumulativeStateMs = Object.fromEntries(RUN_TIME_KNOWN_STATES.map((s) => [s, 100]));
  e = mergeRunTimeReport(e, report({ cumulativeStateMs, cumulativeUnknownMs: 50 }), at(5_000));

  assert.equal(knownOf(e), 700);
  assert.equal(e.unknownMs, 50);
  assert.ok(!Object.hasOwn(e.knownMsByState, "unknown"),
    "unknown is not a state key; the type says so and the merge must agree");
  assertIdentity(e, at(5_000));
});

test("AC1 the accounting module states one wall-time formula, in one place", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/run-time.ts", import.meta.url)), "utf8");
  const summing = source.match(/knownMs \+ .*unknownMs \+ .*unbankedMs/g) ?? [];
  assert.equal(summing.length, 1, "a second wall-time formula is a second answer");
});

test("AC3 an identity-only tick banks nothing and moves nothing", () => {
  const opening = entry();
  const after = mergeRunTimeReport(opening, report(), at(1_000));
  assert.equal(after, opening, "a tick that closed no interval must not bump the version either");
  assert.equal(after.watermarkMs, 0);
  assert.equal(after.unknownMs, 0);
  assert.equal(after.lastAcceptedInstantDb, EPOCH);

  const covering = mergeRunTimeReport(after, report({ cumulativeStateMs: { executing: 600 } }), at(1_000));
  assert.equal(covering.watermarkMs, 600, "and only a covering report advances it");
});

test("AC3 the watermark is the sum of the named states, after every merge", () => {
  let e = entry();
  const steps: Array<[Partial<Record<string, number>>, number]> = [
    [{ executing: 300 }, 1_000],
    [{ executing: 300, waiting_background: 200 }, 2_000],
    [{ executing: 900, waiting_background: 200 }, 4_000],
  ];
  for (const [cumulativeStateMs, readMs] of steps) {
    e = mergeRunTimeReport(e, report({ cumulativeStateMs: cumulativeStateMs as never }), at(readMs));
    assert.equal(e.watermarkMs, knownOf(e), "a divergence here is a defect, not a tolerance");
  }
  assert.equal(e.watermarkMs, 1_100);
});

test("AC3 reason values never advance the watermark on their own", () => {
  const e = mergeRunTimeReport(entry(), report({
    cumulativeStateMs: { waiting_background: 500 },
    cumulativeReasonMs: { background_command: 500 },
  }), at(4_000));
  assert.equal(e.watermarkMs, 500, "the same interval must not be counted twice");
  assert.equal(e.knownMsByReason.background_command, 500);
});

test("AC3 reports out of order never regress the watermark", () => {
  const later = report({ attemptId: "att-1", cumulativeStateMs: { executing: 900 } });
  const earlier = report({ attemptId: "att-1", cumulativeStateMs: { executing: 300 } });

  let e = mergeRunTimeReport(entry(), later, at(4_000));
  assert.equal(e.watermarkMs, 900);
  e = mergeRunTimeReport(e, earlier, at(5_000));
  assert.equal(e.watermarkMs, 900, "a report overtaken by a later one banks nothing");
  assert.equal(e.coverageSeen.stateMs.executing, 900, "and must not lower what has been seen");
});

test("AC3 a report claiming more than has elapsed is clamped, not banked elsewhere", () => {
  const e = mergeRunTimeReport(entry(), report({ cumulativeStateMs: { executing: 10_000 } }), at(1_000));
  assert.equal(e.knownMsByState.executing, 1_000, "the wall clock between two merges is the budget");
  assert.equal(e.unknownMs, 0, "an over-claim is not time the run spent, so it lands nowhere");
  assert.deepEqual(e.clampedKeys, ["state:executing"]);
  assertIdentity(e, at(1_000));
});

test("AC3 replaying a final report, then an earlier one, then the final again", () => {
  const final = report({ cumulativeStateMs: { executing: 800, waiting_background: 200 } });
  const earlier = report({ cumulativeStateMs: { executing: 300 } });
  const inOrder = mergeRunTimeReport(entry(), final, at(4_000));

  let e = mergeRunTimeReport(entry(), final, at(4_000));
  e = mergeRunTimeReport(e, final, at(4_100));
  e = mergeRunTimeReport(e, earlier, at(4_200));
  e = mergeRunTimeReport(e, final, at(4_300));

  assert.deepEqual(e.knownMsByState, inOrder.knownMsByState,
    "exactly-once under a fire-and-forget wire, with no report id anywhere");
  assert.equal(e.watermarkMs, inOrder.watermarkMs);
});

test("AC3 a new attempt's totals restart at zero without re-banking the old ones", () => {
  let e = mergeRunTimeReport(entry(), report({ cumulativeStateMs: { executing: 500 } }), at(2_000));
  e = mergeRunTimeReport(e, report({ attemptId: "att-2", cumulativeStateMs: { executing: 100 } }), at(3_000));
  assert.equal(e.coverageSeen.attemptId, "att-2");
  assert.equal(e.knownMsByState.executing, 600, "a restart at zero is a reset, not a regression");
});

test("AC7 an overshooting state key is clamped and the reason beside it still lands", () => {
  const e = mergeRunTimeReport(entry(), report({
    cumulativeStateMs: { waiting_background: 9_000 },
    cumulativeReasonMs: { background_command: 400 },
  }), at(1_000));

  assert.equal(e.knownMsByState.waiting_background, 1_000);
  assert.deepEqual(e.clampedKeys, ["state:waiting_background"]);
  assert.equal(e.knownMsByReason.background_command, 400, "the well-behaved key is accepted in full");
  assert.equal(e.unknownMs, 0);
});

test("AC7 an overshooting reason key is bounded by the state it attributes", () => {
  const e = mergeRunTimeReport(entry(), report({
    cumulativeStateMs: { waiting_background: 500 },
    cumulativeReasonMs: { background_command: 9_000 },
  }), at(4_000));

  assert.equal(e.knownMsByState.waiting_background, 500, "the state key fits and is taken whole");
  assert.equal(e.knownMsByReason.background_command, 500);
  assert.deepEqual(e.clampedKeys, ["reason:background_command"]);
  assert.equal(knownOf(e), 500, "a reason consumes no budget of its own");
});

test("AC7 a reason-only report is bounded by the state total already stored", () => {
  let e = mergeRunTimeReport(entry(), report({ cumulativeStateMs: { waiting_human: 300 } }), at(4_000));
  e = mergeRunTimeReport(e, report({ cumulativeReasonMs: { approval: 800 } }), at(5_000));
  assert.equal(e.knownMsByReason.approval, 300, "the shape has a defined rule, not an absent one");
  assert.deepEqual(e.clampedKeys, ["reason:approval"]);
});

test("AC7 clamps are answerable both for this report and for the run's life", () => {
  let e = entry();
  // Escalating totals rather than the same one repeated: a duplicate total is
  // banked nowhere and is not a fresh clamp either.
  for (const [claimed, readMs] of [[100_000, 1_000], [200_000, 2_000], [300_000, 3_000]]) {
    e = mergeRunTimeReport(e, report({ cumulativeStateMs: { executing: claimed } }), at(readMs));
    assert.deepEqual(e.clampedKeys, ["state:executing"]);
  }
  assert.equal(e.clampHistory["state:executing"], 3);
  const clean = mergeRunTimeReport(e, report({ cumulativeStateMs: { executing: 400_000 } }), at(300_000));
  assert.deepEqual(clean.clampedKeys, [], "the snapshot is only the latest report's");
  assert.equal(clean.clampHistory["state:executing"], 3, "the history is never cleared");
});

test("AC2 an offset is measured over a round trip, not subtracted once", () => {
  const measured = clockOffsetOf({
    callerDomain: "brain", sentAtMs: 1_000, dbAt: new Date(1_150).toISOString(), receivedAtMs: 1_100,
  });
  assert.equal(measured.rttMs, 100);
  assert.equal(measured.offsetMs, 100, "the midpoint removes the transit delay the one-shot keeps");
  assert.equal(measured.uncertaintyMs, 50);
});

test("AC2 a cross-domain report inside the bound is banked corrected and reduced", () => {
  const offset = {
    callerDomain: "brain" as const, sentAtMs: 1_000,
    dbAt: new Date(1_150).toISOString(), receivedAtMs: 1_100,
  };
  const e = mergeRunTimeReport(entry(), report({
    basis: { kind: "cross_domain", startDomain: "brain", endDomain: "db", offset },
    cumulativeStateMs: { executing: 1_000 },
  }), at(4_000));

  assert.equal(e.knownMsByState.executing, 850, "1000 - offset 100 - uncertainty 50");
  assert.equal(e.accountingVerdict, "computed");
  assertIdentity(e, at(4_000));
});

test("AC2 excess skew refuses the attribution instead of correcting it", () => {
  const wild = RUN_TIME_ACCOUNTING_SKEW_BOUND_SEC * 1000 + 60_000;
  const offset = {
    callerDomain: "brain" as const, sentAtMs: 0,
    dbAt: new Date(wild).toISOString(), receivedAtMs: 10,
  };
  const e = mergeRunTimeReport(entry(), report({
    basis: { kind: "cross_domain", startDomain: "brain", endDomain: "db", offset },
    cumulativeStateMs: { executing: 500 },
    cumulativeReasonMs: { background_command: 100 },
  }), at(2_000));

  assert.equal(knownOf(e), 0, "no state or reason value is accepted from a report this skewed");
  assert.deepEqual(e.knownMsByReason, {});
  assert.equal(e.unknownMs, 2_000, "the whole budget lands where unattributable time lives");
  assert.equal(e.accountingVerdict, "degraded_skew");
  assertIdentity(e, at(2_000));

  const later = mergeRunTimeReport(e, report({ cumulativeStateMs: { executing: 500 } }), at(3_000));
  assert.equal(later.accountingVerdict, "degraded_skew",
    "a run degraded once cannot be called clean afterwards");
});

test("AC2 a cross-domain payload with no offset is refused at the wire boundary", () => {
  const decoded = decodeRunTimeReport({
    key: "k", attemptId: "a", claimCount: 0, deliverySeq: 0, deliveryCount: 0,
    basis: { kind: "cross_domain", startDomain: "brain", endDomain: "db" },
  });
  assert.equal(decoded.ok, false);
  assert.match((decoded as { rejected: string }).rejected, /basis\.offset/);
});

test("AC2 a clock domain outside the closed set is refused, not carried through", () => {
  // A basis naming a domain nothing accounts for would sit in the entry looking
  // like a measurement, and a cross-domain one would bypass the skew rule
  // entirely because no branch recognises it.
  const wire = (basis: unknown) => decodeRunTimeReport({
    key: "k", attemptId: "a", claimCount: 0, deliverySeq: 0, deliveryCount: 0, basis,
  });
  assert.equal(wire({ kind: "same_domain", domain: "wristwatch" }).ok, false);
  assert.match((wire({ kind: "same_domain", domain: "wristwatch" }) as { rejected: string }).rejected,
    /basis\.domain/);
  assert.equal(wire({ kind: "cross_domain", startDomain: "brain", endDomain: "sundial",
    offset: { callerDomain: "brain", sentAtMs: 0, dbAt: EPOCH, receivedAtMs: 1 } }).ok, false);
  assert.equal(wire({ kind: "same_domain", domain: "brain" }).ok, true);
});

test("AC2 an unparseable offset instant is refused by name, not at the arithmetic", () => {
  const decoded = decodeRunTimeReport({
    key: "k", attemptId: "a", claimCount: 0, deliverySeq: 0, deliveryCount: 0,
    basis: {
      kind: "cross_domain", startDomain: "brain", endDomain: "db",
      offset: { callerDomain: "brain", sentAtMs: 0, dbAt: "not-an-instant", receivedAtMs: 1 },
    },
  });
  assert.equal(decoded.ok, false);
  assert.match((decoded as { rejected: string }).rejected, /basis\.offset\.dbAt/);
});

test("AC2 a covered map is refused for an unknown key or a value that is not a duration", () => {
  const wire = (over: Record<string, unknown>) => decodeRunTimeReport({
    key: "k", attemptId: "a", claimCount: 0, deliverySeq: 0, deliveryCount: 0,
    basis: { kind: "same_domain", domain: "brain" }, ...over,
  });
  // `unknown` is not a state key: §3 gives unattributable time one home, and a
  // reporter reaches it through cumulativeUnknownMs alone.
  assert.equal(wire({ cumulativeStateMs: { unknown: 5 } }).ok, false);
  assert.equal(wire({ cumulativeStateMs: { napping: 5 } }).ok, false);
  assert.equal(wire({ cumulativeReasonMs: { impatience: 5 } }).ok, false);
  for (const bad of ["500", Number.NaN, Number.POSITIVE_INFINITY, -1, null]) {
    const decoded = wire({ cumulativeStateMs: { executing: bad } });
    assert.equal(decoded.ok, false, `executing: ${String(bad)} must be refused`);
    assert.match((decoded as { rejected: string }).rejected, /cumulativeStateMs\.executing/);
  }
  assert.equal(wire({ cumulativeUnknownMs: "500" }).ok, false);
  assert.equal(wire({ cumulativeStateMs: { executing: 500 } }).ok, true);
});

test("AC2 a value the decoder let through cannot reach the merge as a non-number", () => {
  // The failure the type refuses to describe: a string state value reaches
  // Date arithmetic and surfaces as a RangeError from a subtraction, three
  // layers from the field that was wrong.
  const decoded = decodeRunTimeReport({
    key: "ktsk_1", attemptId: "att-1", claimCount: 0, deliverySeq: 0, deliveryCount: 0,
    basis: { kind: "same_domain", domain: "brain" },
    cumulativeStateMs: { executing: "500" },
  });
  assert.equal(decoded.ok, false);
  const merged = mergeRunTimeReport(entry(), report({ cumulativeStateMs: { executing: 500 } }), at(1_000));
  assert.ok(Number.isFinite(Date.parse(merged.lastAcceptedInstantDb)),
    "and everything that does get through keeps the anchor a parseable instant");
});

test("AC2 an omitted attempt-token field is not read as a zero", () => {
  for (const missing of ["attemptId", "claimCount", "deliverySeq", "deliveryCount"]) {
    const body: Record<string, unknown> = {
      key: "k", attemptId: "a", claimCount: 0, deliverySeq: 0, deliveryCount: 0,
      basis: { kind: "same_domain", domain: "brain" },
    };
    delete body[missing];
    const decoded = decodeRunTimeReport(body);
    assert.equal(decoded.ok, false, `${missing} must be required`);
  }
});

test("AC2 the recovery-loss quantity says it is an upper bound where it is defined", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/run-time.ts", import.meta.url)), "utf8");
  const doc = source.slice(0, source.indexOf("export function recoveryLossForAttempt"));
  assert.match(doc.slice(doc.lastIndexOf("/**")), /upper bound/i);
});

test("AC6 recovery loss is per class, and never a silent zero", () => {
  const base: AttemptRecord = {
    attemptId: "att-1", attemptGeneration: 1, startedAtDb: at(0),
    renewed: false, recoveryLoss: { computable: false, lossMs: null },
  };

  const renewed = recoveryLossForAttempt(
    { ...base, renewed: true, lastObservedHeartbeatAtDb: at(1_000) }, at(4_000));
  assert.deepEqual(renewed, { computable: true, lossMs: 3_000 });

  // The class D5 names: heartbeat_at and started_at are stamped in one UPDATE,
  // so measuring from the heartbeat gives zero by construction.
  const neverRenewed = recoveryLossForAttempt({ ...base, lastObservedHeartbeatAtDb: at(0) }, at(4_000));
  assert.deepEqual(neverRenewed, { computable: true, lossMs: 4_000 });

  const slotless = recoveryLossForAttempt(
    { ...base, attemptId: null, attemptGeneration: null, startedAtDb: null }, at(4_000));
  assert.deepEqual(slotless, { computable: false, lossMs: null });
  assert.notEqual(slotless.lossMs, 0, "an unknowable loss must not read as no loss");
});

test("queued time is banked by difference, so a second observer banks nothing", () => {
  const first = bankQueuedMs(entry(), 700, at(4_000));
  assert.equal(first.knownMsByState.queued, 700);
  assert.equal(first.watermarkMs, 700, "banked queue time is part of the named-state sum");
  const second = bankQueuedMs(first, 700, at(5_000));
  assert.equal(second, first, "whoever gets there first banks it; the rest bank zero");
  assertIdentity(first, at(4_000));
});

test("the attempt-record list is capped, and says how much it dropped", () => {
  let e = entry();
  const record = (n: number): AttemptRecord => ({
    attemptId: `att-${n}`, attemptGeneration: n, startedAtDb: at(n),
    renewed: false, recoveryLoss: { computable: false, lossMs: null },
  });
  for (let n = 1; n <= MAX_ATTEMPT_RECORDS + 3; n++) e = appendAttemptRecord(e, record(n));

  assert.equal(e.attempts.length, MAX_ATTEMPT_RECORDS);
  assert.equal(e.attemptsDiscarded, 3, "a pathological retry loop loses detail, visibly");
  assert.equal(e.attempts[0].attemptId, "att-4", "the oldest goes first");
});
