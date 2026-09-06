// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Admission happens before the provider is called, not after the sandbox exists.
 *
 * The sweep-boundary half of B42 reconciles targets it finds. That is the right
 * behaviour for a target another replica created, and the wrong place to hold a
 * ceiling: by the time a sweep sees two sandboxes that raced the last slot, both
 * are running, both may be hosting the background work nothing is allowed to
 * evict, and the deferral bound every handle's refresh gap rests on has already
 * been exceeded. So the slot is claimed first, under a token that names no
 * sandbox, and bound to the provider-assigned identity at the first moment one
 * exists -- ahead of bootstrap, the health check, the durable record and local
 * registration.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { SandboxCapacityRefused, admitSandbox, bindAdmission } from "../src/sandbox/admission.js";
import { CeilingDisagreement } from "../src/sandbox/admission-roster.js";
import type { Roster } from "../src/sandbox/admission-roster.js";
import type { CapacitySettings } from "../src/sandbox/keepalive-capacity.js";
import { makeOnProvisioned } from "../src/sandbox/ensure-hands.js";
import type { KV } from "nats";

/** A registry bucket whose writes land, so the hook reaches its own end. */
const kvThatWorks = (): KV => ({ async put() { return 1; } } as unknown as KV);

const CAPACITY: CapacitySettings = { ceiling: 3, reconciliationReserve: 1 };
const ROSTER_KEY = "keepalive.roster";

/**
 * A revision-aware stand-in for the registry bucket, exposing the same
 * compare-and-set the real one does. Two callers reading one revision and both
 * writing is the race, so the stub must refuse the second write rather than
 * serialise them.
 */
function fakeKv() {
  let value: string | null = null;
  let revision = 0;
  const encoder = new TextEncoder();
  const kv = {
    async get(key: string) {
      if (key !== ROSTER_KEY || value === null) return null;
      return { value: encoder.encode(value), revision };
    },
    async create(key: string, data: Uint8Array) {
      if (key !== ROSTER_KEY) throw new Error("unexpected key");
      if (value !== null) throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      value = new TextDecoder().decode(data);
      revision += 1;
    },
    async update(key: string, data: Uint8Array, expected: number) {
      if (key !== ROSTER_KEY) throw new Error("unexpected key");
      if (expected !== revision) throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      value = new TextDecoder().decode(data);
      revision += 1;
    },
  };
  return {
    kv,
    roster: (): Roster | null => (value === null ? null : JSON.parse(value) as Roster),
  };
}

let store: ReturnType<typeof fakeKv>;

beforeEach(async () => {
  store = fakeKv();
  await bindAdmission(store.kv as never, CAPACITY);
});

/** Fill the roster to one ordinary slot below the reserve boundary. */
async function fillToLastSlot(): Promise<void> {
  for (let i = 0; i < CAPACITY.ceiling - CAPACITY.reconciliationReserve - 1; i++) {
    const hold = await admitSandbox(`seed-${i}`);
    await hold.bind(`sandbox-${i}`);
  }
}

test("two provisioning attempts racing the last slot: only one ever calls the provider", async () => {
  await fillToLastSlot();
  const provisioned: string[] = [];

  // Both reach the claim step before either has provisioned anything. A build
  // that admits at the sweep boundary instead lets both call the provider and
  // discovers the second only once it is live work nothing may evict.
  const attempt = async (name: string) => {
    const hold = await admitSandbox(name);
    provisioned.push(name);
    await hold.bind(`sandbox-${name}`);
  };
  const results = await Promise.allSettled([attempt("a"), attempt("b")]);

  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "the roster gains exactly one slot");
  assert.equal(lost.length, 1);
  assert.ok((lost[0] as PromiseRejectedResult).reason instanceof SandboxCapacityRefused);

  assert.equal(provisioned.length, 1,
    "the loser calls no provider at all -- which is the whole point of claiming "
      + "before provisioning rather than after");
  assert.equal(store.roster()!.entries.length, CAPACITY.ceiling - CAPACITY.reconciliationReserve);
});

test("the claim precedes the identity, so the slot starts naming nothing", async () => {
  const hold = await admitSandbox("sess-1");

  const provisional = store.roster()!.entries.at(-1)!;
  assert.equal(provisional.identity, null,
    "the provider assigns the identity, so a slot claimed before it cannot name one");

  await hold.bind("sandbox-1");
  assert.equal(store.roster()!.entries.at(-1)!.identity, "sandbox-1");
  assert.equal(store.roster()!.entries.length, 1, "and the bind adds no slot");
});

test("a provider call that fails gives the slot back, and the next claim succeeds", async () => {
  await fillToLastSlot();
  const hold = await admitSandbox("sess-fails");
  await assert.rejects(() => admitSandbox("sess-next"), SandboxCapacityRefused);

  await hold.release();

  const retry = await admitSandbox("sess-next");
  await retry.bind("sandbox-next");
  assert.ok(store.roster()!.entries.some((e) => e.identity === "sandbox-next"),
    "released with no clock involved: a refused or failed provisioning is not a "
      + "reservation anyone is waiting out");
});

test("a bind that cannot commit is raised, so the caller stops what it created", async () => {
  const hold = await admitSandbox("sess-1");
  await hold.release();

  await assert.rejects(() => hold.bind("sandbox-orphan"), /could not bind its slot/,
    "a live sandbox holding no slot is the un-slotted target the ceiling exists "
      + "to prevent, so this cannot pass silently");
});

test("a bind failure through the production hook stops the workload it was about", async () => {
  // SaFE creates the workload before the provisioning hook runs, so a bind that
  // cannot commit is raised from inside `create` -- and the caller's own catch
  // has no handle to stop, because `create` never returned one. Driven through
  // `makeOnProvisioned`, which is the function production installs, so deleting
  // the rollback call fails this rather than leaving a stand-in green.
  const stopped: string[] = [];
  const hold = await admitSandbox("sess-1");
  await hold.release();   // the token is gone, so the bind below cannot commit

  const onProvisioned = makeOnProvisioned({
    sessionId: "sess-1", namespace: "ns", apiKey: "pk", handsToken: "tok",
    sandboxImage: null, kv: kvThatWorks(), hold,
    stop: async (id) => { stopped.push(id); },
  });

  await assert.rejects(() => onProvisioned("wl-created"), /could not bind its slot/);
  assert.deepEqual(stopped, ["wl-created"],
    "the workload that already exists is taken down by the hook that has its id");
});

test("a rollback whose stop also fails is raised, not swallowed", async () => {
  // Silently swallowed, the workload is left running, holding no slot and named
  // by no record -- the untracked target the rollback exists to prevent, now
  // invisible as well.
  const hold = await admitSandbox("sess-1");
  await hold.release();

  const onProvisioned = makeOnProvisioned({
    sessionId: "sess-1", namespace: "ns", apiKey: "pk", handsToken: "tok",
    sandboxImage: null, kv: kvThatWorks(), hold,
    stop: async () => { throw new Error("control plane unreachable"); },
  });

  await assert.rejects(
    () => onProvisioned("wl-stuck"),
    /running, unadmitted and untracked/,
    "the operator is told which workload, and why it matters",
  );
});

test("a durable-record write that never lands rolls the workload back too", async () => {
  // The other obligation the hook carries: without the record, nothing can stop
  // this workload later.
  const stopped: string[] = [];
  const hold = await admitSandbox("sess-1");

  const onProvisioned = makeOnProvisioned({
    sessionId: "sess-1", namespace: "ns", apiKey: "pk", handsToken: "tok",
    sandboxImage: null, hold,
    kv: { async put() { throw new Error("kv down"); } } as unknown as KV,
    stop: async (id) => { stopped.push(id); },
  });

  await assert.rejects(() => onProvisioned("wl-unrecorded"), /KV pending write failed/);
  assert.deepEqual(stopped, ["wl-unrecorded"]);
});

test("with no ceiling configured, admission reserves nothing and refuses nothing", async () => {
  // Background shells off: there is no ceiling to hold and no work to protect,
  // and provisioning must not acquire a dependency on a roster that has no
  // reason to exist.
  bindAdmission(store.kv as never, { ceiling: 0, reconciliationReserve: 0 });
  for (let i = 0; i < CAPACITY.ceiling * 3; i++) {
    const hold = await admitSandbox(`sess-${i}`);
    await hold.bind(`sandbox-${i}`);
  }
  assert.equal(store.roster(), null);
});

test("a replica configured at a different ceiling refuses to finish starting", async () => {
  // One value governs the whole fleet: a replica computing a different deferral
  // count proves a different refresh gap against the same handles. Discovered
  // on a later sweep, it is already serving requests -- and reporting healthy
  // -- under a bound it does not share, so the check is at the bind.
  const hold = await admitSandbox("sess-1");
  await hold.bind("sandbox-1");

  await assert.rejects(
    () => bindAdmission(store.kv as never, { ...CAPACITY, ceiling: CAPACITY.ceiling + 5 }),
    (err: unknown) => err instanceof CeilingDisagreement
      && err.stamped === CAPACITY.ceiling
      && err.configured === CAPACITY.ceiling + 5,
  );
});

test("a matching ceiling, and an unstamped roster, both bind", async () => {
  await assert.doesNotReject(() => bindAdmission(store.kv as never, CAPACITY),
    "nothing has claimed against it yet, so there is nothing to disagree with");

  const hold = await admitSandbox("sess-1");
  await hold.bind("sandbox-1");
  await assert.doesNotReject(() => bindAdmission(store.kv as never, CAPACITY));
});
