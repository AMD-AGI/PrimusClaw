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
import type { Roster } from "../src/sandbox/admission-roster.js";
import type { CapacitySettings } from "../src/sandbox/keepalive-capacity.js";

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

beforeEach(() => {
  store = fakeKv();
  bindAdmission(store.kv as never, CAPACITY);
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

test("a bind failure through the provider callback stops the workload it was about", async () => {
  // SaFE creates the workload before the provisioning hook runs, so a bind that
  // cannot commit is raised from inside `create` -- and the caller's own catch
  // has no handle to stop, because `create` never returned one. Left there, a
  // running workload holds no slot and is named by no record: the untracked
  // target the ceiling exists to prevent.
  const stopped: string[] = [];
  const hold = await admitSandbox("sess-1");
  await hold.release();   // the token is gone, so the bind below cannot commit

  // The provider's own shape: the workload exists, then the hook runs, then
  // `create` resolves. The hook is what has the id to roll back with.
  const create = async (onProvisioned: (id: string) => Promise<void>) => {
    const workloadId = "wl-created";
    try {
      await onProvisioned(workloadId);
    } catch (err) {
      stopped.push(workloadId);
      throw err;
    }
    return { id: workloadId };
  };

  await assert.rejects(() => create(async (workloadId) => {
    try {
      await hold.bind(`sess-1:safe:${workloadId}`);
    } catch (bindErr) {
      stopped.push(workloadId);
      throw bindErr;
    }
  }));

  assert.ok(stopped.includes("wl-created"),
    "the workload that already exists is torn down by the hook that has its id");
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
