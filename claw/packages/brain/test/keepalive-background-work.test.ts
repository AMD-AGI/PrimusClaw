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
import {
  runKeepaliveTickForTest, unregisterSandbox, resetBackgroundWorkStateForTest,
} from "../src/sandbox/keepalive.js";
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
  resetBackgroundWorkStateForTest();
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

/**
 * A KV that remembers what was written to it.
 *
 * Worth the extra few lines: the sweep writes the entry in one place and re-reads
 * it in another within the same tick, so a stub whose `get` always answers the
 * seed value hides whichever write came first -- including the one these tests
 * are about.
 */
function fakeKv(): { kv: KV; deleted: string[]; current: () => Record<string, unknown> } {
  const deleted: string[] = [];
  let value = sc.encode(JSON.stringify(ENTRY));
  let revision = 5;
  const kv = {
    async keys(filter = ">") {
      const key = `hands.${SESSION}`;
      const matched = filterToRegExp(filter).test(key) && !deleted.includes(key) ? [key] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (key !== `hands.${SESSION}` || deleted.includes(key)) return null;
      return { key, value, revision };
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return ++revision; },
    async update(_k: string, v: unknown, rev: number) {
      if (rev !== revision) throw new Error("revision conflict");
      value = v as Uint8Array;
      return ++revision;
    },
  } as unknown as KV;
  return {
    kv, deleted,
    current: () => JSON.parse(sc.decode(value)) as Record<string, unknown>,
  };
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

test("a probe that cannot answer holds the handle instead of expiring it", async () => {
  const { kv, deleted } = fakeKv();
  stubPingableProvider();

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  });

  assert.ok(
    !deleted.includes(`hands.${SESSION}`),
    "folding \"could not ask\" into \"no work\" is what makes this feature "
      + "unreliable: over a job long enough to need it, at one probe a minute, "
      + "a single timeout is close to certain and would delete the handle",
  );
});

test("a probe that never answers eventually stops holding the handle", async () => {
  const { kv, deleted } = fakeKv();
  stubPingableProvider();

  // Unknown is for a blip, not forever: a sandbox that has stopped answering
  // entirely would otherwise be pinned until its absolute deadline.
  for (let i = 0; i < 8; i++) {
    await runKeepaliveTickForTest({
      kv,
      countActiveShells: async () => { throw new Error("hands unreachable"); },
    });
    if (deleted.includes(`hands.${SESSION}`)) break;
  }

  assert.ok(
    deleted.includes(`hands.${SESSION}`),
    "a permanently unreachable Hands must not hold a handle open indefinitely",
  );
});

test("work that outlasts the reuse window still leaves a window behind it", async () => {
  // The bug this pins: idleSince is stamped when the task ends, so a job that
  // runs longer than the window means the handle is already expired the moment
  // the job finishes -- deleted by the very next sweep, before the session can
  // reuse the pod or read what the job wrote.
  const { kv, current } = fakeKv();
  stubPingableProvider();

  await runKeepaliveTickForTest({ kv, countActiveShells: async () => 1 });

  const idleSince = current().idleSince;
  assert.equal(typeof idleSince, "number", "the idle clock was never moved while work ran");
  assert.ok(
    Date.now() - (idleSince as number) < 60_000,
    `the stamp has to track the work, not the turn that started it; got ${idleSince}`,
  );
});

test("the probe is not repeated on every tick", async () => {
  // The sweep walks KV serially and this is a network call, so one probe per
  // handle per tick is what pushes a tick past its own interval once a few
  // handles stop answering quickly.
  const { kv } = fakeKv();
  stubPingableProvider();
  let probes = 0;
  const deps = { kv, countActiveShells: async () => { probes += 1; return 1; } };

  await runKeepaliveTickForTest(deps);
  await runKeepaliveTickForTest(deps);
  await runKeepaliveTickForTest(deps);

  assert.equal(probes, 1, `three sweeps asked Hands ${probes} times`);
});
