// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reaper's two `hands.*` walks must step over a retained container.
 *
 * A retention keeps its binding in the keyspace every sweep already walks --
 * that is the whole scheme, because anywhere else and nothing pings the
 * container -- and the projection it writes there is a copy of the session
 * binding it replaced: same `status`, same `handsUrl`, same `token`, same idle
 * markers. So it passes every filter these two walks apply, and neither of them
 * asks the one question that separates it from a session's handle.
 *
 * What follows from that is the destruction the retention exists to prevent.
 * The health sweep checks the retained container's endpoint, files the failures
 * under a session id no session has -- the key names a sandbox generation --
 * and, where an operator has enabled eviction, stops the container and deletes
 * the projection with it, taking the live work that was the reason for
 * retaining it. The multi-node sweep reads markers nothing refreshes as a
 * handle idle past its reclaim window and spends a control-plane lookup on a
 * session that never existed, every pass, for as long as the work runs.
 *
 * A retention ends one way: the keepalive sweep reading evidence out of the
 * container that its work has finished. Its walk makes this exact check.
 */
import "./sweeper-evict-env.js";

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import {
  bindClusterReclaimForTest, sweepIdleMultiNodeClustersForTest, sweepStaleHandsForTest,
} from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { retentionKey } from "../src/sandbox/retain-container.js";
import { MULTI_NODE_IDLE_RECLAIM_MS, SANDBOX_SWEEPER_EVICT_AFTER_FAILURES } from "../src/config.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();

/** The generation a retention is keyed by: the endpoint that names the container. */
const GENERATION = "http://retained:9100/mcp";
const RETENTION_KEY = retentionKey(GENERATION);

const LIVE_SESSION = "sess-live";
const LIVE_KEY = `hands.${LIVE_SESSION}`;

/** Idle for longer than the reclaim window, which is what both sweeps read as
 *  their licence. A retention carries whatever the binding it replaced held,
 *  and nothing ever moves it forward again. */
const IDLE_SINCE = Date.now() - (MULTI_NODE_IDLE_RECLAIM_MS + 60_000);

const LIVE_BINDING = {
  status: "ready",
  provider: "safe-workload",
  workloadId: "wl-live",
  platformKey: "pk",
  namespace: "ns",
  handsUrl: "http://live:9100/mcp",
  token: "tok-live",
  keepalive: false,
  sessionDeleted: true,
  idleSince: IDLE_SINCE,
};

/** What `retainContainer` writes: the binding, plus the marker and its reason. */
const RETAINED = {
  ...LIVE_BINDING,
  workloadId: "wl-retained",
  handsUrl: GENERATION,
  token: "tok-retained",
  protected: true,
  reason: "protected",
  detail: "live_work_present",
  retainedAt: new Date(0).toISOString(),
};

let restoreProviders: (() => void) | null = null;
let restoreReclaim: (() => void) | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreProviders?.();
  restoreProviders = null;
  restoreReclaim?.();
  restoreReclaim = null;
});

/** The bucket, holding a retention's projection beside an ordinary handle. */
function bindKv(): { deleted: string[] } {
  const deleted: string[] = [];
  const values = new Map<string, string>([
    [RETENTION_KEY, JSON.stringify(RETAINED)],
    [LIVE_KEY, JSON.stringify(LIVE_BINDING)],
  ]);
  const kv = {
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...values.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      const raw = values.get(key);
      return raw === undefined ? null : { key, value: sc.encode(raw), revision: 3 };
    },
    async put() { return 1; },
    async update() { return 4; },
    async delete(key: string) { deleted.push(key); values.delete(key); },
  } as unknown as KV;
  bindHandsKv(kv);
  return { deleted };
}

/** Every endpoint the health sweep asked about, all of them answering unhealthy. */
function recordHealthChecks(): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    return { ok: false, status: 503 } as Response;
  }) as typeof fetch;
  return seen;
}

/** Every container a sweep decided to stop. */
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

test("the health sweep does not probe or evict a retained container", async () => {
  assert.equal(SANDBOX_SWEEPER_EVICT_AFTER_FAILURES, 1,
    "with eviction disabled this test would pass without ever reaching the destroy");
  const { deleted } = bindKv();
  const checked = recordHealthChecks();
  const stopped = recordStops();
  restoreReclaim = bindClusterReclaimForTest(async () => 0);

  await sweepStaleHandsForTest();

  assert.deepEqual(checked, ["http://live:9100/health"],
    "the retained container's endpoint was health-checked as though it were a session's");
  assert.deepEqual(stopped, ["wl-live"],
    "the retained container was stopped -- the live work it was holding is gone, "
    + "and nothing brings it back");
  assert.deepEqual(deleted, [LIVE_KEY],
    "the projection was deleted, so nothing names the container any more");
});

test("the multi-node sweep does not reclaim against a retention's key", async () => {
  assert.ok(MULTI_NODE_IDLE_RECLAIM_MS > 0, "the sweeper is unconditional; this must hold");
  bindKv();
  const reclaimed: string[] = [];
  restoreReclaim = bindClusterReclaimForTest(async (sessionId: string) => {
    reclaimed.push(sessionId);
    return 0;
  });

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(reclaimed, [LIVE_SESSION],
    "a reclaim was asked for under a session id derived from a retention's key, "
    + "which names a generation and no session");
});
