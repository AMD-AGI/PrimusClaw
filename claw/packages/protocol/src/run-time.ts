// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a run's wall time is made of, and how a report of it is banked.
 *
 * One identity holds everywhere below:
 *
 *     wall = known + unknown + unbanked
 *
 * `known` is the closed-interval time attributed to one of the seven named
 * states, `unknown` is time a reporter said it could not attribute, and
 * `unbanked` is time that has elapsed and nobody has reported yet. The third
 * term is additive rather than a residual computed by subtraction, which is
 * what makes the identity hold after every merge instead of only at the end.
 *
 * Everything here is in the database's clock domain. A pod-measured duration
 * enters only as a claim against a budget the database sized, so no accounted
 * quantity depends on a pod clock agreeing with the database's.
 *
 * Shared between the brain, which produces reports, and the API, which merges
 * and stores them, because a merge rule the two packages state separately is
 * two rules.
 */
import type { RunIdentityKey, RunIdentityRef } from "./run-identity.js";
import type { RunWaitReason } from "./types.js";

export type RunTimeState =
  | "queued" | "executing" | "waiting_human" | "waiting_background"
  | "waiting_resource" | "waiting_external" | "recovering" | "unknown";

export type RunTimeKnownState = Exclude<RunTimeState, "unknown">;

/**
 * Canonical order, matching the state table in the design.
 *
 * A merge applies keys in this order so the same report against the same entry
 * yields the same result wherever it runs: with a budget smaller than the
 * report, which key gets the remainder is otherwise arbitrary.
 */
export const RUN_TIME_KNOWN_STATES: readonly RunTimeKnownState[] = [
  "queued", "executing", "waiting_human", "waiting_background",
  "waiting_resource", "waiting_external", "recovering",
];

/** Which state a wait reason is a breakdown of. Total over the reason set. */
export const REASON_STATE: Readonly<Record<RunWaitReason, RunTimeKnownState>> = {
  approval: "waiting_human",
  background_command: "waiting_background",
};

/** Declared order, for the same determinism the state order gives. */
const RUN_WAIT_REASONS: readonly RunWaitReason[] = ["approval", "background_command"];

export type ClockDomain = "brain" | "api" | "db";

/**
 * One round trip, from which the offset and its uncertainty are derived.
 *
 * A single caller-instant-minus-server-instant difference is transit delay and
 * offset added together and removes neither, so the three readings travel
 * rather than the answer.
 */
export interface ClockOffset {
  readonly callerDomain: ClockDomain;
  /** Caller-domain reading taken before the request. */
  readonly sentAtMs: number;
  /** The `clock_timestamp()` the server answered with. */
  readonly dbAt: string;
  /** Caller-domain reading taken after it. */
  readonly receivedAtMs: number;
}

/**
 * Which clocks produced the endpoints of every duration in one report.
 *
 * A mixed-domain duration that does not name both endpoints, or names them
 * without an offset, is unrepresentable rather than discouraged.
 */
export type DurationBasis =
  | { readonly kind: "same_domain"; readonly domain: ClockDomain }
  | {
      readonly kind: "cross_domain";
      readonly startDomain: ClockDomain;
      readonly endDomain: ClockDomain;
      readonly offset: ClockOffset;
    };

/**
 * How far a measured skew may be from zero before a comparison built on it is
 * refused.
 *
 * Declared independently of the sweeper's backstop grace, which happens to
 * carry the same number: that one is a race-ordering margin between a run's
 * self-report and the deadline sweep, and folding the two would make a change
 * to either a silent change to both.
 */
export const RUN_TIME_ACCOUNTING_SKEW_BOUND_SEC = 300;

/** Covered values are running totals for `attemptId`, never deltas. */
export interface RunTimeReport {
  readonly key: RunIdentityKey;
  readonly attemptId: string;
  /** Attempt token; the row's true value, which is 0 on the fat path. */
  readonly claimCount: number;
  /** JetStream `msg.seq`; 0 on the doorbell path, which has no delivery. */
  readonly deliverySeq: number;
  /** JetStream `msg.info.deliveryCount`; 0 likewise. */
  readonly deliveryCount: number;
  readonly basis: DurationBasis;
  readonly cumulativeStateMs?: Partial<Record<RunTimeKnownState, number>>;
  readonly cumulativeReasonMs?: Partial<Record<RunWaitReason, number>>;
  /** The only way a reporter can add to `unknownMs`. */
  readonly cumulativeUnknownMs?: number;
}

/**
 * A report as it comes back off the wire, where the branded key cannot be
 * reconstructed. Every {@link RunTimeReport} is assignable to this.
 */
export type RunTimeReportInput = Omit<RunTimeReport, "key"> & { readonly key: string };

/** What the entry has already been shown by the attempt it names. */
export interface CoverageSeen {
  readonly attemptId: string;
  readonly stateMs: Readonly<Partial<Record<RunTimeKnownState, number>>>;
  readonly reasonMs: Readonly<Partial<Record<RunWaitReason, number>>>;
  readonly unknownMs: number;
}

export interface AttemptRecord {
  /** Null only for an attempt that never completed a claim. */
  readonly attemptId: string | null;
  readonly attemptGeneration: number | null;
  readonly startedAtDb: string | null;
  readonly endedAtDb?: string;
  readonly lastObservedHeartbeatAtDb?: string;
  readonly renewed: boolean;
  /**
   * An upper bound when computable: it includes the reaper's own detection
   * latency, which can only add apparent loss.
   */
  readonly recoveryLoss:
    | { readonly computable: true; readonly lossMs: number }
    | { readonly computable: false; readonly lossMs: null };
}

export interface RunTimeLedgerEntry {
  readonly identity: RunIdentityRef;
  /** DB-domain duration, equal to the sum of `knownMsByState` after every merge. */
  readonly watermarkMs: number;
  /** Where the entry's accounting starts: the run's `queued_at`. */
  readonly epochInstantDb: string;
  /** Advances only by what a step banks, and never past the read instant. */
  readonly lastAcceptedInstantDb: string;
  readonly terminalAtDb: string | null;
  readonly settled: boolean;
  readonly accountingVerdict: "computed" | "degraded_skew";
  readonly ledgerVersion: number;
  readonly knownMsByState: Readonly<Record<RunTimeKnownState, number>>;
  readonly knownMsByReason: Readonly<Partial<Record<RunWaitReason, number>>>;
  /** The one storage location for time nobody could attribute. */
  readonly unknownMs: number;
  readonly coverageSeen: CoverageSeen;
  /** Only the latest accepted merge's clamps. */
  readonly clampedKeys: readonly string[];
  /** Cumulative and never cleared, so "did this run ever clamp" stays answerable. */
  readonly clampHistory: Readonly<Partial<Record<string, number>>>;
  readonly attempts: readonly AttemptRecord[];
  /** Attempt records dropped past the cap. */
  readonly attemptsDiscarded: number;
}

export const MAX_ATTEMPT_RECORDS = 20;

const zeroStates = (): Record<RunTimeKnownState, number> =>
  Object.fromEntries(RUN_TIME_KNOWN_STATES.map((s) => [s, 0])) as Record<RunTimeKnownState, number>;

function emptyCoverage(attemptId: string): CoverageSeen {
  return { attemptId, stateMs: {}, reasonMs: {}, unknownMs: 0 };
}

/**
 * A fresh entry anchored at the instant the run became accounting-eligible.
 *
 * The epoch is `queued_at` rather than the first report, so time a run spent
 * queued before anything observed it is `unbanked` from the first read instead
 * of vanishing from the identity.
 */
export function newRunTimeLedgerEntry(
  identity: RunIdentityRef,
  queuedAtDb: string,
): RunTimeLedgerEntry {
  return {
    identity,
    watermarkMs: 0,
    epochInstantDb: queuedAtDb,
    lastAcceptedInstantDb: queuedAtDb,
    terminalAtDb: null,
    settled: false,
    accountingVerdict: "computed",
    ledgerVersion: 0,
    knownMsByState: zeroStates(),
    knownMsByReason: {},
    unknownMs: 0,
    coverageSeen: emptyCoverage(""),
    clampedKeys: [],
    clampHistory: {},
    attempts: [],
    attemptsDiscarded: 0,
  };
}

const msBetween = (fromDb: string, toDb: string): number =>
  Date.parse(toDb) - Date.parse(fromDb);

const plusMs = (instantDb: string, ms: number): string =>
  new Date(Date.parse(instantDb) + ms).toISOString();

/** What a round trip actually measured, as three numbers rather than one. */
export function clockOffsetOf(offset: ClockOffset): {
  rttMs: number; offsetMs: number; uncertaintyMs: number;
} {
  const rttMs = Math.max(0, offset.receivedAtMs - offset.sentAtMs);
  const midpoint = (offset.sentAtMs + offset.receivedAtMs) / 2;
  return {
    rttMs,
    offsetMs: Date.parse(offset.dbAt) - midpoint,
    uncertaintyMs: rttMs / 2,
  };
}

/** Whether a report closes any interval at all, or only re-asserts a state. */
export function isCoveringReport(report: RunTimeReportInput): boolean {
  return report.cumulativeStateMs !== undefined
    || report.cumulativeReasonMs !== undefined
    || report.cumulativeUnknownMs !== undefined;
}

/** Whether a basis's measured skew is small enough to attribute time by. */
function basisAdmissible(basis: DurationBasis): boolean {
  if (basis.kind === "same_domain") return true;
  const { offsetMs, uncertaintyMs } = clockOffsetOf(basis.offset);
  return Math.abs(offsetMs) + uncertaintyMs <= RUN_TIME_ACCOUNTING_SKEW_BOUND_SEC * 1000;
}

/**
 * A covered value as it may be banked, given where its endpoints were measured.
 *
 * A duration whose start was read on the caller's clock and whose end was read
 * on the database's carries the offset between them, so the offset comes back
 * out; the uncertainty is then subtracted rather than ignored, which makes what
 * is banked a lower bound and leaves the shortfall visible as unbanked time.
 */
function admissibleValue(raw: number, basis: DurationBasis): number {
  const value = Math.max(Math.floor(raw), 0);
  if (basis.kind === "same_domain") return value;
  const { offsetMs, uncertaintyMs } = clockOffsetOf(basis.offset);
  return Math.max(0, Math.floor(value - offsetMs - uncertaintyMs));
}

interface MergeAccumulator {
  remaining: number;
  banked: number;
  states: Record<RunTimeKnownState, number>;
  reasons: Partial<Record<RunWaitReason, number>>;
  seenStates: Partial<Record<RunTimeKnownState, number>>;
  seenReasons: Partial<Record<RunWaitReason, number>>;
  seenUnknown: number;
  unknownMs: number;
  clamped: string[];
}

function bankStateKeys(
  acc: MergeAccumulator,
  incoming: Partial<Record<RunTimeKnownState, number>> | undefined,
  basis: DurationBasis,
): void {
  if (!incoming) return;
  for (const state of RUN_TIME_KNOWN_STATES) {
    const raw = incoming[state];
    if (raw === undefined) continue;
    const value = admissibleValue(raw, basis);
    const seen = acc.seenStates[state] ?? 0;
    const want = Math.max(0, value - seen);
    const take = Math.min(want, acc.remaining);
    if (take < want) acc.clamped.push(`state:${state}`);
    acc.states[state] += take;
    acc.remaining -= take;
    acc.banked += take;
    // To what was presented, not to what was banked: a clamped excess is
    // recorded once, so a redelivery of the same total cannot re-bank it.
    acc.seenStates[state] = Math.max(seen, value);
  }
}

function bankUnknown(
  acc: MergeAccumulator,
  raw: number | undefined,
  basis: DurationBasis,
): void {
  if (raw === undefined) return;
  const value = admissibleValue(raw, basis);
  const want = Math.max(0, value - acc.seenUnknown);
  const take = Math.min(want, acc.remaining);
  if (take < want) acc.clamped.push("unknown");
  acc.unknownMs += take;
  acc.remaining -= take;
  acc.banked += take;
  acc.seenUnknown = Math.max(acc.seenUnknown, value);
}

/**
 * A reason is a tag on time already counted under a state, so it is bounded by
 * that state's total rather than by the coverage budget: charging it again
 * would spend the same wall second twice and starve a later state key.
 */
function bankReasonKeys(
  acc: MergeAccumulator,
  incoming: Partial<Record<RunWaitReason, number>> | undefined,
  basis: DurationBasis,
): void {
  if (!incoming) return;
  for (const reason of RUN_WAIT_REASONS) {
    const raw = incoming[reason];
    if (raw === undefined) continue;
    const value = admissibleValue(raw, basis);
    const seen = acc.seenReasons[reason] ?? 0;
    const current = acc.reasons[reason] ?? 0;
    const want = Math.max(0, value - seen);
    const headroom = Math.max(0, acc.states[REASON_STATE[reason]] - current);
    const take = Math.min(want, headroom);
    if (take < want) acc.clamped.push(`reason:${reason}`);
    acc.reasons[reason] = current + take;
    acc.seenReasons[reason] = Math.max(seen, value);
  }
}

function withClampHistory(
  history: Readonly<Partial<Record<string, number>>>,
  clamped: readonly string[],
): Partial<Record<string, number>> {
  const next = { ...history };
  for (const key of clamped) next[key] = (next[key] ?? 0) + 1;
  return next;
}

/**
 * Bank what a report covers, up to the wall time that has actually elapsed.
 *
 * Pure and total: a value the budget cannot admit is clamped and recorded, and
 * never rejected as a whole report, which would starve every well-behaved key
 * beside it. Concurrency safety belongs to the caller.
 *
 * @param readAtDb the DB-domain instant read in the same statement as `stored`.
 */
export function mergeRunTimeReport(
  stored: RunTimeLedgerEntry,
  incoming: RunTimeReportInput,
  readAtDb: string,
): RunTimeLedgerEntry {
  if (!isCoveringReport(incoming)) return stored;
  const budget = Math.max(0, msBetween(stored.lastAcceptedInstantDb, readAtDb));

  if (!basisAdmissible(incoming.basis)) {
    // Nothing is clamped to zero and no signed correction is applied: nothing
    // downstream could tell a corrected number from a real one, whereas an
    // explicit `unknown` is checkable.
    return {
      ...stored,
      unknownMs: stored.unknownMs + budget,
      lastAcceptedInstantDb: plusMs(stored.lastAcceptedInstantDb, budget),
      accountingVerdict: "degraded_skew",
      clampedKeys: [],
    };
  }

  // A new attempt restarts its totals at zero, which is a reset rather than a
  // regression. Only a report that already passed the row's attempt fence
  // reaches here, so the reset can only move the entry forward.
  const fresh = stored.coverageSeen.attemptId !== incoming.attemptId;
  const seen = fresh ? emptyCoverage(incoming.attemptId) : stored.coverageSeen;

  const acc: MergeAccumulator = {
    remaining: budget,
    banked: 0,
    states: { ...stored.knownMsByState },
    reasons: { ...stored.knownMsByReason },
    seenStates: { ...seen.stateMs },
    seenReasons: { ...seen.reasonMs },
    seenUnknown: seen.unknownMs,
    unknownMs: stored.unknownMs,
    clamped: [],
  };

  bankStateKeys(acc, incoming.cumulativeStateMs, incoming.basis);
  const bankedStates = acc.banked;
  bankUnknown(acc, incoming.cumulativeUnknownMs, incoming.basis);
  bankReasonKeys(acc, incoming.cumulativeReasonMs, incoming.basis);

  return {
    ...stored,
    watermarkMs: stored.watermarkMs + bankedStates,
    lastAcceptedInstantDb: plusMs(stored.lastAcceptedInstantDb, acc.banked),
    knownMsByState: acc.states,
    knownMsByReason: acc.reasons,
    unknownMs: acc.unknownMs,
    coverageSeen: {
      attemptId: incoming.attemptId,
      stateMs: acc.seenStates,
      reasonMs: acc.seenReasons,
      unknownMs: acc.seenUnknown,
    },
    clampedKeys: acc.clamped,
    clampHistory: withClampHistory(stored.clampHistory, acc.clamped),
  };
}

/**
 * Bank queue time the table has already measured, by difference.
 *
 * Not a report: queue membership is observed by the row rather than by any
 * worker, and a run that timed out in the queue never allocated an attempt to
 * report under. Whichever observer sees the total first banks the outstanding
 * amount and the others bank zero, so no flag is needed to make it once-only.
 */
export function bankQueuedMs(
  stored: RunTimeLedgerEntry,
  queuedTotalMs: number,
  readAtDb: string,
): RunTimeLedgerEntry {
  const budget = Math.max(0, msBetween(stored.lastAcceptedInstantDb, readAtDb));
  const outstanding = Math.max(0, Math.floor(queuedTotalMs) - stored.knownMsByState.queued);
  const take = Math.min(outstanding, budget);
  if (take === 0) return stored;
  return {
    ...stored,
    watermarkMs: stored.watermarkMs + take,
    lastAcceptedInstantDb: plusMs(stored.lastAcceptedInstantDb, take),
    knownMsByState: { ...stored.knownMsByState, queued: stored.knownMsByState.queued + take },
  };
}

/** Wall time as its three terms, at the instant the entry was read. */
export function runTimeTotals(entry: RunTimeLedgerEntry, readAtDb: string): {
  knownMs: number; unknownMs: number; unbankedMs: number; wallMs: number;
} {
  const end = entry.terminalAtDb ?? readAtDb;
  const knownMs = RUN_TIME_KNOWN_STATES.reduce((sum, s) => sum + entry.knownMsByState[s], 0);
  const unbankedMs = Math.max(0, msBetween(entry.lastAcceptedInstantDb, end));
  return {
    knownMs,
    unknownMs: entry.unknownMs,
    unbankedMs,
    wallMs: knownMs + entry.unknownMs + unbankedMs,
  };
}

/**
 * How much of an attempt's work was lost when it died, per attempt class.
 *
 * Every branch is an **upper bound**: each includes the reaper's own detection
 * latency, which can only add apparent loss, never subtract it.
 */
export function recoveryLossForAttempt(
  record: AttemptRecord,
  detectionInstantDb: string,
): AttemptRecord["recoveryLoss"] {
  const anchor = record.renewed ? record.lastObservedHeartbeatAtDb : record.startedAtDb;
  // No claim ever completed, so no anchor instant exists in any domain. Said
  // explicitly rather than reported as a loss of zero, which reads as "nothing
  // was lost" for the class that lost the most.
  if (!anchor) return { computable: false, lossMs: null };
  return { computable: true, lossMs: Math.max(0, msBetween(anchor, detectionInstantDb)) };
}

/** Append an attempt record, dropping the oldest past the cap. */
export function appendAttemptRecord(
  entry: RunTimeLedgerEntry,
  record: AttemptRecord,
): RunTimeLedgerEntry {
  const attempts = [...entry.attempts, record];
  const overflow = Math.max(0, attempts.length - MAX_ATTEMPT_RECORDS);
  return {
    ...entry,
    attempts: attempts.slice(overflow),
    attemptsDiscarded: entry.attemptsDiscarded + overflow,
  };
}

/** Why a payload was refused, or the report it decoded to. */
export type RunTimeReportDecoding =
  | { readonly ok: true; readonly report: RunTimeReportInput }
  | { readonly ok: false; readonly rejected: string };

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function decodeBasis(raw: unknown): DurationBasis | string {
  const basis = raw as Partial<DurationBasis> | undefined;
  if (!basis || typeof basis !== "object") return "basis: required, naming the clock every covered value was measured on";
  if (basis.kind === "same_domain") {
    return typeof (basis as { domain?: unknown }).domain === "string"
      ? { kind: "same_domain", domain: (basis as { domain: ClockDomain }).domain }
      : "basis.domain: required for a same_domain basis";
  }
  if (basis.kind !== "cross_domain") return "basis.kind: expected one of same_domain, cross_domain";
  const cross = basis as Partial<Extract<DurationBasis, { kind: "cross_domain" }>>;
  const offset = cross.offset;
  // A cross-domain duration without a measured offset is a number nobody can
  // bound, so it is refused here rather than banked and quietly wrong.
  if (!offset || !isFiniteNumber(offset.sentAtMs) || !isFiniteNumber(offset.receivedAtMs)
      || typeof offset.dbAt !== "string") {
    return "basis.offset: required for a cross_domain basis, as one measured round trip";
  }
  if (typeof cross.startDomain !== "string" || typeof cross.endDomain !== "string") {
    return "basis.startDomain/endDomain: required for a cross_domain basis";
  }
  return {
    kind: "cross_domain",
    startDomain: cross.startDomain,
    endDomain: cross.endDomain,
    offset,
  };
}

/**
 * Validate a reported reading of a run's time at the boundary it arrives on.
 *
 * Fail-closed on the attempt token: an omitted field is not a zero, because
 * accepting it unfenced reopens the race a late heartbeat wins.
 */
export function decodeRunTimeReport(raw: unknown): RunTimeReportDecoding {
  const body = raw as Partial<RunTimeReportInput> | undefined;
  if (!body || typeof body !== "object") return { ok: false, rejected: "run_time: expected an object" };
  if (typeof body.key !== "string" || !body.key) return { ok: false, rejected: "key: required" };
  if (typeof body.attemptId !== "string" || !body.attemptId) {
    return { ok: false, rejected: "attemptId: required" };
  }
  for (const field of ["claimCount", "deliverySeq", "deliveryCount"] as const) {
    if (!isFiniteNumber(body[field])) return { ok: false, rejected: `${field}: required, and a number` };
  }
  const basis = decodeBasis(body.basis);
  if (typeof basis === "string") return { ok: false, rejected: basis };
  return {
    ok: true,
    report: {
      key: body.key,
      attemptId: body.attemptId,
      claimCount: body.claimCount as number,
      deliverySeq: body.deliverySeq as number,
      deliveryCount: body.deliveryCount as number,
      basis,
      ...(body.cumulativeStateMs ? { cumulativeStateMs: body.cumulativeStateMs } : {}),
      ...(body.cumulativeReasonMs ? { cumulativeReasonMs: body.cumulativeReasonMs } : {}),
      ...(isFiniteNumber(body.cumulativeUnknownMs) ? { cumulativeUnknownMs: body.cumulativeUnknownMs } : {}),
    },
  };
}
