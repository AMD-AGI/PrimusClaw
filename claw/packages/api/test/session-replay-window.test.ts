// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/chat/sessions/:id/messages?mode=replay` with a window.
 *
 * The replay used to read and return a session's whole history every time. An assistant session runs for weeks:
 * one reached 33,196 events (28.6 MB), and each read of it put about 200 MB on whoever made it, which a 512 MiB pod
 * does not survive. `tail=N` and `after=<event_id>&limit=N` read only that window from the table. Without either
 * the reply is the whole history, exactly as before.
 *
 * Driven through the route on PGlite, so what is asserted is the rows the table handed back, not the SQL text.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import { REPLAY_WINDOW_MAX, registerEventRoutes } from "../src/routes/events.js";
import { startHarness, type Harness } from "./scenario-harness.js";

const OWNER = { userId: "u-owner", userName: "u-owner", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
const SID = "s-long";

let h: Harness;
let app: FastifyInstance;
/** Rows each statement on claw_session_events handed back to the route, in order. */
let rowsRead: number[] = [];

before(async () => {
  h = await startHarness();
  const harnessQuery = db.query;
  db.query = (async (text: string, params?: unknown[]) => {
    const r = await (harnessQuery as (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>)(text, params);
    if (/FROM claw_session_events/.test(text)) rowsRead.push(r.rows.length);
    return r;
  }) as typeof db.query;
  app = Fastify();
  app.addHook("preHandler", async (req) => { (req as unknown as { user: unknown }).user = OWNER; });
  await registerEventRoutes(app);
  await app.ready();
});
beforeEach(async () => {
  await h.reset();
  rowsRead = [];
  await h.sql("INSERT INTO claw_sessions (session_id, user_id) VALUES ($1, $2)", [SID, OWNER.userId]);
});
after(async () => {
  await app?.close();
  await h?.close();
});

/** `n` events claw-1..claw-n; every `subEvery`-th one (when set) belongs to sub-agent `sub-a`. */
async function seed(n: number, subEvery = 0): Promise<void> {
  await h.sql(
    `INSERT INTO claw_session_events (event_id, session_id, event, data)
     SELECT 'claw-' || g, $1, 'toolUsed',
            CASE WHEN $3 > 0 AND g % $3 = 0
                 THEN jsonb_build_object('type', 'toolUsed', 'n', g, 'subagent_id', 'sub-a')
                 ELSE jsonb_build_object('type', 'toolUsed', 'n', g) END
       FROM generate_series(1, $2::int) g`,
    [SID, n, subEvery],
  );
  rowsRead = [];
}

async function replay(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({ method: "GET", url: `/v1/chat/sessions/${SID}/messages?mode=replay${query}` });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

const ns = (body: Record<string, unknown>): number[] =>
  (body.data as Array<{ data: { n: number } }>).map((r) => r.data.n);

test("tail=N on a long session reads N rows from the table and returns the last N, oldest first", async () => {
  await seed(3000);
  const { status, body } = await replay("&tail=200");
  assert.equal(status, 200);
  assert.deepEqual(ns(body), Array.from({ length: 200 }, (_, i) => 2801 + i));
  assert.equal(body.has_more, true);
  // One read of the events table, of N+1 rows at most (the one extra says whether there is more): never the 3000.
  assert.equal(rowsRead.length, 1);
  assert.ok(rowsRead[0] <= 201, `read ${rowsRead[0]} rows`);
});

test("without a window the reply is the whole history, in the old shape and with no has_more", async () => {
  await seed(300);
  const { status, body } = await replay("");
  assert.equal(status, 200);
  assert.deepEqual(ns(body), Array.from({ length: 300 }, (_, i) => i + 1));
  assert.equal("has_more" in body, false);
  assert.deepEqual(Object.keys((body.data as object[])[0]).sort(), ["created_at", "data", "event_id", "event_type"]);
});

test("a windowed row has exactly the shape of a whole-history row", async () => {
  await seed(5);
  const whole = (await replay("")).body.data as object[];
  const tail = (await replay("&tail=2")).body.data as object[];
  assert.deepEqual(tail, whole.slice(-2));
});

test("tail larger than the session returns all of it, has_more false", async () => {
  await seed(30);
  const { body } = await replay("&tail=200");
  assert.equal(ns(body).length, 30);
  assert.equal(body.has_more, false);
});

test("after + limit pages forward in row order, across claw-9 / claw-10 where the ids sort the other way as text", async () => {
  await seed(25);
  const first = await replay("&limit=9");
  assert.deepEqual(ns(first.body), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(first.body.has_more, true);
  const next = await replay("&after=claw-9&limit=10");
  assert.deepEqual(ns(next.body), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(next.body.has_more, true);
  const last = await replay("&after=claw-19&limit=10");
  assert.deepEqual(ns(last.body), [20, 21, 22, 23, 24, 25]);
  assert.equal(last.body.has_more, false);
});

test("after + tail is the last N after the cursor", async () => {
  await seed(50);
  const { body } = await replay("&after=claw-40&tail=3");
  assert.deepEqual(ns(body), [48, 49, 50]);
  assert.equal(body.has_more, true);
});

test("the sub-agent filters are applied before the window: tail=N is N events the caller is shown", async () => {
  await seed(100, 2);   // even n: sub-agent sub-a
  const folded = await replay("&fold_subagents=1&tail=5");
  assert.deepEqual(ns(folded.body), [91, 93, 95, 97, 99]);
  const sub = await replay("&subagent_id=sub-a&tail=5");
  assert.deepEqual(ns(sub.body), [92, 94, 96, 98, 100]);
});

test("a folded window keeps the sub-agent lifecycle events, as the whole replay does", async () => {
  await seed(3);
  await h.sql(
    `INSERT INTO claw_session_events (event_id, session_id, event, data)
     VALUES ('claw-4', $1, 'subagentStart', '{"type":"subagentStart","subagent_id":"sub-a","n":4}'),
            ('claw-5', $1, 'toolUsed', '{"type":"toolUsed","subagent_id":"sub-a","n":5}'),
            ('claw-6', $1, 'toolUsed', '{"type":"toolUsed","subagent_id":"","n":6}')`,
    [SID],
  );
  const whole = ns((await replay("&fold_subagents=1")).body);
  const tail = ns((await replay("&fold_subagents=1&tail=10")).body);
  assert.deepEqual(whole, [1, 2, 3, 4, 6]);
  assert.deepEqual(tail, whole);
});

test("deleted events stay out of a window", async () => {
  await seed(10);
  await h.sql("UPDATE claw_session_events SET deleted_at = NOW() WHERE event_id IN ('claw-9', 'claw-10')");
  assert.deepEqual(ns((await replay("&tail=3")).body), [6, 7, 8]);
});

test("a window is redacted like the whole replay", async () => {
  await h.sql(
    `INSERT INTO claw_session_events (event_id, session_id, event, data)
     VALUES ('claw-1', $1, 'statusUpdate', '{"type":"statusUpdate","data":{"platform_key":"sk-secret"}}')`,
    [SID],
  );
  const { body } = await replay("&tail=1");
  const row = (body.data as Array<{ data: { data: Record<string, unknown> } }>)[0];
  assert.equal(row.data.data.platform_key, "[REDACTED]");
});

test("tail and limit above the cap are cut to it", async () => {
  await seed(REPLAY_WINDOW_MAX + 10);
  const { body } = await replay(`&tail=${REPLAY_WINDOW_MAX * 10}`);
  assert.equal(ns(body).length, REPLAY_WINDOW_MAX);
  assert.equal(ns(body)[0], 11);
  assert.equal(body.has_more, true);
});

test("a bad window is refused, not read whole", async () => {
  await seed(10);
  for (const q of ["&tail=0", "&tail=-1", "&tail=abc", "&limit=1.5", "&tail=2&limit=2", "&after=claw-999", "&after=a%20b"]) {
    rowsRead = [];
    const { status, body } = await replay(q);
    assert.equal(status, 400, q);
    assert.equal(body.ok, false, q);
    assert.ok(rowsRead.every((n) => n <= 1), `${q} read ${rowsRead}`);
  }
});

test("another user's session is refused before anything is read", async () => {
  await h.sql("UPDATE claw_sessions SET user_id = 'u-other' WHERE session_id = $1", [SID]);
  await seed(10);
  const { status } = await replay("&tail=5");
  assert.equal(status, 403);
  assert.deepEqual(rowsRead, []);
});
