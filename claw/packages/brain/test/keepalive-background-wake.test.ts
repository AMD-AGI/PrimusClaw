// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// "Run the tests in the background and tell me when they pass": the turn that
// started them has ended, so the only thing still looking at the sandbox is the
// keepalive sweep, which probes an idle sandbox's jobs. When a probe that counts
// none replaces one from the same idle period that counted some, the work ended
// with nobody watching, and the sweep says so (`onBackgroundWorkFinished`), once.

import "./reclaim-single-reading-env.js";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import {
  runKeepaliveTickForTest, unregisterSandbox, resetBackgroundWorkStateForTest, ageBackgroundWorkCacheForTest,
} from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-wake";
const KEY = `hands.${SESSION}`;
// Idle a moment ago (see keepalive-background-work.test.ts: an answer on the
// same millisecond as the park is not believed), and well inside the reuse window.
const IDLE_SINCE = Date.now() - 1_000;
const ENTRY = {
  status: "ready", provider: "safe-workload", workloadId: "wl-wake", platformKey: "pk", namespace: "ns",
  handsUrl: "http://sandbox:9100/mcp", token: "tok", keepalive: false, idleSince: IDLE_SINCE,
};

let restoreProviders: (() => void) | null = null;
afterEach(() => {
  resetBackgroundWorkStateForTest();
  unregisterSandbox(SESSION);
  restoreProviders?.();
  restoreProviders = null;
});

function stubPingableProvider(): void {
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, healthy: true }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
}

/** A KV that remembers what was written to it, and lets the test move the entry the way a turn would. */
function fakeKv() {
  let value = sc.encode(JSON.stringify(ENTRY));
  let revision = 5;
  const kv = {
    async keys(filter = ">") {
      return (async function* () { if (filterToRegExp(filter).test(KEY)) yield KEY; })();
    },
    async get(key: string) { return key === KEY ? { key, value, revision } : null; },
    async delete() {},
    async put() { return ++revision; },
    async update(_k: string, v: unknown, rev: number) {
      if (rev !== revision) throw new Error("revision conflict");
      value = v as Uint8Array;
      return ++revision;
    },
  } as unknown as KV;
  return {
    kv,
    patch(fields: Record<string, unknown>) {
      value = sc.encode(JSON.stringify({ ...JSON.parse(sc.decode(value)), ...fields }));
      revision++;
    },
  };
}

/** One answer of the jobs probe: a sweep starts it, the next reads it; the cache is aged so it is asked again. */
async function probeAnswers(deps: Parameters<typeof runKeepaliveTickForTest>[0]): Promise<void> {
  ageBackgroundWorkCacheForTest(4.5 * 60_000);   // past the refresh interval, short of the age that forgets it
  await runKeepaliveTickForTest(deps);
  await new Promise((r) => setTimeout(r, 30));
}

async function recorded(kv: KV): Promise<unknown> {
  return (JSON.parse(sc.decode((await kv.get(KEY))!.value)) as { bgRunning?: number }).bgRunning;
}

function world() {
  stubPingableProvider();
  const store = fakeKv();
  const woken: Array<[string, string]> = [];
  let jobs = 0;
  const deps = {
    kv: store.kv,
    countActiveShells: async () => jobs,
    onBackgroundWorkFinished: (sessionId: string, key: string) => { woken.push([sessionId, key]); },
  };
  return { store, woken, deps, setJobs: (n: number) => { jobs = n; } };
}

test("work that was running and is now done wakes the session, once", async () => {
  const { woken, deps, setJobs } = world();
  setJobs(1);
  await probeAnswers(deps);
  assert.deepEqual(woken, [], "work still running wakes nobody");
  setJobs(0);
  await probeAnswers(deps);
  assert.equal(woken.length, 1, "the finish was not reported");
  assert.equal(woken[0][0], SESSION);
  await probeAnswers(deps);
  await probeAnswers(deps);
  assert.equal(woken.length, 1, "one finish is one wake, however many sweeps see the sandbox empty after it");
});

test("a sandbox that never had work running after its turn wakes nobody", async () => {
  const { woken, deps, setJobs } = world();
  setJobs(0);
  await probeAnswers(deps);
  await probeAnswers(deps);
  assert.equal(await recorded(deps.kv), 0, "the empty answer was not recorded, so this proves nothing");
  assert.deepEqual(woken, []);
});

test("work seen running in an earlier idle period does not wake the next one when it is found empty", async () => {
  const { store, woken, deps, setJobs } = world();
  setJobs(1);
  await probeAnswers(deps);
  // A turn took the sandbox and parked it again: a new idle period, whose first answer is the empty one.
  store.patch({ idleSince: Date.now() - 500, idleRev: 2 });
  setJobs(0);
  await probeAnswers(deps);
  await probeAnswers(deps);
  assert.equal(await recorded(deps.kv), 0, "the empty answer was not recorded, so this proves nothing");
  assert.deepEqual(woken, [], "the turn in between saw the sandbox; its end is not news");
});
