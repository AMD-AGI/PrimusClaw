// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's access log (`buildServer`'s `accessLog`): one line per request with its method, the route as declared, the
 * status and the duration, so "no traffic" and "inbound broken" can be told apart; never the path as sent, its query or
 * its body, where a token can ride.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { lineLogger } from "../../src/line-logger.js";
import { healthzRoute } from "../../src/http/link.js";
import { json, type HttpRoute } from "../../src/http/routes.js";
import { buildServer, listen, UNMATCHED_ROUTE } from "../../src/http/server.js";

const events: HttpRoute = {
  method: "POST",
  path: "/claw-events/:route",
  handle: (request) => Promise.resolve(json(request.params["route"] === "tok-SECRET-A" ? 202 : 404, {})),
};
const broken: HttpRoute = { method: "GET", path: "/broken", handle: () => Promise.reject(new Error("boom")) };

async function serve(accessLog: RecordingLogger | ReturnType<typeof lineLogger>) {
  const app = buildServer({
    routes: [healthzRoute, events, broken],
    maxBodyBytes: 1024,
    accessLog,
    quietRoutes: [healthzRoute.path],
  });
  const port = await listen(app, "127.0.0.1", 0);
  return { app, base: `http://127.0.0.1:${String(port)}` };
}

test("one line per request: method, declared route, status and duration; no token of the path, query or body", async () => {
  const logger = new RecordingLogger();
  const { app, base } = await serve(logger);
  try {
    const statuses = [
      (await fetch(`${base}/claw-events/tok-SECRET-A?token=SECRET-B`, { method: "POST", body: '{"key":"SECRET-C"}' }))
        .status,
      (await fetch(`${base}/healthz`)).status,
      (await fetch(`${base}/nowhere/SECRET-D?code=SECRET-E`)).status,
      (await fetch(`${base}/broken`)).status,
      (await fetch(`${base}/claw-events/x`, { method: "POST", body: "x".repeat(2048) })).status,
    ];
    assert.deepEqual(statuses, [202, 200, 404, 500, 413]);
  } finally {
    await app.close();
  }
  const lines = logger.lines.filter((l) => l.message === "http request");
  assert.deepEqual(
    lines.map((l) => [l.level, l.fields["method"], l.fields["route"], l.fields["status"]]),
    [
      ["info", "POST", "/claw-events/:route", 202],
      ["debug", "GET", "/healthz", 200],
      ["info", "GET", UNMATCHED_ROUTE, 404],
      ["info", "GET", "/broken", 500],
      ["info", "POST", "/claw-events/:route", 413],
    ],
  );
  for (const line of lines) {
    const ms = line.fields["ms"];
    assert.ok(typeof ms === "number" && Number.isInteger(ms) && ms >= 0, String(ms));
  }
  assert.doesNotMatch(logger.dump(), /SECRET/);
});

test("the line as the worker writes it carries the fields and no token", async () => {
  const written: string[] = [];
  const { app, base } = await serve(lineLogger({ level: "info", now: () => 0, write: (l) => written.push(l) }));
  try {
    await fetch(`${base}/claw-events/tok-SECRET-A?access_token=SECRET-B`, { method: "POST", body: "{}" });
    await fetch(`${base}/healthz`);
  } finally {
    await app.close();
  }
  assert.equal(written.length, 1, written.join("\n")); // (the probe is at debug, below the level)
  assert.match(written[0] ?? "", /^\S+ INFO http request method=POST route=\/claw-events\/:route status=202 ms=\d+$/);
  assert.doesNotMatch(written.join("\n"), /SECRET/);
});
