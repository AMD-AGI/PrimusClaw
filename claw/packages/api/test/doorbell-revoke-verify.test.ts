// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an operator reads from the fleet before a rollback may change membership.
 *
 * The per-pod observable is the internal gate route; the precondition is the
 * pair of maxima over what every pod answered. A fleet aggregate that averages
 * or votes reads "closed" while one stale pod is still publishing doorbells,
 * and a closed gate with a token still held says nothing about the dispatch
 * that took the branch before the revocation landed.
 */

import "./doorbell-dispatch-on-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

import { db } from "../src/infra/db.js";
import { registerAdminRoutes } from "../src/routes/admin.js";
import {
  beginDoorbellDispatch, closeDoorbellLatch, latchFromOperation, resetDoorbellGate, setDoorbellLatch,
} from "../src/tasks/doorbell-gate.js";

interface SeenQuery { params: unknown[] }

const TOKEN = "cluster-internal-token";
const originalQuery = db.query;
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;
const FLOOR = { state: "floor", version: DOORBELL_SEMANTICS_VERSION } as const;

let app: FastifyInstance;
let seen: SeenQuery[] = [];

/** The route's only statement is the incompatible-run count; zero suits every case here. */
function stubCount(n: number): void {
  db.query = (async (_text: string, params: unknown[] = []) => {
    seen.push({ params });
    return { rows: [{ n }], rowCount: 1 };
  }) as typeof db.query;
}

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  app = Fastify();
  await registerAdminRoutes(app);
  await app.ready();
});

beforeEach(() => {
  resetDoorbellGate();
  seen = [];
  stubCount(0);
});

after(async () => {
  db.query = originalQuery;
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  resetDoorbellGate();
  await app.close();
});

/** One pod's answer, as an operator polling it reads it. */
interface PodReport { gate: number; in_flight: number; latch: string }

async function pollPod(query = ""): Promise<PodReport & { supported: number; incompatible: number }> {
  const res = await app.inject({
    method: "GET",
    url: `/v1/internal/brain/doorbell-gate${query}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  return {
    gate: body.gate,
    in_flight: body.in_flight,
    latch: body.latch,
    supported: body.supported,
    incompatible: body.incompatible_runs,
  };
}

/** The revoke-verify predicate, over the answers of every pod that was polled. */
function verifiedClosedAndDrained(pods: PodReport[]): boolean {
  return Math.max(...pods.map((p) => p.gate)) === 0
    && Math.max(...pods.map((p) => p.in_flight)) === 0;
}

test("a pod with a live watch and an asserted floor reports the gate open", async () => {
  setDoorbellLatch(FLOOR);

  const pod = await pollPod();

  assert.equal(pod.gate, 1);
  assert.equal(pod.in_flight, 0);
  assert.equal(pod.latch, "floor");
  assert.equal(pod.supported, DOORBELL_SEMANTICS_VERSION);
  assert.equal(pod.incompatible, 0);
});

test("a pod whose watch died reports gate 0 and says which state it is in", async () => {
  setDoorbellLatch(FLOOR);
  closeDoorbellLatch("iterator ended");

  const pod = await pollPod();

  assert.equal(pod.gate, 0);
  assert.equal(pod.in_flight, 0);
  assert.equal(
    pod.latch,
    "unknown",
    "reporting a dead feed as revoked would read as an operator having turned it off",
  );
});

test("a revoked pod still holding a token reports gate 0 with in_flight 1", async () => {
  setDoorbellLatch(FLOOR);
  const token = beginDoorbellDispatch();
  assert.ok(token);
  setDoorbellLatch(latchFromOperation("DEL", null));

  const held = await pollPod();
  assert.equal(held.gate, 0);
  assert.equal(held.in_flight, 1);
  assert.equal(held.latch, "revoked");

  token.release();
  assert.equal((await pollPod()).in_flight, 0);
});

test("one still-open pod fails the fleet check that every other pod passes", async () => {
  const pods: PodReport[] = [];

  setDoorbellLatch(FLOOR);
  closeDoorbellLatch("iterator ended");
  pods.push(await pollPod());

  resetDoorbellGate();
  setDoorbellLatch(FLOOR);
  setDoorbellLatch({ state: "revoked" });
  pods.push(await pollPod());

  resetDoorbellGate();
  setDoorbellLatch(FLOOR);
  pods.push(await pollPod());

  assert.deepEqual(pods.map((p) => p.gate), [0, 0, 1]);
  assert.equal(
    verifiedClosedAndDrained(pods),
    false,
    "one pod still publishing doorbells is the whole failure",
  );
  // The aggregate a stale pod hides inside: two thirds of the fleet closed
  // reads as "mostly closed" to a mean or a majority, and as a failure to max.
  assert.equal(pods.filter((p) => p.gate === 0).length, 2);
  assert.ok(pods.reduce((n, p) => n + p.gate, 0) / pods.length < 0.5);
});

test("a fleet whose every gate is closed still fails while one pod has a doorbell in flight", async () => {
  const pods: PodReport[] = [];

  setDoorbellLatch(FLOOR);
  setDoorbellLatch({ state: "revoked" });
  pods.push(await pollPod());

  resetDoorbellGate();
  setDoorbellLatch(FLOOR);
  const token = beginDoorbellDispatch();
  assert.ok(token);
  setDoorbellLatch({ state: "revoked" });
  pods.push(await pollPod());

  assert.equal(Math.max(...pods.map((p) => p.gate)), 0);
  assert.equal(
    verifiedClosedAndDrained(pods),
    false,
    "a closed gate says nothing about a dispatch already past the branch",
  );

  token.release();
  pods[1] = await pollPod();

  assert.equal(verifiedClosedAndDrained(pods), true);
});

test("the fleet check passes only when both maxima are zero", () => {
  const cases: Array<[PodReport[], boolean]> = [
    [[{ gate: 0, in_flight: 0, latch: "revoked" }], true],
    [[{ gate: 1, in_flight: 0, latch: "floor" }], false],
    [[{ gate: 0, in_flight: 1, latch: "revoked" }], false],
    [[
      { gate: 0, in_flight: 0, latch: "revoked" },
      { gate: 0, in_flight: 0, latch: "unknown" },
      { gate: 1, in_flight: 0, latch: "floor" },
    ], false],
    [[
      { gate: 0, in_flight: 0, latch: "revoked" },
      { gate: 0, in_flight: 2, latch: "revoked" },
    ], false],
    [[
      { gate: 0, in_flight: 0, latch: "revoked" },
      { gate: 0, in_flight: 0, latch: "revoked" },
    ], true],
  ];

  for (const [pods, expected] of cases) {
    assert.equal(verifiedClosedAndDrained(pods), expected, JSON.stringify(pods));
  }
});

test("the verify poll is authenticated", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/v1/internal/brain/doorbell-gate" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error, "internal auth required");

  const wrong = await app.inject({
    method: "GET",
    url: "/v1/internal/brain/doorbell-gate",
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error, "internal auth required");
});

test("a rollback asks the gate about the version it is rolling to", async () => {
  // A separate precondition from the drained check above: this one counts the
  // runs an incoming older binary could not execute, not what is still coming.
  stubCount(3);
  setDoorbellLatch({ state: "revoked" });

  const pod = await pollPod("?version=1");

  assert.equal(pod.incompatible, 3);
  assert.deepEqual(seen.at(-1)?.params, [1]);

  const refused = await app.inject({
    method: "GET",
    url: "/v1/internal/brain/doorbell-gate?version=0",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(refused.json(), { ok: false, error: "version must be an integer of at least 1" });
});
