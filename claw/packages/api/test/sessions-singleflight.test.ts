// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the in-process singleflight coordinator used by
 * POST /v1/sessions (review fixes M3 / L1 / L2). Pure unit: no DB, no Fastify
 * boot. We drive `execute` with deferred promises so every concurrency case is
 * deterministic.
 *
 * Run with `pnpm --filter @claw/api test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { singleflightCreate, type FlightResult } from "../src/shared/singleflight.js";

// ───────────────────────────── helpers ──────────────────────────────

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const alive = (): boolean => false; // caller still connected
const gone = (): boolean => true; // caller disconnected

// ───────────────────────────── tests ────────────────────────────────

test("singleflight: single caller runs execute once and returns its result", async () => {
  const map = new Map<string, Promise<FlightResult>>();
  let calls = 0;
  const res = await singleflightCreate(
    map,
    "k",
    async () => {
      calls++;
      return { statusCode: 200, response: "ok" };
    },
    alive,
  );
  assert.equal(calls, 1);
  assert.deepEqual(res, { statusCode: 200, response: "ok" });
  assert.equal(map.size, 0, "map cleaned up after completion");
});

test("singleflight: concurrent same-key callers share ONE execution", async () => {
  const map = new Map<string, Promise<FlightResult>>();
  let calls = 0;
  const d = deferred<FlightResult>();
  const execute = async (): Promise<FlightResult> => {
    calls++;
    return d.promise;
  };
  const p1 = singleflightCreate(map, "k", execute, alive);
  const p2 = singleflightCreate(map, "k", execute, alive);
  const p3 = singleflightCreate(map, "k", execute, alive);
  d.resolve({ statusCode: 200, response: "shared" });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(calls, 1, "execute ran exactly once for concurrent joiners");
  assert.deepEqual(r1, { statusCode: 200, response: "shared" });
  assert.deepEqual(r2, r1);
  assert.deepEqual(r3, r1);
  assert.equal(map.size, 0);
});

test("singleflight: different keys run independent executions", async () => {
  const map = new Map<string, Promise<FlightResult>>();
  let a = 0;
  let b = 0;
  const [ra, rb] = await Promise.all([
    singleflightCreate(
      map,
      "ka",
      async () => {
        a++;
        return { statusCode: 200, response: "a" };
      },
      alive,
    ),
    singleflightCreate(
      map,
      "kb",
      async () => {
        b++;
        return { statusCode: 200, response: "b" };
      },
      alive,
    ),
  ]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.deepEqual(ra, { statusCode: 200, response: "a" });
  assert.deepEqual(rb, { statusCode: 200, response: "b" });
  assert.equal(map.size, 0);
});

test("singleflight: a leader exception is NOT inherited; joiner retries as new leader", async () => {
  const map = new Map<string, Promise<FlightResult>>();
  let calls = 0;
  const d1 = deferred<FlightResult>();
  const execute = async (): Promise<FlightResult> => {
    calls++;
    if (calls === 1) return d1.promise; // leader: will reject
    return { statusCode: 200, response: "recovered" }; // joiner's own run
  };
  const leader = singleflightCreate(map, "k", execute, alive);
  const joiner = singleflightCreate(map, "k", execute, alive);
  d1.reject(new Error("boom"));
  await assert.rejects(leader, /boom/, "leader surfaces its own failure");
  const r = await joiner;
  assert.deepEqual(r, { statusCode: 200, response: "recovered" }, "joiner re-ran instead of inheriting the failure");
  assert.equal(calls, 2, "execute ran twice (leader + joiner-as-new-leader)");
  assert.equal(map.size, 0);
});

test("singleflight: leader's own-disconnect 499 is NOT inherited by a still-connected joiner", async () => {
  const map = new Map<string, Promise<FlightResult>>();
  let calls = 0;
  const d1 = deferred<FlightResult>();
  const execute = async (): Promise<FlightResult> => {
    calls++;
    if (calls === 1) return d1.promise; // leader -> 499
    return { statusCode: 200, response: "created" }; // joiner's fresh run
  };
  const leader = singleflightCreate(map, "k", execute, alive);
  const joiner = singleflightCreate(map, "k", execute, alive);
  d1.resolve({ statusCode: 499, response: { error: "client_closed_request" } });
  const lr = await leader;
  assert.equal(lr.statusCode, 499, "leader keeps its own 499");
  const jr = await joiner;
  assert.deepEqual(jr, { statusCode: 200, response: "created" }, "connected joiner re-ran and created");
  assert.equal(calls, 2);
  assert.equal(map.size, 0);
});

test("singleflight: a 499 IS inherited when the joiner is also gone", async () => {
  const map = new Map<string, Promise<FlightResult>>();
  let calls = 0;
  const d1 = deferred<FlightResult>();
  const execute = async (): Promise<FlightResult> => {
    calls++;
    return d1.promise;
  };
  const leader = singleflightCreate(map, "k", execute, gone);
  const joiner = singleflightCreate(map, "k", execute, gone); // also disconnected
  d1.resolve({ statusCode: 499, response: "x" });
  const [lr, jr] = await Promise.all([leader, joiner]);
  assert.equal(lr.statusCode, 499);
  assert.equal(jr.statusCode, 499, "a disconnected joiner inherits the 499");
  assert.equal(calls, 1, "no re-run when the joiner is also gone");
  assert.equal(map.size, 0);
});

test("singleflight: maxJoinAttempts=0 always runs as leader (fallback path)", async () => {
  const map = new Map<string, Promise<FlightResult>>();
  // Pre-seed an entry to prove the join loop is skipped entirely and the
  // fallback leader run overwrites + cleans it up.
  map.set("k", Promise.resolve({ statusCode: 200, response: "stale" }));
  let calls = 0;
  const r = await singleflightCreate(
    map,
    "k",
    async () => {
      calls++;
      return { statusCode: 201, response: "fresh" };
    },
    alive,
    0,
  );
  assert.equal(calls, 1, "fallback ran execute as leader");
  assert.deepEqual(r, { statusCode: 201, response: "fresh" });
  assert.equal(map.size, 0);
});
