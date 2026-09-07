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
import { retentionKey } from "../src/sandbox/retain-container.js";
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

function fakeKv(): { kv: KV; deleted: string[]; updated: number[] } {
  const deleted: string[] = [];
  const updated: number[] = [];
  const kv = {
    async keys(filter = ">") {
      const matched = filterToRegExp(filter).test(KEY) && !deleted.includes(KEY) ? [KEY] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (key !== KEY || deleted.includes(key)) return null;
      return { key, value: sc.encode(JSON.stringify(RETAINED)), revision: 5 };
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return 1; },
    async update(_k: string, _v: unknown, rev: number) { updated.push(rev); return rev + 1; },
  } as unknown as KV;
  return { kv, deleted, updated };
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
  assert.ok(updated.includes(5), `re-put at the revision just read; updates=${JSON.stringify(updated)}`);
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
