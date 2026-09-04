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
 *   S1 a run answers to its session id and carries it back
 *   S2 the task-id form is unchanged by the session-id one
 *   S3 session ids obey the ownership scope
 *   S4 too many session ids is refused at the lower cap
 *   S5 naming runs both ways at once is refused
 *   S6 the session-id cap keeps a full call inside the transport limit
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { maxHeaderSize } from "node:http";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import { registerRunRoutes } from "../src/runs/routes.js";

const originalQuery = db.query;
let app: FastifyInstance;
let lastParams: unknown[] = [];
let lastSql = "";
let queryCalls = 0;
/** Who the request is from, for the tests that care. Null is unauthenticated. */
let caller: { userId: string; roles: string[] } | null = null;

before(async () => {
  app = Fastify();
  // Stands in for the auth hook index.ts registers globally, so the ownership
  // scope has a caller to resolve. Null by default, which leaves every test that
  // does not set one scoped to the empty user -- what they already assumed.
  app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = caller; });
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

/** The ownership predicate the route is expected to add, and the param holding the user. */
const SCOPE_CLAUSE
  = /AND session_id IN \(SELECT session_id FROM claw_sessions WHERE user_id = \$(\d+)\)/;

/**
 * A stub that applies the ownership predicate instead of ignoring it.
 *
 * `serve` hands back its rows whatever the SQL says, which is fine for shape
 * assertions and worthless for a scope one -- a route that dropped the clause
 * altogether would still pass. This reads the clause out of the statement and
 * enforces it against `owners`, so the test fails when the predicate is missing
 * rather than only when it is misspelt.
 */
function serveOwned(rows: Array<Record<string, unknown>>, owners: Record<string, string>): void {
  db.query = (async (text: string, params: unknown[] = []) => {
    queryCalls++;
    lastSql = text.replace(/\s+/g, " ").trim();
    lastParams = params;
    const scoped = SCOPE_CLAUSE.exec(lastSql);
    const visible = scoped
      ? rows.filter((r) => owners[String(r.session_id)] === params[Number(scoped[1]) - 1])
      : rows;
    return { rows: visible, rowCount: visible.length };
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
    terminal: { class: string; kill_reason: string; exit_code: number | null };
    placement: { node: string };
  };
  assert.equal(body.phase, "terminal");
  assert.deepEqual(body.terminal, {
    class: "killed", kill_reason: "preempted", exit_code: 137, signal: "SIGKILL",
  });
  assert.equal(body.placement.node, "gpu-node-7");
});

test("R4b a run with no reported exit code serialises null, not zero", async () => {
  // The JSON a dispatcher actually reads. `exit_code: 0` here would tell it the
  // process ran to completion successfully, which is the opposite of what a row
  // with no exit code means.
  serve([row("ktsk_u", { status: "failed", failure_reason: "agent_error" })]);
  const resp = await app.inject({ method: "GET", url: "/v1/runs/ktsk_u" });
  assert.equal(resp.statusCode, 200);
  const body = resp.json() as { terminal: { exit_code: number | null; signal: string } };
  assert.equal(body.terminal.exit_code, null);
  assert.equal(body.terminal.signal, "");
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

// ── Naming runs by session ───────────────────────────────────────────────────
//
// The dispatcher above Claw never holds a `ktsk_...` id. It has the session id
// `POST /v1/sessions` returned, and against a task-id-only route that produced
// the worse of the two failures available: `?ids=<session id>` answered 200 with
// an empty array, which is what "none of these have finished yet" looks like, so
// a caller polling with the wrong key was told a plausible thing forever.

test("S1 a run answers to its session id and carries it back", async () => {
  const sessionId = "9e0cab58-c73c-4a3e-9324-9e095aa1582e";
  serve([row("ktsk_a", { session_id: sessionId })]);
  const resp = await app.inject({ method: "GET", url: `/v1/runs?session_ids=${sessionId}` });

  assert.equal(resp.statusCode, 200);
  assert.match(lastSql, /WHERE session_id = ANY\(\$1\)/, "matched on the wrong column");
  assert.deepEqual(lastParams[0], [sessionId]);
  const body = resp.json() as { runs: Array<{ run_id: string; session_id: string }>; requested: number };
  assert.equal(body.requested, 1);
  assert.deepEqual(body.runs.map((r) => [r.run_id, r.session_id]), [["ktsk_a", sessionId]]);
});

test("S1b the single-run form carries the session id too", async () => {
  // Without it a caller that resolved one run by task id still cannot join the
  // answer back to the session it dispatched under.
  serve([row("ktsk_a", { session_id: "sess-1" })]);
  const resp = await app.inject({ method: "GET", url: "/v1/runs/ktsk_a" });
  assert.equal(resp.statusCode, 200);
  assert.equal((resp.json() as { session_id: string }).session_id, "sess-1");
});

test("S1c one session answers with every run it owns", async () => {
  // A session is the many side: a DAG expands to a root plus a row per node, a
  // batch to one of those per input, a chat to a row per turn. So `requested`
  // counts sessions asked about, not runs to expect, and the caller groups on
  // the `session_id` each run carries.
  const sessionId = "e2f1a0d4-6b3c-4a71-9f52-0c8d7e6b5a49";
  serve([
    row("ktsk_root", { session_id: sessionId }),
    row("ktsk_n1", { session_id: sessionId }),
    row("ktsk_n2", { session_id: sessionId }),
  ]);
  const body = (await app.inject({
    method: "GET", url: `/v1/runs?session_ids=${sessionId}`,
  })).json() as { runs: Array<{ session_id: string }>; requested: number };

  assert.equal(body.requested, 1, "one session was named");
  assert.equal(body.runs.length, 3, "and it owns three runs");
  assert.ok(body.runs.every((r) => r.session_id === sessionId), "all grouped under it");
  // Rows written inside one transaction share NOW(), so created_at ties are the
  // normal case here and need a tiebreaker or the page order is arbitrary.
  assert.match(lastSql, /ORDER BY created_at, task_id/);
});

test("S2 the task-id form is unchanged by the session-id one", async () => {
  serve([row("ktsk_a")]);
  const resp = await app.inject({ method: "GET", url: "/v1/runs?ids=ktsk_a,ktsk_b" });

  assert.equal(resp.statusCode, 200);
  assert.match(lastSql, /WHERE task_id = ANY\(\$1\)/, "the task-id predicate moved");
  assert.deepEqual(lastParams[0], ["ktsk_a", "ktsk_b"]);
  const body = resp.json() as { runs: unknown[]; requested: number };
  assert.equal(body.requested, 2, "still the ids named");
  assert.equal(body.runs.length, 1, "and a miss is still absent rather than invented");
});

test("S3 session ids obey the ownership scope", async () => {
  // The scope is the whole reason this is not an open lookup: a run id plus a
  // node name is a map of who is running what and where. Another tenant's
  // session must come back absent -- not 404, which would confirm it exists, and
  // certainly not rendered.
  const mine = "11111111-1111-4111-8111-111111111111";
  const theirs = "22222222-2222-4222-8222-222222222222";
  caller = { userId: "u-mine", roles: [] };
  try {
    serveOwned(
      [row("ktsk_mine", { session_id: mine }), row("ktsk_theirs", { session_id: theirs })],
      { [mine]: "u-mine", [theirs]: "u-other" },
    );
    const resp = await app.inject({
      method: "GET", url: `/v1/runs?session_ids=${mine},${theirs}`,
    });

    assert.equal(resp.statusCode, 200, "a foreign session is absent, not an error");
    assert.match(lastSql, SCOPE_CLAUSE, "the batch read was not scoped at all");
    assert.ok(lastParams.includes("u-mine"), "the caller was not bound to the scope");
    const body = resp.json() as { runs: Array<{ run_id: string }>; requested: number };
    assert.deepEqual(body.runs.map((r) => r.run_id), ["ktsk_mine"]);
    assert.equal(body.requested, 2, "both ids were asked about, one was not answerable");
  } finally {
    caller = null;
  }
});

test("S4 too many session ids is refused at the lower cap", async () => {
  serve([]);
  const before = queryCalls;
  const ids = Array.from({ length: 351 }, () => randomUUID());
  const resp = await app.inject({ method: "GET", url: `/v1/runs?session_ids=${ids.join(",")}` });

  assert.equal(resp.statusCode, 400);
  const body = resp.json() as { error: string; max_ids: number };
  assert.equal(body.error, "too_many_ids");
  assert.equal(body.max_ids, 350, "the refusal must name the cap that applied");
  assert.equal(queryCalls, before, "over-long input was trimmed and queried anyway");
});

test("S5 naming runs both ways at once is refused", async () => {
  // Not intersected: when the two disagree an intersection is an empty array,
  // which reads as "nothing finished" to the caller that is already unsure which
  // key it holds.
  serve([row("ktsk_a")]);
  const before = queryCalls;
  const resp = await app.inject({
    method: "GET", url: "/v1/runs?ids=ktsk_a&session_ids=11111111-1111-4111-8111-111111111111",
  });

  assert.equal(resp.statusCode, 400);
  assert.equal((resp.json() as { error: string }).error, "ids_and_session_ids_are_exclusive");
  assert.equal(queryCalls, before, "one of the two parameters won silently");
});

test("S5b an empty session_ids list is refused by name", async () => {
  serve([]);
  const resp = await app.inject({ method: "GET", url: "/v1/runs?session_ids=%2C%2C" });
  assert.equal(resp.statusCode, 400);
  assert.match((resp.json() as { error: string }).error, /^session_ids /);
});

test("S6 the session-id cap keeps a full call inside the transport limit", async () => {
  // Why the session cap sits below the task-id one, asserted rather than left in
  // a comment. A session id is a UUID against a task id's 31 characters, so the
  // task-id ceiling applied here overruns Node's request-line-and-headers limit
  // and the caller gets a bare HTTP 431 naming no size -- the exact failure the
  // cap exists to turn into a readable 400.
  //
  // The cap is read back off the route's own refusal rather than written down
  // here, so raising the constant fails this instead of quietly outgrowing it.
  serve([]);
  const refusal = await app.inject({
    method: "GET",
    url: `/v1/runs?session_ids=${Array.from({ length: 1000 }, () => randomUUID()).join(",")}`,
  });
  assert.equal(refusal.statusCode, 400);
  const cap = (refusal.json() as { max_ids: number }).max_ids;

  const requestLine = `GET /v1/runs?session_ids=${
    Array.from({ length: cap }, () => randomUUID()).join(",")
  } HTTP/1.1\r\n`.length;
  // Room for what a real client sends alongside: bearer token, host, user-agent,
  // accept, tracing headers.
  const headroom = 2048;
  assert.ok(
    requestLine + headroom < maxHeaderSize,
    `a full ${cap}-session call is ${requestLine}B of request line, which passes the `
    + `${maxHeaderSize}B limit once ${headroom}B of headers are added -- callers at the `
    + `documented cap would get HTTP 431, not an answer`,
  );
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
