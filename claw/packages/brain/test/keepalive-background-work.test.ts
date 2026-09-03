// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A turn that ended is not a sandbox that is free.
//
// `stopKeepaliveAfterTask` marks the handle idle on every terminal task, and an
// idle handle is never pinged, so the control-plane GC reclaims the pod about
// fifteen minutes later. Claw's own rule for background shells says the
// opposite -- a `run_in_background` shell is expected to still be running when
// the user asks about it next turn, "which is the reason background shells
// exist at all" -- and reclaiming the pod kills it regardless of that promise.
//
// The sweep now reads the fact instead of assuming it. These pin the three
// answers that matter: work running keeps the handle, no work keeps today's
// behaviour exactly, and a probe that cannot answer is not read as "no work has
// ever been more true" but as the status quo.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import { runKeepaliveTickForTest, unregisterSandbox } from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-bg";
const ENTRY = {
  status: "ready",
  provider: "safe-workload",
  workloadId: "wl-1",
  platformKey: "pk",
  namespace: "ns",
  handsUrl: "http://sandbox:9100/mcp",
  token: "tok",
  keepalive: false,
  // Long past the reuse window, so the sweep wants to expire it.
  idleSince: 0,
};

let restoreProviders: (() => void) | null = null;

afterEach(() => {
  unregisterSandbox(SESSION);
  restoreProviders?.();
  restoreProviders = null;
});

/** A provider whose ping succeeds, so a kept handle is not then evicted by the
 *  fail limit from a branch these tests are not about. */
function stubPingableProvider(): void {
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, healthy: true }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
}

function fakeKv(): { kv: KV; deleted: string[] } {
  const deleted: string[] = [];
  const kv = {
    async keys(filter = ">") {
      const key = `hands.${SESSION}`;
      const matched = filterToRegExp(filter).test(key) && !deleted.includes(key) ? [key] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (key !== `hands.${SESSION}` || deleted.includes(key)) return null;
      return { key, value: sc.encode(JSON.stringify(ENTRY)), revision: 5 };
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return 1; },
    async update(_k: string, _v: unknown, rev: number) { return rev + 1; },
  } as unknown as KV;
  return { kv, deleted };
}

test("an idle handle is kept while the session still has a background shell running", async () => {
  const { kv, deleted } = fakeKv();
  stubPingableProvider();

  await runKeepaliveTickForTest({ kv, countActiveShells: async () => 1 });

  assert.ok(
    !deleted.includes(`hands.${SESSION}`),
    "expiring here reclaims the pod out from under a shell the run was promised "
      + `would still be there; deleted ${JSON.stringify(deleted)}`,
  );
});

test("the probe is asked for the session, which is the owner Hands files shells under", async () => {
  const { kv } = fakeKv();
  stubPingableProvider();
  const asked: Array<[string, string, string]> = [];

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async (url, token, owner) => { asked.push([url, token, owner]); return 1; },
  });

  assert.deepEqual(
    asked[0],
    [ENTRY.handsUrl, ENTRY.token, SESSION],
    "asking under runScope instead would match no owner at all -- it is the run "
      + "lease key, a workspace id under RUN_GATE_KEY=workspace",
  );
});

test("no background work leaves the existing expiry untouched", async () => {
  const { kv, deleted } = fakeKv();

  await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });

  assert.ok(
    deleted.includes(`hands.${SESSION}`),
    "a sandbox nobody is using still has to be reclaimed; this check must not "
      + "turn every finished turn into a held pod",
  );
});

test("a probe that throws falls back to the behaviour from before it existed", async () => {
  const { kv, deleted } = fakeKv();

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  });

  assert.ok(
    deleted.includes(`hands.${SESSION}`),
    "an unreachable Hands must not be able to make things worse than they were; "
      + "the hole this leaves -- a restarted Hands reports zero for shells that "
      + "are still running -- is named in the helper, not hidden here",
  );
});
