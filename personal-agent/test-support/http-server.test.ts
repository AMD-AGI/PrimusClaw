// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { FakeHttpServer, sseText } from "./index.js";

test("a route answers JSON, and the request is recorded as read", async (t) => {
  const server = await FakeHttpServer.start([
    { method: "POST", path: "/api/items", handle: (r) => ({ status: 201, json: { got: r.json } }) },
  ]);
  t.after(() => server.close());
  const res = await fetch(`${server.url}/api/items?x=1`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claw-client": "test" },
    body: JSON.stringify({ a: 1 }),
  });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { got: { a: 1 } });
  const [req] = server.requests;
  assert.ok(req);
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/items");
  assert.equal(req.url, "/api/items?x=1");
  assert.equal(req.query.get("x"), "1");
  assert.equal(req.headers["x-claw-client"], "test");
  assert.equal(req.body, '{"a":1}');
});

test("text replies, regex routes, routes added later, and 404 for the unmatched", async (t) => {
  const server = await FakeHttpServer.start();
  t.after(() => server.close());
  server.route("GET", /^\/items\/\d+$/, () => ({ status: 200, text: "one", headers: { "x-n": "1" } }));
  server.route("GET", "/empty", () => ({ status: 204 }));
  server.route("GET", "/boom", () => {
    throw new TypeError("secret");
  });
  const one = await fetch(`${server.url}/items/7`);
  assert.equal(await one.text(), "one");
  assert.equal(one.headers.get("x-n"), "1");
  assert.equal((await fetch(`${server.url}/empty`)).status, 204);
  const boom = await fetch(`${server.url}/boom`);
  assert.equal(boom.status, 500);
  assert.equal(await boom.text(), "TypeError");
  const missing = await fetch(`${server.url}/items/x`, { method: "GET" });
  assert.equal(missing.status, 404);
  assert.deepEqual(
    server.unmatched.map((r) => r.path),
    ["/items/x"],
  );
  const notJson = await fetch(`${server.url}/items/8`, { method: "GET" });
  await notJson.text();
  const last = server.requests.at(-1);
  assert.ok(last);
  assert.equal(last.json, undefined);
});

test("a body that is not JSON is kept as text with no json", async (t) => {
  const server = await FakeHttpServer.start([{ method: "PUT", path: "/x", handle: () => ({ status: 200 }) }]);
  t.after(() => server.close());
  await (await fetch(`${server.url}/x`, { method: "PUT", body: "not json" })).text();
  const [req] = server.requests;
  assert.ok(req);
  assert.equal(req.body, "not json");
  assert.equal(req.json, undefined);
});

test("an SSE route streams its frames in the wire format", async (t) => {
  function* frames() {
    yield { event: "message", data: '{"a":1}', id: "1" };
    yield { data: "line one\nline two" };
  }
  const server = await FakeHttpServer.start([{ method: "GET", path: "/stream", handle: () => ({ sse: frames() }) }]);
  t.after(() => server.close());
  const res = await fetch(`${server.url}/stream`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(await res.text(), 'id: 1\nevent: message\ndata: {"a":1}\n\ndata: line one\ndata: line two\n\n');
  assert.equal(sseText({ data: "" }), "data: \n\n");
});
