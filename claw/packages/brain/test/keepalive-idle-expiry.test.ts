// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The idle sweep deletes the only record of a live workload, and the guard that
// used to stop it doing that to a running session is gone.
//
// collectTargets used to short-circuit the whole KV branch with
// `if (targets.has(sessionId)) continue; // local wins`. That was removed so a
// DAG's siblings could each be pinged -- correct in itself, but it also removed
// the protection from the expiry branch below it, which deletes `hands.<sid>`
// outright. An entry still carrying stale idle markers -- a reuse whose marker
// clear lost its race, or one a sibling wrote mid-turn -- then reads as an
// expired handle while the session is actively running.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import {
  registerSandbox,
  runKeepaliveTickForTest,
  unregisterSandbox,
  resetBackgroundWorkStateForTest,
} from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-idle";
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

/**
 * "Nothing is running in there" as a fact rather than an absence.
 *
 * The sweep asks Hands before treating an idle handle as spare, and a probe it
 * cannot complete answers `unknown`, which holds the handle rather than
 * expiring it. Without this stub these tests would reach a real socket, get
 * `unknown`, and pass or fail on which of those two the sweep happened to do --
 * which is not what any of them is about.
 */
const idle = async () => 0;

/**
 * Sweep, let the probe land, sweep again.
 *
 * The probe runs behind the sweep rather than in front of every ping, so the
 * first sweep decides on `unknown` -- which holds the handle -- and only the
 * second sees the answer. A test about what happens to a spare handle has to
 * get past the first.
 */
async function sweepTwice(kv: KV): Promise<void> {
  await runKeepaliveTickForTest({ kv, countActiveShells: idle });
  await new Promise((r) => setImmediate(r));
  await runKeepaliveTickForTest({ kv, countActiveShells: idle });
}

let restoreProviders: (() => void) | null = null;

afterEach(() => {
  resetBackgroundWorkStateForTest();
  unregisterSandbox(SESSION);
  restoreProviders?.();
  restoreProviders = null;
});

/**
 * A provider whose keepalive ping succeeds.
 *
 * Without one the ping fails against the stub KV, the fail limit evicts the
 * sandbox, and `destroyHands` deletes the very key under test -- from a branch
 * that has nothing to do with idle expiry.
 */
function stubPingableProvider(): void {
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
}

function fakeKv(opts: { runLease?: boolean } = {}): { kv: KV; deleted: string[]; updated: number[] } {
  const deleted: string[] = [];
  const updated: number[] = [];
  const kv = {
    // Honour the filter. A stub that yields everything makes getRetryPending's
    // `retry-pending.>` scan match the sandbox key, decode it as an expired
    // retry, and delete the key this test is about -- see nats-kv-stub.ts for
    // why subject-token semantics are worth getting right in a stub.
    async keys(filter = ">") {
      const key = `hands.${SESSION}`;
      const matched = filterToRegExp(filter).test(key) && !deleted.includes(key) ? [key] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      // Only the sandbox entry exists. Answering every key with it made
      // getRetryPending parse a sandbox record as an expired retry and delete
      // the very key this test is about, from a branch it is not testing.
      // `lock.<sessionId>` is the run lease, and it lives in this same bucket.
      if (opts.runLease && key === `lock.${SESSION}`) {
        return { key, value: sc.encode("{}"), revision: 1 };
      }
      if (key !== `hands.${SESSION}` || deleted.includes(key)) return null;
      return { key, value: sc.encode(JSON.stringify(ENTRY)), revision: 5 };
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return 1; },
    async update(_k: string, _v: unknown, rev: number) { updated.push(rev); return rev + 1; },
  } as unknown as KV;
  return { kv, deleted, updated };
}

test("an idle handle past its window is expired when nothing is running on it", async () => {
  const { kv, deleted } = fakeKv();
  await sweepTwice(kv);
  assert.ok(deleted.includes(`hands.${SESSION}`),
    "the reuse window is over and no run holds it, so the handle goes");
});

test("the same handle is kept while this replica is running the session", async () => {
  const { kv, deleted } = fakeKv();
  stubPingableProvider();
  registerSandbox(SESSION, { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" });

  await sweepTwice(kv);

  // Only this key matters: registering the sandbox also makes it a ping target,
  // and a ping that fails against the stub touches unrelated bookkeeping keys.
  assert.ok(!deleted.includes(`hands.${SESSION}`),
    `deleting here loses the only record of a workload the run is still using; deleted ${JSON.stringify(deleted)}`);
});

test("a handle kept because the session is live also gets its TTL refreshed", async () => {
  // Keeping the entry is only half of it: this bucket expires entries on its
  // own (BRAIN_REGISTRY_TTL_MS, five minutes), so one that is never re-put
  // vanishes from under the run anyway. The refresh comes from the local ping
  // path rather than the guard, which is why the guard does not write again --
  // this pins that the two together actually keep the entry alive.
  const { kv, deleted, updated } = fakeKv();
  stubPingableProvider();
  registerSandbox(SESSION, { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" });

  await sweepTwice(kv);

  assert.ok(!deleted.includes(`hands.${SESSION}`), "kept, as before");
  assert.ok(updated.includes(5),
    `keeping it means re-putting it at the revision just read; updates=${JSON.stringify(updated)}`);
});

test("the handle is kept when the session is running on a DIFFERENT replica", async () => {
  // `registeredSandboxCount` is process-local, so the two replicas that are not
  // running this session both read zero and both consider the handle idle --
  // whichever sweeps first deletes the key naming a workload in use. The run
  // lease is the same question asked fleet-wide, and it is what this pins.
  //
  // Nothing is registered locally here, which is the whole point: this is the
  // other replica's view.
  const { kv, deleted } = fakeKv({ runLease: true });

  await sweepTwice(kv);

  assert.ok(!deleted.includes(`hands.${SESSION}`),
    `a run holds this session somewhere in the fleet, so its handle must survive `
    + `this replica's sweep; deleted ${JSON.stringify(deleted)}`);
});
