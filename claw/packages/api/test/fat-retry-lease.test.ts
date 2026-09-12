// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import "./reconcile-off-env.js";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { LEASE_LOST_GRACE_SEC } from "../src/config.js";
import { registerInternalRunRoutes } from "../src/routes/internal-runs.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { parkSettledHandsPorts } from "../src/tasks/park-settled-hands.js";
import { reapLostLeases, sweeperPorts } from "../src/tasks/sweeper.js";
import { runRow, seedRun, seedSession, sessionRow, startHarness, type Harness } from "./scenario-harness.js";

const TASK = "ktsk-fat-retry";
const SESSION = "s-fat-retry";
const TOKEN = "test-internal-token";
const FIRST = {
  attempt_id: "att-first", claim_count: 0, delivery_seq: 7, delivery_count: 1,
  brain_id: "brain-first",
};
const NEXT = { ...FIRST, attempt_id: "att-next", delivery_count: 2, brain_id: "brain-next" };

let h: Harness;
let app: FastifyInstance;
const events: Record<string, unknown>[] = [];
const originalToken = process.env.AUTH_INTERNAL_TOKEN;
const originalPublish = sweeperPorts.publishSessionEvent;
const originalPark = parkSettledHandsPorts.parkHandsAfterRun;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  h = await startHarness();
  app = Fastify();
  await registerInternalTaskRoutes(app);
  await registerInternalRunRoutes(app);
  await app.ready();
  sweeperPorts.publishSessionEvent = async (_sessionId, event) => { events.push(event); };
  parkSettledHandsPorts.parkHandsAfterRun = async () => ({ outcome: "gone" });
});

beforeEach(async () => {
  events.length = 0;
  await h.reset();
  await seedSession(h, SESSION);
});

after(async () => {
  if (originalToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalToken;
  sweeperPorts.publishSessionEvent = originalPublish;
  parkSettledHandsPorts.parkHandsAfterRun = originalPark;
  await app.close();
  await h.close();
});

function post(action: "event" | "lease" | "settle-attempt", payload: Record<string, unknown>) {
  return app.inject({
    method: "POST", url: `/v1/internal/tasks/${TASK}/${action}`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload,
  });
}

async function startAttempt(): Promise<void> {
  await seedRun(h, TASK, SESSION, { status: "preparing", dispatch: "fat" });
  // openChatRun stamps this from the lease token it mints, and the pre-gate
  // sends that token as its bearer. The seed does not, so without this line the
  // legacy bridge's `internal_token_hash = $6` compares against NULL and no
  // renewal of that shape can ever match -- which would make the cases below
  // pass for a reason that has nothing to do with what they assert.
  await h.sql(
    "UPDATE claw_tasks SET internal_token_hash = $2 WHERE task_id = $1",
    [TASK, createHash("sha256").update(TOKEN).digest("hex")],
  );
  assert.equal((await post("event", {
    type: "statusUpdate", agent_status: "running", ...FIRST,
  })).statusCode, 200);
  assert.equal((await post("lease", FIRST)).statusCode, 200);
}

async function settleRetry(): Promise<void> {
  assert.equal((await post("settle-attempt", {
    brain_id: FIRST.brain_id, claim_count: FIRST.claim_count, release_lease: true,
  })).statusCode, 200);
}

test("a fat retry without redelivery remains reapable after the lease grace", async () => {
  await startAttempt();
  const [before] = await h.sql("SELECT clock_timestamp() AS at");

  await settleRetry();

  const [after] = await h.sql("SELECT clock_timestamp() AS at");
  const released = await runRow(h, TASK);
  assert.equal(released.status, "running");
  assert.equal(released.lease_owner, null);
  assert.equal(released.attempt_id, null);
  assert.equal(released.settled_attempt_id, FIRST.attempt_id);
  assert.ok(released.lease_expires_at instanceof Date, "the settlement keeps a reaper timestamp");
  assert.ok(released.lease_expires_at >= (before.at as Date));
  assert.ok(released.lease_expires_at <= (after.at as Date), "the released lease expires immediately");
  assert.equal(await reapLostLeases(), 0, "a replacement still has the full lease grace to arrive");

  await h.sql(
    `UPDATE claw_tasks
        SET lease_expires_at = lease_expires_at - ($2::int * INTERVAL '1 second')
      WHERE task_id = $1`,
    [TASK, LEASE_LOST_GRACE_SEC + 1],
  );

  assert.equal(await reapLostLeases(), 1);
  const reaped = await runRow(h, TASK);
  assert.equal(reaped.status, "failed");
  assert.equal(reaped.failure_reason, "worker_lost");
  assert.ok(reaped.completed_at instanceof Date);
  assert.equal((await sessionRow(h, SESSION)).agent_status, "idle");
  assert.equal(events.find((event) => event.type === "exec_complete")?.failure_reason, "worker_lost");
});

test("a new fat attempt renews immediately after its predecessor releases the lease", async () => {
  await startAttempt();
  await settleRetry();

  assert.equal((await post("lease", NEXT)).statusCode, 200);

  const live = await runRow(h, TASK);
  assert.equal(live.attempt_id, NEXT.attempt_id);
  assert.equal(Number(live.attempt_generation), 2);
  assert.equal(live.lease_owner, NEXT.brain_id);
  assert.equal(Number(live.delivery_count), NEXT.delivery_count);
  assert.equal(await reapLostLeases(), 0);
});

test("a redelivery's acceptance may take the lease its predecessor released", async () => {
  // What a retry actually does. `nakAfterAttempt` settles and releases before
  // it naks, so every fat retry leaves owner null with the expiry stamped in
  // the past -- and the redelivery that follows opens with the pre-gate's
  // acceptance, not a renewal. That shape matched neither acquisition arm: the
  // first wants a null expiry and a zero generation, the second wants an owner.
  // So the acceptance answered 409 and the turn never resumed.
  //
  // The renewal case beside this one is a different caller: it already holds
  // the row and is asking to keep it.
  await startAttempt();
  await settleRetry();

  const res = await post("lease", { ...NEXT, accept: true });

  assert.equal(res.statusCode, 200, "the delivery that follows a retry can start");
  const live = await runRow(h, TASK);
  assert.equal(live.lease_owner, NEXT.brain_id);
  assert.ok(Number(live.claim_count) >= 1, "and the acceptance mints its own generation");
});

test("and then keeps it: the holder's pre-gate heartbeat is not the closed bridge", async () => {
  // What the acceptance above is for. A pre-gate heartbeat carries no attempt
  // token -- the acceptance issues none, the first in-run heartbeat opens one
  // -- so it arrives at the legacy bridge, whose counters the takeover does not
  // clear: generation, delivery_count and settled_attempt_id all survive from
  // the attempt that died. The bridge therefore answered 409, and a 409 is the
  // one answer the pre-gate stands down on, so the redelivery that had just
  // taken the row walked away from it on its very first heartbeat and the row
  // sat out its whole lease with nobody executing.
  await startAttempt();
  await settleRetry();
  const accepted = await post("lease", { ...NEXT, accept: true });
  assert.equal(accepted.statusCode, 200);
  const generation = Number((await runRow(h, TASK)).claim_count);

  const res = await post("lease", { brain_id: NEXT.brain_id, run_claim: generation });

  assert.equal(res.statusCode, 200, "the holder may keep the row it was just granted");
  const live = await runRow(h, TASK);
  assert.equal(live.lease_owner, NEXT.brain_id);
  assert.equal(Number(live.claim_count), generation, "a renewal mints no new generation");
  assert.equal(live.attempt_id, null, "and opens no attempt; that is the first in-run heartbeat");
});

test("but only that holder, and only at the generation it was granted", async () => {
  // The controls for the arm above, both halves. The relaxed arm skips the
  // counters, so what stands in their place has to be shown to stand: the
  // generation, which every acquisition changes, and the owner.
  await startAttempt();
  await settleRetry();
  assert.equal((await post("lease", { ...NEXT, accept: true })).statusCode, 200);
  const held = await runRow(h, TASK);
  const generation = Number(held.claim_count);

  assert.equal(
    (await post("lease", { brain_id: NEXT.brain_id, run_claim: generation - 1 })).statusCode, 409,
    "a generation from before the takeover is not this holder's",
  );
  assert.equal(
    (await post("lease", { brain_id: "brain-stranger", run_claim: generation })).statusCode, 409,
    "and quoting the right generation is not holding the row",
  );
  assert.deepEqual(await runRow(h, TASK), held, "neither moved anything");
});

test("nor the predecessor it took the row from, asking in the same shape", async () => {
  // The fence the relaxed arm must not open, and the interesting caller: the
  // brain whose attempt just settled, asking in the pre-gate's own shape with
  // the generation now on the row. The lease is what separates them --
  // lease_owner names the holder the acceptance installed, and this is not it.
  await startAttempt();
  await settleRetry();
  assert.equal((await post("lease", { ...NEXT, accept: true })).statusCode, 200);
  const held = await runRow(h, TASK);

  const res = await post("lease", {
    brain_id: FIRST.brain_id, run_claim: Number(held.claim_count),
  });

  assert.equal(res.statusCode, 409);
  assert.deepEqual(await runRow(h, TASK), held, "and nothing about the row moved");
});

test("and not a live attempt asking in the pre-gate's shape to skip its own token", async () => {
  // The conjunct that makes the relaxed arm a pre-gate arm rather than a hole.
  // An attempt's renewals are fenced on the attempt token -- settled_attempt_id,
  // delivery_seq, delivery_count -- and all three live on the other statement.
  // If a worker holding a live attempt could renew in the token-less shape, it
  // would extend its lease through a bridge that checks none of them, which is
  // exactly what the attempt protocol exists to stop. attempt_id IS NULL is
  // what keeps the arm inside the window between acceptance and first
  // heartbeat, where no attempt is open on the row at all.
  await startAttempt();
  const live = await runRow(h, TASK);
  assert.ok(live.attempt_id, "the fixture holds an open attempt");

  const res = await post("lease", {
    brain_id: FIRST.brain_id, run_claim: Number(live.claim_count),
  });

  assert.equal(res.statusCode, 409, "the token-less shape is not a way around the token");
  assert.deepEqual(await runRow(h, TASK), live, "and nothing about the row moved");
});

test("but not the attempt whose own settlement released it, even declaring acceptance", async () => {
  // The fence the arm above must not open. `settled_attempt_id` remembers the
  // spent token precisely so a late caller quoting it is turned away, and an
  // acceptance is not a way around that.
  await startAttempt();
  await settleRetry();
  const released = await runRow(h, TASK);

  assert.equal((await post("lease", { ...FIRST, accept: true })).statusCode, 409);
  assert.deepEqual(await runRow(h, TASK), released, "and nothing about the row moved");
});

test("a fat attempt cannot renew the expired lease its settlement left behind", async () => {
  await startAttempt();
  await settleRetry();
  const released = await runRow(h, TASK);

  assert.equal((await post("lease", FIRST)).statusCode, 409);

  assert.deepEqual(await runRow(h, TASK), released);
});
