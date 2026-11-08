// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The history a session's event stream (`GET /v1/chat/sessions/:id/messages`) sends before its live events.
 *
 * Every connection without `?after=` used to read the session's whole history into this process in one statement and
 * write all of it to the client; an assistant session reached 33,196 events (28.6 MB), and the web console and the
 * Teams worker open such a connection on every visit and every turn. Now a connection that does not say where it resumes
 * gets the last SSE_HISTORY_TAIL events and a marker that says older ones exist (`has_more`), `?history=all` asks for
 * everything, and the history is read a page at a time. `after` (and Last-Event-ID) is placed by row, so `claw-10`
 * follows `claw-9` (comparing ids as text lost it).
 *
 * Driven through the route on PGlite (no NATS here, so the live part ends at once and the reply is the history).
 * Also: the Anthropic-compatible stream's history and an A2A task's artifacts read only the latest rows.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";

import { SSE_HISTORY_TAIL } from "../src/config.js";
import { db } from "../src/infra/db.js";
import { drained, HISTORY_PAGE_ROWS, registerEventRoutes } from "../src/routes/events.js";
import { streamHistoryRows } from "../src/routes/anthropic-managed-agents.js";
import { latestResults } from "../src/routes/a2a.js";
import { startHarness, type Harness } from "./scenario-harness.js";

const OWNER = { userId: "u-owner", userName: "u-owner", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
const SID = "s-long";

let h: Harness;
let app: FastifyInstance;
/** Rows each statement on claw_session_events handed back, in order. */
let rowsRead: number[] = [];
/** Run after each page of history is read (a writer racing the stream). */
let afterPage: (() => Promise<void>) | undefined;

before(async () => {
  h = await startHarness();
  const harnessQuery = db.query;
  db.query = (async (text: string, params?: unknown[]) => {
    const r = await (harnessQuery as (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>)(text, params);
    if (/FROM claw_session_events/.test(text)) {
      rowsRead.push(r.rows.length);
      if (/LIMIT \$\d+$/.test(text.trim()) && afterPage) await afterPage();
    }
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
  afterPage = undefined;
  await h.sql("INSERT INTO claw_sessions (session_id, user_id) VALUES ($1, $2)", [SID, OWNER.userId]);
});
after(async () => {
  await app?.close();
  await h?.close();
});

/** Events claw-<from>..claw-<to> in that order; every `subEvery`-th one (when set) belongs to sub-agent `sub-a`. */
async function seed(to: number, subEvery = 0, from = 1, event = "toolUsed"): Promise<void> {
  await h.sql(
    `INSERT INTO claw_session_events (event_id, session_id, event, data)
     SELECT 'claw-' || g, $1, $5,
            CASE WHEN $3 > 0 AND g % $3 = 0
                 THEN jsonb_build_object('type', $5::text, 'n', g, 'subagent_id', 'sub-a')
                 ELSE jsonb_build_object('type', $5::text, 'n', g) END
       FROM generate_series($4::int, $2::int) g ORDER BY g`,
    [SID, to, subEvery, from, event],
  );
  rowsRead = [];
}

interface Stream { status: number; ns: number[]; ids: string[]; marker: Record<string, unknown> | null }

async function stream(query = "", headers: Record<string, string> = {}): Promise<Stream> {
  const res = await app.inject({ method: "GET", url: `/v1/chat/sessions/${SID}/messages${query}`, headers });
  const ns: number[] = [];
  const ids: string[] = [];
  let marker: Record<string, unknown> | null = null;
  for (const frame of res.body.split("\n\n")) {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.*)$/m.exec(frame)?.[1];
    if (!event || data === undefined) continue;
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (event === "historyComplete") { marker = parsed; continue; }
    assert.equal(marker, null, "no event after the marker");
    ns.push(parsed.n as number);
    ids.push(/^id: (.+)$/m.exec(frame)![1]);
  }
  return { status: res.statusCode, ns, ids, marker };
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test("without after, a long session sends its last SSE_HISTORY_TAIL events and says older ones exist", async () => {
  const total = SSE_HISTORY_TAIL + 1000;
  await seed(total);
  const s = await stream();
  assert.equal(s.status, 200);
  assert.deepEqual(s.ns, range(total - SSE_HISTORY_TAIL + 1, total));
  assert.deepEqual(s.marker, { type: "historyComplete", count: SSE_HISTORY_TAIL, has_more: true });
  assert.ok(Math.max(...rowsRead) <= HISTORY_PAGE_ROWS, `no statement handed back more than a page: ${rowsRead}`);
});

test("a session shorter than the tail is sent whole, and the marker says nothing is left out", async () => {
  await seed(30);
  const s = await stream();
  assert.deepEqual(s.ns, range(1, 30));
  assert.deepEqual(s.marker, { type: "historyComplete", count: 30, has_more: false });
});

test("history=all sends the whole history, a page at a time", async () => {
  const total = SSE_HISTORY_TAIL + 1000;
  await seed(total);
  const s = await stream("?history=all");
  assert.deepEqual(s.ns, range(1, total));
  assert.deepEqual(s.marker, { type: "historyComplete", count: total, has_more: false });
  assert.ok(Math.max(...rowsRead) <= HISTORY_PAGE_ROWS, `no statement handed back more than a page: ${rowsRead}`);
});

test("after=claw-9 is followed by claw-10: the cursor is placed by row, not compared as text", async () => {
  await seed(12);
  const s = await stream("?after=claw-9");
  assert.deepEqual(s.ids, ["claw-10", "claw-11", "claw-12"]);
  assert.deepEqual(s.marker, { type: "historyComplete", count: 3, has_more: false });
});

test("Last-Event-ID resumes the same way as after", async () => {
  await seed(12);
  const s = await stream("", { "last-event-id": "claw-9" });
  assert.deepEqual(s.ids, ["claw-10", "claw-11", "claw-12"]);
});

test("after is not cut to the tail: a reconnect gets everything it missed, a page at a time", async () => {
  const total = SSE_HISTORY_TAIL + 1000;
  await seed(total);
  const s = await stream("?after=claw-5");
  assert.deepEqual(s.ns, range(6, total));
  assert.equal(s.marker?.has_more, false);
  assert.ok(Math.max(...rowsRead) <= HISTORY_PAGE_ROWS, `no statement handed back more than a page: ${rowsRead}`);
});

test("a stream id the table does not hold yet resumes after the last stored event at or before it", async () => {
  await seed(9);
  await seed(12, 0, 12);   // claw-10 and claw-11 reached the client live and are not stored (yet)
  assert.deepEqual((await stream("?after=claw-10")).ids, ["claw-12"]);
  assert.deepEqual((await stream("?after=claw-99")).ids, []);
});

test("an after that is no event of this session is read as no after: the tail", async () => {
  await seed(5);
  const s = await stream("?after=not-an-event");
  assert.deepEqual(s.ns, range(1, 5));
  assert.equal(s.marker?.has_more, false);
});

test("the tail counts the events the caller is shown: subagent_id gets that sub-agent's last events", async () => {
  const total = 3 * (SSE_HISTORY_TAIL + 10);
  await seed(total, 3);
  const s = await stream("?subagent_id=sub-a");
  assert.equal(s.ns.length, SSE_HISTORY_TAIL);
  assert.ok(s.ns.every((n) => n % 3 === 0));
  assert.equal(s.ns[s.ns.length - 1], total);
  assert.equal(s.marker?.has_more, true);
});

test("the Anthropic-compatible stream's history is the last events, oldest first", async () => {
  await seed(50);
  const rows = await streamHistoryRows(SID, 10);
  assert.deepEqual(rows.map((r) => (r.data as { n: number }).n), range(41, 50));
  assert.deepEqual(rowsRead, [10]);
});

test("an A2A task's artifacts are its latest results, oldest first", async () => {
  await seed(250, 0, 1, "ResultMessage");
  const rows = await latestResults(SID);
  assert.deepEqual(rows.map((r) => (r.data as { n: number }).n), range(151, 250));
  assert.deepEqual(rowsRead, [100]);
});

test("the next page waits while the client has not taken the last one, and stops when it has gone", async () => {
  const fake = () => Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false }) as unknown as ServerResponse;
  assert.equal(await drained(fake(), false), true, "nothing buffered: go on at once");

  const slow = fake();
  let settled: boolean | undefined;
  void drained(slow, true).then((ok) => { settled = ok; });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(settled, undefined, "buffered: wait");
  slow.emit("drain");
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, true);

  const gone = fake();
  const waiting = drained(gone, true);
  gone.emit("close");
  assert.equal(await waiting, false);
  assert.equal(await drained(Object.assign(fake(), { destroyed: true }), false), false, "a closed response is not written to");
});

test("the history is read to the newest row when it starts, once more for what came meanwhile, and no further", async () => {
  await seed(HISTORY_PAGE_ROWS + 100);
  let next = HISTORY_PAGE_ROWS + 100;
  let writes = 5;   // a writer adds a page after each page is read, five times (an unbounded history would send them all)
  afterPage = async () => {
    if (writes-- <= 0) return;
    const from = next + 1;
    next += HISTORY_PAGE_ROWS;
    await seed(next, 0, from);
  };
  const s = await stream("?history=all");
  // 600 when it started, and the 1000 stored while those two pages were sent; what came while those were sent is live.
  const sent = HISTORY_PAGE_ROWS + 100 + 2 * HISTORY_PAGE_ROWS;
  assert.deepEqual(s.ns, range(1, sent));
  assert.equal(s.marker?.count, sent);
  assert.equal(next, HISTORY_PAGE_ROWS + 100 + 5 * HISTORY_PAGE_ROWS, "the writer went on past what was sent");
});

test("events the stream never sends do not take places in the tail", async () => {
  await seed(SSE_HISTORY_TAIL);
  await seed(SSE_HISTORY_TAIL + 5, 0, SSE_HISTORY_TAIL + 1, "exec_complete");
  const s = await stream();
  assert.deepEqual(s.ns, range(1, SSE_HISTORY_TAIL));
  assert.equal(s.marker?.has_more, false);
});

/** One event `id` stored now (rows are stored in the order these are called). */
async function store1(id: string, n: number): Promise<void> {
  await h.sql(
    `INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, 'toolUsed', jsonb_build_object('type', 'toolUsed', 'n', $3::int))`,
    [id, SID, n],
  );
}

test("a stream event stored before a lower one still follows it: after is placed by sequence, not by row", async () => {
  // Several API replicas pull from one consumer: claw-11 can be stored before claw-10.
  await seed(9);
  await store1("user-a", 100);    // a row of the turn itself (no stream id), stored before the cursor
  await store1("claw-11", 11);
  await store1("claw-10", 10);
  await store1("user-b", 101);    // stored after the cursor
  await store1("claw-12", 12);
  assert.deepEqual((await stream("", { "last-event-id": "claw-10" })).ids, ["claw-11", "user-b", "claw-12"]);
  assert.deepEqual((await stream("?after=claw-11")).ids, ["user-b", "claw-12"]);
});

test("a stream id not stored yet is placed by sequence too", async () => {
  // claw-10 reached the client live and its row is not written yet; claw-12 was stored before claw-8, the last stored
  // stream event at or before it, so placing the cursor by that row would leave claw-12 out.
  await seed(7);
  await store1("claw-12", 12);
  await store1("claw-8", 8);
  await store1("claw-11", 11);
  assert.deepEqual((await stream("?after=claw-10")).ids, ["claw-12", "claw-11"]);
});
