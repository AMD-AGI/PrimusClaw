// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A sandbox that cannot start has to be told to the user early and ended early.
//
// Before this, an admitted workload whose pod no node would take read as an
// ordinary slow start: the user saw "Waiting in queue (position 0)" once and then
// nothing for the whole of the start ceiling (15 minutes), and the model, handed a
// bare "did not become ready", opened another sandbox and waited it out again.
//
// Driven through the wait loop's seams with a scripted SaFE (the workload detail
// the platform returns, one body per read) and a clock the test moves itself, so
// each rule about elapsed time is a statement about the clock, not a wait. One
// test goes through `create` in real time because it is the only way to see the
// workload being stopped.

import test from "node:test";
import assert from "node:assert/strict";

process.env.SAFE_API_URL = "http://safe.test";
// Read when the config module loads; the create-path test below waits it out in real time.
process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS = "1";
const { waitForWorkloadReady } = await import("../src/sandbox/workload-wait.js");
const { readWaitingState, cleanPlatformText, describeWaiting } = await import("../src/sandbox/workload-stall.js");
const {
  SandboxProvisionTerminalError, SANDBOX_UNAVAILABLE_REASONS, sandboxUnavailableOf,
} = await import("../src/sandbox/errors.js");
const { __test__, SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");

type Body = Record<string, unknown>;

// ── the platform's account of a workload, in the states under test ───────────

/** In SaFE's own queue: not admitted, the scheduler says why. */
const queued = (position: number, message = "In queue - insufficient resources, no cpu available"): Body =>
  ({ phase: "Pending", queuePosition: position, message });
/** Admitted (position 0, message cleared) with a pod that nothing has taken. */
const untaken = (message = ""): Body =>
  ({ phase: "Pending", queuePosition: 0, message, pods: [{ podId: "sb-1-abc", phase: "Pending" }] });
/** The same pod once a node's kubelet has acknowledged it: pulling its image. */
const taken: Body = {
  phase: "Pending", queuePosition: 0,
  pods: [{
    podId: "sb-1-abc", phase: "Pending", adminNodeName: "node-1", hostIP: "10.0.0.5",
    startTime: "2026-11-03T04:00:00",
  }],
};
/** The same, in the phase a sandbox object reports while it is not ready. */
const takenNotReady: Body = { ...taken, phase: "NotReady" };
const running: Body = { phase: "Running" };
const repeat = (n: number, b: Body): Body[] => Array.from({ length: n }, () => b);

function scriptedFetch(bodies: Body[]) {
  let i = 0;
  return (async () => {
    const body = bodies[Math.min(i, bodies.length - 1)]!;
    i++;
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
}

function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      // A wait that ignores every rule it is tested for would spin here forever.
      if (nowMs > 100_000_000) throw new Error("wait did not end within 100000s of fake time");
      nowMs += ms;
    },
    get value() { return nowMs; },
  };
}

const isRunning = (d: Body) => String(d.phase ?? "").toLowerCase() === "running";

type Progress = { phase: string; queuePosition: number; waiting?: { kind: string; reason: string }; at: number };

/** Runs the shared loop to its end and reports everything it told the caller. */
async function run(bodies: Body[], o: {
  unschedulableTimeoutMs?: number;
  pendingTimeoutMs?: number;
  startTimeoutMs?: number;
}) {
  const clock = fakeClock();
  const progress: Progress[] = [];
  const terminal: Array<{ phase: string; status: string; reason: string; message?: string }> = [];
  const gaveUp: Array<{ reason: string; phase: string }> = [];
  let ended: string | null = null;
  try {
    await waitForWorkloadReady({
      workloadId: "wl-1", apiKey: "key", logPrefix: "test", isReady: isRunning,
      unschedulableTimeoutMs: o.unschedulableTimeoutMs,
      onProgress: async (p) => { progress.push({ ...p, at: clock.now() } as Progress); },
      onTerminal: async (t) => { terminal.push(t); },
      onGiveUp: async (g) => { gaveUp.push(g); },
      deps: {
        fetchImpl: scriptedFetch(bodies), sleepImpl: clock.sleep, nowImpl: clock.now, pollMs: 5000,
        unreadableTimeoutMs: 0, pendingTimeoutMs: o.pendingTimeoutMs ?? 0, startTimeoutMs: o.startTimeoutMs ?? 0,
      },
    });
  } catch (e) {
    assert.ok(e instanceof SandboxProvisionTerminalError, `unexpected error: ${String(e)}`);
    ended = e.reason;
  }
  return { ended, progress, terminal, gaveUp, clock };
}

// ── reading the state ────────────────────────────────────────────────────────

test("queued: the scheduler's own reason is the reason", () => {
  assert.deepEqual(readWaitingState(queued(3)), {
    kind: "queued", reason: "In queue - insufficient resources, no cpu available",
  });
});

test("admitted with the pod untaken is unscheduled, whichever phase the platform gives it", () => {
  for (const phase of ["Pending", "NotReady"]) {
    const w = readWaitingState({ phase, queuePosition: 0, pods: [{ podId: "p1", phase: "Pending" }] });
    assert.equal(w?.kind, "unscheduled", phase);
    assert.match(w!.reason, /pod p1 has not been started on any node/);
  }
  // No pod yet at all reads the same, in different words.
  assert.match(readWaitingState({ phase: "Pending" })!.reason, /no node has taken its pod/);
});

test("a message the platform gave wins over our wording", () => {
  const w = readWaitingState(untaken("waiting for scale-up - 0/3 nodes are available: 3 node(s) were unschedulable"));
  assert.equal(w?.reason, "waiting for scale-up - 0/3 nodes are available: 3 node(s) were unschedulable");
});

test("a pod that has only been bound to a node is still untaken", () => {
  // The pod that will not start: the scheduler named a node and the node never answered.
  const w = readWaitingState({ phase: "Pending", pods: [{ podId: "p", phase: "Pending", adminNodeName: "node-9" }] });
  assert.equal(w?.kind, "unscheduled");
});

test("any sign a node took the pod means it is starting, not waiting", () => {
  const signs: Array<Record<string, unknown>> = [
    { hostIP: "10.0.0.5" }, { podIP: "10.1.1.1" }, { startTime: "2026-11-03T04:00:00" },
    { containers: [{ name: "main" }] }, { phase: "Running" },
  ];
  for (const sign of signs) {
    const w = readWaitingState({ phase: "Pending", pods: [{ podId: "p", phase: "Pending", ...sign }] });
    assert.equal(w, null, JSON.stringify(sign));
  }
  assert.equal(readWaitingState(taken), null);
});

test("phases it does not know to be waiting are not read as waiting", () => {
  for (const phase of ["Running", "Failed", "Stopped", "Updating", ""]) {
    assert.equal(readWaitingState({ phase, queuePosition: 0 }), null, phase);
  }
});

test("platform text reaches the user as one bounded line", () => {
  assert.equal(cleanPlatformText("a\n\tb\u0000c   d"), "a b c d");
  const long = cleanPlatformText("x".repeat(1000));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith("…"));
  const w = readWaitingState(untaken(`bad\nreason ${"y".repeat(500)}`));
  assert.ok(!w!.reason.includes("\n") && w!.reason.length <= 300);
});

test("the progress sentence names the platform's reason for either kind", () => {
  assert.equal(
    describeWaiting({ kind: "queued", reason: "In queue - insufficient resources" }, 4),
    "Waiting in queue (position 4): In queue - insufficient resources",
  );
  assert.equal(
    describeWaiting({ kind: "unscheduled", reason: "0/3 nodes are available" }, 0),
    "Sandbox is waiting for the platform to schedule it: 0/3 nodes are available",
  );
});

// ── the wait loop ────────────────────────────────────────────────────────────

test("an admitted workload no node takes ends as sandbox_unschedulable at the limit", { timeout: 5000 }, async () => {
  const r = await run([untaken()], { unschedulableTimeoutMs: 180_000 });
  assert.equal(r.ended, "sandbox_unschedulable");
  // The first read (5s) starts the clock; the first read more than 180s later ends it.
  assert.equal(r.clock.value, 190_000);
  assert.deepEqual(r.gaveUp, [{ reason: "sandbox_unschedulable", phase: "pending" }]);
  assert.equal(r.terminal.length, 1);
  assert.equal(r.terminal[0]!.reason, "sandbox_unschedulable");
  assert.equal(r.terminal[0]!.status, "failed");
  assert.match(r.terminal[0]!.message!, /could not be scheduled: the pod sb-1-abc has not been started on any node/);
});

test("the error carries the platform's reason", { timeout: 5000 }, async () => {
  const why = "0/3 nodes are available: 3 node(s) were unschedulable";
  const r = await run([untaken(why)], { unschedulableTimeoutMs: 60_000 });
  assert.equal(r.ended, "sandbox_unschedulable");
  assert.ok(r.terminal[0]!.message!.includes(why), r.terminal[0]!.message);
});

test("the user is told when the wait begins, once, and with the reason", { timeout: 5000 }, async () => {
  const why = "0/3 nodes are available: 3 node(s) were unschedulable";
  const r = await run([untaken(why)], { unschedulableTimeoutMs: 180_000 });
  // Dozens of reads happen before it gives up; the same reason is not repeated.
  assert.equal(r.progress.length, 1);
  assert.deepEqual(r.progress[0]!.waiting, { kind: "unscheduled", reason: why });
});

test("a queued workload is told its reason at once, and a move up the queue is announced", { timeout: 5000 }, async () => {
  const bodies = [...repeat(60, queued(3)), ...repeat(60, queued(2)), ...repeat(60, queued(1)), running];
  const r = await run(bodies, { unschedulableTimeoutMs: 180_000 });
  assert.equal(r.ended, null);
  assert.deepEqual(
    r.progress.map((p) => [p.queuePosition, p.waiting?.kind, p.waiting?.reason]),
    [3, 2, 1].map((n) => [n, "queued", "In queue - insufficient resources, no cpu available"]),
  );
});

test("a reason that changes is announced again, paced rather than on every read", { timeout: 5000 }, async () => {
  const bodies = [...repeat(3, untaken("reason A")), ...repeat(20, untaken("reason B")), running];
  const r = await run(bodies, {});
  assert.deepEqual(r.progress.map((p) => p.waiting?.reason), ["reason A", "reason B"]);
  // B first appears at 20s but A was announced at 5s: B waits out the 30s pace.
  assert.deepEqual(r.progress.map((p) => p.at), [5_000, 35_000]);
});

test("a reason that flaps cannot flood the stream", { timeout: 5000 }, async () => {
  // 500s of the platform alternating between two messages every read.
  const flapping: Body[] = [];
  for (let k = 0; k < 100; k++) flapping.push(untaken(k % 2 ? "reason B" : "reason A"));
  flapping.push(running);
  const r = await run(flapping, {});
  assert.ok(r.progress.length >= 10, `announced ${r.progress.length} times`);
  assert.ok(r.progress.length <= 17, `announced ${r.progress.length} times in 500s, against a 30s pace`);
});

test("a queue is never given the short limit, however long it takes", { timeout: 5000 }, async () => {
  // Two hours in the platform's queue behind others, then it runs.
  const r = await run([...repeat(1440, queued(1)), running], { unschedulableTimeoutMs: 180_000 });
  assert.equal(r.ended, null);
  assert.ok(r.clock.value > 7_000_000);
});

test("the clock starts at admission, not in the queue", { timeout: 5000 }, async () => {
  // 200s queued, then 150s admitted and untaken: neither alone, nor together, is a stall.
  const ok = await run([...repeat(40, queued(1)), ...repeat(30, untaken()), running], { unschedulableTimeoutMs: 180_000 });
  assert.equal(ok.ended, null);
  // Left untaken, it ends 180s after admission (first untaken read at 205s), not after 180s of waiting.
  const stalled = await run([...repeat(40, queued(1)), untaken()], { unschedulableTimeoutMs: 180_000 });
  assert.equal(stalled.ended, "sandbox_unschedulable");
  assert.equal(stalled.clock.value, 390_000);
});

test("only an unbroken absence of progress counts: a pod being taken clears the clock", { timeout: 5000 }, async () => {
  // 150s untaken, 100s taken, 150s untaken: 400s in all and never 180s in a row.
  const broken = [...repeat(30, untaken()), ...repeat(20, taken), ...repeat(30, untaken()), running];
  assert.equal((await run(broken, { unschedulableTimeoutMs: 180_000 })).ended, null);
  // The same without the break is a stall, so the break is what saved it.
  const unbroken = [...repeat(30, untaken()), ...repeat(30, untaken()), running];
  assert.equal((await run(unbroken, { unschedulableTimeoutMs: 180_000 })).ended, "sandbox_unschedulable");
});

test("a sandbox that is starting keeps the long limit, not the short one", { timeout: 5000 }, async () => {
  // A pod a node took and is still pulling for ten minutes: far past the short limit.
  for (const pulling of [taken, takenNotReady]) {
    const slow = await run([...repeat(120, pulling), running], { unschedulableTimeoutMs: 60_000, startTimeoutMs: 900_000 });
    assert.equal(slow.ended, null, String(pulling.phase));
    assert.ok(slow.clock.value >= 600_000);
  }
  // And one that never comes up still ends on its own ceiling, under its own name.
  const never = await run([takenNotReady], { unschedulableTimeoutMs: 60_000, startTimeoutMs: 600_000 });
  assert.equal(never.ended, "sandbox_start_timeout");
  assert.ok(!never.progress.some((p) => p.waiting), "a starting sandbox is not announced as waiting");
});

test("absent or zero, the short limit is off and an admitted workload waits as it always did", { timeout: 5000 }, async () => {
  for (const limit of [undefined, 0]) {
    const r = await run([...repeat(2000, untaken()), running], { unschedulableTimeoutMs: limit });
    assert.equal(r.ended, null, String(limit));
  }
});

test("the long ceilings still apply to what the short limit does not cover", { timeout: 5000 }, async () => {
  // Queued past the Pending ceiling still ends as sandbox_pending_timeout.
  const r = await run([queued(2)], { unschedulableTimeoutMs: 60_000, pendingTimeoutMs: 600_000 });
  assert.equal(r.ended, "sandbox_pending_timeout");
});

// ── what the sandbox's consumers are sent ────────────────────────────────────

async function poll(bodies: Body[], unschedulableTimeoutMs?: number) {
  const events: Array<Record<string, unknown>> = [];
  const clock = fakeClock();
  let ended: string | null = null;
  try {
    await __test__.pollWorkloadUntilRunning("wl-1", "key", async (e) => { events.push(e); }, {
      fetchImpl: scriptedFetch(bodies), sleepImpl: clock.sleep, nowImpl: clock.now, pollMs: 5000,
      unreadableTimeoutMs: 0, pendingTimeoutMs: 0, startTimeoutMs: 0,
    }, "hands", { unschedulableTimeoutMs });
  } catch (e) {
    ended = (e as InstanceType<typeof SandboxProvisionTerminalError>).reason;
  }
  return { events, ended };
}

test("a queued sandbox's progress event says the position and the platform's reason", { timeout: 5000 }, async () => {
  const { events } = await poll([queued(3), running]);
  const progress = events.find((e) => e.status === "pending");
  assert.ok(progress, JSON.stringify(events));
  assert.equal(progress.type, "sandboxStatus");
  assert.equal(progress.event, "phase");
  assert.equal(progress.queuePosition, 3);
  assert.equal(progress.log, "Waiting in queue (position 3): In queue - insufficient resources, no cpu available");
  assert.equal(progress.waiting, "queued");
  assert.equal(progress.waitReason, "In queue - insufficient resources, no cpu available");
});

test("an unschedulable sandbox says so when it starts waiting, then ends with the reason as an event", { timeout: 5000 }, async () => {
  const why = "0/3 nodes are available: 3 node(s) were unschedulable";
  const { events, ended } = await poll([untaken(why)], 60_000);
  assert.equal(ended, "sandbox_unschedulable");
  const progress = events.find((e) => e.status === "pending");
  assert.equal(progress?.log, `Sandbox is waiting for the platform to schedule it: ${why}`);
  assert.equal(progress?.waiting, "unscheduled");
  const failed = events.find((e) => e.status === "failed");
  assert.equal(failed?.reason, "sandbox_unschedulable");
  assert.ok(String(failed?.message).includes(why), JSON.stringify(failed));
});

test("a sandbox that is simply starting is announced exactly as before", { timeout: 5000 }, async () => {
  const { events } = await poll([taken, running]);
  const progress = events.find((e) => e.status === "pending");
  assert.equal(progress?.log, "Waiting in queue (position 0)");
  assert.ok(!("waiting" in progress!) && !("waitReason" in progress!));
});

// ── what the failure does to the workload, through create ────────────────────

test("create ends an unschedulable sandbox with the reason and stops the workload it made", { timeout: 40_000 }, async (t) => {
  const calls: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (String(url).endsWith("/api/v1/workloads")) {
      return { ok: true, status: 200, json: async () => ({ workloadId: "wl-created" }) };
    }
    return { ok: true, status: 200, json: async () => untaken("0/3 nodes are available"), text: async () => "" };
  }) as unknown as typeof fetch;

  // SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS=1 (above) and the real 5s poll: the
  // first read starts the clock, the second trips it.
  const err = await new SafeWorkloadProvider().create({
    sessionId: "s1", namespace: "ns", image: "img:tag", resources: { cpu: "1" }, env: {}, platformKey: "key",
    onEvent: async (e) => { events.push(e); },
    // A backstop only: if the limit never fires this ends the wait (as a cancel)
    // so the test fails on the reason below rather than hanging the process.
    signal: AbortSignal.timeout(25_000),
  }).then(() => null, (e: unknown) => e);

  assert.ok(err instanceof SandboxProvisionTerminalError, String(err));
  assert.equal(err.reason, "sandbox_unschedulable");
  assert.ok(err.message.includes("0/3 nodes are available"), err.message);
  assert.ok(calls.includes("POST /api/v1/workloads/wl-created/stop"), `the workload is stopped: ${calls.join(", ")}`);
  assert.ok(events.some((e) => e.waiting === "unscheduled"), "the user was told it was waiting");
  assert.ok(events.some((e) => e.status === "failed" && e.reason === "sandbox_unschedulable"));
});

test("the setting reads in seconds, defaults to five minutes, and 0 turns it off", async () => {
  const load = async (value: string | undefined) => {
    const prior = process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS;
    if (value === undefined) delete process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS;
    else process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS = value;
    try {
      const m = await import(`../src/config.js?unschedulable=${value ?? "unset"}`);
      return m.SANDBOX_UNSCHEDULABLE_TIMEOUT_MS as number;
    } finally {
      if (prior === undefined) delete process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS;
      else process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS = prior;
    }
  };
  assert.equal(await load(undefined), 300_000);
  assert.equal(await load("90"), 90_000);
  assert.equal(await load("0"), 0);
});

// ── what ends a run's attempts to open a sandbox ─────────────────────────────

test("the endings that mean the platform has no sandbox are a closed, named set", () => {
  assert.deepEqual(
    [...SANDBOX_UNAVAILABLE_REASONS].sort(),
    ["sandbox_pending_timeout", "sandbox_start_timeout", "sandbox_unschedulable"],
  );
  for (const reason of SANDBOX_UNAVAILABLE_REASONS) {
    assert.equal(sandboxUnavailableOf(new SandboxProvisionTerminalError(reason, "m"))?.reason, reason);
  }
  // Provisioning endings that do not say waiting is what failed are not in it.
  for (const reason of ["sandbox_gone", "sandbox_exited_before_ready", "sandbox_status_unreadable", "sandbox_wait_interrupted"]) {
    assert.equal(sandboxUnavailableOf(new SandboxProvisionTerminalError(reason, "m")), null, reason);
  }
  assert.equal(sandboxUnavailableOf(new Error("sandbox_unschedulable")), null);
  assert.equal(sandboxUnavailableOf(null), null);
});

test("an open wrapped for the agent loop is still recognised", async () => {
  const { SandboxAttachError } = await import("../src/agent/attach-error.js");
  const cause = new SandboxProvisionTerminalError("sandbox_unschedulable", "m");
  assert.equal(sandboxUnavailableOf(new SandboxAttachError(cause)), cause);
});
