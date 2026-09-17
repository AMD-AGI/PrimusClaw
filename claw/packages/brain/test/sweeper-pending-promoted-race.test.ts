// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The collector must not act on a snapshot the world has moved past.
 *
 * The sweep reads `hands.<sid>` and then reads the run lease, and both reads are
 * separate points in time. The creator that entry belongs to finishes in
 * exactly that gap: it promotes PENDING -> READY (a plain `kv.put`, see
 * ensure-hands) and then releases `lock.<scope>` at the end of its run. A
 * collector that carries the first read forward therefore sees a free lease and
 * stops a workload whose session is, by then, happily attached to it.
 *
 * The order is what makes this detectable rather than merely unlikely: the
 * promotion happens BEFORE the release, so any lease that reads free has a
 * promotion already durable behind it. Re-reading the entry after the lease read
 * -- and refusing the stop unless it still sits at the revision the decision was
 * taken at -- turns "the lease was free a moment ago" into "and the record this
 * is about has not moved since".
 *
 * The revision-conditional DELETE cannot stand in for that. It runs after the
 * stop, so at best it reports the race: the workload is already gone and the
 * session's READY entry is left pointing at it.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { sweepStaleHandsForTest } from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { SANDBOX_PENDING_ABANDONED_AFTER_MS } from "../src/config.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();

const SESSION = "sess-promoted-race";
const KEY = `hands.${SESSION}`;
const SCOPE = "ws.workspace-9";
const WORKLOAD = "wl-being-promoted";
const HORIZON = SANDBOX_PENDING_ABANDONED_AFTER_MS;

let restoreProviders: (() => void) | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  restoreProviders?.();
  restoreProviders = null;
});

function pendingPayload(ageMs: number) {
  return {
    status: "pending",
    provider: "safe-workload",
    workloadId: WORKLOAD,
    platformKey: "pk",
    namespace: "ns",
    token: "tok",
    runScope: SCOPE,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
  };
}

interface Deletion { key: string; previousSeq?: number }

/**
 * An in-memory KV with per-write revisions, as NATS has: a write bumps the
 * revision, so "still at the revision I read" is a real statement about whether
 * anybody else has written. `onGet` is where a concurrent writer is spliced in.
 */
function bindKv(
  seed: Record<string, unknown>,
  onGet: (key: string, store: Store) => Promise<void> | void = () => {},
) {
  let revision = 0;
  const values = new Map<string, { raw: string; revision: number }>();
  const deleted: Deletion[] = [];
  const store: Store = {
    put(key: string, value: unknown) {
      revision += 1;
      values.set(key, { raw: JSON.stringify(value), revision });
    },
    read(key: string) { return values.get(key); },
  };
  for (const [k, v] of Object.entries(seed)) store.put(k, v);
  const kv = {
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...values.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      await onGet(key, store);
      const found = values.get(key);
      return found === undefined
        ? null
        : { key, value: sc.encode(found.raw), revision: found.revision, operation: "PUT" };
    },
    async put(key: string, value: Uint8Array) {
      store.put(key, JSON.parse(sc.decode(value)));
      return 1;
    },
    async update() { return revision + 1; },
    async delete(key: string, opts?: { previousSeq?: number }) {
      deleted.push({ key, previousSeq: opts?.previousSeq });
      const found = values.get(key);
      // CAS, as the bucket does it: a delete pinned to a revision the entry has
      // moved past does not land.
      if (opts?.previousSeq !== undefined && found && found.revision !== opts.previousSeq) {
        throw new Error("wrong last sequence");
      }
      values.delete(key);
    },
  } as unknown as KV;
  bindHandsKv(kv);
  return { store, deleted };
}

interface Store {
  put(key: string, value: unknown): void;
  read(key: string): { raw: string; revision: number } | undefined;
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

function healthyEndpoints(): void {
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
}

test("a pending entry promoted to READY while the sweep was deciding is left alone", async () => {
  assert.ok(HORIZON > 0, "the collector is off; this test would assert nothing");
  let promoted = false;
  const { store, deleted } = bindKv(
    { [KEY]: pendingPayload(HORIZON + 60_000) },
    (key, s) => {
      // The creator finishing, in the gap the collector used to carry its
      // snapshot across: READY is written first, the run lock is released
      // after, and this read is the one that reports the lock free.
      if (key !== `lock.${SCOPE}` || promoted) return;
      promoted = true;
      s.put(KEY, {
        ...pendingPayload(HORIZON + 60_000),
        status: "ready",
        handsUrl: "http://live:9100/mcp",
      });
    },
  );
  const stopped = recordStops();
  healthyEndpoints();

  await sweepStaleHandsForTest();

  assert.ok(promoted, "the promotion never happened; this test asserted nothing");
  assert.deepEqual(stopped, [],
    `stopped ${JSON.stringify(stopped)}: that workload is the sandbox the session has `
    + "just been told is ready, and the run attached to it loses it mid-turn");
  assert.deepEqual(deleted, [],
    "and nothing may be deleted either -- the entry is a live binding now");
  const left = store.read(KEY);
  assert.equal(JSON.parse(left!.raw).status, "ready",
    "the READY binding the creator wrote must survive the pass untouched");
});

test("and a pending entry nothing touched is still collected", async () => {
  // The other half: the guard above must cost nothing when the world did not
  // move, or the leak it was added to close comes straight back.
  const { store, deleted } = bindKv({ [KEY]: pendingPayload(HORIZON + 60_000) });
  const seeded = store.read(KEY)!.revision;
  const stopped = recordStops();
  healthyEndpoints();

  await sweepStaleHandsForTest();

  assert.deepEqual(stopped, [WORKLOAD],
    "an entry no one has written to since the walk is exactly what the collector is for");
  assert.deepEqual(deleted, [{ key: KEY, previousSeq: seeded }],
    "deleted at the revision the decision was read at, and no other");
  assert.equal(store.read(KEY), undefined);
});
