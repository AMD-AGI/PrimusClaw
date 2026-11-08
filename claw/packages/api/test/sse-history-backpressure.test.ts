// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A long session's event stream, opened without a cursor over a real socket, by a client that does not read at once.
 *
 * The tail of such a session is SSE_HISTORY_TAIL events, an exact number of pages. After the last full page the route
 * reads one more page, which is empty and writes nothing, and then waited for 'drain' because the write before it had
 * been buffered -- but that buffer had been flushed (and 'drain' emitted) long before, so nothing came: the client got
 * the history and then only keepalives, never `historyComplete` and never a live event (#540 in production, 2026-11-08).
 *
 * A real server and socket, because only a socket's buffer fills and drains the way production does; on PGlite.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";

import { SSE_HISTORY_TAIL } from "../src/config.js";
import { HISTORY_PAGE_ROWS, registerEventRoutes } from "../src/routes/events.js";
import { startHarness, type Harness } from "./scenario-harness.js";

const OWNER = { userId: "u-owner", userName: "u-owner", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
const SID = "s-long";
const PAD = 16 * 1024;   // per event: the tail is ~32 MB, far more than a loopback socket buffers, so writes are held back

let h: Harness;
let app: FastifyInstance;
let port = 0;

before(async () => {
  h = await startHarness();
  app = Fastify();
  app.addHook("preHandler", async (req) => { (req as unknown as { user: unknown }).user = OWNER; });
  await registerEventRoutes(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.server.address() as { port: number }).port;
  await h.sql("INSERT INTO claw_sessions (session_id, user_id) VALUES ($1, $2)", [SID, OWNER.userId]);
  await h.sql(
    `INSERT INTO claw_session_events (event_id, session_id, event, data)
     SELECT 'claw-' || g, $1, 'toolUsed', jsonb_build_object('type', 'toolUsed', 'n', g, 'pad', repeat('x', $3::int))
       FROM generate_series(1, $2::int) g ORDER BY g`,
    [SID, SSE_HISTORY_TAIL + 100, PAD],
  );
});
after(async () => {
  await app?.close();
  await h?.close();
});

/** Opens the stream, reads nothing for `pauseMs`, then reads until the server ends it or `limitMs` passes. */
function read(pauseMs: number, limitMs: number): Promise<{ ended: boolean; events: number; marker: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/v1/chat/sessions/${SID}/messages` }, (res) => {
      let text = "";
      let events = 0;
      let marker: Record<string, unknown> | null = null;
      const finish = (ended: boolean): void => { clearTimeout(timer); res.destroy(); resolve({ ended, events, marker }); };
      const timer = setTimeout(() => finish(false), limitMs);
      res.setEncoding("utf8");
      res.pause();
      setTimeout(() => res.resume(), pauseMs);
      res.on("data", (chunk: string) => {
        text += chunk;
        const frames = text.split("\n\n");
        text = frames.pop() ?? "";
        for (const frame of frames) {
          if (/^id: /m.test(frame)) events++;
          const m = /^event: historyComplete\ndata: (.*)$/m.exec(frame);
          if (m) marker = JSON.parse(m[1]) as Record<string, unknown>;
        }
      });
      res.on("end", () => finish(true));
    });
    req.on("error", reject);
  });
}

test("a long session's tail, an exact number of pages, ends with historyComplete and goes on to the live part", { timeout: 60_000 }, async () => {
  assert.equal(SSE_HISTORY_TAIL % HISTORY_PAGE_ROWS, 0, "the case that hung: the tail fills its last page");
  const got = await read(500, 30_000);
  assert.equal(got.events, SSE_HISTORY_TAIL);
  assert.deepEqual(got.marker, { type: "historyComplete", count: SSE_HISTORY_TAIL, has_more: true },
    "the marker comes after the last page (it never did)");
  // No NATS here: the live part ends at once, and the server closes the stream. A route stuck after the history never does.
  assert.equal(got.ended, true, "the route went on past the history to the live part");
});
