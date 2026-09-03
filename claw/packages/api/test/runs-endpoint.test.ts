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
 *   R1 a full batch of runs comes back in a single call
 *   R2 more ids than a call may carry is refused, not silently trimmed
 *   R3 the terminal listing reads one extra row to report whether a page follows
 *   R4 a run is rendered with the platform's account of its ending
 *   R5 equal timestamps paginate by task id without overlap
 *   R6 malformed cursors and limits fail before querying
 *   R7 the database index follows the cursor's complete ordering
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import { registerRunRoutes } from "../src/runs/routes.js";

const originalQuery = db.query;
let app: FastifyInstance;
let lastParams: unknown[] = [];
let lastSql = "";
let queryCalls = 0;

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
    sandbox_workload_id: "wl-1", platform_exit_code: null,
    platform_node: null, platform_message: null, platform_container_reason: null,
    created_at: "2026-09-01T00:00:00Z", started_at: "2026-09-01T00:00:01Z",
    completed_at: "2026-09-01T01:00:00Z", deadline_at: null,
    ...over,
  };
}

function serve(rows: unknown[]): void {
  db.query = (async (text: string, params: unknown[] = []) => {
    queryCalls++;
    lastSql = text.replace(/\s+/g, " ").trim();
    lastParams = params;
    return { rows, rowCount: rows.length };
  }) as typeof db.query;
}

test("R1 a full batch of runs comes back in a single call", async () => {
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

test("R3 terminal listing reads one extra row and reports a finished page", async () => {
  serve([]);
  const resp = await app.inject({ method: "GET", url: "/v1/runs?state=terminal" });
  assert.equal(resp.statusCode, 200);
  assert.ok(
    (lastParams as number[]).includes(201),
    `the default 200-row page did not request its lookahead row: ${JSON.stringify(lastParams)}`,
  );
  assert.deepEqual(resp.json(), {
    runs: [],
    limit: 200,
    has_more: false,
    next_cursor: null,
  });
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

test("R5 equal timestamps paginate by task id without overlap", async () => {
  const exactCompletedAt = "2026-09-01 01:00:00.123456+00";
  serve([
    row("ktsk_c", { cursor_completed_at: exactCompletedAt }),
    row("ktsk_b", { cursor_completed_at: exactCompletedAt }),
    row("ktsk_a", { cursor_completed_at: exactCompletedAt }),
  ]);

  const first = await app.inject({
    method: "GET",
    url: "/v1/runs?state=terminal&since=2026-09-01T00%3A00%3A00Z&limit=2",
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as {
    runs: Array<{ run_id: string }>;
    has_more: boolean;
    next_cursor: string | null;
  };
  assert.deepEqual(firstBody.runs.map((run) => run.run_id), ["ktsk_c", "ktsk_b"]);
  assert.equal(firstBody.has_more, true);
  assert.ok(firstBody.next_cursor);
  assert.match(lastSql, /ORDER BY completed_at DESC NULLS LAST, task_id DESC/);
  assert.equal(lastParams.at(-1), 3, "limit=2 needs one lookahead row");

  serve([row("ktsk_a", { cursor_completed_at: exactCompletedAt })]);
  const second = await app.inject({
    method: "GET",
    url: `/v1/runs?state=terminal&since=2026-09-01T00%3A00%3A00Z&limit=2&cursor=${firstBody.next_cursor}`,
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as {
    runs: Array<{ run_id: string }>;
    has_more: boolean;
    next_cursor: string | null;
  };
  assert.deepEqual(secondBody.runs.map((run) => run.run_id), ["ktsk_a"]);
  assert.equal(secondBody.has_more, false);
  assert.equal(secondBody.next_cursor, null);
  assert.match(lastSql, /\(completed_at, task_id\) < \(\$\d+::timestamptz, \$\d+\)/);
  assert.ok(
    lastParams.includes(exactCompletedAt),
    "the cursor timestamp lost PostgreSQL microsecond precision",
  );
  assert.ok(lastParams.includes("ktsk_b"), "the task id tiebreaker was not applied");
});

test("R6 malformed cursors and limits fail before querying", async () => {
  serve([]);
  const before = queryCalls;
  for (const url of [
    "/v1/runs",
    "/v1/runs?state=active",
    "/v1/runs?state=running",
    "/v1/runs?state=termnial",
    "/v1/runs?state=terminal&cursor=",
    "/v1/runs?state=terminal&cursor=not%2Bbase64",
    "/v1/runs?state=terminal&cursor=e30",
    "/v1/runs?cursor=WyIyMDI2LTA5LTAxVDAwOjAwOjAwWiIsInQiXQ",
    "/v1/runs?ids=ktsk_1&cursor=e30",
    "/v1/runs?state=terminal&limit=0",
    "/v1/runs?state=terminal&limit=1001",
    "/v1/runs?state=terminal&limit=1.5",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 400, url);
  }
  assert.equal(queryCalls, before, "invalid pagination input reached the database");
});

test("R7 the terminal index follows the cursor's complete ordering", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/infra/db.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    source,
    /idx_tasks_terminal_completed_task_v2[\s\S]*completed_at DESC NULLS LAST, task_id DESC/,
    "the keyset query would sort instead of stopping at the page boundary",
  );
});

// ── The cursor's tiebreaker ──────────────────────────────────────────────────
//
// Paging on completed_at alone drops runs whenever more than `limit` of them
// share a timestamp: the cut falls in DB-arbitrary order, and a caller
// advancing past the last timestamp it saw never comes back for the rest. A
// sweeping dispatcher loses completions silently. The tiebreaker is what makes
// the cut deterministic and the cursor resumable, and nothing exercised it.

test("R20 terminal listings are ordered by a total key, not by timestamp alone", async () => {
  serve([]);
  await app.inject({ method: "GET", url: "/v1/runs?state=terminal&limit=2" });
  assert.match(lastSql, /ORDER BY completed_at DESC NULLS LAST, task_id DESC/,
    "task_id must break ties, or equal timestamps are cut arbitrarily");
});

test("R21 the cursor is a compound keyset, and it is exclusive", async () => {
  // Inclusive would re-serve the boundary row forever; comparing only the
  // timestamp would skip the rest of a tied group.
  serve([]);
  await app.inject({
    method: "GET",
    url: "/v1/runs?state=terminal&limit=2&cursor="
      + Buffer.from(JSON.stringify(["2026-09-01T01:00:00Z", "ktsk_b"]), "utf8").toString("base64url"),
  });
  assert.match(lastSql, /\(completed_at, task_id\) < \(\$\d+::timestamptz, \$\d+\)/,
    "a row-value comparison over both columns");
  assert.ok(
    lastParams.some((p) => String(p).includes("ktsk_b")),
    "and the task_id half must actually be bound",
  );
});

test("R22 a full page hands back a cursor naming its last row", async () => {
  // Without this the caller has to synthesise one, which is where the
  // timestamp-only shortcut comes back in. The route over-fetches by one to
  // know whether more exist, so a full page needs limit+1 rows served.
  serve([row("ktsk_a"), row("ktsk_b"), row("ktsk_c")]);
  const body = (await app.inject({ method: "GET", url: "/v1/runs?state=terminal&limit=2" })).json();
  assert.equal(body.runs.length, 2, "the probe row is not returned");
  assert.ok(body.next_cursor, "a full page must be resumable");
  const [ts, id] = JSON.parse(Buffer.from(body.next_cursor, "base64url").toString("utf8"));
  assert.equal(id, "ktsk_b", "the cursor names the last returned row, not the probe");
  assert.ok(ts, "and carries its timestamp");
});

test("R23 a short page ends the walk", async () => {
  serve([row("ktsk_a")]);
  const body = (await app.inject({ method: "GET", url: "/v1/runs?state=terminal&limit=2" })).json();
  assert.ok(!body.next_cursor, "nothing left to continue from");
});

test("R24 a malformed terminal row never produces a cursor the API rejects itself", async () => {
  serve([
    row("ktsk_a"),
    row("ktsk_missing_time", { completed_at: null, cursor_completed_at: undefined }),
    row("ktsk_probe"),
  ]);

  const response = await app.inject({
    method: "GET",
    url: "/v1/runs?state=terminal&limit=2",
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    ok: false,
    error: "terminal_run_missing_completed_at",
  });
});
