// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The readiness wait reads a workload's status every second for the first 20s
// and then backs off to the old 5s grid. What is pinned: the schedule itself; that a
// sandbox ready a few seconds after its create is seen within a second of it,
// where a 5s reader saw it up to 5s late; that a long wait costs the platform
// about what it did before; and that reading faster does not give up on a
// workload the platform answers 404 for sooner than the 5s reader did.
//
// Driven with the real schedule (no `pollMs`), a fake clock and a fetch whose
// answer depends on that clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPollGapMs, waitForWorkloadReady } from "../src/sandbox/workload-wait.js";
import { SandboxProvisionTerminalError } from "../src/sandbox/errors.js";

function clockedWait(answer: (nowMs: number) => { status: number; phase?: string }, extra: { pollMs?: number } = {}) {
  let nowMs = 0;
  const reads: number[] = [];
  const fetchImpl = (async () => {
    reads.push(nowMs);
    const a = answer(nowMs);
    return { ok: a.status < 400, status: a.status, json: async () => (a.phase ? { phase: a.phase } : {}) };
  }) as unknown as typeof fetch;
  const done = waitForWorkloadReady({
    workloadId: "wl-1",
    apiKey: "k",
    isReady: (d) => String(d.phase).toLowerCase() === "running",
    logPrefix: "test",
    deps: {
      fetchImpl,
      sleepImpl: async (ms) => { nowMs += ms; },
      nowImpl: () => nowMs,
      ...(extra.pollMs ? { pollMs: extra.pollMs } : {}),
      pendingTimeoutMs: 0,
      startTimeoutMs: 0,
      unreadableTimeoutMs: 0,
    },
  });
  return { done, reads, now: () => nowMs };
}

test("the schedule: every second for the first 20s, then the old 5s grid", () => {
  const reads: number[] = [];
  let t = 0;
  while (t < 60_000) {
    t += nextPollGapMs(t);
    reads.push(t);
  }
  assert.deepEqual(reads.slice(0, 20), Array.from({ length: 20 }, (_, i) => (i + 1) * 1000));
  assert.deepEqual(reads.slice(20, 24), [25_000, 30_000, 35_000, 40_000], "every read of the 5s reader, and no others");
  // A read that took a while lands the next one back on the grid, never sooner than a second later.
  assert.equal(nextPollGapMs(20_030), 4_970);
  assert.equal(nextPollGapMs(24_600), 1_000);
});

test("no readiness time is seen later than the 5s reader saw it", async () => {
  for (let readyAt = 0; readyAt <= 90_000; readyAt += 700) {
    const answer = (now: number) => ({ status: 200, phase: now >= readyAt ? "Running" : "Pending" });
    const fast = clockedWait(answer);
    await fast.done;
    const old = clockedWait(answer, { pollMs: 5000 });
    await old.done;
    assert.ok(fast.now() <= old.now(), `ready at ${readyAt}ms: seen at ${fast.now()}ms against ${old.now()}ms`);
  }
});

test("a sandbox ready 6.2s after its create is seen at 7s, where a 5s reader saw it at 10s", async () => {
  const readyAt = 6_200;
  const answer = (now: number) => ({ status: 200, phase: now >= readyAt ? "Running" : "NotReady" });

  const fast = clockedWait(answer);
  await fast.done;
  assert.equal(fast.now(), 7_000);

  const old = clockedWait(answer, { pollMs: 5000 });
  await old.done;
  assert.equal(old.now(), 10_000);
});

test("over a 3-minute wait the platform is read about as often as before, the extra reads all in the first 20s", async () => {
  const readyAt = 180_000;
  const answer = (now: number) => ({ status: 200, phase: now >= readyAt ? "Running" : "Pending" });
  const fast = clockedWait(answer);
  await fast.done;
  const old = clockedWait(answer, { pollMs: 5000 });
  await old.done;
  assert.equal(old.reads.length, 36);
  assert.ok(fast.reads.length <= old.reads.length + 20, `${fast.reads.length} reads against ${old.reads.length}`);
  const afterWindow = fast.reads.filter((t) => t > 30_000);
  const gaps = afterWindow.slice(1).map((t, i) => t - afterWindow[i]!);
  assert.ok(gaps.every((g) => g === 5000), "past the start the gap is the old one");
});

test("a workload that answers 404 is given up as gone no sooner than the 5s reader gave it up", async () => {
  const gone = async (w: ReturnType<typeof clockedWait>) => {
    const err = await w.done.then(() => null, (e: unknown) => e);
    assert.ok(err instanceof SandboxProvisionTerminalError);
    assert.equal((err as SandboxProvisionTerminalError).reason, "sandbox_gone");
    return w.now();
  };
  const old = await gone(clockedWait(() => ({ status: 404 }), { pollMs: 5000 }));
  const fast = await gone(clockedWait(() => ({ status: 404 })));
  assert.equal(old, 60_000, "twelve reads, 5s apart");
  assert.ok(fast >= old - 5_000, `the fast reader gave up at ${fast}ms`);
  assert.ok(fast <= old, `and not later than ${old}ms either (${fast}ms)`);
});

test("a 404 streak the platform recovers from is not counted across the recovery", async () => {
  // Twelve quick 404s, then the workload shows up: the fast reader must not have
  // given up on it during those twelve seconds.
  const w = clockedWait((now) => (now <= 12_000 ? { status: 404 } : { status: 200, phase: now >= 14_000 ? "Running" : "Pending" }));
  await w.done;
  assert.equal(w.now(), 14_000);
});
