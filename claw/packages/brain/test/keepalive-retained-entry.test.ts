// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A container retained because it still holds live work, as the sweep sees it.
 *
 * The retention keeps its binding in the same keyspace the sweep already walks,
 * because anywhere else and nothing pings it: the container falls out of the
 * routing and the keepalive paths together and is reclaimed as idle with the
 * work in it, which is the destruction the retention exists to prevent.
 *
 * Its key names no session, so the owner scope a probe would ask about owns
 * nothing. A probe there reads zero, files the container idle, and reclaims it.
 * The entry therefore carries a marker only a retention writes, and the sweep
 * treats a marked entry as a case of its own: pinged like any other, never
 * probed for a count, never marked idle, never destroyed on a failed ping.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import { ledgerKeyForRetention, retentionKey } from "../src/sandbox/retain-container.js";
import {
  runKeepaliveTickForTest, resetBackgroundWorkStateForTest,
} from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const GENERATION = "sb-generation-1";
const KEY = retentionKey(GENERATION);

const RETAINED = {
  status: "ready",
  provider: "safe-workload",
  workloadId: "wl-retained",
  platformKey: "pk",
  namespace: "ns",
  handsUrl: "http://sandbox:9100/mcp",
  token: "tok",
  sandboxName: GENERATION,
  protected: true,
  reason: "protected",
  detail: "live_work_present",
  // Long past any reuse window, and with the markers an ordinary idle handle
  // would be expired on. A retention must survive both.
  keepalive: false,
  idleSince: 0,
};

let restoreProviders: (() => void) | null = null;

afterEach(() => {
  resetBackgroundWorkStateForTest();
  restoreProviders?.();
  restoreProviders = null;
});

/** A provider whose ping succeeds, and that records every exec it was asked. */
function stubProvider(): { execs: string[] } {
  const execs: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec(_inst: unknown, command: string) {
      execs.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async stop() {},
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  return { execs };
}

const LEDGER = ledgerKeyForRetention(KEY);
const PROJECTION_REVISION = 5;
const LEDGER_REVISION = 9;

/**
 * The bucket, with the retention's two halves in it.
 *
 * `ledger` says whether the record under `retention.` is still there, because
 * the sweep has to tell "expired or refreshable" from "released by another
 * replica" and must act oppositely on the two.
 */
function fakeKv(opts: { ledger?: boolean; ledgerWriteFails?: boolean } = {}): {
  kv: KV; deleted: string[]; updated: { key: string; revision: number }[]; put: string[];
} {
  const ledgerPresent = opts.ledger ?? true;
  const deleted: string[] = [];
  const updated: { key: string; revision: number }[] = [];
  const put: string[] = [];
  const kv = {
    async keys(filter = ">") {
      const matched = filterToRegExp(filter).test(KEY) && !deleted.includes(KEY) ? [KEY] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (deleted.includes(key)) return null;
      if (key === KEY) {
        return { key, value: sc.encode(JSON.stringify(RETAINED)), revision: PROJECTION_REVISION };
      }
      if (key === LEDGER && ledgerPresent) {
        return { key, value: sc.encode(JSON.stringify(RETAINED)), revision: LEDGER_REVISION };
      }
      return null;
    },
    async delete(key: string) { deleted.push(key); },
    async put(key: string) { put.push(key); return 1; },
    async update(key: string, _v: unknown, revision: number) {
      if (key === LEDGER && opts.ledgerWriteFails) throw new Error("bucket refused the write");
      updated.push({ key, revision });
      return revision + 1;
    },
  } as unknown as KV;
  return { kv, deleted, updated, put };
}

/** Whether this sweep re-put `key` at the revision it had just read. */
function refreshed(updated: { key: string; revision: number }[], key: string, revision: number) {
  return updated.some((u) => u.key === key && u.revision === revision);
}

/**
 * Sweep twice, letting any probe land in between.
 *
 * The probe runs behind the sweep, so a single tick decides on `unknown` and
 * only the second sees an answer. A retention must survive both, which is what
 * a one-tick fixture could not tell.
 */
async function sweepTwice(kv: KV, countActiveShells: () => Promise<number>): Promise<void> {
  await runKeepaliveTickForTest({ kv, countActiveShells });
  await new Promise((r) => setImmediate(r));
  await runKeepaliveTickForTest({ kv, countActiveShells });
}

test("its key lies in the namespace the sweep walks, in that sweep's own key shape", () => {
  // A key shaped otherwise is not walked at all, and the container it names
  // would be pinged by nobody.
  assert.ok(filterToRegExp("hands.*").test(KEY), `${KEY} is outside the sweep's walk`);
  assert.match(KEY, /^hands\.retained-[A-Z2-7]+$/,
    "base32 only, so every generation is writable whatever bytes it holds");
});

test("a retained entry is never probed for a shell count", async () => {
  // Its key names no session, so a probe would ask about a scope that owns
  // nothing, read zero, and file the container idle -- reclaiming the very work
  // it is held for.
  const { kv } = fakeKv();
  stubProvider();
  let probes = 0;
  await sweepTwice(kv, async () => { probes += 1; return 0; });
  assert.equal(probes, 0, "the retention was probed for a shell count");
});

test("a retained entry past the idle window is not expired", async () => {
  // The same fixture an ordinary handle is deleted on: idle markers set, the
  // reuse window long gone, nothing registered locally.
  const { kv, deleted } = fakeKv();
  stubProvider();
  await sweepTwice(kv, async () => 0);
  assert.deepEqual(deleted, [], "the retention was reclaimed as an idle handle");
});

test("a retained entry has its TTL refreshed, so the bucket does not drop it", async () => {
  // Keeping it is only half of it: this bucket expires entries on its own, so
  // one never re-put vanishes from under the work anyway.
  const { kv, updated } = fakeKv();
  stubProvider();
  await sweepTwice(kv, async () => 0);
  assert.ok(refreshed(updated, KEY, PROJECTION_REVISION),
    `re-put at the revision just read; updates=${JSON.stringify(updated)}`);
});

test("the record behind it is refreshed too, so the repair path outlives one TTL", async () => {
  // The projection is what a pre-scheme replica overwrites and the record under
  // `retention.` is the only thing it is put back from. That record is in the
  // same bucket as the projection, so refreshing one and not the other leaves
  // the repair working for one TTL window and silently never again.
  const { kv, updated } = fakeKv();
  stubProvider();
  await sweepTwice(kv, async () => 0);
  assert.ok(refreshed(updated, LEDGER, LEDGER_REVISION),
    `the record was not re-put at the revision just read; updates=${JSON.stringify(updated)}`);
});

test("a record another replica released is not written back", async () => {
  // `releaseRetention` removes the record first and the projection second, so a
  // sweep that finds the record gone is looking at a retention already given
  // up -- possibly between its own two writes. Creating it again would have the
  // next `reassertRetentions` restore a retention whose work had finished, and
  // the container it protects would then be held against admission by nothing
  // any sweep can retire.
  const { kv, updated, put } = fakeKv({ ledger: false });
  stubProvider();
  await sweepTwice(kv, async () => 0);
  assert.ok(!updated.some((u) => u.key === LEDGER) && !put.includes(LEDGER),
    `the released record was written back; updates=${JSON.stringify(updated)}, puts=${JSON.stringify(put)}`);
});

test("a record the bucket refuses does not cost the retention its refresh", async () => {
  // Losing the backup is not losing the protection: the projection is what
  // keeps the container out of the sweep's reclaim, so a failed record write is
  // logged and the entry stands rather than being failed back to the sweep.
  const { kv, deleted, updated } = fakeKv({ ledgerWriteFails: true });
  stubProvider();
  await sweepTwice(kv, async () => 0);
  assert.ok(refreshed(updated, KEY, PROJECTION_REVISION),
    `the projection was not refreshed; updates=${JSON.stringify(updated)}`);
  assert.deepEqual(deleted, [], "the retention was reclaimed over a failed record write");
});

test("a retention is not eligible for post-task idle reuse", async () => {
  // It exists to protect work, never to be handed to a new session, and no
  // acquisition looks under this key: acquisition resolves a session key, and
  // this is not one.
  const { sessionIdFromHandsKey, handsSessionKey } = await import("../src/sandbox/hands-key.js");
  const named = sessionIdFromHandsKey(KEY);
  assert.notEqual(handsSessionKey(named), KEY,
    "a session id resolving back to a retention's key would let an acquisition take it");
});
