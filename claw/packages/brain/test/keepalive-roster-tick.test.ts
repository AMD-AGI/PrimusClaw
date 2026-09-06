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
/** Runs inside the ping phase, so a test can make something arrive mid-sweep. */
let onPing: (() => void) | null = null;

beforeEach(() => {
  values = new Map();
  kv = makeKv(values);
  pinged = [];
  onPing = null;
  resetBackgroundWorkStateForTest();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }) {
        pinged.push(inst.id);
        onPing?.();
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

test("remote registrations past the ceiling are admitted, reported, and served", async () => {
  // Genuinely over-cap: the roster is at the reserve boundary and three more
  // targets appear that it does not hold, which is more than the reserve and
  // more than the ceiling. Reconciliation is not an ordinary claim -- those
  // sandboxes exist and their refresh is this replica's business whoever
  // created them -- so it admits regardless and the size above the ceiling is
  // declared rather than resolved by dropping one.
  const filler = Array.from({ length: CONFIG.ceiling - CONFIG.reconciliationReserve }, (_, i) => ({
    identity: `sandbox-filler-${i}`, token: `t${i}`, claimedBy: "replica-b", renewedAtMs: Date.now(),
  }));
  kv.seed("keepalive.roster", JSON.stringify({ ceiling: CONFIG.ceiling, entries: filler }));
  for (const n of [1, 2, 3]) kv.seed(`hands.sess-remote-${n}`, entry(`wl-remote-${n}`));

  const probed: string[] = [];
  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async (_url, _token, owner) => { probed.push(owner); return 1; },
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  const after = roster()!;
  assert.equal(after.entries.length, filler.length + 3);
  assert.ok(after.entries.length > CONFIG.ceiling, "genuinely past the declared ceiling");
  for (const n of [1, 2, 3]) {
    assert.ok(after.entries.some((e) => e.identity === `sess-remote-${n}:safe:wl-remote-${n}`), `remote ${n}`);
    assert.ok(pinged.includes(`wl-remote-${n}`),
      "served in this tick, not deferred behind the admitted ones");
  }
  for (const seeded of filler) {
    assert.ok(after.entries.some((e) => e.identity === seeded.identity),
      "nothing is expired, reclaimed or evicted on account of the breach");
  }

  // An ordinary claim stays refused while the breach stands.
  const { bindAdmission, admitSandbox, SandboxCapacityRefused } =
    await import("../src/sandbox/admission.js");
  await bindAdmission(kv, {
    ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve,
  });
  await assert.rejects(() => admitSandbox("sess-new"), SandboxCapacityRefused);
});

test("a registration arriving mid-sweep is admitted and served by the next one", async () => {
  // The sweep takes its target list once and then serves it, so a sandbox
  // registered after that snapshot belongs to the next tick. What must hold is
  // that it is not lost: the roster admits it when the next sweep sees it, and
  // nothing about the tick it arrived during leaves it unaccounted for.
  kv.seed("hands.sess-existing", entry("wl-existing"));
  let arrived = false;
  // The ping phase runs after the target list is taken and after admission, so
  // a registration made from inside it is one that lands mid-sweep.
  onPing = () => {
    if (arrived) return;
    arrived = true;
    kv.seed("hands.sess-latecomer", entry("wl-latecomer"));
    registerSandbox("sess-local", {
      provider: "safe-workload", workloadId: "wl-local", platformKey: "pk", namespace: "ns",
    });
  };

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => 1,
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  assert.ok(arrived, "the registration really did land during the sweep");
  assert.ok(!pinged.includes("wl-latecomer"), "it belongs to the next tick, not this one");

  pinged.length = 0;
  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => 1,
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  const identities = roster()!.entries.map((e) => e.identity);
  assert.ok(identities.includes("sess-latecomer:safe:wl-latecomer"),
    "admitted, so it counts against the ceiling like every other target");
  assert.ok(identities.includes("sess-local:safe:wl-local"));
  assert.ok(pinged.includes("wl-latecomer"), "and served");
  assert.ok(pinged.includes("wl-local"));
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

test("a sandbox parked for idle reuse keeps its slot", async () => {
  // A turn that ends stops pinging its sandbox but keeps the handle for the
  // next message, and a background shell started that turn is expected to still
  // be there. Releasing the slot then hands the ceiling to another provisioning
  // while this sandbox is still a target the sweep will reconcile back in --
  // the over-cap state admission exists to prevent, reached through ordinary
  // use rather than through a race.
  const { bindAdmission, admitSandbox } = await import("../src/sandbox/admission.js");
  await bindAdmission(kv, {
    ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve,
  });
  const identity = "sess-local:safe:wl-local";
  const hold = await admitSandbox("sess-local");
  await hold.bind(identity);
  registerSandbox("sess-local", {
    provider: "safe-workload", workloadId: "wl-local", platformKey: "pk", namespace: "ns",
  });

  unregisterSandbox("sess-local", undefined, { releaseSlot: false });
  await new Promise((r) => setImmediate(r));

  assert.ok(roster()!.entries.some((e) => e.identity === identity),
    "the slot stays with a sandbox that is still reusable and still counted");
});
