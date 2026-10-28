// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The orphan sweep must leave an idle, parked sandbox alone for its reuse window.
 *
 * Measured on the live fleet: a turn ends, Brain parks the sandbox so the
 * session's next message can pick it up (SANDBOX_IDLE_REUSE_SECONDS, 15 minutes),
 * Brain's keepalive publishes its first idle verdict one interval later, and the
 * next tick of this sweep read "terminal DAG row, nothing live, verdict idle" as
 * an orphan and stopped the workload -- 56-90 s after the turn, with Brain's own
 * sweep still counting the handle as inside its window. The next turn found a
 * terminal workload and cold-started a new one (10-14 s).
 *
 * These drive the real `reapOrphanHandles` over the real reader with its
 * production default window, a fake KV bucket standing in for NATS, and assert on
 * the one outcome that matters: whether a stop reached SaFE, and for which
 * workload. Every deferral case has a control that is stopped, because a sweep
 * that defers everything is the leak this branch must not reintroduce.
 */
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handsSessionKey } from "@claw/protocol";

process.env.SAFE_API_URL = "http://safe.test";

const { db } = await import("../src/infra/db.js");
const { SANDBOX_IDLE_REUSE_MS } = await import("../src/config.js");
const {
  handleRegistry, readSessionBackgroundWork, reuseWindowRemaining, unreleasedRecord,
} = await import("../src/tasks/sandbox-stopper.js");

handleRegistry.terminalHold = async () => ({ state: "none" });
const { reapOrphanHandles } = await import("../src/tasks/sweeper.js");

const originalQuery = db.query;
const originalRegistry = { ...handleRegistry };
const originalRecord = { ...unreleasedRecord };
const originalFetch = globalThis.fetch;
function restoreAll(): void {
  db.query = originalQuery;
  Object.assign(handleRegistry, originalRegistry);
  Object.assign(unreleasedRecord, originalRecord);
  globalThis.fetch = originalFetch;
}
after(restoreAll);
afterEach(restoreAll);

const WINDOW = SANDBOX_IDLE_REUSE_MS;
const MIN = 60_000;

let stopped: string[];
beforeEach(() => {
  stopped = [];
  handleRegistry.retained = async () => false;
  unreleasedRecord.mark = async () => {};
  unreleasedRecord.clear = async () => {};
  unreleasedRecord.any = async () => false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    stopped.push(/\/workloads\/([^/]+)\/stop$/.exec(url)?.[1] ?? url);
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
});

/**
 * The bucket as a Map, read through the reader's DEFAULT window -- the same call
 * `handleRegistry.backgroundWork` makes in production, which closes over a NATS
 * KV that cannot be substituted. Passing a window here would test the test.
 */
function bucketHolding(entries: Record<string, unknown>, windowMs?: number): void {
  const enc = new TextEncoder();
  const kv = {
    async get(key: string) {
      const value = entries[key];
      if (value === undefined) return null;
      return { value: enc.encode(JSON.stringify(value)), revision: 7 };
    },
  };
  handleRegistry.backgroundWork = (sessionId, workloadIds) =>
    windowMs === undefined
      ? readSessionBackgroundWork(kv, sessionId, workloadIds)
      : readSessionBackgroundWork(kv, sessionId, workloadIds, Date.now(), windowMs);
}

function handleFor(dagRoot: string, workloadId: string, sessionId: string): void {
  const live = new Map([["main", { workload_id: workloadId, session_id: sessionId }]]);
  const rows = (): Record<string, { workload_id: string; session_id: string }> =>
    Object.fromEntries(live);
  handleRegistry.listAll = async () => [[dagRoot, rows()]];
  handleRegistry.listForDag = async () => rows();
  handleRegistry.listForDagConsistent = async () => rows();
  handleRegistry.listDagRoots = async () => [dagRoot];
  handleRegistry.lookup = async (_d: string, n: string) => live.get(n) ?? null;
  handleRegistry.destroy = async (_d: string, n: string) => {
    const w = live.get(n)?.workload_id ?? null;
    live.delete(n);
    return w;
  };
}

/** A finished chat: the DAG row is terminal and nothing in the session is live. */
function chatIsOver(sessionId: string): void {
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT status, session_id FROM claw_tasks")) {
      return { rows: [{ status: "completed", session_id: sessionId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

/**
 * A parked handle as Brain leaves one after a turn, `idledFor` ms ago, with a
 * verdict measured empty inside that idle period -- the state the sweep stopped.
 */
function parked(
  workloadId: string, idledFor: number, extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const idleSince = Date.now() - idledFor;
  return {
    status: "ready",
    provider: "safe-workload",
    workloadId,
    platformKey: "pk-1",
    handsUrl: "http://hands.test",
    token: "tok-1",
    keepalive: false,
    idleSince,
    idleEpoch: idleSince,
    idleRev: 7,
    bgCheckedAt: Date.now() - 1_000,
    bgRunning: 0,
    bgEpoch: idleSince,
    bgIdleSince: idleSince,
    bgIdleRev: 7,
    bgRev: 6,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The window arithmetic.
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const W = 15 * MIN;

const WINDOW_CASES: Array<{
  name: string;
  info: Record<string, unknown>;
  windowMs?: number;
  want: { idleForMs: number; remainingMs: number } | null;
}> = [
  { name: "parked a minute ago has most of its window left",
    info: { status: "ready", idleSince: NOW - MIN },
    want: { idleForMs: MIN, remainingMs: W - MIN } },
  { name: "an entry with no status is read as live, as older writers left it",
    info: { idleSince: NOW - MIN },
    want: { idleForMs: MIN, remainingMs: W - MIN } },
  { name: "past the window it no longer applies",
    info: { status: "ready", idleSince: NOW - W - 1 }, want: null },
  { name: "exactly at the window it no longer applies",
    info: { status: "ready", idleSince: NOW - W }, want: null },
  { name: "a window of zero is the old behaviour",
    info: { status: "ready", idleSince: NOW - MIN }, windowMs: 0, want: null },
  { name: "never parked: no idle period, nothing to measure from",
    info: { status: "ready" }, want: null },
  { name: "a deleted session has no next message to wait for",
    info: { status: "ready", idleSince: NOW - MIN, sessionDeleted: true }, want: null },
  { name: "a closing sandbox is not reusable",
    info: { status: "closing", idleSince: NOW - MIN }, want: null },
  { name: "a pending sandbox is not reusable",
    info: { status: "pending", idleSince: NOW - MIN }, want: null },
  { name: "a recorded terminal reason means it is dead",
    info: { status: "ready", idleSince: NOW - MIN, terminalReason: "exec_sandbox_terminal" },
    want: null },
  { name: "Brain's quiescedAt, when later, is the anchor Brain expires from",
    info: { status: "ready", idleSince: NOW - 20 * MIN, quiescedAt: NOW - 5 * MIN },
    want: { idleForMs: 5 * MIN, remainingMs: W - 5 * MIN } },
  { name: "work seen after the park restarts the window",
    info: { status: "ready", idleSince: NOW - 20 * MIN, workSeenAt: NOW - 2 * MIN },
    want: { idleForMs: 2 * MIN, remainingMs: W - 2 * MIN } },
  { name: "an earlier quiescedAt does not shorten it",
    info: { status: "ready", idleSince: NOW - MIN, quiescedAt: NOW - 10 * MIN },
    want: { idleForMs: MIN, remainingMs: W - MIN } },
  { name: "a stamp from a fast clock holds for one window, not for the skew on top",
    info: { status: "ready", idleSince: NOW + 30 * MIN },
    want: { idleForMs: 0, remainingMs: W } },
];

for (const c of WINDOW_CASES) {
  test(`window: ${c.name}`, () => {
    assert.deepEqual(reuseWindowRemaining(c.info, NOW, c.windowMs ?? W), c.want);
  });
}

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

const SWEEP_CASES: Array<{
  name: string;
  entry: (w: string) => Record<string, unknown>;
  stops: boolean;
  /** Override the reader's window, for the controls. */
  windowMs?: number;
}> = [
  { name: "R1 idle verdict one minute after the turn: kept (the measured defect)",
    entry: (w) => parked(w, MIN), stops: false },
  { name: "R2 CONTROL: the same sandbox with the window switched off is stopped",
    entry: (w) => parked(w, MIN), windowMs: 0, stops: true },
  { name: "R3 not yet measured, inside the window: kept",
    entry: (w) => {
      const e = parked(w, 30_000);
      for (const k of ["bgCheckedAt", "bgRunning", "bgEpoch", "bgIdleSince", "bgIdleRev", "bgRev"]) delete e[k];
      return e;
    }, stops: false },
  { name: "R4 CONTROL: idle verdict and the window has closed: stopped, not leaked",
    entry: (w) => parked(w, WINDOW + 5_000), stops: true },
  { name: "R5 kept just inside the window",
    entry: (w) => parked(w, WINDOW - 5_000), stops: false },
  { name: "R6 CONTROL: a deleted session's parked sandbox is stopped at once",
    entry: (w) => parked(w, MIN, { sessionDeleted: true, token: "" }), stops: true },
  { name: "R7 CONTROL: a sandbox Brain already recorded as terminal is stopped",
    entry: (w) => parked(w, MIN, { terminalReason: "exec_sandbox_terminal" }), stops: true },
  { name: "R8 CONTROL: a sandbox that is closing is stopped",
    entry: (w) => parked(w, MIN, { status: "closing" }), stops: true },
  { name: "R9 no credentials to probe with, but the window still has not closed: kept",
    entry: (w) => {
      const e = parked(w, MIN);
      delete e.handsUrl; delete e.token;
      return e;
    }, stops: false },
  { name: "R10 CONTROL: no credentials and the window has closed: stopped",
    entry: (w) => {
      const e = parked(w, WINDOW + 5_000);
      delete e.handsUrl; delete e.token;
      return e;
    }, stops: true },
  { name: "R11 a running shell still holds the sandbox after the window closes",
    entry: (w) => parked(w, WINDOW + 5 * MIN, { bgRunning: 2 }), stops: false },
];

for (const c of SWEEP_CASES) {
  test(c.name, async () => {
    handleFor("t-chat", "w-1", "s-1");
    chatIsOver("s-1");
    bucketHolding({ [handsSessionKey("s-1")]: c.entry("w-1") }, c.windowMs);

    await reapOrphanHandles();

    assert.deepEqual(stopped, c.stops ? ["w-1"] : []);
  });
}

test("R12 a binding naming a different sandbox does not hold this one", async () => {
  // The session moved on to w-2; w-1 is the displaced one this sweep exists to
  // reap, and the window belongs to the sandbox the slot names.
  handleFor("t-chat", "w-1", "s-1");
  chatIsOver("s-1");
  bucketHolding({ [handsSessionKey("s-1")]: parked("w-2", MIN) });

  await reapOrphanHandles();

  assert.deepEqual(stopped, ["w-1"]);
});

test("R13 the reader's own default is the configured window", async () => {
  // The seam above passes no window; this pins that what it falls back to is the
  // deployment's setting and not a literal, so changing the setting moves both.
  const enc = new TextEncoder();
  const kv = {
    async get() {
      return { value: enc.encode(JSON.stringify(parked("w-1", MIN))), revision: 7 };
    },
  };
  const answer = await readSessionBackgroundWork(kv, "s-1", ["w-1"]);
  assert.equal(answer.state, "reusable");
  // The entry is stamped a minute ago by a clock read a few ms away from the
  // reader's, so the remainder is the window less a minute, give or take that.
  assert.ok(
    answer.state === "reusable" && Math.abs(answer.remainingMs - (WINDOW - MIN)) < 5_000,
    "what remains is the configured window less the time already spent idle",
  );
});
