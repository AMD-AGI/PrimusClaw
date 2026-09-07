// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The states `parkHandsAfterRun` must refuse, and the shape it writes when it
 * does not.
 *
 * Each refusal is a live sandbox if it is got wrong: parking a handle that is
 * still provisioning, or one a newer sandbox has taken over, stops the fleet
 * pinging a pod that is in use, and re-stamping a handle that is already idle
 * extends the life of the pod the park exists to reclaim. A refusal has to
 * leave the entry untouched to do that, so these assert on the write itself
 * and not only on the returned outcome.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  parkHandsAfterRun,
  applyRunEndedIdleFields,
  type RevisionedKv,
} from "../src/sandbox/park-hands.js";

const SESSION = "sess-park";
const KEY = `hands.${SESSION}`;
const REVISION = 7;

const READY = {
  status: "ready",
  provider: "safe-workload",
  workloadId: "wl-1",
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

interface Recorded {
  kv: RevisionedKv;
  writes: Array<{ value: Record<string, unknown>; revision: number }>;
}

function kvHolding(entry: Record<string, unknown> | null, revision = REVISION): Recorded {
  const writes: Recorded["writes"] = [];
  return {
    writes,
    kv: {
      async get(key: string) {
        assert.equal(key, KEY, "the handle is addressed by session id");
        if (!entry) return null;
        return { value: new TextEncoder().encode(JSON.stringify(entry)), revision };
      },
      async update(_key: string, value: Uint8Array, rev: number) {
        writes.push({
          value: JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>,
          revision: rev,
        });
        return rev + 1;
      },
    },
  };
}

test("a handle that is not ready belongs to an in-flight ensureHands", async () => {
  const { kv, writes } = kvHolding({ ...READY, status: "pending" });
  const result = await parkHandsAfterRun(kv, SESSION, "wl-1");

  assert.deepEqual(result, { outcome: "skipped", reason: "not_ready" });
  assert.equal(writes.length, 0, "a pending handle's own writer must win, not this one");
});

test("a handle already idle keeps the reuse window it is already running", async () => {
  const { kv, writes } = kvHolding({ ...READY, keepalive: false });
  const result = await parkHandsAfterRun(kv, SESSION, "wl-1");

  assert.deepEqual(result, { outcome: "skipped", reason: "already_idle" });
  assert.equal(
    writes.length, 0,
    "re-stamping idleSince would extend the life of the pod this exists to reclaim",
  );
});

test("a handle naming a different workload has been taken over by a newer sandbox", async () => {
  const { kv, writes } = kvHolding({ ...READY, workloadId: "wl-2" });
  const result = await parkHandsAfterRun(kv, SESSION, "wl-1");

  assert.deepEqual(result, { outcome: "skipped", reason: "other_sandbox" });
  assert.equal(writes.length, 0, "parking it would stop the fleet pinging a pod in use");
});

test("a workload id neither side can name is nothing to disagree with", async () => {
  for (const [expect, held] of [[null, "wl-2"], ["wl-1", ""]] as const) {
    const { kv, writes } = kvHolding({ ...READY, workloadId: held });
    const result = await parkHandsAfterRun(kv, SESSION, expect);

    assert.equal(result.outcome, "parked", `expect=${expect} held=${held}`);
    assert.equal(writes.length, 1);
  }
});

test("parking opens a new idle period in the one shape the sweep understands", async () => {
  const { kv, writes } = kvHolding({ ...READY });
  const result = await parkHandsAfterRun(kv, SESSION, "wl-1");

  assert.deepEqual(result, { outcome: "parked" });
  assert.equal(writes.length, 1);
  const [write] = writes;
  assert.equal(write.revision, REVISION, "the write is conditioned on the revision it read");

  const written = write.value;
  assert.equal(written.keepalive, false, "what the sweep selects on");
  assert.equal(
    written.idleEpoch, written.idleSince,
    "the period is named by the stamp the reuse window is measured from",
  );
  assert.equal(
    written.idleRev, REVISION,
    "the half two periods cannot share is the revision, not a clock reading",
  );
  assert.ok((written.idleSince as number) > (READY.idleSince as number), "a new period, not the old one");

  for (const stale of ["bgCheckedAt", "bgRunning", "bgEpoch", "bgIdleSince", "bgIdleRev", "bgRev", "workSeenAt"]) {
    assert.ok(
      !(stale in written),
      `${stale} is last period's verdict; republishing it speaks for this one`,
    );
  }

  assert.equal(written.token, READY.token, "the session is alive and may be reused");
  assert.equal(written.handsUrl, READY.handsUrl, "the background-work probe needs it");

  const viaHelper: Record<string, unknown> = { ...READY };
  applyRunEndedIdleFields(viaHelper, written.idleSince as number, REVISION);
  assert.deepEqual(written, viaHelper, "both writers must leave the entry in one shape");
});

test("a handle nobody wrote is not a handle to park", async () => {
  const { kv, writes } = kvHolding(null);
  assert.deepEqual(await parkHandsAfterRun(kv, SESSION, "wl-1"), { outcome: "gone" });
  assert.equal(writes.length, 0);
});

test("unreadable ownership data is not evidence that no sandbox is referenced", async () => {
  const writes: Recorded["writes"] = [];
  const kv: RevisionedKv = {
    async get() {
      return { value: new TextEncoder().encode("{not json"), revision: REVISION };
    },
    async update(_k, _v, rev) {
      writes.push({ value: {}, revision: rev });
      return rev + 1;
    },
  };
  assert.deepEqual(
    await parkHandsAfterRun(kv, SESSION, "wl-1"),
    { outcome: "skipped", reason: "unreadable" },
  );
  assert.equal(writes.length, 0, "leave it for operator repair and the bucket's TTL");
});
