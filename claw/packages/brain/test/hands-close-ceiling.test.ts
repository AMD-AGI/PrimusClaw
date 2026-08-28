// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Closing a hands transport has to come back.
//
// close() runs from the run's finally block, against a sandbox that may already
// be gone, over a transport with no deadline of its own. Unbounded, it holds the
// run's slot open and eats into the SIGTERM grace window -- the same hazard
// withHandsTimeout exists for on the callTool side, which is why the ceiling is
// here rather than at each call site.
//
// Its own file because the ceiling is read at module load, and the test runner
// gives each file a process.

import test from "node:test";
import assert from "node:assert/strict";

process.env.HANDS_CLOSE_TIMEOUT_MS = "40";
const { HandsClient } = await import("../src/clients/hands.js");

/** A client wired to a transport whose close() behaves as `close` says. */
function clientWith(close: () => Promise<void>) {
  const c = new HandsClient("http://hands.test", "token");
  (c as unknown as { connected: boolean }).connected = true;
  (c as unknown as { client: { close: () => Promise<void> } }).client = { close };
  return c;
}

test("a transport that never closes does not hold the caller", async () => {
  const c = clientWith(() => new Promise<void>(() => {}));

  const started = Date.now();
  await c.close();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2_000, `close must return on the ceiling, took ${elapsed}ms`);
});

test("a transport that refuses to close is not an error the caller handles", async () => {
  // Nothing downstream acts on a failed close, and the run it belongs to is
  // already over: rejecting here would turn cleanup into a second failure.
  const c = clientWith(() => Promise.reject(new Error("ECONNRESET")));
  await c.close();
});

test("a client that timed out closing does not wait again", async () => {
  // The flag is cleared before the await, so the state a timeout leaves behind is
  // "not connected" rather than "still connected": a second close returns at
  // once, and nothing goes on using the transport.
  let calls = 0;
  const c = clientWith(() => { calls++; return new Promise<void>(() => {}); });

  await c.close();
  const started = Date.now();
  await c.close();

  assert.equal(calls, 1, "the second close must not reach the transport");
  assert.ok(Date.now() - started < 20, "and must not wait out the ceiling again");
});

test("an ordinary close still awaits the transport", async () => {
  // The ceiling is a backstop, not a replacement: a transport that closes
  // promptly is still waited for, so the common path releases the connection
  // before the process moves on.
  let closed = false;
  const c = clientWith(async () => { closed = true; });

  await c.close();

  assert.equal(closed, true);
});
