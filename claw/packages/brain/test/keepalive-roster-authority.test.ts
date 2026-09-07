// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * B42 -- the roster is what the ceiling is enforced against, so it has to be
 * one slot per physical sandbox and it has to be reconciled before it is used.
 *
 * Three ways it was not. One sandbox reachable through two logical names -- a
 * session binding and a DAG handle map under a different root -- took two slots
 * and two pings a sweep, understating the deferral count the idle-GC deadline is
 * proven against. A claim committed before any census had run was checked
 * against a roster stamped empty at boot. And a sweep whose reconciliation
 * failed went on to serve targets no roster held, spending its ping budget
 * against a count nobody could write.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import {
  registerSandbox, resetBackgroundWorkStateForTest, runKeepaliveTickForTest, unregisterSandbox,
} from "../src/sandbox/keepalive.js";
import {
  SandboxCapacityRefused, admitSandbox, bindAdmission, latchRosterStale,
} from "../src/sandbox/admission.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { rosterStore } from "../src/sandbox/roster-store.js";
import type { Roster, RosterConfig } from "../src/sandbox/admission-roster.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const CONFIG: RosterConfig = {
  ceiling: 8, reconciliationReserve: 2, reclaimHorizonMs: 900_000, replicaId: "replica-a",
};
const CAPACITY = { ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve };

const entry = (workloadId: string, over: Record<string, unknown> = {}) => JSON.stringify({
  status: "ready", provider: "safe-workload", workloadId,
  platformKey: "pk", namespace: "ns",
  handsUrl: `http://${workloadId}:9100/mcp`, token: "tok",
  ...over,
});

function makeKv(values: Map<string, Uint8Array>): KV & { seed(key: string, value: string): void } {
  const revisions = new Map<string, number>();
  const bump = (k: string) => revisions.set(k, (revisions.get(k) ?? 0) + 1);
  return {
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
let pinged: string[];

beforeEach(() => {
  values = new Map();
  kv = makeKv(values);
  pinged = [];
  latchRosterStale(false);
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
  unregisterSandbox("sess-dag-node");
  resetBackgroundWorkStateForTest();
});

const roster = (): Roster | null => {
  const raw = values.get("keepalive.roster");
  return raw ? JSON.parse(sc.decode(raw)) as Roster : null;
};

test("one physical sandbox named twice takes one slot and one ping", async () => {
  // The same container: bound to the node's session and held in the DAG's
  // handle map under the root. Two logical names, and a roster keyed by the
  // name it was reached through counts the sandbox twice -- two slots against
  // one ceiling, and its refresh gap proven from a deferral count that is wrong
  // for every other handle in the fleet.
  kv.seed("hands.sess-dag-node", entry("wl-shared"));

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => 1,
    listDagHandles: async () => [["dag-root-1", {
      primary: {
        workload_id: "wl-shared", platform_key: "pk", provider: "safe-workload",
        hands_url: "http://wl-shared:9100/mcp", namespace: "ns",
      },
    }]],
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  const held = roster()!.entries.filter((e) => e.identity?.includes("wl-shared"));
  assert.equal(held.length, 1, `one sandbox, one slot: ${JSON.stringify(held)}`);
  assert.deepEqual(pinged, ["wl-shared"], "and pinged once, not once per name");
});

test("a claim arriving before the first census is refused", async () => {
  // The roster is stamped empty at boot and the fleet is reconciled onto it by
  // a sweep. A claim committed in between is checked against a count that omits
  // every sandbox this replica did not create, which is the ceiling enforced
  // against a number nobody took.
  kv.seed("hands.sess-elsewhere", entry("wl-elsewhere"));
  await bindAdmission(kv, CAPACITY);

  await assert.rejects(() => admitSandbox("sess-new"), SandboxCapacityRefused);

  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 1, roster: { store: rosterStore(kv), config: CONFIG },
  });

  const hold = await admitSandbox("sess-new");
  await hold.bind("safe:wl-new");
  assert.equal(roster()!.entries.length, 2,
    "and the claim is now checked against a roster holding the running fleet");
});

test("a reconciliation that failed serves what it admitted and refuses the rest", async () => {
  // Reconcile-before-serving is what makes the deferral count a number the
  // fleet agrees on. A sweep that could not reconcile and pinged everything
  // anyway spends its budget on targets no roster holds -- while an admitted
  // one, which may be the sandbox holding live background work, waits behind
  // them.
  kv.seed("keepalive.roster", JSON.stringify({
    ceiling: CONFIG.ceiling,
    entries: [{
      identity: "safe:wl-admitted", token: "t0", claimedBy: "replica-b",
      renewedAtMs: Date.now(),
    }],
  }));
  kv.seed("hands.sess-admitted", entry("wl-admitted"));
  kv.seed("hands.sess-unadmitted", entry("wl-unadmitted"));
  // Every conditional write on the roster loses, which is what a reconcile that
  // cannot commit looks like from here.
  const realUpdate = kv.update.bind(kv);
  (kv as unknown as { update: unknown }).update = async (
    key: string, value: Uint8Array, expected: number,
  ) => {
    if (key === "keepalive.roster") {
      throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
    }
    return realUpdate(key, value, expected);
  };

  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 1, roster: { store: rosterStore(kv), config: CONFIG },
  });

  assert.deepEqual(pinged, ["wl-admitted"],
    "the admitted target keeps its refresh; the unadmitted one is not served");
});
