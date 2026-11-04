// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain wakes a session whose sandbox finished background work while no turn ran: a server message on the
 * session's queue, drained like any queued message, once per finish, and never for a session that acts as a user.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { registerInternalRunRoutes } from "../src/routes/internal-runs.js";
import { BACKGROUND_WORK_FINISHED_NOTICE, sessionWakePorts } from "../src/sessions/wake.js";

const TOKEN = "cluster-internal-token";
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;
const originalPorts = { ...sessionWakePorts };

let app: FastifyInstance;
let sessions: Record<string, { userId: string; acting: boolean }>;
let queued: Array<{ sessionId: string; userId: string; content: string; dedupeKey?: string }>;
let drained: string[];
let queueAnswer: Awaited<ReturnType<typeof sessionWakePorts.queue>>;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  app = Fastify();
  await registerInternalRunRoutes(app);
  await app.ready();
});

after(async () => {
  Object.assign(sessionWakePorts, originalPorts);
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await app.close();
});

beforeEach(() => {
  sessions = { "s-1": { userId: "u-1", acting: false }, "s-acting": { userId: "u-2", acting: true } };
  queued = [];
  drained = [];
  queueAnswer = { ok: true, pendingId: 7, deduplicated: false };
  sessionWakePorts.owner = async (sessionId) => sessions[sessionId] ?? null;
  sessionWakePorts.queue = async (_q, m) => { queued.push(m); return queueAnswer; };
  sessionWakePorts.drain = async (sessionId) => { drained.push(sessionId); return "drained"; };
});

function wake(sessionId: string, body: unknown, token = TOKEN) {
  return app.inject({
    method: "POST", url: `/v1/internal/sessions/${sessionId}/wake`,
    headers: { authorization: `Bearer ${token}` }, payload: body as object,
  });
}

test("a finish queues one report turn as the session's owner and runs it", async () => {
  const res = await wake("s-1", { reason: "background_work_finished", key: "wl-1:100:5" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, outcome: "queued" });
  assert.deepEqual(queued, [{
    sessionId: "s-1", userId: "u-1", content: BACKGROUND_WORK_FINISHED_NOTICE, dedupeKey: "bg-done:wl-1:100:5",
  }]);
  assert.deepEqual(drained, ["s-1"]);
});

test("the same finish reported again starts nothing more", async () => {
  queueAnswer = { ok: true, pendingId: null, deduplicated: true };
  const res = await wake("s-1", { reason: "background_work_finished", key: "wl-1:100:5" });
  assert.deepEqual(res.json(), { ok: true, outcome: "duplicate" });
  assert.deepEqual(drained, [], "a duplicate must not drain: the first one already did");
});

test("a session that acts as a user is not woken", async () => {
  const res = await wake("s-acting", { reason: "background_work_finished", key: "k" });
  assert.deepEqual(res.json(), { ok: true, outcome: "acting" });
  assert.deepEqual(queued, []);
});

test("a session the owner never sent credentials to is not run", async () => {
  queueAnswer = { ok: false, error: "no_credentials" };
  const res = await wake("s-1", { reason: "background_work_finished", key: "k" });
  assert.deepEqual(res.json(), { ok: true, outcome: "no_credentials" });
  assert.deepEqual(drained, []);
});

const REFUSALS: Array<{ name: string; session: string; body: unknown; token?: string; status: number }> = [
  { name: "no cluster token", session: "s-1", body: { reason: "background_work_finished", key: "k" }, token: "wrong", status: 401 },
  { name: "an unknown reason", session: "s-1", body: { reason: "anything", key: "k" }, status: 400 },
  { name: "no key", session: "s-1", body: { reason: "background_work_finished" }, status: 400 },
  { name: "a key too long", session: "s-1", body: { reason: "background_work_finished", key: "k".repeat(201) }, status: 400 },
  { name: "a session that does not exist", session: "s-gone", body: { reason: "background_work_finished", key: "k" }, status: 404 },
];

for (const row of REFUSALS) {
  test(`refused: ${row.name}`, async () => {
    const res = await wake(row.session, row.body, row.token);
    assert.equal(res.statusCode, row.status);
    assert.deepEqual(queued, []);
  });
}
