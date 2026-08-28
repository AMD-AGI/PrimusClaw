// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run's lease: the row's own answer to "is anything still executing this?".
 *
 * The answer it replaces was inferred from whether a queue message was still
 * unacknowledged, which cannot separate a worker that died from one that is
 * slow and takes the whole redelivery budget -- an hour and a half -- to
 * conclude either. A lease renewed every few seconds makes it answerable in
 * seconds. What has to hold for that to be true, and is pinned here: renewals
 * only touch live rows, a worker cannot ask for a lease so long that a dead pod
 * goes unnoticed, and an expired lease closes the row without shouting an
 * interrupt at a session that has moved on.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import {
  runLeaseTimingProblems, worstLockBlockedTakeover,
} from "@claw/protocol";

import {
  LEASE_LOST_GRACE_SEC, RUN_LEASE_TTL_MS, runLeaseTiming,
} from "../src/config.js";
import { db } from "../src/infra/db.js";
import { interruptPublisher, reapLostLeases } from "../src/tasks/sweeper.js";

interface SeenQuery { sql: string; params: unknown[] }

const originalQuery = db.query;
const originalPublisher = { ...interruptPublisher };
after(() => {
  db.query = originalQuery;
  Object.assign(interruptPublisher, originalPublisher);
});

function stubDb(rows: Array<Record<string, unknown>>): SeenQuery[] {
  const seen: SeenQuery[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    seen.push({ sql: text.replace(/\s+/g, " ").trim(), params });
    return { rows, rowCount: rows.length };
  }) as typeof db.query;
  return seen;
}

function stubBus(): { published: string[] } {
  const state = { published: [] as string[] };
  Object.assign(interruptPublisher, {
    available: () => true,
    publish: (subject: string) => { state.published.push(subject); },
    flush: async () => {},
  });
  return state;
}

const LOST = {
  task_id: "t-1", session_id: "s-1", origin: "chat", lease_owner: "brain-7",
};

test("an expired lease closes the run, and says which one it was", async () => {
  const seen = stubDb([LOST]);
  stubBus();

  assert.equal(await reapLostLeases(), 1);
  assert.match(seen[0]!.sql, /ELSE 'worker_lost' END/,
    "a worker that vanished is a different failure from a run that overran");
});

test("a reclaimed run does not shout at the session it used to be in", async () => {
  // The deadline backstop publishes an interrupt because the process may still
  // be alive. Here it cannot be -- that is what the expired lease means -- and
  // the interrupt is keyed by session, which outlives any single run. Sending
  // one would abort whatever the user is running now.
  const bus = stubBus();
  stubDb([LOST]);

  await reapLostLeases();
  assert.deepEqual(bus.published, []);
});

test("runs that never had a lease keep the old behaviour", async () => {
  // An upgrade in progress has workers that do not renew anything yet. Reaping
  // their runs for not speaking a protocol they have not been taught is the
  // one way this scan could take down a healthy fleet.
  const seen = stubDb([]);
  stubBus();
  await reapLostLeases();

  assert.match(seen[0]!.sql, /lease_expires_at IS NOT NULL/);
});

test("a slow renewal is not a dead worker", async () => {
  const seen = stubDb([]);
  stubBus();
  await reapLostLeases();

  assert.match(
    seen[0]!.sql,
    /lease_expires_at < NOW\(\) - \(\$1::int \* INTERVAL '1 second'\)/,
    "expiry plus a grace period, so a GC pause does not close a live run",
  );
  assert.ok(
    Number(seen[0]!.params[0]) > 0,
    "a zero grace makes every late heartbeat fatal",
  );
});

test("only live rows are eligible", async () => {
  const seen = stubDb([]);
  stubBus();
  await reapLostLeases();

  assert.match(seen[0]!.sql, /status IN \('preparing','running','cancelling'\)/,
    "a finished run's stale lease says nothing about anything");
});

test("the reaper waits out the takeover it must not preempt", async () => {
  // The property, not the number: whatever the deployment's grace is, the
  // verdict has to land after the *latest* moment a redelivery could have
  // resumed the run. That moment is set by `lock.<key>` outliving its dead
  // holder, not by ack_wait -- the hand-picked 120s cleared ack_wait and still
  // closed runs while their takeover was minutes away.
  //
  // Both sides are the ones production uses: the lease expires a heartbeat
  // after the last renewal rather than at the death, and the verdict lands
  // anywhere inside the tick that reaches it. Comparing the bare sum against
  // the first death's takeover passes at a grace 290s too short.
  const seen = stubDb([]);
  stubBus();
  await reapLostLeases();

  const timing = runLeaseTiming();
  assert.equal(Number(seen[0]!.params[0]), LEASE_LOST_GRACE_SEC,
    "the query has to use the grace the invariant was checked against");
  assert.deepEqual(runLeaseTimingProblems(timing), []);
  const worst = worstLockBlockedTakeover(timing);
  const verdictMs = RUN_LEASE_TTL_MS + LEASE_LOST_GRACE_SEC * 1000 - timing.heartbeatMs;
  assert.ok(
    verdictMs >= worst.atMs + timing.sweeperTickMs,
    `verdict at ${verdictMs}ms must follow the takeover at ${worst.atMs}ms `
    + `on delivery ${worst.delivery}, plus a ${timing.sweeperTickMs}ms tick`,
  );
});
