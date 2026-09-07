// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What markHandsIdle does when it cannot do its job, and what it says it did.
 *
 * It runs at every task's terminal state to park the sandbox handle for reuse.
 * The handle matters beyond reuse though: the idle sweeper walks `hands.*` to
 * find a session's GPU clusters, so losing the entry loses the only clue for
 * reclaiming them. That makes the error branches the interesting part —
 * deleting the entry on a transient KV blip would turn a hiccup into a leaked
 * cluster, while an entry nobody can parse is worth dropping because every
 * consumer skips it anyway.
 *
 * Every branch's returned outcome is pinned beside its side effect, because
 * that outcome is the only thing separating a park from a refusal at the call
 * site: `keepalive.stopped_after_task` reports `parked` from it, and a branch
 * that wrote nothing while reporting success is how a handle nobody parks gets
 * pinged by the whole fleet until the workload's absolute deadline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { isRevisionConflict } from "@claw/utils";
import { parkHandsAfterRun, type RevisionedKv } from "@claw/protocol";
import { markHandsIdle } from "../src/sandbox/keepalive.js";

const sc = StringCodec();

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

  const result = await markHandsIdle(kv, SID, "w1");

  assert.deepEqual(result, { outcome: "parked" });
  assert.deepEqual(
    calls.updated,
    [{ key: KEY, revision: REVISION }],
    "conditioned on the revision just read, so a concurrent delete makes it fail",
  );
  assert.deepEqual(calls.deleted, []);
});

test("a read failure never authorizes deleting an unknown owner", async () => {
  const { kv, calls } = stubKv({ getError: new Error("TIMEOUT") });

  const result = await markHandsIdle(kv, SID, "w1");

  assert.equal(result.outcome, "failed", "a blip is not a park, and must not be logged as one");
  assert.deepEqual(calls.deleted, []);
});

test("a failed conditional write preserves the latest owner", async () => {
  const { kv, calls } = stubKv({
    entry: { status: "ready", workloadId: "w1" },
    updateError: new Error("CONNECTION_CLOSED"),
  });

  const result = await markHandsIdle(kv, SID, "w1");

  assert.equal(result.outcome, "failed");
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

  const result = await markHandsIdle(kv, SID, "w1");

  assert.equal(result.outcome, "superseded", "the winner parked it; this caller did not");
  assert.deepEqual(calls.deleted, []);
});

test("an unparseable entry is preserved because it may name a live sandbox", async () => {
  const { kv, calls } = stubKv({ raw: "{ not json" });

  const result = await markHandsIdle(kv, SID, "w1");

  assert.deepEqual(result, { outcome: "skipped", reason: "unreadable" });
  assert.deepEqual(calls.deleted, []);
  assert.deepEqual(calls.updated, []);
});

test("a handle for a different workload is left untouched", async () => {
  // The task ran on w1 but the entry now points at w2: somebody rebuilt the
  // sandbox, and parking it as idle would misrepresent what is running.
  const { kv, calls } = stubKv({ entry: { status: "ready", workloadId: "w2" } });

  const result = await markHandsIdle(kv, SID, "w1");

  assert.deepEqual(result, { outcome: "skipped", reason: "other_sandbox" });
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

  const result = await markHandsIdle(kv, SID, {
    provider: "agent-sandbox",
    sessionId: "agent-session",
    sandboxName: "sandbox-a",
    namespace: "ns",
  });

  assert.deepEqual(result, { outcome: "skipped", reason: "other_sandbox" });
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

  const result = await markHandsIdle(kv, SID, "w1");

  assert.deepEqual(result, { outcome: "skipped", reason: "not_ready" });
  assert.deepEqual(calls.updated, []);
  assert.deepEqual(calls.deleted, []);
});

test("a handle nobody wrote is reported gone, not parked", async () => {
  const { kv, calls } = stubKv({});

  const result = await markHandsIdle(kv, SID, "w1");

  assert.deepEqual(result, { outcome: "gone" }, "a fresh task will recreate one");
  assert.deepEqual(calls.updated, []);
});

test("both writers of an idle period leave the handle in one shape", async () => {
  // The reason the field-setting is shared code at all: the sweep reclaims on
  // these fields and the background-work verdict is matched to a period by
  // them, so if Brain's park and the API's reaper disagree about any one of
  // them, the fleet acts on a verdict from a period that has already ended.
  const HELD = {
    status: "ready",
    provider: "safe-workload",
    workloadId: "w1",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    keepalive: true,
    idleSince: 111,
    idleEpoch: 111,
    idleRev: 2,
    bgCheckedAt: 900,
    bgRunning: true,
    bgEpoch: 111,
    bgIdleSince: 111,
    bgIdleRev: 2,
    bgRev: 3,
    workSeenAt: 950,
  };

  const written: Record<string, Record<string, unknown>> = {};
  const capturingKv = (into: string) => ({
    async get(key: string) {
      return { key, value: sc.encode(JSON.stringify(HELD)), revision: REVISION };
    },
    async update(_key: string, value: Uint8Array, _revision: number) {
      written[into] = JSON.parse(sc.decode(value)) as Record<string, unknown>;
      return REVISION + 1;
    },
  });

  assert.deepEqual(
    await markHandsIdle(capturingKv("brain") as unknown as KV, SID, "w1"),
    { outcome: "parked" },
  );
  assert.deepEqual(
    await parkHandsAfterRun(capturingKv("api") as unknown as RevisionedKv, SID, "w1"),
    { outcome: "parked" },
  );

  for (const [who, entry] of Object.entries(written)) {
    assert.equal(entry.idleEpoch, entry.idleSince, `${who}: the period is named by its stamp`);
    // The one field that legitimately differs between two writers is the clock
    // reading, so it is pinned to a constant before the shapes are compared.
    entry.idleSince = 0;
    entry.idleEpoch = 0;
  }
  assert.deepEqual(written.brain, written.api, "a divergence here is a divergence in the sweep");
  assert.equal(written.brain.idleRev, REVISION);
  assert.equal(written.brain.keepalive, false);
  assert.ok(!("bgRunning" in written.brain), "last period's verdict does not speak for this one");
});
