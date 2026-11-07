// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which key a session teardown runs with, and what it may conclude without one.
 *
 * A session with no key offered and no `hands.<sid>` binding has nothing Claw
 * could address -- every session the retention pass deletes is one. Those used
 * to come back as `no_platform_key`, park nothing, and fire the teardown alert
 * once per replica. A binding without a key, or a store that cannot be read, is
 * still a teardown that could not finish.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { bindHandsKv } from "../src/sandbox/registry.js";
import { destroySessionCompute, resolveCleanupCredential } from "../src/sandbox/session-compute-teardown.js";
import type { SessionDestroyResult } from "../src/sandbox/multi-node/types.js";

const sc = StringCodec();
const SID = "sess-compute-1";

function bindStore(opts: { entry?: unknown; raw?: string; getError?: Error }): void {
  const store = new Map<string, Uint8Array>();
  if (opts.entry !== undefined) store.set(`hands.${SID}`, sc.encode(JSON.stringify(opts.entry)));
  if (opts.raw !== undefined) store.set(`hands.${SID}`, sc.encode(opts.raw));
  bindHandsKv({
    async get(key: string) {
      if (opts.getError) throw opts.getError;
      const value = store.get(key);
      return value ? { key, value, revision: 1, operation: "PUT" } : null;
    },
  } as unknown as KV);
}

function provider(result: SessionDestroyResult = { complete: true, found: 0, deleted: 0 }) {
  const calls: Array<{ sessionId: string; platformKey: string }> = [];
  return {
    calls,
    deps: {
      multiNodeAvailable: () => true,
      destroyForSession: async (sessionId: string, opts: { platformKey: string }) => {
        calls.push({ sessionId, platformKey: opts.platformKey });
        return result;
      },
    },
  };
}

test("no key and no binding is a finished teardown that asked nothing of SaFE", async () => {
  bindStore({});
  const p = provider();

  const result = await destroySessionCompute(SID, "", p.deps);

  assert.deepEqual(result, { complete: true, found: 0, deleted: 0 });
  assert.deepEqual(p.calls, [], "there is no key to list with, so nothing is asked");
});

test("the key on the notification wins, and SaFE is asked with it", async () => {
  bindStore({ entry: { workloadId: "w1", platformKey: "binding-key" } });
  const p = provider();

  await destroySessionCompute(SID, " caller-key ", p.deps);

  assert.deepEqual(p.calls, [{ sessionId: SID, platformKey: "caller-key" }]);
});

test("with no key offered, the binding's key is used", async () => {
  bindStore({ entry: { workloadId: "w1", platformKey: "binding-key" } });
  const p = provider({ complete: false, reason: "delete_failed", found: 1, deleted: 0 });

  const result = await destroySessionCompute(SID, "", p.deps);

  assert.deepEqual(p.calls, [{ sessionId: SID, platformKey: "binding-key" }]);
  assert.equal(result.complete, false, "the provider's answer is passed through untouched");
  assert.equal(result.reason, "delete_failed");
});

test("a binding that carries no key is still an incomplete teardown", async () => {
  // Something Claw created may be behind it, and there is no key to reach it.
  bindStore({ entry: { workloadId: "w1" } });
  const p = provider();

  const result = await destroySessionCompute(SID, "", p.deps);

  assert.deepEqual(result, { complete: false, reason: "no_platform_key", found: 0, deleted: 0 });
  assert.deepEqual(p.calls, []);
});

test("a binding that is not JSON is a binding, not an absence", async () => {
  bindStore({ raw: "{not json" });

  assert.deepEqual(await resolveCleanupCredential(SID, ""), { kind: "no_key", binding: "present" });
});

test("an unreadable store is not read as an absent binding", async () => {
  bindStore({ getError: new Error("nats: timeout") });
  const p = provider();

  const result = await destroySessionCompute(SID, "", p.deps);

  assert.equal(result.complete, false, "an outage may be hiding a live sandbox");
  assert.equal(result.reason, "no_platform_key");
  assert.deepEqual(p.calls, []);
});

test("a deployment without SaFE has nothing to destroy and reads nothing", async () => {
  bindStore({ getError: new Error("must not be read") });
  const p = provider();

  const result = await destroySessionCompute(SID, "", { ...p.deps, multiNodeAvailable: () => false });

  assert.deepEqual(result, { complete: true, found: 0, deleted: 0 });
});

test("the binding's workspace goes with the key, whichever key it is", async () => {
  bindStore({ entry: { workloadId: "w1", platformKey: "binding-key", namespace: "global-cpu" } });
  const seen: Array<{ platformKey: string; workspaces: string[] }> = [];
  const deps = {
    multiNodeAvailable: () => true,
    destroyForSession: async (_sid: string, opts: { platformKey: string; workspaces: string[] }) => {
      seen.push(opts);
      return { complete: true, found: 0, deleted: 0 };
    },
  };

  await destroySessionCompute(SID, "", deps);
  await destroySessionCompute(SID, "caller-key", deps);

  assert.deepEqual(seen, [
    { platformKey: "binding-key", workspaces: ["global-cpu"] },
    { platformKey: "caller-key", workspaces: ["global-cpu"] },
  ]);
});

test("a non-admin session's teardown completes through the real provider", async (t) => {
  // The whole path that parked sessions as cleanup_incomplete_parked: the binding names global-cpu, the
  // key may list only there, and the provider must ask there.
  const { SafeMultiNodeProvider } = await import("../src/sandbox/multi-node/safe-provider.js");
  bindStore({ entry: { workloadId: "w1", platformKey: "user-key", namespace: "global-cpu" } });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
    const ws = new URL(String(input), "http://safe.test").searchParams.get("workspaceId");
    if (ws !== "global-cpu") return new Response("{}", { status: 403 });
    return new Response(JSON.stringify({ totalCount: 1, items: [{ workloadId: "w1", phase: "running" }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  const result = await destroySessionCompute(SID, "", {
    multiNodeAvailable: () => true,
    destroyForSession: (sid, opts) => new SafeMultiNodeProvider().destroyForSession(sid, opts),
  });

  assert.deepEqual(result, { complete: true, found: 1, deleted: 1 });
});

test("a failed lookup is asked again before the teardown is called incomplete", async () => {
  // A session with no binding has nothing to park, so no sweep ever comes back for it: the one notification
  // is the only chance its workloads get, and one SaFE blip used to spend it.
  bindStore({});
  const answers: SessionDestroyResult[] = [
    { complete: false, reason: "lookup_failed", found: 0, deleted: 0 },
    { complete: true, found: 1, deleted: 1 },
  ];
  const waits: number[] = [];
  let calls = 0;

  const result = await destroySessionCompute(SID, "caller-key", {
    multiNodeAvailable: () => true,
    destroyForSession: async () => answers[calls++],
    sleep: async (ms) => { waits.push(ms); },
  });

  assert.deepEqual(result, { complete: true, found: 1, deleted: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1_000]);
});

test("a lookup that keeps failing is retried a bounded number of times, and a refused delete is not retried", async () => {
  bindStore({});
  let lookups = 0;
  const waits: number[] = [];
  const failed = await destroySessionCompute(SID, "caller-key", {
    multiNodeAvailable: () => true,
    destroyForSession: async () => { lookups += 1; return { complete: false, reason: "lookup_failed", found: 0, deleted: 0 }; },
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(failed.reason, "lookup_failed");
  assert.equal(lookups, 3);
  assert.deepEqual(waits, [1_000, 4_000]);

  let deletes = 0;
  const refused = await destroySessionCompute(SID, "caller-key", {
    multiNodeAvailable: () => true,
    destroyForSession: async () => { deletes += 1; return { complete: false, reason: "delete_failed", found: 1, deleted: 0 }; },
    sleep: async () => { throw new Error("must not wait"); },
  });
  assert.equal(refused.reason, "delete_failed");
  assert.equal(deletes, 1);
});
