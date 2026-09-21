// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The orphan sweep must not stop a sandbox that is still running the user's
 * background work.
 *
 * Ending a chat is not the same as being finished with the sandbox. Background
 * shells are started deliberately and are meant to outlive the run; Brain keeps
 * the pod warm as `hands.<session>` with `keepalive: false` and lets them run.
 * What it does NOT do on that path is write a retention record -- the one thing
 * on record that means "do not stop this", and the only thing
 * `handleRegistry.retained` inside the teardown looks at. So a moment later
 * this sweep finds a terminal DAG row, no live task in the session, and a
 * handle naming a live workload, and stops it. Reproduced against real
 * NATS/Postgres with a live Hands process: at the moment `/stop` was issued the
 * running process count inside the sandbox was still 1, and the sweep took the
 * sandbox out from under it.
 *
 * The evidence the sweep was missing is on the entry itself: Brain's keepalive
 * sweep probes idle handles and publishes what it found. These drive the real
 * `reapOrphanHandles` over the real reader (`readSessionBackgroundWork`) with a
 * fake KV bucket standing in for NATS, and assert on the only outcome that
 * matters -- whether a stop was issued against SaFE, and for which workload.
 *
 * Coverage:
 *   G1  a sandbox with a measured running shell is not stopped
 *   G2  CONTROL: the same sandbox measured empty is stopped
 *   G3  CONTROL: a session with no binding at all is stopped
 *   G4  a verdict from the PREVIOUS idle period does not hold a sandbox
 *   G5  a binding naming a rebuilt sandbox does not hold the old workload
 *   G6  a sandbox not yet measured in this idle period is not stopped
 *   G7  ... but not forever: past the wait, an unmeasured sandbox is stopped
 *   G8  a binding written under the legacy key name is still read
 *   G9  a store that cannot be read does not license a stop
 *   G10 a measured running shell holds the sandbox even with no way to re-ask
 */
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BG_VERDICT_TTL_MS, handsSessionKey, legacyHandsKey } from "@claw/protocol";

process.env.SAFE_API_URL = "http://safe.test";

const { db } = await import("../src/infra/db.js");
const {
  handleRegistry, readSessionBackgroundWork, unreleasedRecord,
} = await import("../src/tasks/sandbox-stopper.js");
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

/** Every workload id a stop was actually issued against, in order. */
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
 * The bucket the reader really reads, as a Map.
 *
 * Wired in through `handleRegistry.backgroundWork` because the production
 * binding closes over a module-scoped NATS KV that cannot be substituted --
 * the same seam, and the same reason, as `retained` above it. The rules under
 * test are the real ones: this replaces the bucket, not the answer.
 */
function bucketHolding(entries: Record<string, unknown>): { reads: string[] } {
  const enc = new TextEncoder();
  const reads: string[] = [];
  const kv = {
    async get(key: string) {
      reads.push(key);
      const value = entries[key];
      if (value === undefined) return null;
      return { value: enc.encode(JSON.stringify(value)), revision: 7 };
    },
  };
  handleRegistry.backgroundWork = (sessionId, workloadIds) =>
    readSessionBackgroundWork(kv, sessionId, workloadIds);
  return { reads };
}

/** A registry holding one handle for `dagRoot`, as Brain registers it. */
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
    if (sql.startsWith("SELECT 1 FROM claw_tasks")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

const IDLE_SINCE = Date.now() - 60_000;

/**
 * A parked handle, exactly as Brain leaves one: `keepalive: false`, an idle
 * period opened by `applyRunEndedIdleFields`, and the probe credentials kept
 * because the session is still alive.
 */
function parkedEntry(workloadId: string, extra: Record<string, unknown> = {}) {
  return {
    status: "ready",
    provider: "safe-workload",
    workloadId,
    platformKey: "pk-1",
    handsUrl: "http://hands.test",
    token: "tok-1",
    keepalive: false,
    idleSince: IDLE_SINCE,
    idleEpoch: IDLE_SINCE,
    idleRev: 7,
    ...extra,
  };
}

/** A verdict measured inside the idle period `parkedEntry` opened. */
function verdict(running: number, at = Date.now() - 1_000): Record<string, unknown> {
  return {
    bgCheckedAt: at,
    bgRunning: running,
    bgEpoch: IDLE_SINCE,
    bgIdleSince: IDLE_SINCE,
    bgIdleRev: 7,
    bgRev: 6,
  };
}

test("G1 a sandbox with a measured running shell is not stopped", async () => {
  // The defect. The chat is over, the DAG row is terminal, nothing in the
  // session is live -- and one background shell is still running in the pod.
  handleFor("t-chat", "w-bg", "s-1");
  chatIsOver("s-1");
  bucketHolding({ [handsSessionKey("s-1")]: parkedEntry("w-bg", verdict(1)) });

  await reapOrphanHandles();

  assert.deepEqual(
    stopped, [],
    "a sandbox measured with a live background shell in it is not an orphan",
  );

  // And the count is carried, not reduced to a boolean: what holds the sandbox
  // is a measurement of how many processes are running in it.
  const answer = await handleRegistry.backgroundWork("s-1", ["w-bg"]);
  assert.equal(answer.state, "running");
  assert.equal(
    answer.state === "running" ? answer.running : -1, 1,
    "the live background process count at the moment of the sweep",
  );
});

test("G2 CONTROL: the same sandbox measured empty is stopped", async () => {
  // Without this, G1 passes for a guard that defers everything -- and a sweep
  // that reaps nothing is the separate defect this branch already fixed once.
  // Every input is G1's except the measured count.
  handleFor("t-chat", "w-bg", "s-1");
  chatIsOver("s-1");
  bucketHolding({ [handsSessionKey("s-1")]: parkedEntry("w-bg", verdict(0)) });

  await reapOrphanHandles();

  assert.deepEqual(
    stopped, ["w-bg"],
    "a sandbox measured empty in this idle period is exactly what this sweep is for",
  );
});

test("G3 CONTROL: a session with no binding at all is stopped", async () => {
  // The genuine orphan: no session entry, so nothing claims the workload.
  handleFor("t-chat", "w-bg", "s-1");
  chatIsOver("s-1");
  bucketHolding({});

  await reapOrphanHandles();

  assert.deepEqual(stopped, ["w-bg"], "no binding is no reason to keep the workload");
});

test("G4 a verdict from the PREVIOUS idle period does not hold a sandbox", async () => {
  // `bgRunning > 0` on its own is not the test, and this is why. The entry says
  // three shells were running -- during an idle period that has since ended and
  // been reopened, which says nothing about this one. The credentials are gone
  // with the session delete that parked it, so nothing will ever publish a
  // verdict about the current period either: a reader that looked only at the
  // count would hold this workload forever.
  handleFor("t-chat", "w-bg", "s-1");
  chatIsOver("s-1");
  bucketHolding({
    [handsSessionKey("s-1")]: parkedEntry("w-bg", {
      ...verdict(3),
      // The current idle period, reopened after the verdict was measured.
      idleSince: IDLE_SINCE + 5_000,
      idleEpoch: IDLE_SINCE + 5_000,
      idleRev: 9,
      token: "",
    }),
  });

  await reapOrphanHandles();

  assert.deepEqual(
    stopped, ["w-bg"],
    "a measurement of the previous idle period is not evidence about this one",
  );
});

test("G5 a binding naming a rebuilt sandbox does not hold the old workload", async () => {
  // One session key names one sandbox at a time. The session rebuilt its
  // sandbox and is running shells in the NEW one; the stale handle points at
  // the old workload, which nothing is using and which nobody else will stop.
  handleFor("t-chat", "w-old", "s-1");
  chatIsOver("s-1");
  bucketHolding({ [handsSessionKey("s-1")]: parkedEntry("w-new", verdict(2)) });

  await reapOrphanHandles();

  assert.deepEqual(
    stopped, ["w-old"],
    "the verdict is about w-new; the handle is about w-old",
  );
});

test("G6 a sandbox not yet measured in this idle period is not stopped", async () => {
  // The window the defect actually lands in. Parking a handle clears the
  // verdict fields deliberately -- a measurement of the last idle period must
  // not be republished as one about this one -- so for the first keepalive
  // interval after a chat ends there is no verdict at all. A measurement that
  // has not happened is not a measurement of zero, and the sandbox is still
  // addressable, so the answer is coming.
  handleFor("t-chat", "w-bg", "s-1");
  chatIsOver("s-1");
  bucketHolding({ [handsSessionKey("s-1")]: parkedEntry("w-bg") });

  await reapOrphanHandles();

  assert.deepEqual(
    stopped, [],
    "nothing has looked inside this sandbox yet; that is not a licence to stop it",
  );
});

test("G7 ... but not forever: past the wait, an unmeasured sandbox is stopped", async () => {
  // The other half of G6, and the reason the wait is bounded. A fleet with the
  // keepalive sweep switched off publishes no verdicts at all, ever -- so an
  // unbounded wait would leave this sweep permanently unable to reap anything,
  // which is the leak it exists to close.
  handleFor("t-chat", "w-bg", "s-1");
  chatIsOver("s-1");
  const old = Date.now() - BG_VERDICT_TTL_MS - 60_000;
  bucketHolding({
    [handsSessionKey("s-1")]: parkedEntry("w-bg", {
      idleSince: old, idleEpoch: old, idleRev: 7,
    }),
  });

  await reapOrphanHandles();

  assert.deepEqual(
    stopped, ["w-bg"],
    "a whole verdict lifetime with nothing measured is unmeasured, not mid-measurement",
  );
});

test("G8 a binding written under the legacy key name is still read", async () => {
  // A session id that has to be re-keyed lives under `hands.=<base32>` now and
  // under `hands.retained-...` on any replica that predates the re-keying. A
  // reader that looked only at the canonical name would read a live sandbox as
  // having no binding at all -- and stop it -- for the length of a rollout.
  const sessionId = "retained-legacy";
  assert.notEqual(
    handsSessionKey(sessionId), legacyHandsKey(sessionId),
    "this id must really have two names, or the test proves nothing",
  );
  handleFor("t-chat", "w-bg", sessionId);
  chatIsOver(sessionId);
  bucketHolding({ [legacyHandsKey(sessionId)]: parkedEntry("w-bg", verdict(1)) });

  await reapOrphanHandles();

  assert.deepEqual(stopped, [], "the binding is under the other name, not absent");
});

test("G9 a store that cannot be read does not license a stop", async () => {
  handleFor("t-chat", "w-bg", "s-1");
  chatIsOver("s-1");
  handleRegistry.backgroundWork = (sessionId, workloadIds) =>
    readSessionBackgroundWork({
      async get() { throw new Error("stream not found"); },
    }, sessionId, workloadIds);

  await reapOrphanHandles();

  assert.deepEqual(
    stopped, [],
    "an unreadable bucket is an unknown, and the one answer it must not become is `nothing running`",
  );
});

test("G10 a measured running shell holds the sandbox even with no way to re-ask", async () => {
  // Missing credentials mean this replica cannot ask again -- not that the
  // answer is no. Brain's own reader takes the evidence first and falls back to
  // the legacy idle behaviour only when there is none; reading the credentials
  // first would throw away a witnessed `running` because the address to
  // re-check it had gone.
  handleFor("t-chat", "w-bg", "s-1");
  chatIsOver("s-1");
  bucketHolding({
    [handsSessionKey("s-1")]: parkedEntry("w-bg", { ...verdict(2), token: "", handsUrl: "" }),
  });

  await reapOrphanHandles();

  assert.deepEqual(stopped, [], "the measurement stands on its own");
});
