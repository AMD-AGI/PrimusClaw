// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What happens when the stop before a replacement does not land?
//
// Teardown refusing to replace an unconfirmed sandbox is right: a workload that
// is still running must not be orphaned under a new one writing the same
// workspace. But "did not land" covers two things that want opposite handling,
// and folding them together was worse than the overwrite the refusal prevents:
//
//   - The control plane answered badly once. Retrying can still succeed, and
//     failing a user request on a single 503 is not evidence of anything.
//   - This deployment cannot issue a stop at all -- no platform key on the
//     entry, no API URL configured. Nothing here becomes true on a retry, so
//     refusing means the session is unusable until its TTL, with no operator
//     action that helps and the KV entry left in place to repeat it.
//
// The first is retried and then refused; the second lets teardown finish and
// leaves the workload to the control plane's GC, which is what happened before
// teardown could refuse at all.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import { bindSandboxStopRetry, destroyHands, reapPendingHands } from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { SandboxStopUnavailable } from "../src/sandbox/errors.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-stop";
const ENTRY = {
  provider: "safe-workload",
  workloadId: "wl-1",
  platformKey: "pk",
  namespace: "ns",
  token: "tok",
};

let restoreProviders: (() => void) | null = null;
let restoreRetry: (() => void) | null = null;

afterEach(() => {
  restoreProviders?.();
  restoreProviders = null;
  restoreRetry?.();
  restoreRetry = null;
});

/** A KV holding one session entry, recording whether it was deleted. */
function fakeKv(): { kv: KV; deleted: string[] } {
  const deleted: string[] = [];
  const kv = {
    async get(key: string) {
      if (deleted.includes(key)) return null;
      return { key, value: sc.encode(JSON.stringify(ENTRY)), revision: 3 };
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return 1; },
    async update() { return 4; },
  } as unknown as KV;
  return { kv, deleted };
}

/** Stand in for both providers; only `stop` is reached by these paths. */
function stubStop(stop: () => Promise<void>): { calls: () => number } {
  let calls = 0;
  const provider = {
    kind: "safe-workload",
    async stop() { calls++; return stop(); },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({
    safeWorkload: provider,
    agentSandbox: provider,
  });
  return { calls: () => calls };
}

test("a stop that fails once is retried rather than failing the request", async () => {
  const { kv, deleted } = fakeKv();
  bindHandsKv(kv);
  restoreRetry = bindSandboxStopRetry({ delayMs: 1 });
  let n = 0;
  const stub = stubStop(async () => {
    if (++n === 1) throw new Error("safe-workload stop failed: HTTP 503");
  });

  await destroyHands(SESSION, ENTRY);

  assert.equal(stub.calls(), 2, "one bad answer from the control plane is not a verdict");
  assert.deepEqual(deleted, [`hands.${SESSION}`], "a confirmed stop still clears the entry");
});

test("a stop that never lands refuses the replacement, and says why", async () => {
  const { kv, deleted } = fakeKv();
  bindHandsKv(kv);
  restoreRetry = bindSandboxStopRetry({ attempts: 3, delayMs: 1 });
  const stub = stubStop(async () => { throw new Error("safe-workload stop failed: HTTP 500"); });

  await assert.rejects(
    () => destroyHands(SESSION, ENTRY),
    // The consequence, not just the status code: the caller was about to build
    // a replacement and needs to know that is what was refused.
    /could not confirm the sandbox was stopped.*was not replaced/s,
  );
  assert.equal(stub.calls(), 3, "the bound is what stops it, not the first failure");
  assert.deepEqual(deleted, [], "an unconfirmed workload keeps its entry, or it is unreachable");
});

test("a stop this deployment cannot issue lets teardown finish", async () => {
  // The regression that wedged sessions: an entry with no platform key can
  // never be stopped, so refusing on it refuses forever.
  const { kv, deleted } = fakeKv();
  bindHandsKv(kv);
  restoreRetry = bindSandboxStopRetry({ delayMs: 1 });
  const stub = stubStop(async () => {
    throw new SandboxStopUnavailable("safe-workload stop requires workload id, platform key, and API URL");
  });

  await destroyHands(SESSION, ENTRY);

  assert.equal(stub.calls(), 1, "there is nothing to retry, so it must not be retried");
  assert.deepEqual(deleted, [`hands.${SESSION}`],
    "the entry has to go, or every later request fails the same way");
});

test("the real safe-workload provider raises the unavailable error, not a generic one", async () => {
  // The distinction teardown relies on is produced here, in the provider. Only
  // the test's own stub had ever thrown SandboxStopUnavailable, so nothing
  // pinned that the provider actually maps "no key / no URL" to it -- change
  // that mapping and destroyHands would start refusing forever again.
  const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
  const provider = new SafeWorkloadProvider();
  await assert.rejects(
    () => provider.stop({
      provider: "safe-workload", id: "wl-1", sandboxName: "wl-1",
      namespace: "ns", handsBaseUrl: "", platformKey: "",
    }),
    (e: unknown) => e instanceof SandboxStopUnavailable,
    "a missing platform key is unavailable, not a failure to retry",
  );
});

test("the real agent-sandbox provider raises the unavailable error for a missing id", async () => {
  const { AgentSandboxProvider } = await import("../src/sandbox/agent-sandbox-provider.js");
  const provider = new AgentSandboxProvider();
  await assert.rejects(
    () => provider.stop({
      provider: "agent-sandbox", id: "", sandboxName: "box",
      namespace: "ns", handsBaseUrl: "",
    }),
    (e: unknown) => e instanceof SandboxStopUnavailable,
  );
});

test("stopping one sandbox does not delete a sibling's session entry", async () => {
  // destroyHands scopes its KV cleanup with sameHandsSandbox: the entry is only
  // removed when it still names the sandbox being stopped. Neuter that check
  // and a DAG node tearing down its own sandbox deletes whichever sibling last
  // wrote the shared session key -- which is the clobbering this PR exists to
  // stop. Nothing pinned it: replacing the comparison with `true` left the
  // suite green.
  const deleted: string[] = [];
  const sibling = { provider: "safe-workload", workloadId: "wl-SIBLING", platformKey: "pk", namespace: "ns" };
  const kv = {
    async get(key: string) {
      if (deleted.includes(key)) return null;
      // The session key names the SIBLING, not the sandbox being stopped.
      return { key, value: sc.encode(JSON.stringify(sibling)), revision: 3 };
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return 1; },
    async update() { return 4; },
  } as unknown as KV;
  bindHandsKv(kv);
  restoreRetry = bindSandboxStopRetry({ delayMs: 1 });
  const stub = stubStop(async () => {});

  // Stop MY sandbox, named explicitly, while the session key names the sibling.
  await destroyHands(SESSION, { provider: "safe-workload", workloadId: "wl-MINE", platformKey: "pk" });

  assert.equal(stub.calls(), 1, "my own sandbox is still stopped");
  assert.deepEqual(deleted, [],
    "but the sibling's session entry must survive -- it does not name my sandbox");
});

/** A KV whose entry is replaced by a sibling between the two reads. */
function bumpedKv(entry: Record<string, unknown>): { kv: KV; deleted: string[] } {
  let reads = 0;
  const deleted: string[] = [];
  const kv = {
    async get(key: string) {
      reads += 1;
      // The second read is teardown's own: by then the key names a sandbox
      // provisioned after the decision to tear down was taken.
      return { key, value: sc.encode(JSON.stringify(entry)), revision: reads === 1 ? 5 : 6 };
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return 1; },
    async update() { return 7; },
  } as unknown as KV;
  return { kv, deleted };
}

test("a TTL refresh between the caller's read and the teardown does not stop it", async () => {
  // `hands.<sessionId>` is re-put on every successful keepalive ping to refresh
  // its TTL, so its revision moves on a timer that has nothing to do with
  // ownership. A teardown that refused whenever the revision had moved would
  // abort on that alone -- and the workload it had already confirmed dead
  // would keep running until some later sweep tried again.
  //
  // Nothing is lost by proceeding: the stop targets the identity the caller
  // passed, not whatever the key names now, and the KV delete below is a CAS
  // gated on sameHandsSandbox, so a sibling that really did take the key over
  // keeps both its workload and its entry (see the sibling test above).
  const { kv, deleted } = bumpedKv({ ...ENTRY, status: "pending" });
  bindHandsKv(kv);
  restoreRetry = bindSandboxStopRetry({ delayMs: 1 });
  const stub = stubStop(async () => {});

  await reapPendingHands(SESSION);

  assert.equal(stub.calls(), 1,
    "a bumped revision is a TTL refresh, not a change of owner: the dead "
    + "workload still has to be stopped");
  assert.deepEqual(deleted, [`hands.${SESSION}`],
    "and its entry cleared, or the next reap finds the same corpse");
});

test("a key being rewritten faster than teardown can clear it does not fail the request", async () => {
  // The workload is confirmed stopped; only the record is contended. Failing
  // here would fail a user request over a row the bucket TTL removes on its
  // own, and the caller's next move -- building a replacement -- is safe
  // precisely because the stop was confirmed.
  let revision = 10;
  const deleted: string[] = [];
  const kv = {
    async get(key: string) {
      return { key, value: sc.encode(JSON.stringify(ENTRY)), revision };
    },
    async delete(key: string, opts?: { previousSeq?: number }) {
      // A write lands between every read and the delete that follows it, which
      // is what a keepalive TTL refresh does to a busy session.
      revision += 1;
      if (opts?.previousSeq !== undefined && opts.previousSeq !== revision) {
        throw new Error(`wrong last sequence: ${opts.previousSeq}`);
      }
      deleted.push(key);
    },
    async put() { return 1; },
    async update() { return revision + 1; },
  } as unknown as KV;
  bindHandsKv(kv);
  restoreRetry = bindSandboxStopRetry({ delayMs: 1 });
  const stub = stubStop(async () => {});

  await destroyHands(SESSION, ENTRY);   // must resolve, not reject

  assert.equal(stub.calls(), 1, "the workload still has to be stopped");
  assert.deepEqual(deleted, [], "and the contended row is simply left to its TTL");
});

test("a key another teardown deleted first does not fail this one", async () => {
  // Two teardowns, or a teardown and a sweeper, can race. The loser confirms
  // its stop, loses the CAS delete, re-reads -- and finds the key already gone.
  // A deleted key reads back with an empty value, so reading it as "unreadable"
  // rather than "missing" ends this path on a throw, which reaches the caller
  // as a failed request even though the workload is stopped and the entry it
  // wanted removed has been removed.
  let reads = 0;
  const deleted: string[] = [];
  const kv = {
    async get(key: string) {
      reads += 1;
      // First read: ours, still valid. Second: after the other teardown won.
      return reads === 1
        ? { key, value: sc.encode(JSON.stringify(ENTRY)), revision: 7 }
        : { key, value: new Uint8Array(0), revision: 8, operation: "DEL" };
    },
    async delete(key: string, opts?: { previousSeq?: number }) {
      if (opts?.previousSeq === 7) throw new Error("wrong last sequence: 7");
      deleted.push(key);
    },
    async put() { return 1; },
    async update() { return 9; },
  } as unknown as KV;
  bindHandsKv(kv);
  restoreRetry = bindSandboxStopRetry({ delayMs: 1 });
  const stub = stubStop(async () => {});

  await destroyHands(SESSION, ENTRY);   // must resolve

  assert.equal(stub.calls(), 1, "the workload is stopped either way");
  assert.deepEqual(deleted, [], "and the entry is already gone, so there is nothing to delete");
});
