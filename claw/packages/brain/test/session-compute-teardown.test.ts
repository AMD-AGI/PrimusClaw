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
