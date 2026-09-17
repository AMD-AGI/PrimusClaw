// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The sweeper's PENDING branch collects an abandoned workload, and only one.
 *
 * It used to be an unconditional `continue`, justified by two claims that are
 * both false. That an unowned entry expires on the bucket TTL: it does not,
 * because `startDeliveryHeartbeat` re-puts `hands.<sid>` every 10s, is
 * SESSION-keyed, and runs for every task on the session including the ones that
 * provision nothing -- so the entry is held open by exactly the runs that do not
 * own it. And that the workload behind it is then the platform's idle-killer
 * problem: SaFE's Workload has no idle timeout, as this repo says in config.ts
 * and in safe-workload-provider.ts, so what is actually behind it is the 24-hour
 * absolute `timeout`.
 *
 * Expiry would be the wrong outcome regardless -- the entry is the only record
 * of workloadId + platformKey, so an entry that expires is a workload nothing
 * can name. Hence a collector, and hence three conditions on it rather than an
 * age alone. These tests assert on the stop that was issued and the key that was
 * deleted; a collector that quietly does nothing and a collector that stops the
 * wrong container are both green under a boolean.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";
import { handsSessionKey } from "@claw/protocol";

import { sweepStaleHandsForTest } from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { retentionKey } from "../src/sandbox/retain-container.js";
import { SANDBOX_PENDING_ABANDONED_AFTER_MS } from "../src/config.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();

const SESSION = "sess-abandoned";
const KEY = `hands.${SESSION}`;
/** Where this session's lease actually lives: workspace-gated, not the session. */
const SCOPE = "ws.workspace-7";
const ABANDONED = "wl-abandoned";

/** The revision the sweep reads, and therefore the only one it may delete at. */
const REVISION = 11;

const HORIZON = SANDBOX_PENDING_ABANDONED_AFTER_MS;

let restoreProviders: (() => void) | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  restoreProviders?.();
  restoreProviders = null;
});

function pending(workloadId: string, ageMs: number, extra: Record<string, unknown> = {}) {
  return {
    status: "pending",
    provider: "safe-workload",
    workloadId,
    platformKey: "pk",
    namespace: "ns",
    token: `tok-${workloadId}`,
    runScope: SCOPE,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    ...extra,
  };
}

interface Deletion { key: string; previousSeq?: number }

function bindKv(seed: Record<string, unknown>, throwOn: Set<string> = new Set()) {
  const values = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const deleted: Deletion[] = [];
  const kv = {
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...values.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (throwOn.has(key)) throw new Error("kv unavailable");
      const raw = values.get(key);
      return raw === undefined
        ? null
        : { key, value: sc.encode(raw), revision: REVISION, operation: "PUT" };
    },
    async put() { return 1; },
    async update() { return REVISION + 1; },
    async delete(key: string, opts?: { previousSeq?: number }) {
      deleted.push({ key, previousSeq: opts?.previousSeq });
      values.delete(key);
    },
  } as unknown as KV;
  bindHandsKv(kv);
  return { values, deleted };
}

function recordStops(): string[] {
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async stop(inst: { id: string }) { stopped.push(inst.id); },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  return stopped;
}

/** Health always answers ok, so nothing here is evicted for being unhealthy. */
function healthyEndpoints(): void {
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
}

test("a pending entry past the horizon with no lease is stopped and its key deleted", async () => {
  assert.ok(HORIZON > 0, "the collector is off; this test would assert nothing");
  const { values, deleted } = bindKv({ [KEY]: pending(ABANDONED, HORIZON + 60_000) });
  const stopped = recordStops();
  healthyEndpoints();

  await sweepStaleHandsForTest();

  assert.deepEqual(stopped, [ABANDONED],
    "nothing stopped the workload, so it runs to SANDBOX_DEFAULT_TIMEOUT_SECONDS -- 24h "
    + "of GPUs on a sandbox no run is waiting for");
  assert.deepEqual(deleted, [{ key: KEY, previousSeq: REVISION }],
    "the entry must go, and only at the revision the decision was read at");
  assert.equal(values.has(KEY), false);
});

test("but not while the session's run lease is still held", async () => {
  // The case the age alone gets wrong: SANDBOX_PENDING_TIMEOUT_SECONDS lets a
  // run queue for three hours, past this two-hour horizon, and that run is
  // alive -- it renews `lock.<scope>` every LOCK_REFRESH_INTERVAL_MS for its
  // whole length, so it is still holding it between statements of its agent
  // loop and through any long tool call. The lease is read under the scope the
  // ENTRY names, because under the default RUN_GATE_KEY=workspace the lock is
  // `lock.ws.<id>` and looking under the session id would find nothing.
  const { values, deleted } = bindKv({
    [KEY]: pending(ABANDONED, HORIZON + 60_000),
    [`lock.${SCOPE}`]: { holderId: "brain-1", acquiredAt: Date.now() },
  });
  const stopped = recordStops();
  healthyEndpoints();

  await sweepStaleHandsForTest();

  assert.deepEqual(stopped, [],
    `stopped ${JSON.stringify(stopped)}: a run is still queueing for that sandbox and `
    + "will now be told its provisioning failed");
  assert.deepEqual(deleted, []);
  assert.ok(values.has(KEY));
});

test("nor before the horizon, while the queue wait is still ordinary", async () => {
  const { values, deleted } = bindKv({ [KEY]: pending(ABANDONED, Math.floor(HORIZON / 2)) });
  const stopped = recordStops();
  healthyEndpoints();

  await sweepStaleHandsForTest();

  assert.deepEqual(stopped, [], "GPU queueing is unbounded; a short wait is not abandonment");
  assert.deepEqual(deleted, []);
  assert.ok(values.has(KEY));
});

test("nor an entry that does not name the scope its lease would be under", async () => {
  // Written before `runScope` reached the PENDING payload. The lease cannot be
  // looked up, and "cannot tell" has to read as "leave it": the fallback key is
  // `lock.<sessionId>`, which is empty for every workspace-gated and every
  // DAG-rooted run, so guessing means answering "no lease" for live runs.
  const { values, deleted } = bindKv({
    [KEY]: pending(ABANDONED, HORIZON + 60_000, { runScope: undefined }),
  });
  const stopped = recordStops();
  healthyEndpoints();

  await sweepStaleHandsForTest();

  assert.deepEqual(stopped, []);
  assert.deepEqual(deleted, []);
  assert.ok(values.has(KEY));
});

test("and never a retained container, whatever its projection looks like", async () => {
  // The defect a sibling branch has already shipped. A retention projection is
  // a byte copy of the binding it was made from -- same status, same handsUrl,
  // same token -- and its idle and creation markers are frozen at the moment it
  // was taken, so it is past any horizon from the moment it exists. It is keyed
  // by a sandbox generation, so the session id this walk derives from its key
  // names no session and the lease lookup under it finds nothing. Every
  // condition the collector applies therefore passes, and what it would stop is
  // the container holding the live work the retention was taken for.
  const generation = "http://retained:9100/mcp";
  const key = retentionKey(generation);
  const { values, deleted } = bindKv({
    [key]: pending("wl-retained", HORIZON + 86_400_000, {
      handsUrl: generation,
      protected: true,
      reason: "protected",
      detail: "live_work_present",
    }),
  });
  const stopped = recordStops();
  healthyEndpoints();

  await sweepStaleHandsForTest();

  assert.deepEqual(stopped, [],
    "the retained container was stopped -- the live work it was holding is gone, "
    + "and nothing brings it back");
  assert.deepEqual(deleted, [],
    "and its projection deleted, so nothing names the container any more");
  assert.ok(values.has(key));
});

test("the delete lands on the key that was walked, not one rebuilt from a session id", async () => {
  // A rolling upgrade puts a binding under the legacy name while the canonical
  // one holds a different generation of the same session. A collector that
  // re-derived its key from `sessionIdFromHandsKey` would read the canonical
  // entry back -- a healthy sibling here -- and act on that instead.
  const legacySession = "=raw-session";
  const walkedKey = `hands.${legacySession}`;
  // The name this session's binding would be rebuilt under, computed the way
  // the code would compute it -- which for this session id is a different key.
  const canonicalKey = handsSessionKey(legacySession);
  assert.notEqual(canonicalKey, walkedKey);
  const sibling = {
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-live-sibling",
    platformKey: "pk",
    namespace: "ns",
    token: "tok-sibling",
    handsUrl: "http://sibling:9100/mcp",
  };
  const { values, deleted } = bindKv({
    [walkedKey]: pending(ABANDONED, HORIZON + 60_000),
    [canonicalKey]: sibling,
  });
  const stopped = recordStops();
  healthyEndpoints();

  await sweepStaleHandsForTest();

  assert.deepEqual(stopped, [ABANDONED],
    `stopped ${JSON.stringify(stopped)}: the sibling under the canonical key is a live `
    + "sandbox and was never what this decision was taken about");
  assert.deepEqual(deleted, [{ key: walkedKey, previousSeq: REVISION }],
    "the walked key is the only one this decision covers");
  assert.ok(values.has(canonicalKey), "the sibling binding must survive");
});

test("nor when the bucket could not say whether the lease is held", async () => {
  // The difference between "nobody is running this" and "I could not find
  // out". `sessionHasActiveRunLease` folds them together, which costs its own
  // callers a skipped reclaim and would cost this one a user's sandbox: there
  // is no later pass that undoes a stop.
  const { values, deleted } = bindKv(
    { [KEY]: pending(ABANDONED, HORIZON + 60_000) },
    new Set([`lock.${SCOPE}`]),
  );
  const stopped = recordStops();
  healthyEndpoints();

  await sweepStaleHandsForTest();

  assert.deepEqual(stopped, [],
    `stopped ${JSON.stringify(stopped)} on the strength of a failed KV read`);
  assert.deepEqual(deleted, []);
  assert.ok(values.has(KEY));
});
