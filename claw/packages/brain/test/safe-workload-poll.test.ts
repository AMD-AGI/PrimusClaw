// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// SaFE provisioning poll loop + terminal-reason classifier.
//
// The poll loop carries three interacting counters with different reset rules
// (consecutiveNotFound, lastReadableMs, lastPendingNotifyTime); a single missed
// reset is exactly how the "refresh before json()" hole slipped in. These
// table tests pin the contract with a scripted fetch sequence and a fake clock
// (no real waiting), driven through the injectable-deps seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../src/sandbox/safe-workload-provider.js";
import { classifyWorkloadTerminalReason } from "../src/sandbox/errors.js";

const { pollWorkloadUntilRunning } = __test__;

// ── scripted fetch + fake clock ──────────────────────────────────────────────

type Entry =
  | { status: number; body?: Record<string, unknown> }
  | { status: number; badJson: true }
  | { throw: string };

/** Returns responses from `entries` in order; the last entry repeats so a test
 *  can express a "persistent" condition (e.g. a stuck 401) with one entry. */
function scriptedFetch(entries: Entry[]) {
  let i = 0;
  const fn = async (_url: string, _opts?: unknown) => {
    const e = entries[Math.min(i, entries.length - 1)];
    i++;
    if ("throw" in e) throw new Error(e.throw);
    const ok = e.status < 400;
    if ("badJson" in e) {
      return { ok, status: e.status, json: async () => { throw new Error("Unexpected token < in JSON"); } };
    }
    return { ok, status: e.status, json: async () => e.body ?? {} };
  };
  return fn as unknown as typeof fetch;
}

function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => { nowMs += ms; },
    get value() { return nowMs; },
  };
}

async function runPoll(entries: Entry[], opts: { unreadableTimeoutMs?: number; pendingTimeoutMs?: number } = {}) {
  const events: Array<Record<string, unknown>> = [];
  const clock = fakeClock();
  const p = pollWorkloadUntilRunning(
    "wl-1",
    "key",
    async (e) => { events.push(e); },
    {
      fetchImpl: scriptedFetch(entries),
      sleepImpl: clock.sleep,
      nowImpl: clock.now,
      pollMs: 5000,
      unreadableTimeoutMs: opts.unreadableTimeoutMs ?? 30_000,
      // Off by default so the existing cases exercise only the behaviour they name.
      pendingTimeoutMs: opts.pendingTimeoutMs ?? 0,
    },
  );
  return { p, events, clock };
}

const failed = (events: Array<Record<string, unknown>>) =>
  events.find((e) => e.type === "sandboxStatus" && (e.status === "failed" || e.status === "stopped"));

// ── poll loop ────────────────────────────────────────────────────────────────

test("a healthy 2xx Pending waits past the deadline and resolves on Running", async () => {
  // 20 Pending polls span 100s, far beyond the 30s unreadable deadline. Each
  // readable poll refreshes the deadline, so a queued workload is never bounded.
  const entries: Entry[] = [];
  for (let k = 0; k < 20; k++) entries.push({ status: 200, body: { phase: "Pending", queuePosition: 1 } });
  entries.push({ status: 200, body: { phase: "Running" } });

  const { p, events, clock } = await runPoll(entries, { unreadableTimeoutMs: 30_000 });
  await p; // must not throw
  assert.ok(clock.value > 30_000, "the wait must have exceeded the deadline without tripping it");
  assert.ok(events.some((e) => e.status === "running"), "a Running status must be emitted");
  assert.equal(failed(events), undefined, "a healthy Pending wait must never emit a terminal event");
});

test("a readable Pending between error bursts refreshes the deadline", async () => {
  // The reverse of the unreadable-deadline tests, pinning fdfecb2b: a single
  // readable poll in the middle resets lastReadableMs, so neither burst of 500s
  // (each shorter than the deadline) may trip it. Without the refresh the second
  // burst would cross the deadline measured from the start.
  const entries: Entry[] = [
    { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
    { status: 200, body: { phase: "Pending", queuePosition: 1 } },
    { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
    { status: 200, body: { phase: "Running" } },
  ];
  const { p, events } = await runPoll(entries, { unreadableTimeoutMs: 27_000 });
  await p; // must resolve on Running, never trip sandbox_status_unreadable
  assert.equal(failed(events), undefined);
  assert.ok(events.some((e) => e.status === "running"));
});

test("auth codes (401/403) do NOT fail fast — they ride the unreadable backstop", async () => {
  // A flaky auth backend can momentarily answer 401/403, so a single sample must
  // not be terminal; auth codes accumulate toward the deadline like any non-2xx.
  for (const status of [401, 403]) {
    const { p, clock } = await runPoll([{ status }], { unreadableTimeoutMs: 30_000 });
    await assert.rejects(p, (err: any) => {
      assert.equal(err.reason, "sandbox_status_unreadable", `HTTP ${status} must not fail fast`);
      return true;
    });
    assert.ok(clock.value > 30_000, `HTTP ${status} must only terminate after the deadline`);
  }
});

test("a persistent 2xx with an unparseable body trips the unreadable deadline", async () => {
  const { p, clock } = await runPoll([{ status: 200, badJson: true }], { unreadableTimeoutMs: 30_000 });
  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_status_unreadable");
    return true;
  });
  assert.ok(clock.value > 30_000, "the body was 2xx but never readable, so the backstop must fire");
});

test("a persistent 2xx with an empty phase trips the unreadable deadline", async () => {
  const { p } = await runPoll([{ status: 200, body: { queuePosition: 0 } }], { unreadableTimeoutMs: 30_000 });
  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_status_unreadable");
    return true;
  });
});

test("twelve consecutive 404s report the workload as gone", async () => {
  // Backstop disabled to isolate the gone path from the unreadable deadline.
  const { p, clock } = await runPoll([{ status: 404 }], { unreadableTimeoutMs: 0 });
  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_gone");
    return true;
  });
  assert.equal(clock.value, 12 * 5_000, "gone must fire only after the 12th consecutive 404");
});

test("alternating 404/500 never false-positives sandbox_gone", async () => {
  const entries: Entry[] = [];
  for (let k = 0; k < 20; k++) { entries.push({ status: 404 }); entries.push({ status: 500 }); }
  entries.push({ status: 200, body: { phase: "Running" } });

  // Backstop disabled so only gone (the bug) or Running can end the loop.
  const { p, events } = await runPoll(entries, { unreadableTimeoutMs: 0 });
  await p; // must resolve on Running, never throw sandbox_gone
  assert.ok(events.some((e) => e.status === "running"));
});

test("a workload stuck Pending past the ceiling times out", async () => {
  // Healthy readable Pending forever, but bounded by the pending ceiling: the
  // message fails terminally (sandbox_pending_timeout) rather than waiting on.
  const { p, clock } = await runPoll(
    [{ status: 200, body: { phase: "Pending", queuePosition: 3 } }],
    { unreadableTimeoutMs: 0, pendingTimeoutMs: 30_000 },
  );
  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_pending_timeout");
    return true;
  });
  assert.ok(clock.value > 30_000, "the ceiling must fire only after the pending deadline");
});

test("leaving Pending stops the pending clock (dispatched work is not killed)", async () => {
  // The ceiling counts queue time only. Once the workload is dispatched (any
  // non-Pending phase, e.g. NotReady while pulling a large image), the clock
  // stops — even a long provisioning stretch well past the ceiling must not fire
  // sandbox_pending_timeout, because from dispatch on SaFE's own timeout governs.
  const entries: Entry[] = [
    { status: 200, body: { phase: "Pending", queuePosition: 1 } },
  ];
  for (let k = 0; k < 12; k++) entries.push({ status: 200, body: { phase: "NotReady" } });
  entries.push({ status: 200, body: { phase: "Running" } });

  const { p, events, clock } = await runPoll(entries, { unreadableTimeoutMs: 0, pendingTimeoutMs: 15_000 });
  await p; // must resolve on Running, never trip the pending ceiling
  assert.ok(clock.value > 15_000, "the NotReady stretch must exceed the ceiling to prove the clock stopped");
  assert.equal(failed(events), undefined);
  assert.ok(events.some((e) => e.status === "running"));
});

test("with both ceilings on, a readable Pending fires pending, not unreadable", async () => {
  // Priority when both timeouts are active AND the unreadable one is the shorter:
  // every readable Pending poll refreshes the unreadable clock, so it must never
  // trip; the queue ceiling is the one that fires. Guards against mislabeling a
  // genuinely-queued workload as sandbox_status_unreadable.
  const { p } = await runPoll(
    [{ status: 200, body: { phase: "Pending", queuePosition: 1 } }],
    { unreadableTimeoutMs: 15_000, pendingTimeoutMs: 30_000 },
  );
  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_pending_timeout");
    return true;
  });
});

test("reaching Running before the ceiling succeeds", async () => {
  // Boundary: a workload that becomes Running while still under the queue ceiling
  // must resolve normally, not be caught by the timeout.
  const entries: Entry[] = [
    { status: 200, body: { phase: "Pending", queuePosition: 2 } },
    { status: 200, body: { phase: "Pending", queuePosition: 1 } },
    { status: 200, body: { phase: "Running" } },
  ];
  const { p, events, clock } = await runPoll(entries, { unreadableTimeoutMs: 0, pendingTimeoutMs: 30_000 });
  await p; // must resolve, not throw
  assert.ok(clock.value < 30_000, "Running must arrive before the ceiling for this to be a boundary case");
  assert.equal(failed(events), undefined);
  assert.ok(events.some((e) => e.status === "running"));
});

test("a pod that exits before ready is terminal", async () => {
  const { p } = await runPoll([{ status: 200, body: { phase: "Pending", pods: [{ phase: "Failed" }] } }]);
  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_exited_before_ready");
    return true;
  });
});

test("a Stopped-by-timeout phase is terminal, reported as stopped/timed-out", async () => {
  const { p, events } = await runPoll([{
    status: 200,
    body: { phase: "Stopped", conditions: [{ type: "AdminStopped", message: "the workload has timed out" }] },
  }]);
  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_timed_out");
    return true;
  });
  const evt = failed(events);
  assert.equal(evt?.status, "stopped", "a stop must not be flattened into a crash");
  assert.equal(evt?.reason, "sandbox_timed_out");
});

test("a Failed phase is terminal, reported as failed", async () => {
  const { p, events } = await runPoll([{
    status: 200,
    body: { phase: "Failed", conditions: [{ type: "AdminFailed", message: "container crashed" }] },
  }]);
  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_workload_terminal");
    return true;
  });
  assert.equal(failed(events)?.status, "failed");
});

// ── classifyWorkloadTerminalReason ───────────────────────────────────────────

test("timeout is read from the terminal condition", () => {
  assert.equal(
    classifyWorkloadTerminalReason({ conditions: [{ type: "AdminStopped", message: "the workload has timed out" }] }),
    "sandbox_timed_out",
  );
});

test("a non-timeout terminal condition is a generic terminal failure", () => {
  assert.equal(
    classifyWorkloadTerminalReason({ conditions: [{ type: "AdminFailed", message: "container crashed" }] }),
    "sandbox_workload_terminal",
  );
});

test("a stale top-level queue message is NOT mistaken for a resource shortage", () => {
  // The trap 55d8b0da closes: SaFE's top-level Status.Message keeps the queue
  // reason after the workload ran and failed. Without a terminal condition we
  // fall back to it, but it must never resurrect a resource_unavailable label.
  assert.equal(
    classifyWorkloadTerminalReason({ message: "In queue - insufficient resources", conditions: [] }),
    "sandbox_workload_terminal",
  );
});

test("the terminal condition wins over a stale top-level queue message", () => {
  assert.equal(
    classifyWorkloadTerminalReason({
      message: "In queue - insufficient resources",
      conditions: [{ type: "AdminStopped", message: "the workload has timed out" }],
    }),
    "sandbox_timed_out",
  );
});
