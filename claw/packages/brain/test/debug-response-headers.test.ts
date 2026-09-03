// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Capturing upstream response headers is opt-in, allowlisted, and only ever
 * describes the attempt that actually served the turn.
 *
 * Each of those three is load-bearing. Off by default, because most
 * deployments do not need it and a log field nobody reads is a field that
 * eventually holds something nobody meant to write. Allowlisted rather than
 * "capture the response headers", because response headers carry credentials
 * -- echoed authorization, set-cookie -- and this value is logged; naming what
 * you want is the difference between a diagnostic and a leak. And successful
 * attempts only, because a 429 from one backend followed by a 200 from another
 * would otherwise leave the failed hop's identity attached to the turn the
 * other one served, which inverts the exact question this exists to answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { wrapFetchCaptureRoutedModel, type RoutedModelSink } from "../src/llm/routed-model.js";

function res(status: number, headers: Record<string, string>): Response {
  return new Response("{}", { status, headers });
}

/** A fetch that replays the given responses in order. */
function fetchReplaying(...responses: Response[]): typeof fetch {
  let i = 0;
  return (async () => responses[i++]) as typeof fetch;
}

test("nothing is captured when no header is allowlisted", async () => {
  const sink: RoutedModelSink = {};
  const f = wrapFetchCaptureRoutedModel(
    sink,
    fetchReplaying(res(200, { "x-ms-region": "westus", "authorization": "Bearer secret" })),
    [],
  );
  await f("https://example.invalid");
  assert.equal(sink.headers, undefined, "an empty allowlist must capture nothing at all");
});

test("only allowlisted headers are captured, whatever else came back", async () => {
  const sink: RoutedModelSink = {};
  const f = wrapFetchCaptureRoutedModel(
    sink,
    fetchReplaying(res(200, {
      "x-upstream-id": "backend-7",
      "authorization": "Bearer secret",
      "set-cookie": "session=secret",
    })),
    ["x-upstream-id"],
  );
  await f("https://example.invalid");
  assert.deepEqual(sink.headers, { "x-upstream-id": "backend-7" });
});

test("a header that was asked for and not sent is absent, not empty", async () => {
  const sink: RoutedModelSink = {};
  const f = wrapFetchCaptureRoutedModel(
    sink,
    fetchReplaying(res(200, { "x-upstream-id": "backend-7" })),
    ["x-upstream-id", "x-not-sent"],
  );
  await f("https://example.invalid");
  assert.deepEqual(
    sink.headers,
    { "x-upstream-id": "backend-7" },
    "an absent header must not appear as empty; 'the gateway does not send this' and "
      + "'the gateway sent nothing' are different answers",
  );
});

test("a failed attempt does not leave its identity on the turn a later one served", async () => {
  const sink: RoutedModelSink = {};
  const f = wrapFetchCaptureRoutedModel(
    sink,
    fetchReplaying(
      res(429, { "x-upstream-id": "overloaded-backend" }),
      res(200, { "x-upstream-id": "backend-that-answered" }),
    ),
    ["x-upstream-id"],
  );
  await f("https://example.invalid");
  assert.equal(sink.headers, undefined, "a non-ok attempt must not write the sink");
  await f("https://example.invalid");
  assert.deepEqual(sink.headers, { "x-upstream-id": "backend-that-answered" });
});
