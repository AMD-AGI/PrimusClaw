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
import { ledgerKeyForRetention, retentionKey } from "../src/sandbox/retain-container.js";
import { latchRosterStale } from "../src/sandbox/admission.js";
import type { Roster, RosterConfig } from "../src/sandbox/admission-roster.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const CONFIG: RosterConfig = {
  ceiling: 8, reconciliationReserve: 2, reclaimHorizonMs: 900_000, replicaId: "replica-a",
};

const entry = (workloadId: string, over: Record<string, unknown> = {}) => JSON.stringify({
  status: "ready", provider: "safe-workload", workloadId,
  platformKey: "pk", namespace: "ns",
  handsUrl: `http://${workloadId}:9100/mcp`, token: "tok",
  ...over,
});

/** An idle-parked handle: not pinged until something says it is still working,
 *  which is the only shape that reaches the active-shell probe. */
const retained = (workloadId: string) => entry(workloadId, { keepalive: false, idleSince: 0 });

/**
 * A revision-aware KV whose contents a test can change mid-tick, enumerating in
 * NATS stream-sequence order.
 *
 * The order is the point. `KV.keys()` is a consumer over the bucket's stream
 * delivering the last value per subject, so what comes back is ordered by the
 * sequence of each key's most recent *write*, not by when the key was first
 * created. Every refresh therefore moves its key to the back of the walk, and a
 * phase that refreshes a subset -- a ping batch that ran out of budget, say --
 * permutes the keyspace between one sweep and the next.
 *
 * An insertion-ordered stub hides that completely: it hands every sweep the
 * same walk in the same order, which is the one assumption a scheduler keyed on
 * position in the walk needs in order to look correct. So this stub keeps a
 * global write counter and sorts `keys()` by it, and any scheduling property
 * asserted through it is asserted against a keyspace that really does move.
 */
function makeKv(values: Map<string, Uint8Array>): KV & { seed(key: string, value: string): void } {
  const revisions = new Map<string, number>();
  const sequence = new Map<string, number>();
  let stream = 0;
  const bump = (k: string) => {
    revisions.set(k, (revisions.get(k) ?? 0) + 1);
    sequence.set(k, ++stream);
  };
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
      const matched = [...values.keys()].filter((k) => re.test(k))
        .sort((a, b) => (sequence.get(a) ?? 0) - (sequence.get(b) ?? 0));
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
    async delete(key: string) { values.delete(key); sequence.delete(key); },
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
  // Module state: a replica that latched in one test must not refuse in the next.
  latchRosterStale(false);
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
  assert.ok(identities.includes("safe:wl-remote"),
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
    assert.ok(after.entries.some((e) => e.identity === `safe:wl-remote-${n}`), `remote ${n}`);
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
  assert.ok(identities.includes("safe:wl-latecomer"),
    "admitted, so it counts against the ceiling like every other target");
  assert.ok(identities.includes("safe:wl-local"));
  assert.ok(pinged.includes("wl-latecomer"), "and served");
  assert.ok(pinged.includes("wl-local"));
});

test("a sandbox that is unregistered gives its slot straight back", async () => {
  // Held past the unregister, the slot counts against the ceiling for a sandbox
  // that no longer exists, and an ordinary teardown becomes a capacity refusal
  // for the next request.
  const { bindAdmission, admitSandbox, markCensusReconciled } =
    await import("../src/sandbox/admission.js");
  bindAdmission(kv, { ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve });
  // No sweep runs here, and admission refuses every claim until one has
  // reconciled a census onto the roster.
  markCensusReconciled();
  const identity = "safe:wl-local";

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
  const { bindAdmission, admitSandbox, markCensusReconciled } =
    await import("../src/sandbox/admission.js");
  await bindAdmission(kv, {
    ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve,
  });
  markCensusReconciled();
  const identity = "safe:wl-local";
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

test("mid-sweep arrival, over-cap result, and a retained shell that must not be lost", async () => {
  // The three at once, which is where they interact: the roster is already at
  // its reserve boundary, more remote targets appear than the reserve can
  // cover, one of them is an idle-parked handle whose sandbox still holds a
  // background shell, and a further registration lands while the sweep is
  // running. What must survive all of it is the retained shell's host.
  const filler = Array.from({ length: CONFIG.ceiling - CONFIG.reconciliationReserve }, (_, i) => ({
    identity: `sandbox-filler-${i}`, token: `t${i}`, claimedBy: "replica-b", renewedAtMs: Date.now(),
  }));
  kv.seed("keepalive.roster", JSON.stringify({ ceiling: CONFIG.ceiling, entries: filler }));
  // The one holding live work is idle-parked, so it is the one the probe is
  // asked about -- and the one a wrong answer expires.
  kv.seed("hands.sess-working", retained("wl-working"));
  for (const n of [1, 2, 3]) kv.seed(`hands.sess-remote-${n}`, entry(`wl-remote-${n}`));

  const probedOwners: string[] = [];
  let arrived = false;
  onPing = () => {
    if (arrived) return;
    arrived = true;
    kv.seed("hands.sess-latecomer", entry("wl-latecomer"));
  };

  const probe = async (_u: string, _t: string, owner: string) => {
    probedOwners.push(owner);
    return owner === "sess-working" ? 1 : 0;
  };
  // Twice, because the probe answers behind the sweep: the first tick reads
  // `unknown` and the second acts on the answer.
  await runKeepaliveTickForTest({ kv, countActiveShells: probe, roster: { store: rosterStore(kv), config: CONFIG } });
  await new Promise((r) => setImmediate(r));
  await runKeepaliveTickForTest({ kv, countActiveShells: probe, roster: { store: rosterStore(kv), config: CONFIG } });

  assert.ok(arrived, "the registration really did land during a sweep");
  assert.ok(probedOwners.includes("sess-working"), "the retained handle was actually asked about");

  const identities = roster()!.entries.map((e) => e.identity);
  assert.ok(roster()!.entries.length > CONFIG.ceiling, "genuinely past the declared ceiling");
  for (const n of [1, 2, 3]) {
    assert.ok(identities.includes(`safe:wl-remote-${n}`), `remote ${n} admitted`);
  }
  assert.ok(identities.includes("safe:wl-working"),
    "the target holding live work is admitted, not left to residual capacity");
  assert.ok(kv.get, "sanity");
  assert.ok(values.has("hands.sess-working"),
    "and its handle survives the breach: nothing is expired or reclaimed on account of it");
  assert.ok(pinged.includes("wl-working"),
    "a handle held by a running shell is pinged rather than left to idle out");

  // A third tick picks up what arrived during the first two.
  pinged.length = 0;
  await runKeepaliveTickForTest({ kv, countActiveShells: probe, roster: { store: rosterStore(kv), config: CONFIG } });
  assert.ok(roster()!.entries.some((e) => e.identity === "safe:wl-latecomer"),
    "the mid-sweep arrival is admitted rather than lost");
  assert.ok(pinged.includes("wl-latecomer"));
});

test("last activity never ages past the idle deadline, over four of them", async () => {
  // The bound as the design states it: not sweep-index arithmetic but elapsed
  // time, driven on an injected clock across long enough for the shortest
  // reclaim to lapse four times over, asserting the age of each target's last
  // activity rather than how many sweeps ago it was.
  const C = 2;
  const N = 7;
  const INTERVAL_MS = 60_000;
  const IDLE_DEADLINE_MS = 900_000;
  const PING_MS = 1_000;

  const targets = Array.from({ length: N }, (_, i) => `wl-${i}`);
  for (const [i, id] of targets.entries()) kv.seed(`hands.sess-${i}`, entry(id));

  let now = 0;
  const lastActivity = new Map<string, number>();
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }) {
        pinged.push(inst.id);
        now += PING_MS;
        lastActivity.set(inst.id, now);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as SandboxProvider,
  });

  const sweepAt: number[] = [];
  let worstAge = 0;
  const until = IDLE_DEADLINE_MS * 4;
  while (now < until) {
    const sweepStart = now;
    sweepAt.push(sweepStart);
    pinged.length = 0;
    await runKeepaliveTickForTest({
      kv,
      countActiveShells: async (_u, _t, owner) => (owner === "sess-3" ? 1 : 0),
      pingBudgetMs: C * PING_MS,
      now: () => now,
      roster: { store: rosterStore(kv), config: CONFIG },
    });
    assert.ok(pinged.length <= C, `a sweep started ${pinged.length} pings past its budget`);
    // The clock advances by one interval per sweep, as the timer would.
    now = sweepStart + INTERVAL_MS;
    for (const id of targets) {
      // A target never pinged is at its full age since time zero.
      worstAge = Math.max(worstAge, now - (lastActivity.get(id) ?? 0));
    }
  }

  assert.ok(sweepAt.length >= (until / INTERVAL_MS) - 1, "the clock really advanced");
  assert.ok(worstAge < IDLE_DEADLINE_MS,
    `some target's last activity reached ${Math.round(worstAge / 1000)}s, past the `
      + `${IDLE_DEADLINE_MS / 1000}s reclaim in force`);
  for (const id of targets) {
    assert.ok(lastActivity.has(id), `${id} was never pinged at all`);
    assert.ok(now - lastActivity.get(id)! < IDLE_DEADLINE_MS, `${id} ended stale`);
  }
});

test("a target that arrives or leaves cannot push a deferred one further back", async () => {
  // The starvation the cursor exists to prevent: a served target reordered
  // ahead of one still waiting, repeatedly. Driven with the population changing
  // between every sweep.
  const C = 2;
  const PING_MS = 1_000;
  let now = 0;
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }) {
        pinged.push(inst.id);
        now += PING_MS;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as SandboxProvider,
  });

  // The one that must not starve is seeded first and never leaves.
  kv.seed("hands.sess-stay", entry("wl-stay"));
  for (let i = 0; i < 4; i++) kv.seed(`hands.sess-base-${i}`, entry(`wl-base-${i}`));

  let servedStay = 0;
  for (let sweep = 0; sweep < 12; sweep++) {
    pinged.length = 0;
    // Churn: one target joins and another leaves before every sweep.
    kv.seed(`hands.sess-churn-${sweep}`, entry(`wl-churn-${sweep}`));
    if (sweep > 0) values.delete(`hands.sess-churn-${sweep - 1}`);

    await runKeepaliveTickForTest({
      kv, countActiveShells: async () => 0, pingBudgetMs: C * PING_MS, now: () => now,
      roster: { store: rosterStore(kv), config: CONFIG },
    });
    if (pinged.includes("wl-stay")) servedStay += 1;
  }

  assert.ok(servedStay >= 3,
    `the never-leaving target was served ${servedStay} times in 12 sweeps; a cursor `
      + "that lets arrivals reorder it ahead of waiting targets starves it");
});

test("a contended reconciliation blocks the next ordinary claim until it recovers", async () => {
  // A reconcile that exhausted its retries wrote nothing, so the roster is
  // missing every target it was about to take on. Admitting against it is
  // admitting against a count nobody could write.
  const { bindAdmission, admitSandbox, SandboxCapacityRefused, isRosterStale } =
    await import("../src/sandbox/admission.js");
  await bindAdmission(kv, {
    ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve,
  });
  kv.seed("hands.sess-remote", entry("wl-remote"));

  // A store whose writes are always refused is a roster under permanent
  // contention, which is what exhaustion looks like from inside the sweep.
  const contended = { ...rosterStore(kv)!, async write() { return false; } };
  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, roster: { store: contended, config: CONFIG },
  });

  assert.equal(await isRosterStale(), true);
  await assert.rejects(() => admitSandbox("sess-new"), SandboxCapacityRefused,
    "nothing new is admitted against a roster missing targets");

  // A second replica, which never hit the contention, reads the same roster --
  // and the flag is on it, not in the first replica's memory.
  const { bindAdmission: bindOther, admitSandbox: admitOther } =
    await import("../src/sandbox/admission.js");
  await bindOther(kv, {
    ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve,
  });
  await assert.rejects(() => admitOther("sess-neighbour"), SandboxCapacityRefused,
    "a replica that never saw the fault must not go on admitting against the "
      + "same understated count");

  // A later sweep that lands clears it.
  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, roster: { store: rosterStore(kv), config: CONFIG },
  });
  assert.equal(await isRosterStale(), false);
  const hold = await admitSandbox("sess-new");
  assert.ok(hold, "and admission resumes once the roster is whole again");
  await hold.release();
});

test("a census that could not be read does not clear staleness", async () => {
  // A walk that failed produces a smaller target set, and reconciling that set
  // as if whole announces a fleet nobody counted -- which is the same
  // understated roster arrived at without any contention at all.
  const { bindAdmission, admitSandbox, SandboxCapacityRefused, isRosterStale } =
    await import("../src/sandbox/admission.js");
  await bindAdmission(kv, {
    ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve,
  });
  kv.seed("hands.sess-a", entry("wl-a"));
  kv.seed("hands.sess-broken", "{ not json");

  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, roster: { store: rosterStore(kv), config: CONFIG },
  });

  assert.equal(await isRosterStale(), true, "an unreadable record is a missing sandbox");
  await assert.rejects(() => admitSandbox("sess-new"), SandboxCapacityRefused);

  // Repaired, and the next sweep clears it.
  values.delete("hands.sess-broken");
  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, roster: { store: rosterStore(kv), config: CONFIG },
  });
  assert.equal(await isRosterStale(), false);
});

test("a KV read that rejects makes the census incomplete, not the key absent", async () => {
  // Folded into absence, the target drops out of the census and the next
  // reconcile clears a staleness the fleet still has.
  const { bindAdmission, admitSandbox, SandboxCapacityRefused, isRosterStale } =
    await import("../src/sandbox/admission.js");
  await bindAdmission(kv, {
    ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve,
  });
  kv.seed("hands.sess-a", entry("wl-a"));
  kv.seed("hands.sess-unreadable", entry("wl-unreadable"));
  const realGet = kv.get.bind(kv);
  (kv as unknown as { get: unknown }).get = async (key: string) => {
    if (key === "hands.sess-unreadable") throw new Error("kv unavailable");
    return realGet(key);
  };

  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, roster: { store: rosterStore(kv), config: CONFIG },
  });

  assert.equal(await isRosterStale(), true);
  await assert.rejects(() => admitSandbox("sess-new"), SandboxCapacityRefused);

  (kv as unknown as { get: unknown }).get = realGet;
  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, roster: { store: rosterStore(kv), config: CONFIG },
  });
  assert.equal(await isRosterStale(), false);
});

test("a DAG sandbox surviving a restart is admitted and pinged", async () => {
  // Its session key may name nothing, or a stale sibling: every node of a DAG
  // shares one session id. Walked from session keys alone it holds no slot and
  // is pinged by nobody, which after a restart is every DAG sandbox this
  // replica did not create.
  const { bindAdmission } = await import("../src/sandbox/admission.js");
  await bindAdmission(kv, {
    ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve,
  });

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => 1,
    listDagHandles: async () => [["dag-root-1", {
      primary: {
        workload_id: "wl-dag", platform_key: "pk", provider: "safe-workload",
        hands_url: "http://wl-dag:9100/mcp", namespace: "ns",
      },
    }]],
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  assert.ok(roster()!.entries.some((e) => e.identity === "safe:wl-dag"),
    "admitted, so it counts against the ceiling like every other target");
  assert.ok(pinged.includes("wl-dag"), "and pinged, so its idle clock is held off");
});

test("many simultaneous eviction failures do not stretch the sweep past its span", async () => {
  // Evictions run serially and each awaits a stop, so an unbounded failure
  // phase is fleet-sized -- and the declared span, which every refresh gap is
  // derived from, becomes a number the sweep routinely exceeds.
  const failing = 40;
  for (let i = 0; i < failing; i++) kv.seed(`hands.sess-bad-${i}`, entry(`wl-bad-${i}`));

  let now = 0;
  const STOP_MS = 5_000;
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec() { now += 100; throw new Error("sandbox gone"); },
      async stop() { now += STOP_MS; throw new Error("control plane unreachable"); },
    } as unknown as SandboxProvider,
  });

  const started = now;
  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, now: () => now,
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  const elapsedSec = (now - started) / 1000;
  const { keepaliveSweepCeilingSec } = await import("../src/sandbox/keepalive.js");
  assert.ok(elapsedSec <= keepaliveSweepCeilingSec(),
    `the sweep ran ${elapsedSec}s against a declared worst case of `
      + `${keepaliveSweepCeilingSec()}s with ${failing} targets failing at once`);
});

test("many unresponsive retained containers do not stretch the sweep past its span", async () => {
  // The census walks every handle record serially and each retention awaits a
  // live-work read inside a container, so an unbudgeted census is fleet-sized
  // the same way an unbudgeted failure phase is -- and it runs before the roster
  // is renewed and before the ping budget starts counting, so every second of it
  // is added to the span every refresh gap and the reclaim horizon rest on.
  const retentions = 40;
  for (let i = 0; i < retentions; i++) {
    const key = retentionKey(`gen-${i}`);
    const value = entry(`wl-held-${i}`, {
      sandboxName: `gen-${i}`, protected: true, reason: "protected",
      detail: "live_work_present", keepalive: false, idleSince: 0,
    });
    kv.seed(key, value);
    // The record behind the projection, so the sweep's refresh of it is the one
    // a live retention takes rather than the absent-ledger path.
    kv.seed(ledgerKeyForRetention(key), value);
  }

  let now = 0;
  const READ_MS = 20_000;
  /** Containers this sweep actually asked for live-work evidence. */
  const gathered: string[] = [];
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }, command: string) {
        // The gather command is the expensive one: a container that will not
        // answer holds it for the whole exec timeout. A ping is cheap and stays
        // cheap, so what this measures is the census and not the ping phase.
        if (command.includes("MARKER")) {
          gathered.push(inst.id);
          now += READ_MS;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        pinged.push(inst.id);
        now += 100;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async stop() {},
    } as unknown as SandboxProvider,
  });

  const started = now;
  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, now: () => now,
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  const elapsedSec = (now - started) / 1000;
  const { keepaliveSweepCeilingSec } = await import("../src/sandbox/keepalive.js");
  assert.ok(elapsedSec <= keepaliveSweepCeilingSec(),
    `the sweep ran ${elapsedSec}s against a declared worst case of `
      + `${keepaliveSweepCeilingSec()}s with ${retentions} retained containers unresponsive`);
  assert.ok(gathered.length < retentions,
    "the budget has to defer reads, or it is not bounding anything");
  // Deferring a read costs the container nothing: its target and identity go
  // into the census before the read, so it is pinged and named to the roster
  // this sweep exactly as one that was read is.
  assert.ok(pinged.some((id) => !gathered.includes(id)),
    "a container whose live-work read was deferred fell out of the sweep");
});

test("a retention whose release fails does not cost the fleet its refresh", async () => {
  // The reads were lifted out of the per-entry try/catch the walk wraps every
  // record in, so an error that used to cost one retention its turn now escapes
  // `collectTargets` and exits the tick -- before the roster is renewed and
  // before a single ping goes out. One container whose delete the store refuses
  // would then leave every live sandbox in the fleet without the refresh its
  // idle deadline is proven against, and would do so again on every sweep for
  // as long as the store kept refusing.
  const finishedKey = retentionKey("gen-unreleasable");
  const held = entry("wl-unreleasable", {
    sandboxName: "gen-unreleasable", protected: true, reason: "protected",
    detail: "live_work_present", keepalive: false, idleSince: 0,
  });
  kv.seed(finishedKey, held);
  kv.seed(ledgerKeyForRetention(finishedKey), held);
  // An ordinary live sandbox alongside it, which is what must still be served.
  kv.seed("hands.sess-bystander", entry("wl-bystander"));

  // The store refuses exactly the deletes a release issues, the way a NATS
  // request timeout would.
  const realDelete = (kv as unknown as { delete: (k: string) => Promise<void> }).delete;
  (kv as unknown as { delete: (k: string) => Promise<void> }).delete = async (key: string) => {
    if (key === finishedKey || key === ledgerKeyForRetention(finishedKey)) {
      throw new Error("the store refused the delete");
    }
    return realDelete.call(kv, key);
  };

  let now = 0;
  const CLEAR = 'MARKER {"epoch":"e1","bearer":{"pid":7,"startToken":"t7"}}\nSUBTREE ok\nPROCS 7';
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }, command: string) {
        if (command.includes("MARKER")) {
          // Answers `clear`, so the read reaches the release that then fails.
          now += 100;
          return { exitCode: 0, stdout: CLEAR, stderr: "" };
        }
        pinged.push(inst.id);
        now += 100;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async stop() {},
    } as unknown as SandboxProvider,
  });

  await assert.doesNotReject(() => runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, now: () => now,
    roster: { store: rosterStore(kv), config: CONFIG },
  }), "a refused release must not take the tick down with it");

  assert.ok(pinged.includes("wl-bystander"),
    "the sandbox that had nothing to do with the failed release was never pinged");
  assert.ok(values.has(finishedKey),
    "the retention whose release failed must stand rather than be half-removed");
});

test("a retention whose work has finished is read even when stuck ones lead the walk", async () => {
  // The budget is not fairness. Whatever bounds one sweep says nothing about
  // which retentions that sweep spends itself on, and if the answer can be "the
  // same ones every time" then a retention behind them whose work has already
  // finished is never read at all: its records go on being refreshed, it goes on
  // being pinged, and it holds an admission slot for as long as the containers
  // ahead of it stay unresponsive -- which is forever, because `clear` is the
  // only verdict that releases a retention and it can never be read from a
  // container that will not answer.
  //
  // The property asserted is the release, not the scheme that gets there: with
  // two stuck containers ahead of it, a finished retention has to be read inside
  // a handful of sweeps.
  const stuck = ["gen-stuck-0", "gen-stuck-1"];
  const finished = "gen-finished";
  for (const generation of [...stuck, finished]) {
    const key = retentionKey(generation);
    const value = entry(`wl-${generation}`, {
      sandboxName: generation, protected: true, reason: "protected",
      detail: "live_work_present", keepalive: false, idleSince: 0,
    });
    kv.seed(key, value);
    kv.seed(ledgerKeyForRetention(key), value);
  }

  let now = 0;
  const CLEAR = 'MARKER {"epoch":"e1","bearer":{"pid":7,"startToken":"t7"}}\nSUBTREE ok\nPROCS 7';
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }, command: string) {
        if (!command.includes("MARKER")) {
          pinged.push(inst.id);
          now += 100;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        // The two leading containers hold the read for its whole timeout and
        // never answer; the one behind them answers at once and answers clear.
        if (inst.id.includes("stuck")) {
          now += 20_000;
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: CLEAR, stderr: "" };
      },
      async stop() {},
    } as unknown as SandboxProvider,
  });

  for (let sweep = 0; sweep < 5; sweep++) {
    await runKeepaliveTickForTest({
      kv, countActiveShells: async () => 0, now: () => now,
      roster: { store: rosterStore(kv), config: CONFIG },
    });
  }

  assert.ok(!values.has(retentionKey(finished)),
    "five sweeps and the finished retention was never read, so it was never released");
  assert.ok(!values.has(ledgerKeyForRetention(retentionKey(finished))),
    "the released retention left its ledger record behind");
  // The retentions that are genuinely still held are untouched by the schedule.
  for (const generation of stuck) {
    assert.ok(values.has(retentionKey(generation)),
      `${generation} was released, and it never answered clear`);
  }
});

test("the tail of the walk gets its turn however many stuck containers lead it", async () => {
  // Whatever decides whose turn it is has to preserve the waiting order, not
  // just remember that a read was deferred. A scheme that only asks "were you
  // deferred last time?" cannot tell "waited longest" from "just deferred": with
  // four stuck containers and two reads a sweep it alternates between the first
  // two pairs forever -- after reading the first pair the carry-over holds the
  // second pair and the tail, after reading the second pair it holds the first
  // pair and the tail -- and the tail, deferred earliest and every time since,
  // is always last and always out of budget when it comes up. It keeps being
  // refreshed and keeps an admission slot, which is the leak this schedule
  // exists to close.
  const stuck = ["gen-stuck-0", "gen-stuck-1", "gen-stuck-2", "gen-stuck-3"];
  const finished = "gen-finished";
  for (const generation of [...stuck, finished]) {
    const key = retentionKey(generation);
    const value = entry(`wl-${generation}`, {
      sandboxName: generation, protected: true, reason: "protected",
      detail: "live_work_present", keepalive: false, idleSince: 0,
    });
    kv.seed(key, value);
    kv.seed(ledgerKeyForRetention(key), value);
  }

  let now = 0;
  const CLEAR = 'MARKER {"epoch":"e1","bearer":{"pid":7,"startToken":"t7"}}\nSUBTREE ok\nPROCS 7';
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }, command: string) {
        if (!command.includes("MARKER")) {
          pinged.push(inst.id);
          now += 100;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (inst.id.includes("stuck")) {
          now += 20_000;
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: CLEAR, stderr: "" };
      },
      async stop() {},
    } as unknown as SandboxProvider,
  });

  // The bound that matters is not "eventually": every retention has to be read
  // within as many sweeps as there are retentions, however long the ones ahead
  // of it hold their reads and whatever order the keyspace is handed over in.
  // Twenty are run so a scheme that gets there later still reports how much
  // later.
  let released = 0;
  for (let sweep = 1; sweep <= 20; sweep++) {
    await runKeepaliveTickForTest({
      kv, countActiveShells: async () => 0, now: () => now,
      roster: { store: rosterStore(kv), config: CONFIG },
    });
    if (!released && !values.has(retentionKey(finished))) released = sweep;
  }

  assert.ok(released, "twenty sweeps and the last retention in the walk was never once read");
  assert.ok(released <= stuck.length + 1,
    `the tail waited ${released} sweeps behind ${stuck.length} stuck containers, `
      + `which is past the ${stuck.length + 1} that a queue over the retentions bounds `
      + "it by");
  assert.ok(!values.has(ledgerKeyForRetention(retentionKey(finished))),
    "the released retention left its ledger record behind");
  for (const generation of stuck) {
    assert.ok(values.has(retentionKey(generation)),
      `${generation} was released, and it never answered clear`);
  }
});

test("a slow preliminary walk cannot spend the retention-read budget", async () => {
  // The budget exists to bound the container reads a census starts, and those
  // are the only thing in it. Measured as a wall-clock deadline armed at the
  // top of the census it is something else entirely: the local registry's
  // retry-pending checks run serially ahead of the walk, so a store that
  // answers them slowly retires the deadline before the first retained
  // container is reached. Rotation cannot help -- every sweep spends the same
  // budget on the same preliminary work -- so a retention whose work finished
  // long ago is never read, never released, and holds its admission slot for
  // as long as the store stays slow.
  const slow = 31;
  const sessions = Array.from({ length: slow }, (_, i) => `sess-slow-${i}`);
  const finished = "gen-finished";
  const key = retentionKey(finished);
  const value = entry(`wl-${finished}`, {
    sandboxName: finished, protected: true, reason: "protected",
    detail: "live_work_present", keepalive: false, idleSince: 0,
  });
  kv.seed(key, value);
  kv.seed(ledgerKeyForRetention(key), value);

  let now = 0;
  // One second per retry-pending lookup, which is what the local-registry loop
  // does once per registration before the walk over `hands.*` even begins. The
  // reads happen in a phase after that walk, so the budget they are bounded by
  // has not started when any of this is spent.
  const scan = kv.keys.bind(kv);
  (kv as unknown as { keys: KV["keys"] }).keys = async (filter?: string) => {
    if (filter?.startsWith("retry-pending.")) now += 1_000;
    return scan(filter as string);
  };

  const CLEAR = 'MARKER {"epoch":"e1","bearer":{"pid":7,"startToken":"t7"}}\nSUBTREE ok\nPROCS 7';
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }, command: string) {
        if (!command.includes("MARKER")) {
          pinged.push(inst.id);
          now += 100;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: CLEAR, stderr: "" };
      },
      async stop() {},
    } as unknown as SandboxProvider,
  });

  try {
    for (const sessionId of sessions) {
      registerSandbox(sessionId, {
        provider: "safe-workload", workloadId: `wl-${sessionId}`,
        platformKey: "pk", namespace: "ns",
      });
    }
    for (let sweep = 0; sweep < 3; sweep++) {
      await runKeepaliveTickForTest({
        kv, countActiveShells: async () => 0, now: () => now,
        roster: { store: rosterStore(kv), config: { ...CONFIG, ceiling: 64 } },
      });
    }
  } finally {
    for (const sessionId of sessions) unregisterSandbox(sessionId);
  }

  assert.ok(!values.has(key),
    "the preliminary walk spent the whole budget, so the retention was never read");
  assert.ok(!values.has(ledgerKeyForRetention(key)),
    "the released retention left its ledger record behind");
});

test("the clock seam is inert when it is not supplied", async () => {
  // A seam that changes behaviour by existing is a second code path nobody runs
  // in production. Nothing branches on whether it is set: the deadline reads
  // whichever clock it was handed, and the default is the real one.
  kv.seed("hands.sess-a", entry("wl-a"));
  kv.seed("hands.sess-b", entry("wl-b"));

  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, roster: { store: rosterStore(kv), config: CONFIG },
  });
  const withoutSeam = [...pinged].sort();

  pinged.length = 0;
  // The same sweep with the seam supplied as the real clock: identical work.
  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, now: () => Date.now(),
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  assert.deepEqual([...pinged].sort(), withoutSeam);
  const source = await import("node:fs").then((fs) => fs.readFileSync(
    new URL("../src/sandbox/keepalive.ts", import.meta.url), "utf8",
  ));
  assert.ok(!/if\s*\(\s*deps\.now\s*\)/.test(source),
    "no path may branch on whether the seam was supplied");
  assert.match(source, /const clock = deps\.now \?\? Date\.now;/,
    "it is a default, not a mode");
});

test("a parked handle that expires gives its slot back", async () => {
  // Idle expiry is the one exit that reaches no unregisterSandbox: the record
  // is deleted by the sweep itself. A slot held past it counts against the
  // ceiling for a sandbox that no longer exists, and because parking is
  // ordinary use the loss is monotonic -- provisioning is eventually refused
  // for capacity on a fleet that is nowhere near it.
  const { bindAdmission, admitSandbox, markCensusReconciled } =
    await import("../src/sandbox/admission.js");
  await bindAdmission(kv, {
    ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve,
  });
  markCensusReconciled();
  const identity = "safe:wl-park";
  const hold = await admitSandbox("sess-park");
  await hold.bind(identity);
  kv.seed("hands.sess-park", retained("wl-park"));

  // The background-work probe answers a tick behind, so the idle verdict this
  // expiry depends on lands on a later sweep than the one that asks for it --
  // and the clock restarts at every answer that is not a confirmed zero, so the
  // window has to pass after that verdict rather than before it.
  let clock = Date.now();
  for (let i = 0; i < 3; i++) {
    await runKeepaliveTickForTest({
      kv,
      countActiveShells: async () => 0,
      roster: { store: rosterStore(kv), config: CONFIG },
      now: () => clock,
    });
    await new Promise((r) => setImmediate(r));
    clock += 2 * 60 * 60 * 1000;
  }

  assert.ok(!values.has("hands.sess-park"), "the parked handle should have expired");
  assert.ok(!roster()!.entries.some((e) => e.identity === identity),
    "the expired handle's slot is still held against the ceiling");
});

test("an expiry whose delete lost its race keeps the slot", async () => {
  // `previousSeq` loses to a sibling reactivating this very handle. Releasing
  // on a delete that did not happen strips the slot from a target that is live
  // again, so the release cannot be unconditional.
  const { bindAdmission, admitSandbox, markCensusReconciled } =
    await import("../src/sandbox/admission.js");
  await bindAdmission(kv, {
    ceiling: CONFIG.ceiling, reconciliationReserve: CONFIG.reconciliationReserve,
  });
  markCensusReconciled();
  const identity = "safe:wl-park";
  const hold = await admitSandbox("sess-park");
  await hold.bind(identity);
  kv.seed("hands.sess-park", retained("wl-park"));

  const contended = Object.create(kv) as typeof kv;
  contended.delete = async () => {
    throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
  };

  for (let i = 0; i < 3; i++) {
    await runKeepaliveTickForTest({
      kv: contended, countActiveShells: async () => 0,
      roster: { store: rosterStore(kv), config: CONFIG },
    });
    await new Promise((r) => setImmediate(r));
  }

  assert.ok(roster()!.entries.some((e) => e.identity === identity),
    "a slot was released for a record that is still there");
});

test("a finished retention is read within its bound when refreshes permute the walk", async () => {
  // The walk order is not a schedule. `KV.keys()` enumerates in stream-sequence
  // order -- the order of each key's last write -- and a sweep rewrites the very
  // keys it walks: the census refreshes every retention's projection, and the
  // ping phase rewrites the `hands.` record of every retention it manages to
  // ping. When the ping budget runs out the batch rotates, so a different subset
  // is rewritten each sweep and the keyspace is permuted between one walk and
  // the next.
  //
  // Anything that decides whose turn it is by position in that walk therefore
  // decides nothing: a retention that has not been read can be carried ahead of
  // the point the last sweep stopped at, be skipped for being "ahead" of it, and
  // be carried ahead of it again next sweep. It keeps being refreshed and keeps
  // being pinged, so it holds its admission slot, and it never gets the one read
  // that could release it.
  const stuck = Array.from({ length: 5 }, (_, i) => `gen-stuck-${i}`);
  const finished = "gen-finished";
  for (const generation of [...stuck, finished]) {
    const key = retentionKey(generation);
    const value = entry(`wl-${generation}`, {
      sandboxName: generation, protected: true, reason: "protected",
      detail: "live_work_present", keepalive: false, idleSince: 0,
    });
    kv.seed(key, value);
    kv.seed(ledgerKeyForRetention(key), value);
  }

  let now = 0;
  const CLEAR = 'MARKER {"epoch":"e1","bearer":{"pid":7,"startToken":"t7"}}\nSUBTREE ok\nPROCS 7';
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }, command: string) {
        if (!command.includes("MARKER")) {
          pinged.push(inst.id);
          now += 100;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (inst.id.includes("stuck")) {
          now += 20_000;
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: CLEAR, stderr: "" };
      },
      async stop() {},
    } as unknown as SandboxProvider,
  });

  // What each sweep actually walked, so the test can show the keyspace moved
  // rather than assume it.
  const walks: string[][] = [];
  const scan = kv.keys.bind(kv);
  (kv as unknown as { keys: KV["keys"] }).keys = async (filter?: string) => {
    const iter = await scan(filter as string);
    if (filter !== "hands.*") return iter;
    const seen: string[] = [];
    for await (const key of iter) seen.push(key);
    walks.push(seen);
    return (async function* () { yield* seen; })();
  };

  let released = 0;
  for (let sweep = 1; sweep <= 20; sweep++) {
    await runKeepaliveTickForTest({
      kv, countActiveShells: async () => 0, now: () => now,
      // Small enough that the batch cannot ping every target, which is what
      // makes it rotate -- and rotating it is what rewrites a different subset
      // of the keyspace each sweep.
      pingBudgetMs: 250,
      roster: { store: rosterStore(kv), config: CONFIG },
    });
    if (!released && !values.has(retentionKey(finished))) released = sweep;
  }

  assert.ok(walks.some((walk, i) => i > 0 && walk.join() !== walks[i - 1].join()),
    "the walk order never moved, so this test is not modelling a NATS keyspace at all");
  assert.ok(released, "twenty sweeps and the finished retention was never once read");
  assert.ok(released <= stuck.length + 1,
    `the finished retention waited ${released} sweeps behind ${stuck.length} stuck `
      + `containers, past the ${stuck.length + 1} that a queue over the retentions bounds `
      + "it by");
  for (const generation of stuck) {
    assert.ok(values.has(retentionKey(generation)),
      `${generation} was released, and it never answered clear`);
  }
});

test("a census read that outlasts the container timeout still fits the census ceiling", async () => {
  // The exec timeout is the *command's* deadline inside the container; it is not
  // the ceiling of the call the census awaits. Both providers give the HTTP call
  // that carries it `parseExecTimeoutMs(timeout) + EXEC_TRANSPORT_SLACK_MS`, and
  // the SaFE path can add a status lookup on top of that -- so a Router that
  // accepts the connection and goes quiet holds a read far past the timeout the
  // ceiling names, without the provider violating anything it declared.
  //
  // Which is why the phase is bounded by a term over *both* halves: a budget that
  // bars starting a read, plus a ceiling on the one read the budget lets start.
  // A sweep that spends nearly the whole budget on a read that answers and then
  // starts one that does not is the worst case, and it has to fit.
  const slow = "gen-slow";
  const quiet = "gen-quiet";
  for (const generation of [slow, quiet]) {
    const key = retentionKey(generation);
    const value = entry(`wl-${generation}`, {
      sandboxName: generation, protected: true, reason: "protected",
      detail: "live_work_present", keepalive: false, idleSince: 0,
    });
    kv.seed(key, value);
    kv.seed(ledgerKeyForRetention(key), value);
  }

  let now = 0;
  let censusEndedAt: number | null = null;
  /** The signal each live-work read was given, which is what enforces its end. */
  const readSignals: unknown[] = [];
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }, command: string, _timeout: string, signal?: AbortSignal) {
        if (!command.includes("MARKER")) {
          // The first ping marks the end of the census: nothing between them
          // awaits a container, and the stub's store answers for free.
          censusEndedAt ??= now;
          pinged.push(inst.id);
          now += 100;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        readSignals.push(signal);
        // A container that answers slowly but inside its own timeout, and a
        // Router that accepts the call and then says nothing until the provider's
        // own transport bound ends it: 20s of command timeout plus the 15s of
        // slack both providers add for the call that carries it.
        now += inst.id.includes(slow) ? 29_000 : 35_000;
        return { exitCode: 1, stdout: "", stderr: "" };
      },
      async stop() {},
    } as unknown as SandboxProvider,
  });

  await runKeepaliveTickForTest({
    kv, countActiveShells: async () => 0, now: () => now,
    roster: { store: rosterStore(kv), config: CONFIG },
  });

  const { keepaliveCensusPhaseCeilingSec } = await import("../src/sandbox/keepalive.js");
  assert.ok(censusEndedAt !== null, "the sweep never reached its ping phase");
  assert.ok(censusEndedAt! / 1000 <= keepaliveCensusPhaseCeilingSec(),
    `the census awaited container reads for ${censusEndedAt! / 1000}s against a declared `
      + `worst case of ${keepaliveCensusPhaseCeilingSec()}s`);
  assert.ok(readSignals.length > 0, "no live-work read was started at all");
  for (const signal of readSignals) {
    assert.ok(signal instanceof AbortSignal,
      "a live-work read was started with no deadline of its own, so the term the ceiling "
        + "names rests on the provider honouring a timeout rather than on anything enforced here");
    assert.equal((signal as AbortSignal).aborted, false,
      "the read was handed a signal that had already fired");
  }
});

test("a restart mid-cycle costs the tail one more cycle and no more", async () => {
  // The queue is process-local, like every other rotation state here, so a
  // restart empties it and the next sweep orders itself by the walk again. That
  // is a real cost and it has to be a bounded one: a retention that was about to
  // come up goes back to wherever the walk puts it, so it waits at most one more
  // cycle -- never longer, and never a release it should not have had, because
  // nothing in the queue decides a verdict.
  const stuck = Array.from({ length: 3 }, (_, i) => `gen-stuck-${i}`);
  const finished = "gen-finished";
  for (const generation of [...stuck, finished]) {
    const key = retentionKey(generation);
    const value = entry(`wl-${generation}`, {
      sandboxName: generation, protected: true, reason: "protected",
      detail: "live_work_present", keepalive: false, idleSince: 0,
    });
    kv.seed(key, value);
    kv.seed(ledgerKeyForRetention(key), value);
  }

  let now = 0;
  const CLEAR = 'MARKER {"epoch":"e1","bearer":{"pid":7,"startToken":"t7"}}\nSUBTREE ok\nPROCS 7';
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }, command: string) {
        if (!command.includes("MARKER")) {
          pinged.push(inst.id);
          now += 100;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (inst.id.includes("stuck")) {
          now += 20_000;
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: CLEAR, stderr: "" };
      },
      async stop() {},
    } as unknown as SandboxProvider,
  });

  const cycle = stuck.length + 1;
  let released = 0;
  for (let sweep = 1; sweep <= 4 * cycle; sweep++) {
    await runKeepaliveTickForTest({
      kv, countActiveShells: async () => 0, now: () => now,
      roster: { store: rosterStore(kv), config: CONFIG },
    });
    // Every sweep but the last of the first cycle is followed by a restart, so
    // the queue never survives long enough to reach the tail on its own.
    if (sweep < cycle) resetBackgroundWorkStateForTest();
    if (!released && !values.has(retentionKey(finished))) released = sweep;
  }

  assert.ok(released, "the tail was never read at all across four cycles of restarts");
  assert.ok(released <= 2 * cycle,
    `the tail waited ${released} sweeps across restarts, past the ${2 * cycle} that one `
      + "lost cycle plus one whole cycle bounds it by");
  for (const generation of stuck) {
    assert.ok(values.has(retentionKey(generation)),
      `${generation} was released, and it never answered clear`);
  }
});

test("a retention the walk could not read keeps its place in the queue", async () => {
  // Absence from the walk is two different things and the queue has to tell
  // them apart. A retention another replica released is gone and must leave the
  // queue; a retention whose `hands.` read the store refused this sweep is still
  // there, still refreshed by whoever can read it, still holding an admission
  // slot, and still owed the one read that could release it.
  //
  // Rebuilding the queue from what the read phase walked folds the second into
  // the first: the unread key is not in `retentionReads`, so it is dropped, and
  // it re-enters at the BACK the next sweep the store answers for it. With reads
  // that outlast the budget ahead of it, that is a livelock rather than a delay
  // -- the sweeps it is visible for are spent on the containers ahead of it, and
  // the sweeps that would have advanced it are the ones that forget it.
  //
  // Two stuck containers and a budget that affords one read a sweep, with the
  // finished retention's record readable every other sweep: readable often
  // enough that a queue which remembers it reaches it in a cycle, and never once
  // reached by a queue that does not.
  const stuck = ["gen-stuck-0", "gen-stuck-1"];
  const finished = "gen-finished";
  for (const generation of [...stuck, finished]) {
    const key = retentionKey(generation);
    const value = entry(`wl-${generation}`, {
      sandboxName: generation, protected: true, reason: "protected",
      detail: "live_work_present", keepalive: false, idleSince: 0,
    });
    kv.seed(key, value);
    kv.seed(ledgerKeyForRetention(key), value);
  }

  const finishedKey = retentionKey(finished);
  let sweep = 0;
  // Per-key and intermittent, which is the shape a request timeout against one
  // subject has: the rest of the walk is whole, so the sweep goes on and its
  // census is merely incomplete.
  const realGet = kv.get.bind(kv);
  (kv as unknown as { get: unknown }).get = async (key: string) => {
    if (key === finishedKey && sweep % 2 === 0) throw new Error("kv unavailable");
    return realGet(key);
  };

  let now = 0;
  const CLEAR = 'MARKER {"epoch":"e1","bearer":{"pid":7,"startToken":"t7"}}\nSUBTREE ok\nPROCS 7';
  restoreProviders?.();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec(inst: { id: string }, command: string) {
        if (!command.includes("MARKER")) {
          pinged.push(inst.id);
          now += 100;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (inst.id.includes("stuck")) {
          now += 20_000;
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: CLEAR, stderr: "" };
      },
      async stop() {},
    } as unknown as SandboxProvider,
  });

  let released = 0;
  for (sweep = 1; sweep <= 20; sweep++) {
    await runKeepaliveTickForTest({
      kv, countActiveShells: async () => 0, now: () => now,
      roster: { store: rosterStore(kv), config: CONFIG },
    });
    if (!released && !values.has(finishedKey)) released = sweep;
  }

  assert.ok(released,
    "twenty sweeps and the retention whose record the store refused on half of them was "
      + "never once read, so it was never released");
  // One cycle of the queue, plus the one sweep the failure can cost it: a key
  // preserved unread does not advance on the sweep it is invisible for, because
  // the read that sweep took could not have been its own.
  assert.ok(released <= 2 * (stuck.length + 1),
    `the finished retention waited ${released} sweeps behind ${stuck.length} stuck `
      + `containers, past the ${2 * (stuck.length + 1)} that a queue which survives an `
      + "incomplete walk bounds it by");
  for (const generation of stuck) {
    assert.ok(values.has(retentionKey(generation)),
      `${generation} was released, and it never answered clear`);
  }
});
