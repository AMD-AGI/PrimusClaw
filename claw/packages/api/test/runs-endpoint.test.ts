// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/v1/runs` over HTTP, which nothing exercised before.
 *
 * The classifier under it was well covered and the endpoint was not, so the one
 * acceptance criterion stated as a number -- 200 runs back in a single call --
 * rested on reading two constants. Numbers in constants are exactly what drifts.
 *
 * Coverage:
 *   R1 one sweep's worth of runs comes back in a single call
 *   R2 more ids than a call may carry is refused, not silently trimmed
 *   R3 the terminal listing defaults to the width the dispatcher needs
 *   R4 a run is rendered with the platform's account of its ending
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import { registerRunRoutes } from "../src/runs/routes.js";

const originalQuery = db.query;
let app: FastifyInstance;
let lastParams: unknown[] = [];

before(async () => {
  app = Fastify();
  // No auth hook: the app registers one globally in index.ts, and an
  // unauthenticated request here simply scopes to the empty user -- which is
  // what the stubbed query ignores.
  await registerRunRoutes(app);
  await app.ready();
});

after(async () => { db.query = originalQuery; await app.close(); });

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    task_id: id, session_id: "s1", status: "failed", failure_reason: "brain_timeout",
    sandbox_workload_id: "wl-1", platform_kill_reason: null, platform_exit_code: null,
    platform_node: null, platform_message: null, platform_container_reason: null,
    created_at: "2026-09-01T00:00:00Z", started_at: "2026-09-01T00:00:01Z",
    completed_at: "2026-09-01T01:00:00Z", deadline_at: null,
    ...over,
  };
}

function serve(rows: unknown[]): void {
  db.query = (async (_text: string, params: unknown[] = []) => {
    lastParams = params;
    return { rows, rowCount: rows.length };
  }) as typeof db.query;
}

test("R1 one sweep's worth of runs comes back in a single call", async () => {
  // 200 concurrent runs is the stated width of one reconcile pass at full
  // concurrency, and the reason the batch form exists at all: point queries
  // would be 200 calls per 30-second tick.
  const ids = Array.from({ length: 200 }, (_, i) => `ktsk_${String(i).padStart(4, "0")}`);
  serve(ids.map((id) => row(id)));
  const resp = await app.inject({ method: "GET", url: `/v1/runs?ids=${ids.join(",")}` });
  assert.equal(resp.statusCode, 200);
  const body = resp.json() as { runs: unknown[]; requested: number };
  assert.equal(body.requested, 200);
  assert.equal(body.runs.length, 200, "all 200 in one response");
  assert.deepEqual(lastParams[0], ids, "and all 200 in one query");
});

test("R2 more ids than a call may carry is refused, not trimmed", async () => {
  // It used to stop reading at the cap and answer for the ids it had, reporting
  // the trimmed count as `requested` -- so a caller over the limit was told
  // about exactly what it asked about and never learnt the rest was missing.
  serve([]);
  const ids = Array.from({ length: 501 }, (_, i) => `ktsk_${i}`);
  const resp = await app.inject({ method: "GET", url: `/v1/runs?ids=${ids.join(",")}` });
  assert.equal(resp.statusCode, 400);
  const body = resp.json() as { error: string; max_ids: number };
  assert.equal(body.error, "too_many_ids");
  assert.equal(body.max_ids, 500);
});

test("R3 the terminal listing defaults to the width the dispatcher needs", async () => {
  serve([]);
  const resp = await app.inject({ method: "GET", url: "/v1/runs?state=terminal" });
  assert.equal(resp.statusCode, 200);
  assert.ok(
    (lastParams as number[]).includes(200),
    `no default limit of 200 in ${JSON.stringify(lastParams)}`,
  );
});

test("R4 a run is rendered with the platform's account of its ending", async () => {
  // The end of the chain the write path feeds: a row carrying what SaFE said
  // must come back as a preemption rather than as an unexplained failure.
  serve([row("ktsk_p", {
    platform_message: "Preempted, the pod was preempted by a higher priority pod",
    platform_node: "gpu-node-7",
    platform_exit_code: 137,
  })]);
  const resp = await app.inject({ method: "GET", url: "/v1/runs/ktsk_p" });
  assert.equal(resp.statusCode, 200);
  const body = resp.json() as {
    phase: string;
    terminal: { class: string; kill_reason: string; exit_code: number };
    placement: { node: string };
  };
  assert.equal(body.phase, "terminal");
  assert.deepEqual(body.terminal, {
    class: "killed", kill_reason: "preempted", exit_code: 137, signal: "SIGKILL",
  });
  assert.equal(body.placement.node, "gpu-node-7");
});
