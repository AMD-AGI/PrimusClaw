// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Admission and the sweep, driven as one tick.
 *
 * A target another replica created appears mid-sweep as a handle record for an
 * identity this roster does not hold. Reconciling it has to happen before this
 * sweep serves it: deferring it to whatever capacity the admitted targets leave
 * starves exactly the sandbox that is holding live background work, because
 * that one was never admitted here.
 *
 * Driven through `runKeepaliveTickForTest` rather than by calling the roster
 * directly, so what is asserted is that a real tick both admits the target and
 * pings it.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import {
  registerSandbox, resetBackgroundWorkStateForTest, runKeepaliveTickForTest, unregisterSandbox,
} from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { rosterStore } from "../src/sandbox/roster-store.js";
import type { Roster, RosterConfig } from "../src/sandbox/admission-roster.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const CONFIG: RosterConfig = {
  ceiling: 8, reconciliationReserve: 2, reclaimHorizonMs: 900_000, replicaId: "replica-a",
};

const entry = (workloadId: string) => JSON.stringify({
  status: "ready", provider: "safe-workload", workloadId,
  platformKey: "pk", namespace: "ns",
  handsUrl: `http://${workloadId}:9100/mcp`, token: "tok",
});

/** A revision-aware KV whose contents a test can change mid-tick. */
function makeKv(values: Map<string, Uint8Array>): KV & { seed(key: string, value: string): void } {
  const revisions = new Map<string, number>();
  const bump = (k: string) => revisions.set(k, (revisions.get(k) ?? 0) + 1);
  return {
    // Seeding goes through the same revision bookkeeping a write does; a value
    // whose revision the stub never recorded makes every conditional write on
    // it lose, which would read as the code under test refusing to update.
    seed(key: string, value: string) { values.set(key, sc.encode(value)); bump(key); },
    async get(key: string) {
      if (!values.has(key)) return null;
      return { value: values.get(key)!, revision: revisions.get(key) ?? 1 };
    },
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...values.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async put(key: string, value: Uint8Array) { values.set(key, value); bump(key); return 1; },
    async create(key: string, value: Uint8Array) {
      if (values.has(key)) throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      values.set(key, value); bump(key); return 1;
    },
    async update(key: string, value: Uint8Array, expected: number) {
      if ((revisions.get(key) ?? 0) !== expected) {
        throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      }
      values.set(key, value); bump(key); return 1;
    },
    async delete(key: string) { values.delete(key); },
  } as unknown as KV;
}

let values: Map<string, Uint8Array>;
let kv: KV & { seed(key: string, value: string): void };
let restoreProviders: (() => void) | null = null;
/** Which sandboxes this tick actually reached. */
let pinged: string[];

beforeEach(() => {
  values = new Map();
  kv = makeKv(values);
  pinged = [];
  resetBackgroundWorkStateForTest();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }) {
        pinged.push(inst.id);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as SandboxProvider,
  });
});

afterEach(() => {
  restoreProviders?.();
  restoreProviders = null;
  unregisterSandbox("sess-local");
  resetBackgroundWorkStateForTest();
});

const roster = (): Roster | null => {
  const raw = values.get("keepalive.roster");
  return raw ? JSON.parse(sc.decode(raw)) as Roster : null;
};

test("a handle record another replica wrote is admitted and pinged in the same tick", async () => {
  // This replica knows about one sandbox; the other appears only as a record in
  // the bucket, and it is the one holding the active background shell.
  registerSandbox("sess-local", { provider: "safe-workload", workloadId: "wl-local", platformKey: "pk", namespace: "ns" });
  kv.seed("hands.sess-remote", entry("wl-remote"));

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => 1,
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  const identities = roster()!.entries.map((e) => e.identity);
  assert.ok(identities.includes("sess-remote:safe:wl-remote"),
    "an un-admitted target is reconciled in before the sweep serves it, not left "
      + "to whatever capacity the admitted ones leave");
  assert.ok(pinged.includes("wl-remote"),
    "and it is pinged in this tick -- a target admitted but not served is the "
      + "sandbox being reclaimed on schedule");
  assert.ok(pinged.includes("wl-local"));
});

test("a full roster still admits and serves a remote target", async () => {
  // At the reserve boundary an ordinary claim is refused. Reconciliation is not
  // an ordinary claim: the target already exists and its refresh is this
  // replica's business whoever created it.
  const filler = Array.from({ length: CONFIG.ceiling - CONFIG.reconciliationReserve }, (_, i) => ({
    identity: `sandbox-filler-${i}`, token: `t${i}`, claimedBy: "replica-b", renewedAtMs: Date.now(),
  }));
  kv.seed("keepalive.roster", JSON.stringify({ ceiling: CONFIG.ceiling, entries: filler }));
  kv.seed("hands.sess-remote", entry("wl-remote"));

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => 1,
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  assert.ok(roster()!.entries.some((e) => e.identity === "sess-remote:safe:wl-remote"));
  assert.ok(pinged.includes("wl-remote"));
});

test("a sandbox that is unregistered gives its slot straight back", async () => {
  // Held past the unregister, the slot counts against the ceiling for a sandbox
  // that no longer exists, and an ordinary teardown becomes a capacity refusal
  // for the next request.
  const { bindAdmission, admitSandbox } = await import("../src/sandbox/admission.js");
  bindAdmission(kv, { ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve });
  const identity = "sess-local:safe:wl-local";

  const hold = await admitSandbox("sess-local");
  await hold.bind(identity);
  registerSandbox("sess-local", { provider: "safe-workload", workloadId: "wl-local", platformKey: "pk", namespace: "ns" });
  assert.ok(roster()!.entries.some((e) => e.identity === identity));

  unregisterSandbox("sess-local");
  await new Promise((r) => setImmediate(r));

  assert.ok(!roster()!.entries.some((e) => e.identity === identity),
    "released on the ordinary path, not left to the stale horizon");
});
