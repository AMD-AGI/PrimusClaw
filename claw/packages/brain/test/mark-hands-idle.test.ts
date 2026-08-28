// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What markHandsIdle does when it cannot do its job.
 *
 * It runs at every task's terminal state to park the sandbox handle for reuse.
 * The handle matters beyond reuse though: the idle sweeper walks `hands.*` to
 * find a session's GPU clusters, so losing the entry loses the only clue for
 * reclaiming them. That makes the error branches the interesting part —
 * deleting the entry on a transient KV blip would turn a hiccup into a leaked
 * cluster, while an entry nobody can parse is worth dropping because every
 * consumer skips it anyway.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { isRevisionConflict } from "@claw/utils";
import { markHandsIdle } from "../src/sandbox/keepalive.js";

const sc = StringCodec();

/** markHandsIdle is fire-and-forget, so let its promise chain settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

interface StubCalls {
  deleted: string[];
  /** Key plus the revision the write was conditioned on. */
  updated: Array<{ key: string; revision: number }>;
  put: string[];
}

/** The revision the stubbed get() reports, so a CAS write can be checked. */
const REVISION = 7;

function stubKv(opts: {
  entry?: unknown;
  raw?: string;
  getError?: Error;
  updateError?: Error;
}): { kv: KV; calls: StubCalls } {
  const calls: StubCalls = { deleted: [], updated: [], put: [] };
  const kv = {
    async get(key: string) {
      if (opts.getError) throw opts.getError;
      if (opts.raw !== undefined) return { key, value: sc.encode(opts.raw), revision: REVISION };
      if (opts.entry === undefined) return null;
      return { key, value: sc.encode(JSON.stringify(opts.entry)), revision: REVISION };
    },
    // Records the revision too: without it, an assertion about the write being
    // conditioned on the revision just read would pass even for `put`-like
    // behaviour that ignores it.
    async update(key: string, _value: Uint8Array, revision: number) {
      if (opts.updateError) throw opts.updateError;
      calls.updated.push({ key, revision });
      return REVISION + 1;
    },
    async put(key: string) {
      calls.put.push(key);
      return 8;
    },
    async delete(key: string) {
      calls.deleted.push(key);
    },
  } as unknown as KV;
  return { kv, calls };
}

const SID = "sess-idle-1";
const KEY = `hands.${SID}`;

test("a READY handle is parked with a revision-conditioned write", async () => {
  const { kv, calls } = stubKv({ entry: { status: "ready", workloadId: "w1" } });

  markHandsIdle(kv, SID, "w1");
  await settle();

  assert.deepEqual(
    calls.updated,
    [{ key: KEY, revision: REVISION }],
    "conditioned on the revision just read, so a concurrent delete makes it fail",
  );
  assert.deepEqual(calls.deleted, []);
});

test("a read failure never authorizes deleting an unknown owner", async () => {
  const { kv, calls } = stubKv({ getError: new Error("TIMEOUT") });

  markHandsIdle(kv, SID, "w1");
  await settle();

  assert.deepEqual(calls.deleted, []);
});

test("a failed conditional write preserves the latest owner", async () => {
  const { kv, calls } = stubKv({
    entry: { status: "ready", workloadId: "w1" },
    updateError: new Error("CONNECTION_CLOSED"),
  });

  markHandsIdle(kv, SID, "w1");
  await settle();

  assert.deepEqual(calls.deleted, []);
});

test("losing the write race leaves whatever the winner wrote", async () => {
  // A concurrent session teardown deleted or rewrote the entry. Deleting here
  // would remove an entry somebody else just wrote.
  const conflict = Object.assign(new Error("wrong last sequence: 7"), {
    api_error: { err_code: 10071 },
  });
  const { kv, calls } = stubKv({
    entry: { status: "ready", workloadId: "w1" },
    updateError: conflict,
  });

  markHandsIdle(kv, SID, "w1");
  await settle();

  assert.deepEqual(calls.deleted, []);
});

test("an unparseable entry is preserved because it may name a live sandbox", async () => {
  const { kv, calls } = stubKv({ raw: "{ not json" });

  markHandsIdle(kv, SID, "w1");
  await settle();

  assert.deepEqual(calls.deleted, []);
  assert.deepEqual(calls.updated, []);
});

test("a handle for a different workload is left untouched", async () => {
  // The task ran on w1 but the entry now points at w2: somebody rebuilt the
  // sandbox, and parking it as idle would misrepresent what is running.
  const { kv, calls } = stubKv({ entry: { status: "ready", workloadId: "w2" } });

  markHandsIdle(kv, SID, "w1");
  await settle();

  assert.deepEqual(calls.updated, []);
  assert.deepEqual(calls.deleted, []);
});

test("agent-sandbox idle marking compares its full identity", async () => {
  const { kv, calls } = stubKv({
    entry: {
      status: "ready",
      provider: "agent-sandbox",
      sessionId: "agent-session",
      sandboxName: "sandbox-b",
      namespace: "ns",
    },
  });

  markHandsIdle(kv, SID, {
    provider: "agent-sandbox",
    sessionId: "agent-session",
    sandboxName: "sandbox-a",
    namespace: "ns",
  });
  await settle();

  assert.deepEqual(calls.updated, []);
  assert.deepEqual(calls.deleted, []);
});

test("a lost write race is recognised as one, not as a KV error", () => {
  // Two callers depend on this distinction, and both do something harmful if it
  // regresses: markHandsIdle above would delete an entry the winner just wrote,
  // and parkForIdleReclaim would report normal contention between replicas as a
  // failure. So the shape JetStream reports is pinned here rather than left to
  // whatever the client library happens to surface.
  // Deliberately carries only the code, with a message that would not match:
  // an error with both would still pass on the text fallback alone, so it could
  // not tell whether the code path still works.
  const codeOnly = Object.assign(new Error("10071"), { api_error: { err_code: 10071 } });
  assert.equal(isRevisionConflict(codeOnly), true, "recognised by err_code");
  // And text-only, for transports that surface nothing else.
  assert.equal(isRevisionConflict(new Error("wrong last sequence: 7")), true);

  for (const other of [new Error("TIMEOUT"), new Error("CONNECTION_CLOSED"), null, undefined]) {
    assert.equal(isRevisionConflict(other), false, `err=${other}`);
  }
});

test("a pending handle is not parked", async () => {
  const { kv, calls } = stubKv({ entry: { status: "pending", workloadId: "w1" } });

  markHandsIdle(kv, SID, "w1");
  await settle();

  assert.deepEqual(calls.updated, []);
  assert.deepEqual(calls.deleted, []);
});
