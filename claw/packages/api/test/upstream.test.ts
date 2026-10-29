// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `getUpstreamJson`: every way a dependency can answer, sorted into the four
 * failures a route answers differently -- and none of them carrying the
 * credential that was sent or the body that came back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { UPSTREAM_MAX_BODY_BYTES, UpstreamError, describeFetchFailure, getUpstreamJson, type UpstreamFailure } from "../src/shared/upstream.js";
import { closedPortUrl, sendJson, startFakeUpstream } from "./support/fake-upstream.js";

const SECRET = "Bearer vk-secret-value";

async function failureOf(url: string, timeoutMs?: number): Promise<{ failure: UpstreamFailure; error: UpstreamError }> {
  try {
    await getUpstreamJson(url, { authorization: SECRET }, timeoutMs);
  } catch (e) {
    assert.ok(e instanceof UpstreamError, `expected an UpstreamError, got ${String(e)}`);
    return { failure: e.failure, error: e };
  }
  assert.fail("expected the call to fail");
}

test("a 2xx JSON object is returned, and the request carried the headers and Accept", async () => {
  const up = await startFakeUpstream((_req, res) => sendJson(res, 200, { ok: [1, 2] }));
  try {
    assert.deepEqual(await getUpstreamJson(`${up.url}/x?y=1`, { authorization: SECRET }), { ok: [1, 2] });
    assert.equal(up.seen[0].method, "GET");
    assert.equal(up.seen[0].url, "/x?y=1");
    assert.equal(up.seen[0].headers.authorization, SECRET);
    assert.equal(up.seen[0].headers.accept, "application/json");
  } finally { await up.close(); }
});

test("401 and 403 are `rejected`, carrying the status", async () => {
  for (const status of [401, 403]) {
    const up = await startFakeUpstream((_req, res) => sendJson(res, status, { message: `echo ${SECRET}` }));
    try {
      const { failure } = await failureOf(up.url);
      assert.deepEqual(failure, { kind: "rejected", status });
    } finally { await up.close(); }
  }
});

test("any other non-2xx is `http`, carrying the status", async () => {
  for (const status of [400, 404, 429, 500, 502, 503]) {
    const up = await startFakeUpstream((_req, res) => sendJson(res, status, { message: "x" }));
    try {
      assert.deepEqual((await failureOf(up.url)).failure, { kind: "http", status });
    } finally { await up.close(); }
  }
});

test("a 2xx with no body at all is `bad_body`, not an unreadable stream", async () => {
  const up = await startFakeUpstream((_req, res) => { res.writeHead(204); res.end(); });
  try {
    assert.deepEqual((await failureOf(up.url)).failure, { kind: "bad_body" });
  } finally { await up.close(); }
});

test("a 2xx that is not a JSON object or array is `bad_body`", async () => {
  const bodies = ["", "<html>login</html>", "null", "42", '"text"', "{not json"];
  for (const body of bodies) {
    const up = await startFakeUpstream((_req, res) => { res.writeHead(200); res.end(body); });
    try {
      assert.deepEqual((await failureOf(up.url)).failure, { kind: "bad_body" }, `body ${JSON.stringify(body)}`);
    } finally { await up.close(); }
  }
});

test("a body over the size limit is `bad_body`, and one at the limit is read, chunked or with a Content-Length", async () => {
  const at = JSON.stringify({ pad: "x".repeat(UPSTREAM_MAX_BODY_BYTES - '{"pad":""}'.length) });
  assert.equal(Buffer.byteLength(at), UPSTREAM_MAX_BODY_BYTES);
  const over = JSON.stringify({ pad: "x".repeat(UPSTREAM_MAX_BODY_BYTES - '{"pad":""}'.length + 1) });
  for (const [body, ok] of [[at, true], [over, false]] as const) {
    for (const declared of [false, true]) {
      const up = await startFakeUpstream((_req, res) => {
        res.writeHead(200, declared ? { "content-length": String(Buffer.byteLength(body)) } : {});
        res.end(body);
      });
      try {
        if (ok) assert.equal(typeof (await getUpstreamJson(up.url, {})), "object", `at the limit, declared=${declared}`);
        else assert.deepEqual((await failureOf(up.url)).failure, { kind: "bad_body" }, `over the limit, declared=${declared}`);
      } finally { await up.close(); }
    }
  }
});

test("the limit is in bytes, not characters", async () => {
  // 2.1M two-byte characters: under the limit as a string length, over it as bytes.
  const body = JSON.stringify({ pad: "\u00e9".repeat(Math.ceil(UPSTREAM_MAX_BODY_BYTES / 2) + 100) });
  assert.ok(body.length < UPSTREAM_MAX_BODY_BYTES && Buffer.byteLength(body) > UPSTREAM_MAX_BODY_BYTES);
  const up = await startFakeUpstream((_req, res) => { res.writeHead(200); res.end(body); });
  try {
    assert.deepEqual((await failureOf(up.url)).failure, { kind: "bad_body" });
  } finally { await up.close(); }
});

test("a declared length over the limit is refused without waiting for the body", async () => {
  const up = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-length": String(UPSTREAM_MAX_BODY_BYTES + 1) });
    res.write("{"); // and never the rest: reading it would hang until the timeout
  });
  try {
    const started = Date.now();
    assert.deepEqual((await failureOf(up.url, 5_000)).failure, { kind: "bad_body" });
    assert.ok(Date.now() - started < 2_000, "refused on the header, not after the timeout");
  } finally { await up.close(); }
});

test("an endless chunked body is cut off at the limit, not buffered", async () => {
  // No Content-Length: only counting as the bytes arrive can stop this. The
  // server stops writing when the client goes away, so how much it managed to
  // send is how much the client was willing to take.
  const CHUNK = Buffer.alloc(64 * 1024, 0x78);
  const TOTAL = 512 * 1024 * 1024;
  let written = 0;
  let closed!: () => void;
  const gone = new Promise<void>((resolve) => { closed = resolve; });
  const up = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.on("close", closed);
    const pump = (): void => {
      while (written < TOTAL && !res.destroyed) {
        written += CHUNK.length;
        if (!res.write(CHUNK)) { res.once("drain", pump); return; }
      }
      if (!res.destroyed) res.end();
    };
    pump();
  });
  try {
    assert.deepEqual((await failureOf(up.url, 20_000)).failure, { kind: "bad_body" });
    // Released at once, not left open until the request timeout (20 s here, 10 s in production).
    let timer: NodeJS.Timeout | undefined;
    const released = await Promise.race([
      gone.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3_000); }),
    ]);
    clearTimeout(timer);
    assert.ok(released, "the connection was still open 3 s after the body was refused");
    // Socket buffers hold a few MiB on each side; nowhere near the 512 MiB on offer.
    assert.ok(written < 64 * 1024 * 1024, `the server was allowed to send ${written} bytes`);
  } finally { await up.close(); }
});

test("a refused connection is `unreachable` with the error code and no URL", async () => {
  const url = await closedPortUrl();
  const { failure, error } = await failureOf(url);
  assert.equal(failure.kind, "unreachable");
  assert.equal((failure as { detail: string }).detail, "ECONNREFUSED");
  assert.equal(JSON.stringify(failure).includes(url), false);
  assert.equal(error.message.includes(url), false);
});

test("a hung upstream is `unreachable: timeout` after the timeout, not never", async () => {
  const up = await startFakeUpstream(() => { /* never answers */ });
  try {
    const started = Date.now();
    const { failure } = await failureOf(up.url, 150);
    assert.deepEqual(failure, { kind: "unreachable", detail: "timeout" });
    assert.ok(Date.now() - started < 5_000);
  } finally { await up.close(); }
});

test("a body that stalls after the headers is `unreachable`, not a hang", async () => {
  const up = await startFakeUpstream((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"a":'); /* never ends */ });
  try {
    const { failure } = await failureOf(up.url, 150);
    assert.equal(failure.kind, "unreachable");
  } finally { await up.close(); }
});

test("no failure carries the credential or the upstream's body", async () => {
  const up = await startFakeUpstream((_req, res) => sendJson(res, 500, { message: `echo ${SECRET} and internal detail` }));
  try {
    const { failure, error } = await failureOf(up.url);
    const dump = JSON.stringify(failure) + error.message + String(error.stack);
    assert.equal(dump.includes("vk-secret-value"), false);
    assert.equal(dump.includes("internal detail"), false);
  } finally { await up.close(); }
});

test("describeFetchFailure names the class of failure and never echoes a message", () => {
  const timeout = new Error("The operation was aborted due to timeout http://internal.example/x");
  timeout.name = "TimeoutError";
  const abort = new Error("aborted http://internal.example/x");
  abort.name = "AbortError";
  const withCode = (code: unknown) => Object.assign(new Error("fetch failed http://internal.example/x"), { cause: { code } });
  const rows: [string, unknown, string][] = [
    ["timeout", timeout, "timeout"],
    ["abort", abort, "timeout"],
    ["a socket code", withCode("ECONNRESET"), "ECONNRESET"],
    ["a dns code", withCode("ENOTFOUND"), "ENOTFOUND"],
    ["a code with a newline and spaces is not trusted into a log line", withCode("bad code\nforged log line"), "network_error"],
    ["a lowercase code is not trusted", withCode("econnreset"), "network_error"],
    ["an over-long code is not trusted", withCode("A".repeat(41)), "network_error"],
    ["a non-string code", withCode(42), "network_error"],
    ["an error with no cause", new Error("x http://internal.example/x"), "network_error"],
    ["not an Error at all", "http://internal.example/x", "network_error"],
  ];
  for (const [name, err, want] of rows) {
    const got = describeFetchFailure(err);
    assert.equal(got, want, name);
    assert.equal(got.includes("internal.example"), false, name);
  }
});
