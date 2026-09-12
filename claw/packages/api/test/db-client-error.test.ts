// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A connection that drops while a caller holds the client must not take the
 * process with it.
 *
 * The pools' own 'error' handlers cover a client while it is idle IN the pool.
 * A checked-out client emits on itself, and a client with no 'error' listener is
 * the one case where node's EventEmitter rethrows -- which is a process exit,
 * not a failed query. Four API replicas were restarting every few hours on
 * exactly that:
 *
 *   Error: Connection terminated unexpectedly
 *       at Client._handleErrorEvent (pg/lib/client.js:422)
 *   throw er; // Unhandled 'error' event
 *
 * Every long hold is exposed: `withLeaderLock` keeps a client for a whole scan
 * and `withTransaction` for a whole transaction, so the window is the length of
 * the work rather than of a query.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

process.env.SAFE_API_URL = "http://safe.test";
const { db } = await import("../src/infra/db.js");

/** A client as the pool hands one out: an emitter that can answer a query. */
function fakeClient(): EventEmitter & { query: () => Promise<unknown> } {
  const client = new EventEmitter() as EventEmitter & { query: () => Promise<unknown> };
  client.query = async () => ({ rows: [] });
  return client;
}

for (const [name, pool] of [
  ["pool", db.pool],
  ["lockPool", db.lockPool],
] as const) {
  test(`${name}: a client that drops while checked out is logged, not thrown`, () => {
    const client = fakeClient();
    // What the pool does when it opens a new connection. Every client a caller
    // can hold has been through this.
    (pool as unknown as EventEmitter).emit("connect", client);

    assert.doesNotThrow(
      () => client.emit("error", new Error("Connection terminated unexpectedly")),
      "an unhandled 'error' on a checked-out client ends the process, not the query",
    );
  });

  test(`${name}: the listener is attached on connect, not on first failure`, () => {
    const client = fakeClient();
    (pool as unknown as EventEmitter).emit("connect", client);
    assert.ok(
      client.listenerCount("error") > 0,
      "a client with no 'error' listener is one dropped connection from a restart",
    );
  });
}
