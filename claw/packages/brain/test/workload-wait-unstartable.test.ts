// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The wait for a sandbox workload must end for a sandbox that can never start,
// and must end when the user stops the run. It used to do neither: a dispatched
// workload whose pod could not start (an image that cannot be pulled) was waited
// on until the workload's own timeout, and the wait took no cancel signal, so the
// frontend's Stop left the session running. Driven through the shared loop's
// seams with a scripted status sequence and a clock the test moves itself.

import test from "node:test";
import assert from "node:assert/strict";

process.env.SAFE_API_URL = "http://safe.test";
// Read when the config module loads; the create-path ceiling test below waits it out in real time.
process.env.SANDBOX_START_TIMEOUT_SECONDS = "1";
const { waitForWorkloadReady } = await import("../src/sandbox/workload-wait.js");
const { SandboxProvisionTerminalError } = await import("../src/sandbox/errors.js");
const { __test__ } = await import("../src/sandbox/safe-workload-provider.js");

type Body = Record<string, unknown>;

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
      // A wait that ignores every rule it is tested for would spin here
      // forever, starving the test runner's own timer; fail it instead.
      if (nowMs > 10_000_000) throw new Error("wait did not end within 10000s of fake time");
      nowMs += ms;
    },
    get value() { return nowMs; },
  };
}

const isRunning = (d: Body) => String(d.phase ?? "").toLowerCase() === "running";

/** What the wait ended with: the reason, or null for a return. */
async function outcome(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    assert.ok(e instanceof SandboxProvisionTerminalError, `unexpected error: ${String(e)}`);
    return e.reason;
  }
}

function wait(bodies: Body[], extra: {
  signal?: AbortSignal;
  startTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onGiveUp?: (g: { reason: string; phase: string }) => Promise<void>;
  onTerminal?: (t: { reason: string; status: string }) => Promise<void>;
}) {
  const clock = fakeClock();
  const p = waitForWorkloadReady({
    workloadId: "wl-1",
    apiKey: "key",
    logPrefix: "test",
    isReady: isRunning,
    signal: extra.signal,
    onGiveUp: extra.onGiveUp,
    onTerminal: extra.onTerminal,
    deps: {
      fetchImpl: scriptedFetch(bodies),
      sleepImpl: extra.sleep ?? clock.sleep,
      nowImpl: clock.now,
      pollMs: 5000,
      unreadableTimeoutMs: 0,
      pendingTimeoutMs: 0,
      startTimeoutMs: extra.startTimeoutMs ?? 0,
    },
  });
  return { p, clock };
}

const pending = { phase: "Pending", queuePosition: 2 };
const notReady = { phase: "NotReady", pods: [{ phase: "Pending" }] };

test("an abort while the workload is queued ends the wait as interrupted and gives the workload up", { timeout: 5000 }, async () => {
  const ctl = new AbortController();
  const gaveUp: string[] = [];
  let polls = 0;
  const { p } = wait([pending], {
    signal: ctl.signal,
    // Aborts on the third poll; the wait must not run on to a fourth.
    sleep: async () => { if (++polls === 3) ctl.abort(); if (polls > 50) throw new Error("abort ignored"); },
    onGiveUp: async ({ reason }) => { gaveUp.push(reason); },
  });
  assert.equal(await outcome(p), "sandbox_wait_interrupted");
  assert.deepEqual(gaveUp, ["sandbox_wait_interrupted"]);
  assert.equal(polls, 3);
});

test("an abort while the workload is dispatched but NotReady ends the wait as interrupted", { timeout: 5000 }, async () => {
  const ctl = new AbortController();
  const gaveUp: Array<{ reason: string; phase: string }> = [];
  let polls = 0;
  const { p } = wait([notReady], {
    signal: ctl.signal,
    sleep: async () => { if (++polls === 4) ctl.abort(); if (polls > 50) throw new Error("abort ignored"); },
    onGiveUp: async (g) => { gaveUp.push(g); },
  });
  assert.equal(await outcome(p), "sandbox_wait_interrupted");
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0]!.reason, "sandbox_wait_interrupted");
});

test("an abort during the sleep between reads does not wait the sleep out", { timeout: 5000 }, async () => {
  const ctl = new AbortController();
  const gaveUp: string[] = [];
  // A sleep that never finishes on its own: only the abort can end the wait.
  const { p } = wait([notReady], {
    signal: ctl.signal,
    sleep: () => new Promise<void>(() => {}),
    onGiveUp: async ({ reason }) => { gaveUp.push(reason); },
  });
  setTimeout(() => ctl.abort(), 10);
  assert.equal(await outcome(p), "sandbox_wait_interrupted");
  assert.deepEqual(gaveUp, ["sandbox_wait_interrupted"]);
});

test("an already-aborted signal ends the wait before any read", { timeout: 5000 }, async () => {
  const ctl = new AbortController();
  ctl.abort();
  let fetched = 0;
  const clock = fakeClock();
  const p = waitForWorkloadReady({
    workloadId: "wl-1", apiKey: "k", logPrefix: "test", isReady: isRunning, signal: ctl.signal,
    deps: {
      fetchImpl: (async () => { fetched++; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch,
      sleepImpl: clock.sleep, nowImpl: clock.now, pollMs: 5000,
    },
  });
  assert.equal(await outcome(p), "sandbox_wait_interrupted");
  assert.equal(fetched, 0);
});

test("a workload dispatched but never ready ends as sandbox_start_timeout, not as a pending or unreadable timeout", { timeout: 5000 }, async () => {
  const gaveUp: Array<{ reason: string; phase: string }> = [];
  const terminal: Array<{ reason: string; status: string }> = [];
  const { p, clock } = wait([pending, pending, notReady], {
    startTimeoutMs: 600_000,
    onGiveUp: async (g) => { gaveUp.push(g); },
    onTerminal: async (t) => { terminal.push(t); },
  });
  assert.equal(await outcome(p), "sandbox_start_timeout");
  assert.deepEqual(gaveUp, [{ reason: "sandbox_start_timeout", phase: "notready" }]);
  assert.deepEqual(terminal, [{ phase: "notready", status: "failed", reason: "sandbox_start_timeout" }]);
  // Counted from the first dispatched read (the third), not from the queue.
  assert.ok(clock.value > 600_000 + 3 * 5000 - 1, `ended too early at ${clock.value}ms`);
  assert.ok(clock.value <= 600_000 + 5 * 5000, `ended too late at ${clock.value}ms`);
});

test("the start ceiling does not count queue time, and a fall back to Pending restarts it", { timeout: 5000 }, async () => {
  // 100 Pending polls (500s) first, then NotReady for 8 polls, back to Pending
  // for 20 polls, then NotReady again and Running: with a 60s ceiling the two
  // NotReady stretches are each under it only because Pending is not counted.
  const bodies: Body[] = [];
  for (let k = 0; k < 100; k++) bodies.push(pending);
  for (let k = 0; k < 8; k++) bodies.push(notReady);
  for (let k = 0; k < 20; k++) bodies.push(pending);
  for (let k = 0; k < 8; k++) bodies.push(notReady);
  bodies.push({ phase: "Running" });
  const { p } = wait(bodies, { startTimeoutMs: 60_000 });
  assert.equal(await outcome(p), null);
});

test("a healthy slow start is still waited on and returns the ready detail", { timeout: 5000 }, async () => {
  const bodies: Body[] = [];
  for (let k = 0; k < 20; k++) bodies.push(notReady); // 100s of image pull
  bodies.push({ phase: "Running", marker: "ready" });
  const { p, clock } = wait(bodies, { startTimeoutMs: 600_000 });
  const detail = (await p) as Body;
  assert.equal(detail.marker, "ready");
  assert.ok(clock.value >= 100_000);
});

test("with no abort and no start ceiling a long NotReady is still waited on (ceiling 0 disables it)", { timeout: 5000 }, async () => {
  const bodies: Body[] = [];
  for (let k = 0; k < 2000; k++) bodies.push(notReady);
  bodies.push({ phase: "Running" });
  const { p } = wait(bodies, { startTimeoutMs: 0 });
  assert.equal(await outcome(p), null);
});

test("the sandbox poll passes the run's signal and give-up hook through", { timeout: 5000 }, async () => {
  const ctl = new AbortController();
  const gaveUp: string[] = [];
  let polls = 0;
  const p = __test__.pollWorkloadUntilRunning("wl-1", "key", async () => {}, {
    fetchImpl: scriptedFetch([notReady]),
    sleepImpl: async () => { if (++polls === 2) ctl.abort(); if (polls > 50) throw new Error("abort ignored"); },
    nowImpl: () => 0,
    pollMs: 5000,
    startTimeoutMs: 0,
  }, "hands", { signal: ctl.signal, onGiveUp: async ({ reason }) => { gaveUp.push(reason); } });
  assert.equal(await outcome(p), "sandbox_wait_interrupted");
  assert.deepEqual(gaveUp, ["sandbox_wait_interrupted"]);
});

test("a cancelled create stops the workload it created, naming that workload", { timeout: 5000 }, async (t) => {
  const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (String(url).endsWith("/api/v1/workloads")) {
      return { ok: true, status: 200, json: async () => ({ workloadId: "wl-created" }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;

  const ctl = new AbortController();
  // Aborted once the workload exists, which is the first thing the caller hears of it.
  const created = new SafeWorkloadProvider().create({
    sessionId: "s1", namespace: "ns", image: "img:tag", resources: { cpu: "1" }, env: {},
    platformKey: "key", signal: ctl.signal,
    onProvisioned: async () => { ctl.abort(); },
  });
  assert.equal(await outcome(created), "sandbox_wait_interrupted");
  assert.ok(calls.includes("POST /api/v1/workloads/wl-created/stop"), `calls: ${calls.join(", ")}`);
});

test("a handover abort leaves the workload alone, in the wait and through create", { timeout: 5000 }, async (t) => {
  const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
  // The wait: isHandover true means onGiveUp is not run, but the abort still ends the wait.
  const gaveUp: string[] = [];
  const ctl2 = new AbortController();
  let polls2 = 0;
  const direct = waitForWorkloadReady({
    workloadId: "wl-1", apiKey: "k", logPrefix: "test", isReady: isRunning,
    signal: ctl2.signal, isHandover: () => true,
    onGiveUp: async ({ reason }) => { gaveUp.push(reason); },
    deps: {
      fetchImpl: scriptedFetch([notReady]),
      sleepImpl: async () => { if (++polls2 === 2) ctl2.abort(); if (polls2 > 50) throw new Error("abort ignored"); },
      nowImpl: () => 0, pollMs: 5000, startTimeoutMs: 0,
    },
  });
  assert.equal(await outcome(direct), "sandbox_wait_interrupted");
  assert.deepEqual(gaveUp, [], "a handover must not run the give-up hook");

  // Through create: no stop request.
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (String(url).endsWith("/api/v1/workloads")) {
      return { ok: true, status: 200, json: async () => ({ workloadId: "wl-created" }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;
  const ctl3 = new AbortController();
  const created = new SafeWorkloadProvider().create({
    sessionId: "s1", namespace: "ns", image: "img:tag", resources: { cpu: "1" }, env: {},
    platformKey: "key", signal: ctl3.signal, isHandover: () => true,
    onProvisioned: async () => { ctl3.abort(); },
  });
  assert.equal(await outcome(created), "sandbox_wait_interrupted");
  assert.ok(!calls.some((c) => c.endsWith("/stop")), `no stop on a handover: ${calls.join(", ")}`);
});

test("create does not stop the workload on sandbox_start_timeout: the failure path reaps it after reading its facts", { timeout: 30_000 }, async (t) => {
  const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (String(url).endsWith("/api/v1/workloads")) {
      return { ok: true, status: 200, json: async () => ({ workloadId: "wl-created" }) };
    }
    return { ok: true, status: 200, json: async () => ({ phase: "NotReady" }), text: async () => "" };
  }) as unknown as typeof fetch;
  // Real poll interval (5s): the first NotReady read starts the 1s ceiling, the next trips it.
  const created = new SafeWorkloadProvider().create({
    sessionId: "s1", namespace: "ns", image: "img:tag", resources: { cpu: "1" }, env: {}, platformKey: "key",
  });
  assert.equal(await outcome(created), "sandbox_start_timeout");
  assert.ok(!calls.some((c) => c.endsWith("/stop")), `the wait must leave the workload for the runner: ${calls.join(", ")}`);
});
