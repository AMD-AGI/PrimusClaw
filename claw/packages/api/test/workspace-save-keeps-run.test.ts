// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run whose turn has ended keeps its lease while its workspace save holds the session, over the real lease route and
 * a Postgres with the run and session tables (scenario harness).
 *
 * Measured on release 202611120049: the completion closed the run's row; the saving Brain's next renewal was refused as
 * terminal ("gone") and the sandbox was destroyed 4 s into the save, so 0 of 2,725 files were uploaded.
 *
 *   K1 the saving worker's renewal of its closed row is granted while the hold names that run
 *   K2 another worker's, an acceptance's, and any renewal once the save is over or the hold has run out, are refused as before
 *   K3 an attempt-token renewal is kept only for the attempt the row holds: a stale or settled attempt of the same pod is
 *      refused
 *   K4 a session settled by another path (a lost or exhausted run) is not parked while the save holds it, and is after
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Harness } from "./scenario-harness.js";

const { startHarness, seedSession } = await import("./scenario-harness.js");
const { registerInternalTaskRoutes } = await import("../src/routes/internal-tasks.js");
const { parkHandsOfSettledSessions, parkSettledHandsPorts } = await import("../src/tasks/park-settled-hands.js");

const TOKEN = "run-lease-token";
let app: FastifyInstance;
let h: Harness;

before(async () => {
  h = await startHarness();
  app = Fastify();
  app.addHook("onRequest", async (req) => { Object.assign(req, { user: { userId: "user-1", roles: [] } }); });
  await registerInternalTaskRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  await h.reset();
  await seedSession(h, "session-1", { userId: "user-1" });
  // What the completion leaves: the row closed, the session idle and held for the run's save.
  await h.sql(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, internal_token_hash, lease_owner, lease_expires_at,
                             metadata)
     VALUES ('run-1', 'session-1', 'chat', 'completed', 'chat', $1, 'worker-1', NOW() + INTERVAL '30 seconds',
             '{"message_id":"claw-1"}'::jsonb)`,
    [createHash("sha256").update(TOKEN).digest("hex")],
  );
  await h.sql(
    `UPDATE claw_sessions SET agent_status = 'idle', workspace_save_id = 'save-1',
            workspace_save_until = NOW() + INTERVAL '2 hours', workspace_save_task_id = 'run-1'`,
  );
});

after(async () => {
  await app?.close();
  await h?.close();
});

function renew(brainId: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST", url: "/v1/internal/tasks/run-1/lease",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: brainId, lease_seconds: 45, ...extra },
  });
}

test("K1 the saving worker's renewal of its closed row is granted while its save holds the session", async () => {
  const res = await renew("worker-1");
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, status: "completed" });
  const [row] = await h.sql("SELECT status FROM claw_tasks WHERE task_id = 'run-1'");
  assert.equal(row.status, "completed", "the row stays closed; only the refusal is withheld");
});

test("K2 everyone else, and the same worker once the save is over or the hold ran out, is refused as before", async () => {
  const other = await renew("worker-2");
  assert.equal(other.statusCode, 409, other.body);

  const accept = await renew("worker-1", { accept: true });
  assert.equal(accept.statusCode, 409, "a redelivery still reads the ended turn's row as over");

  await h.sql("UPDATE claw_sessions SET workspace_save_id = NULL, workspace_save_until = NULL, workspace_save_task_id = NULL");
  const finished = await renew("worker-1");
  assert.equal(finished.statusCode, 409, finished.body);
  assert.equal(finished.json().reason, "terminal");

  await h.sql(
    `UPDATE claw_sessions SET workspace_save_id = 'save-1', workspace_save_until = NOW() - INTERVAL '1 second',
            workspace_save_task_id = 'run-1'`,
  );
  const expired = await renew("worker-1");
  assert.equal(expired.statusCode, 409, expired.body);

  await h.sql(
    `UPDATE claw_sessions SET workspace_save_until = NOW() + INTERVAL '1 hour', workspace_save_task_id = 'run-other'`,
  );
  const otherRun = await renew("worker-1");
  assert.equal(otherRun.statusCode, 409, "a hold for another run's save keeps nothing of this one");
});

test("K3 an attempt-token renewal is kept only for the attempt the row holds", async () => {
  await h.sql("UPDATE claw_tasks SET attempt_id = 'attempt-2', claim_count = 2 WHERE task_id = 'run-1'");
  const token = (attempt: string, claim: number) => ({ attempt_id: attempt, claim_count: claim, delivery_seq: 0, delivery_count: 1 });

  const current = await renew("worker-1", token("attempt-2", 2));
  assert.equal(current.statusCode, 200, current.body);
  assert.deepEqual(current.json(), { ok: true, status: "completed" });

  const stale = await renew("worker-1", token("attempt-1", 2));
  assert.equal(stale.statusCode, 409, "the same pod name, an earlier attempt");
  const oldGeneration = await renew("worker-1", token("attempt-2", 1));
  assert.equal(oldGeneration.statusCode, 409, "the same attempt id, an earlier generation");

  await h.sql("UPDATE claw_tasks SET settled_attempt_id = 'attempt-2' WHERE task_id = 'run-1'");
  const settled = await renew("worker-1", token("attempt-2", 2));
  assert.equal(settled.statusCode, 409, "an attempt the row has settled holds nothing");
});

test("K4 a session settled by another path is not parked while the save holds it, and is after", async () => {
  const parked: string[] = [];
  const original = parkSettledHandsPorts.parkHandsAfterRun;
  parkSettledHandsPorts.parkHandsAfterRun = async (sessionId: string) => {
    parked.push(sessionId);
    return { outcome: "parked" } as Awaited<ReturnType<typeof original>>;
  };
  try {
    await parkHandsOfSettledSessions(["session-1"]);
    assert.deepEqual(parked, [], "the saving run is still using the sandbox");
    await h.sql("UPDATE claw_sessions SET workspace_save_id = NULL, workspace_save_until = NULL, workspace_save_task_id = NULL");
    await parkHandsOfSettledSessions(["session-1"]);
    assert.deepEqual(parked, ["session-1"]);
  } finally {
    parkSettledHandsPorts.parkHandsAfterRun = original;
  }
});
