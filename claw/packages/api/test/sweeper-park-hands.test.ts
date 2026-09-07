// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The sandbox handle of a session whose last run was given up on.
 *
 * Brain parks `hands.<sid>` when a run ends in its own process. A run whose
 * worker went away never reaches that line, so the handle keeps `keepalive`
 * unset -- and an unparked handle is not a handle the idle sweep ignores, it is
 * one the whole fleet pings once a tick forever, keeping the platform's
 * `lastActivity` fresh and its idle GC away. Measured on a live cluster: three
 * sandboxes held that way, the oldest for seventeen hours, bounded by nothing
 * but the workload's own absolute deadline.
 *
 * The reaper that closes the row is the only place that knows no worker is
 * coming back for it, which is why the park lives here. It is attached to the
 * gate release rather than to one reaper because all three chat reapers already
 * call that, and a guard added to the one reaper being edited is how this hole
 * was opened.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import {
  reapLostLeases,
  reapExpiredQueuedRuns,
  reapExpiredDoorbellRuns,
  sweeperPorts,
} from "../src/tasks/sweeper.js";
import { parkSettledHandsPorts } from "../src/tasks/park-settled-hands.js";
import { parkHandsAfterRun, type RevisionedKv } from "@claw/protocol";

const originalQuery = db.query;
const originalPublish = sweeperPorts.publishSessionEvent;
const originalPark = parkSettledHandsPorts.parkHandsAfterRun;
after(() => {
  db.query = originalQuery;
  sweeperPorts.publishSessionEvent = originalPublish;
  parkSettledHandsPorts.parkHandsAfterRun = originalPark;
});

let parkCalls: Array<{ sessionId: string; workloadId?: string | null }> = [];

const CHAT_RUN = {
  task_id: "t-1", session_id: "s-1", origin: "chat",
  lease_owner: "brain-a", message_id: "m-1",
  sandbox_workload_id: "claw-1-sandbox-aaa", failure_reason: "worker_lost",
  prompt: "optimise the kernel", user_id: "u-1",
};

/**
 * `settled` is what the "which of these sessions has nothing running" SELECT
 * answers. Distinguished from the gate UPDATE by being a SELECT: the two ask
 * the same question and must not be answered by the same stub, or a test could
 * not tell an unparked session from an ungated one.
 */
function stubDb(reaped: Array<Record<string, unknown>>, settled: string[]): void {
  parkCalls = [];
  sweeperPorts.publishSessionEvent = async () => {};
  parkSettledHandsPorts.parkHandsAfterRun = async (sessionId, workloadId) => {
    parkCalls.push({ sessionId, workloadId });
    return { outcome: "parked" as const };
  };
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT s.session_id FROM claw_sessions")) {
      return { rows: settled.map((session_id) => ({ session_id })), rowCount: settled.length };
    }
    if (sql.startsWith("UPDATE claw_tasks SET")) {
      return { rows: reaped, rowCount: reaped.length };
    }
    if (sql.includes("failure_reason = 'run_budget_exhausted'")) {
      return { rows: reaped, rowCount: reaped.length };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

function stubLostWorkloads(workloadIds: Array<string | null>): void {
  stubDb(workloadIds.map((sandbox_workload_id, index) => ({
    ...CHAT_RUN,
    task_id: `t-${index + 1}`,
    message_id: `m-${index + 1}`,
    sandbox_workload_id,
  })), ["s-1"]);
}

function useParkKv(kv: RevisionedKv): void {
  parkSettledHandsPorts.parkHandsAfterRun = async (sessionId, workloadId) => {
    parkCalls.push({ sessionId, workloadId });
    return parkHandsAfterRun(kv, sessionId, workloadId);
  };
}

beforeEach(() => { parkCalls = []; });

test("P1 a reaped worker_lost chat run parks the handle of its session", async () => {
  stubDb([CHAT_RUN], ["s-1"]);
  assert.equal(await reapLostLeases(), 1);
  assert.deepEqual(parkCalls, [{ sessionId: "s-1", workloadId: "claw-1-sandbox-aaa" }]);
});

test("P2 a session with another turn still running keeps its pod", async () => {
  // The settled SELECT is what answers this, and it answers with nothing.
  stubDb([CHAT_RUN], []);
  await reapLostLeases();
  assert.deepEqual(parkCalls, [], "parked a handle a live turn is using");
});

test("P3 the queue-timeout reaper parks too", async () => {
  stubDb([{ ...CHAT_RUN, failure_reason: "queue_timeout", claim_count: 0 }], ["s-1"]);
  await reapExpiredQueuedRuns();
  assert.deepEqual(parkCalls.map((c) => c.sessionId), ["s-1"]);
});

test("P4 the doorbell budget reaper parks too", async () => {
  stubDb([{ ...CHAT_RUN, failure_reason: "run_budget_exhausted", claim_count: 3 }], ["s-1"]);
  await reapExpiredDoorbellRuns();
  assert.deepEqual(parkCalls.map((c) => c.sessionId), ["s-1"]);
});

test("P5 a park that throws does not take the reap down with it", async () => {
  stubDb([CHAT_RUN], ["s-1"]);
  parkSettledHandsPorts.parkHandsAfterRun = async () => { throw new Error("kv is down"); };
  await assert.doesNotReject(() => reapLostLeases());
});

/* ── the write itself ───────────────────────────────────────────────────── */

interface FakeEntry { value: Uint8Array; revision: number }

function kvWith(info: Record<string, unknown>, revision = 7) {
  const store = new Map<string, FakeEntry>();
  store.set("hands.s-1", {
    value: new TextEncoder().encode(JSON.stringify(info)),
    revision,
  });
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async update(key: string, value: Uint8Array, rev: number) {
      const cur = store.get(key);
      if (!cur || cur.revision !== rev) throw new Error("wrong last sequence");
      store.set(key, { value, revision: rev + 1 });
      return rev + 1;
    },
    read() {
      return JSON.parse(new TextDecoder().decode(store.get("hands.s-1")!.value));
    },
  };
}

const READY = {
  status: "ready", handsUrl: "http://hands", token: "tok",
  workloadId: "claw-1-sandbox-aaa", keepalive: true,
};

test("P6 parking opens a new idle period and drops the last one's verdict", async () => {
  const kv = kvWith({
    ...READY,
    idleSince: 1, idleEpoch: 1, idleRev: 2,
    bgCheckedAt: 3, bgRunning: 0, bgEpoch: 1, bgIdleSince: 1, bgIdleRev: 2, bgRev: 4,
    workSeenAt: 5,
  });
  const before = Date.now();
  assert.equal((await parkHandsAfterRun(kv, "s-1")).outcome, "parked");
  const after_ = kv.read();

  assert.equal(after_.keepalive, false, "the sweep selects on this");
  assert.ok(after_.idleSince >= before, "the reuse window starts now, not when the run did");
  assert.equal(after_.idleEpoch, after_.idleSince, "the period is named by its own stamp");
  assert.equal(after_.idleRev, 7, "and by the revision the write was conditioned on");
  for (const gone of [
    "bgCheckedAt", "bgRunning", "bgEpoch", "bgIdleSince", "bgIdleRev", "bgRev", "workSeenAt",
  ]) {
    assert.equal(gone in after_, false, `${gone} survived into a new idle period`);
  }
  // Unlike a deleted session's park: this pod may still be reused, and the
  // background-work probe needs both of these to ask whether it is busy.
  assert.equal(after_.token, "tok");
  assert.equal(after_.handsUrl, "http://hands");
  assert.equal("sessionDeleted" in after_, false, "the session is alive");
});

test("P7 a handle already idle is not re-stamped", async () => {
  // Re-stamping extends the reuse window, which lengthens the life of the very
  // pod this exists to reclaim.
  const kv = kvWith({ ...READY, keepalive: false, idleSince: 1000, idleEpoch: 1000 });
  const r = await parkHandsAfterRun(kv, "s-1");
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "already_idle");
  assert.equal(kv.read().idleSince, 1000);
});

test("P8 a handle that is not ready is left to the ensureHands that owns it", async () => {
  const kv = kvWith({ ...READY, status: "pending" });
  const r = await parkHandsAfterRun(kv, "s-1");
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "not_ready");
  assert.equal(kv.read().keepalive, true);
});

test("P9 a handle naming a different sandbox is not parked", async () => {
  const kv = kvWith(READY);
  const r = await parkHandsAfterRun(kv, "s-1", "claw-2-sandbox-bbb");
  assert.equal(r.outcome, "skipped");
  assert.equal(r.reason, "other_sandbox");
  assert.equal(kv.read().keepalive, true);
});

test("P10 a handle rewritten under us loses, rather than being clobbered", async () => {
  const kv = kvWith(READY);
  const racing = {
    ...kv,
    async get() { return { value: kv.store.get("hands.s-1")!.value, revision: 999 }; },
  };
  const r = await parkHandsAfterRun(racing, "s-1");
  assert.equal(r.outcome, "superseded");
  assert.equal(kv.read().keepalive, true, "the reuse that took the pod back was overwritten");
});

test("P11 no handle at all is not an error", async () => {
  const kv = { async get() { return null; }, async update() { return 1; } };
  assert.equal((await parkHandsAfterRun(kv, "s-1")).outcome, "gone");
});

/* ── the fourth route: a run claimed to exhaustion ──────────────────────── */

/**
 * `failExhaustedClaim` is not a sweep and does not go through the gate release
 * the three reapers share, so the guard hung there missed it. It is also the
 * route closest to the failure people actually hit: the redelivery kept
 * arriving and kept not finishing. Two rows on this cluster reached it, each
 * after twenty-two claims, each the only run its session ever had -- so no
 * later turn came past to park the handle either.
 */
test("P12 a run claimed to exhaustion parks its session's handle", async () => {
  const { claimRunById, runClaimPorts } = await import("../src/tasks/run-claim.js");
  const originalHistory = runClaimPorts.buildHistory;
  const originalEvent = runClaimPorts.publishSessionEvent;
  parkCalls = [];
  parkSettledHandsPorts.parkHandsAfterRun = async (sessionId, workloadId) => {
    parkCalls.push({ sessionId, workloadId });
    return { outcome: "parked" as const };
  };
  runClaimPorts.publishSessionEvent = async () => {};

  const TAKEN = {
    task_id: "t-9", session_id: "s-9", origin: "chat",
    claim_count: 99, prompt: "p", input: {}, metadata: {},
  };
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT s.session_id FROM claw_sessions")) {
      return { rows: [{ session_id: "s-9" }], rowCount: 1 };
    }
    // takeClaim, and the UPDATE that closes the exhausted row.
    if (sql.includes("claw_tasks")) return { rows: [TAKEN], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  try {
    const r = await claimRunById("t-9", "brain-a");
    assert.equal((r as { kind?: string }).kind, "exhausted", "fixture did not reach the give-up");
    assert.deepEqual(
      parkCalls.map((c) => c.sessionId),
      ["s-9"],
      "the row was closed and the sandbox left pinned",
    );
  } finally {
    runClaimPorts.buildHistory = originalHistory;
    runClaimPorts.publishSessionEvent = originalEvent;
  }
});

test("P13 any matching reaped workload parks the handle regardless of row order", async () => {
  const stale = "claw-2-sandbox-bbb";
  for (const workloadIds of [[READY.workloadId, stale], [stale, READY.workloadId]]) {
    stubLostWorkloads(workloadIds);
    const kv = kvWith(READY);
    useParkKv(kv);

    assert.equal(await reapLostLeases(), 2);
    assert.equal(kv.read().keepalive, false, `workloads=${workloadIds}`);
    assert.equal(kv.store.get("hands.s-1")!.revision, 8, "park only once per session");
  }
});

test("P14 null candidates cannot bypass known workload identities for a replacement handle", async () => {
  const stale = "claw-2-sandbox-bbb";
  for (const workloadIds of [
    [null, READY.workloadId, stale],
    [READY.workloadId, null, stale],
    [READY.workloadId, stale, null],
  ]) {
    stubLostWorkloads(workloadIds);
    const kv = kvWith({ ...READY, workloadId: "claw-3-sandbox-ccc" });
    useParkKv(kv);

    await reapLostLeases();
    assert.equal(kv.read().keepalive, true, `workloads=${workloadIds}`);
    assert.equal(kv.store.get("hands.s-1")!.revision, 7, "replacement handle was rewritten");
    assert.deepEqual(parkCalls.map((call) => call.workloadId), [READY.workloadId, stale]);
  }
});

test("P15 duplicate workload identities are checked once", async () => {
  const stale = "claw-2-sandbox-bbb";
  stubLostWorkloads([stale, stale, READY.workloadId, READY.workloadId]);
  const kv = kvWith(READY);
  useParkKv(kv);

  await reapLostLeases();
  assert.deepEqual(parkCalls.map((call) => call.workloadId), [stale, READY.workloadId]);
  assert.equal(kv.read().keepalive, false);
  assert.equal(kv.store.get("hands.s-1")!.revision, 8);
});

test("P16 a superseded park never retries another reclaimed workload", async () => {
  const replacementWorkloadId = "claw-2-sandbox-bbb";
  stubLostWorkloads([READY.workloadId, replacementWorkloadId, READY.workloadId]);
  const kv = kvWith(READY);
  let updates = 0;
  useParkKv({
    ...kv,
    async update(key, value, revision) {
      if (++updates === 1) {
        const replacement = { ...READY, workloadId: replacementWorkloadId };
        await kv.update(key, new TextEncoder().encode(JSON.stringify(replacement)), revision);
      }
      return kv.update(key, value, revision);
    },
  });

  await reapLostLeases();
  assert.equal(updates, 1, "a CAS conflict must end the session's parking attempt");
  assert.deepEqual(parkCalls.map((call) => call.workloadId), [READY.workloadId]);
  assert.equal(kv.read().workloadId, replacementWorkloadId);
  assert.equal(kv.read().keepalive, true, "the concurrently reused handle was parked");
});

test("P17 runs without workload identities retain the existing unguarded park", async () => {
  stubLostWorkloads([null, null]);
  const kv = kvWith(READY);
  useParkKv(kv);

  await reapLostLeases();
  assert.deepEqual(parkCalls, [{ sessionId: "s-1", workloadId: undefined }]);
  assert.equal(kv.read().keepalive, false);
  assert.equal(kv.store.get("hands.s-1")!.revision, 8);
});
