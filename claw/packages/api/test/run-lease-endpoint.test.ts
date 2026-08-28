// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The lease endpoint, driven through the real route.
 *
 * It is called every few seconds by every run in the fleet, which is what
 * makes its narrowness the point: it must not move a row between states, must
 * not wake the scheduler, and must not let a worker buy so much lease that a
 * dead pod goes unnoticed for minutes. The interesting cases are all about what
 * it refuses to do.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { DEFAULT_RUN_LEASE_TTL_MS } from "@claw/protocol";
import { db } from "../src/infra/db.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";

const TOKEN = "cluster-internal-token";
const originalQuery = db.query;
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;

let app: FastifyInstance;
let seen: Array<{ sql: string; params: unknown[] }>;
/** What the stubbed UPDATE reports back; [] models a terminal or missing row. */
let updateRows: Array<Record<string, unknown>> = [{ status: "running" }];
/** The row the refusal lookup finds, once the UPDATE has already declined. */
let refusalRows: Array<Record<string, unknown>> = [];

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  app = Fastify();
  await registerInternalTaskRoutes(app);
  await app.ready();
});

after(async () => {
  db.query = originalQuery;
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await app.close();
});

function stubDb(): void {
  seen = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    // The auth preHandler looks up the per-task hash first; answering with no
    // hash sends it to the AUTH_INTERNAL_TOKEN fallback the tests use.
    if (sql.startsWith("SELECT internal_token_hash")) return { rows: [{}], rowCount: 1 };
    if (sql.startsWith("SELECT status, lease_owner")) {
      return { rows: refusalRows, rowCount: refusalRows.length };
    }
    return { rows: updateRows, rowCount: updateRows.length };
  }) as typeof db.query;
}

async function renew(body: Record<string, unknown>) {
  stubDb();
  return app.inject({
    method: "POST",
    url: "/v1/internal/tasks/t-1/lease",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: body,
  });
}

/** The lease UPDATE, as opposed to the auth lookup that precedes it. */
function leaseUpdate() {
  return seen.find((q) => q.sql.startsWith("UPDATE claw_tasks"))!;
}

test("a renewal extends the lease and records the heartbeat", async () => {
  updateRows = [{ status: "running" }];
  const res = await renew({ brain_id: "brain-7", lease_seconds: 45, phase: "executing" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, status: "running" });
  const q = leaseUpdate();
  assert.match(q.sql, /lease_expires_at = NOW\(\) \+ \(\$3::int \* INTERVAL '1 second'\)/);
  assert.match(q.sql, /heartbeat_at\s+= NOW\(\)/);
  assert.equal(q.params[2], 45);
});

test("renewing does not move the row between states", async () => {
  // The whole reason this is not folded into the event endpoint: that one
  // transitions rows and wakes schedulers, and this runs constantly.
  updateRows = [{ status: "running" }];
  await renew({ brain_id: "brain-7", lease_seconds: 45 });

  // Only the assignments, because the renewal reads the status in its WHERE to
  // decide whether the row is still one it may write to, and a check is not an
  // assignment.
  const assignments = leaseUpdate().sql.split(/\bWHERE\b/)[0];
  assert.doesNotMatch(assignments, /\bstatus\b\s*=/,
    "a heartbeat must never be able to change what a run is");
});

test("a worker cannot buy an arbitrarily long lease", async () => {
  // A lease is how quickly a dead pod is noticed. A worker asking for a day of
  // it -- through a bug or a bad config -- would put its runs beyond reclaim.
  updateRows = [{ status: "running" }];
  await renew({ brain_id: "brain-7", lease_seconds: 86_400 });

  assert.equal(leaseUpdate().params[2], 300);
});

test("a nonsense lease length falls back to the TTL the reaper judges", async () => {
  updateRows = [{ status: "running" }];
  await renew({ brain_id: "brain-7", lease_seconds: -5 });

  assert.equal(
    leaseUpdate().params[2],
    DEFAULT_RUN_LEASE_TTL_MS / 1000,
    "one second would expire on arrival and let any worker claim the row",
  );
});

test("omitting the length is the same as asking for the shipped TTL", async () => {
  updateRows = [{ status: "running" }];
  await renew({ brain_id: "brain-7" });

  assert.equal(leaseUpdate().params[2], DEFAULT_RUN_LEASE_TTL_MS / 1000);
});

test("a terminal run is told it is no longer active", async () => {
  // A worker still heartbeating a run that was cancelled or reclaimed is
  // burning compute nobody is waiting for, and should learn that.
  updateRows = [];
  refusalRows = [{ status: "cancelled", lease_owner: "brain-7", lease_live: false }];
  const res = await renew({ brain_id: "brain-7", lease_seconds: 45 });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().ok, false);
  assert.equal(res.json().reason, "terminal");
});

test("a refusal says which of the two refusals it is", async () => {
  // The same 409 used to answer "this run was cancelled" and "another worker
  // has this run", and they ask the refused worker for opposite things: one
  // must hand back the sandbox it registered and the delivery it is holding,
  // the other must leave both alone because they are the live worker's. A
  // worker that guessed wrong terminated a message its successor was running
  // from, and the turn was gone.
  updateRows = [];
  refusalRows = [{ status: "running", lease_owner: "brain-9", lease_live: true }];
  const res = await renew({ brain_id: "brain-7", lease_seconds: 45 });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().reason, "superseded");
});

test("a finished row whose successor still holds the lease is not called terminal", async () => {
  // Nothing clears `lease_owner` on the way to a terminal state, so a cancelled
  // or completed row carries its live lease for the rest of the TTL. A worker
  // that stalled long enough to be taken over asks about the row in exactly
  // that window, and `terminal` would tell it to stop the sandbox and throw
  // its delivery away -- the sandbox being shared per session, that is the
  // successor's sandbox and the successor's message.
  updateRows = [];
  refusalRows = [{ status: "cancelled", lease_owner: "brain-9", lease_live: true }];
  const res = await renew({ brain_id: "brain-7", lease_seconds: 45 });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().reason, "superseded",
    "somebody demonstrably holds this run, which is the answer that touches nothing");
});

test("a live run whose rival's lease just lapsed is not called terminal", async () => {
  // Two statements, two clocks. The renewal refuses a row that exists and is
  // still running only when someone else holds an unexpired lease on it; if
  // that lease lapses in the gap before the classification reads the row, the
  // lease reads free while the row is plainly alive. Deciding on the lease
  // alone called that `terminal`, and `terminal` is the answer that tells a
  // caller to stop the sandbox and throw its delivery away.
  //
  // Nobody owns this row as far as this snapshot can tell, so the honest
  // answer is that we do not know -- which Brain reads as the refusal that
  // touches nothing.
  updateRows = [];
  refusalRows = [{ status: "running", lease_owner: "brain-9", lease_live: false }];
  const res = await renew({ brain_id: "brain-7", lease_seconds: 45 });

  assert.equal(res.statusCode, 409);
  assert.notEqual(res.json().reason, "terminal");
  assert.equal(res.json().reason, "unexplained");
});

test("a row nobody can find is not reported as somebody else's", async () => {
  updateRows = [];
  refusalRows = [];
  const res = await renew({ brain_id: "brain-7", lease_seconds: 45 });

  assert.equal(res.json().reason, "missing");
});

test("only the worker the row recognises may renew it", async () => {
  // Without this the row accepted a renewal from anyone, so when two workers
  // ended up on one run -- a lock that expired under a worker that could not
  // renew it, and a redelivery that took it over -- both were told they were
  // live and nothing could name which of them was. The fence makes exactly one
  // of them get a 409.
  updateRows = [{ status: "running" }];
  await renew({ brain_id: "brain-7", lease_seconds: 45 });

  const q = leaseUpdate();
  assert.match(q.sql, /lease_owner = \$2/);
  assert.equal(q.params[1], "brain-7", "the fence is only as good as what it compares");
});

test("a lease nobody holds yet can still be claimed", async () => {
  // Two of them: the first renewal a run ever makes, and a run dispatched
  // before leases existed. Neither has an owner to compare against, and both
  // have to be able to become one.
  updateRows = [{ status: "running" }];
  await renew({ brain_id: "brain-7", lease_seconds: 45 });

  assert.match(leaseUpdate().sql, /lease_owner IS NULL/);
  assert.match(leaseUpdate().sql, /lease_expires_at IS NULL/);
});

test("an expired lease may change hands, which is what a takeover is", async () => {
  // The disjunct that keeps the fence from being a wall. A resuming worker's
  // first renewal names an owner that is not the dead one, so a fence written
  // as "owner is null or owner is me" would refuse every takeover there is and
  // leave the run to be reaped instead of resumed.
  updateRows = [{ status: "running" }];
  await renew({ brain_id: "brain-8", lease_seconds: 45 });

  assert.match(leaseUpdate().sql, /lease_expires_at < NOW\(\)/);
});

test("the phase and the waiting total travel with the renewal", async () => {
  // This is the measurement that decides whether handing the slot back during
  // waits is worth building: a fleet that is always executing does not need it.
  updateRows = [{ status: "running" }];
  await renew({
    brain_id: "brain-7", lease_seconds: 45,
    phase: "waiting", wait_reason: "background_command", waited_ms: 90_000, waits: 2,
  });

  const stored = JSON.parse(String(leaseUpdate().params[3]));
  assert.equal(stored.phase, "waiting");
  assert.equal(stored.wait_reason, "background_command");
  assert.equal(stored.waited_ms, 90_000);
  assert.equal(stored.waits, 2);
});

test("a wait reason is not kept once the run is executing again", async () => {
  updateRows = [{ status: "running" }];
  await renew({
    brain_id: "brain-7", lease_seconds: 45,
    phase: "executing", wait_reason: "approval",
  });

  const stored = JSON.parse(String(leaseUpdate().params[3]));
  assert.equal(stored.phase, "executing");
  assert.equal(stored.wait_reason, null, "a stale reason reads as a run still stuck on it");
});

test("an unauthenticated renewal is refused", async () => {
  stubDb();
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/t-1/lease",
    payload: { brain_id: "brain-7", lease_seconds: 45 },
  });

  assert.equal(res.statusCode, 401);
});
