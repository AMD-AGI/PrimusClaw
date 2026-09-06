// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * B42 -- admission has to be fleet-wide and race-safe, not process-local.
 *
 * The deferral count a sweep accumulates is derived from how many targets it
 * faces, and the activity gap the keepalive relation is proven against is
 * derived from that count. The in-memory registry is per-process, so two
 * replicas each observing one slot below the ceiling both admitted, the real
 * target set exceeded the value the relation was proven at, and a live
 * background shell could miss the idle reclaim the sweep exists to hold off --
 * because a different sandbox was admitted.
 *
 * The tests below are the two the finding names: two replicas racing the
 * boundary, and a running sweeper handed remote registrations past the ceiling.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CeilingDisagreement, bindSlot, claimProvisionalSlot, deferralCount, reconcileTargets,
  releaseSlot, renewAndReap, type Roster, type RosterConfig, type RosterStore,
} from "../src/sandbox/admission-roster.js";

const CONFIG: RosterConfig = {
  ceiling: 6,
  reconciliationReserve: 2,
  reclaimHorizonMs: 60_000,
  replicaId: "replica-a",
};

/**
 * A revision-aware store, plus a seam that lets a test hold one replica's read
 * open across another's write -- which is the race itself.
 */
function sharedStore() {
  let value: Roster | null = null;
  let revision = 0;
  return {
    peek: () => value,
    store(replicaId: string): RosterStore {
      return {
        async read() {
          return value === null ? null : { roster: structuredClone(value), revision };
        },
        async write(roster, expected) {
          if ((expected ?? null) !== (value === null ? null : revision)) return false;
          value = structuredClone(roster);
          revision += 1;
          void replicaId;
          return true;
        },
      };
    },
  };
}

const configFor = (replicaId: string): RosterConfig => ({ ...CONFIG, replicaId });

async function fill(store: RosterStore, config: RosterConfig, n: number): Promise<string[]> {
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) {
    const claim = await claimProvisionalSlot(store, config);
    assert.ok(claim.ok, `seed claim ${i}`);
    await bindSlot(store, config, claim.token, `sandbox-${i}`);
    tokens.push(claim.token);
  }
  return tokens;
}

test("two replicas racing the last ordinary slot: exactly one wins", async () => {
  const shared = sharedStore();
  const a = shared.store("replica-a");
  const b = shared.store("replica-b");
  // One ordinary slot below the reserve boundary.
  await fill(a, configFor("replica-a"), CONFIG.ceiling - CONFIG.reconciliationReserve - 1);

  // Both reach the claim step against the same revision. A build that counts
  // the roster and then writes unconditionally admits both and fails here.
  const [first, second] = await Promise.all([
    claimProvisionalSlot(a, configFor("replica-a")),
    claimProvisionalSlot(b, configFor("replica-b")),
  ]);

  const winners = [first, second].filter((r) => r.ok);
  assert.equal(winners.length, 1, "the roster gains exactly one slot");
  assert.equal(
    shared.peek()!.entries.length, CONFIG.ceiling - CONFIG.reconciliationReserve,
  );
  const loser = [first, second].find((r) => !r.ok)!;
  assert.equal(loser.ok, false);
  assert.equal((loser as { reason: string }).reason, "at_capacity",
    "and the loser reports the capacity condition rather than provisioning");
});

test("the winner's slot is provisional: it names nothing and is not a target", async () => {
  const shared = sharedStore();
  const a = shared.store("replica-a");
  const claim = await claimProvisionalSlot(a, CONFIG);
  assert.ok(claim.ok);

  const provisional = shared.peek()!.entries[0];
  assert.equal(provisional.identity, null,
    "the provider assigns the identity, so the slot precedes it and is pinged by nobody");
  assert.equal(provisional.token, claim.token);

  const bound = await bindSlot(a, CONFIG, claim.token, "sandbox-x");
  assert.deepEqual(bound, { ok: true, added: true });
  assert.equal(shared.peek()!.entries.length, 1, "the bind adds no slot");
  assert.equal(shared.peek()!.entries[0].identity, "sandbox-x");
});

test("each rollback gives the slot back, and a refused claim then succeeds", async () => {
  const shared = sharedStore();
  const a = shared.store("replica-a");
  await fill(a, CONFIG, CONFIG.ceiling - CONFIG.reconciliationReserve - 1);

  const claim = await claimProvisionalSlot(a, CONFIG);
  assert.ok(claim.ok);
  const refused = await claimProvisionalSlot(a, CONFIG);
  assert.equal(refused.ok, false, "at the boundary, with the reserve held back");

  // A provider call that fails releases the provisional slot.
  await releaseSlot(a, CONFIG, { token: claim.token });
  const retry = await claimProvisionalSlot(a, CONFIG);
  assert.ok(retry.ok, "the released slot is available again, with no clock involved");
  await releaseSlot(a, CONFIG, { token: retry.token });
});

test("a bind onto an identity the roster already holds adds nothing and stands down", async () => {
  const shared = sharedStore();
  const a = shared.store("replica-a");
  const first = await claimProvisionalSlot(a, CONFIG);
  assert.ok(first.ok);
  await bindSlot(a, CONFIG, first.token, "sandbox-shared");

  const second = await claimProvisionalSlot(a, CONFIG);
  assert.ok(second.ok);
  const bound = await bindSlot(a, CONFIG, second.token, "sandbox-shared");

  assert.deepEqual(bound, { ok: true, added: false });
  assert.equal(shared.peek()!.entries.length, 1, "one target, one slot, whichever path reached it");
  assert.equal(shared.peek()!.entries[0].identity, "sandbox-shared");
});

test("a bind that cannot find its token reports it rather than inventing a slot", async () => {
  const shared = sharedStore();
  const a = shared.store("replica-a");
  const bound = await bindSlot(a, CONFIG, "a-token-nobody-claimed", "sandbox-y");
  assert.deepEqual(bound, { ok: false, reason: "token_gone" });
  assert.equal(shared.peek(), null, "a live sandbox holding no slot is what the ceiling forbids");
});

test("a replica killed between claim and bind holds its slot until the reclaim horizon", async () => {
  const shared = sharedStore();
  const a = shared.store("replica-a");
  const b = shared.store("replica-b");
  const claim = await claimProvisionalSlot(a, CONFIG);
  assert.ok(claim.ok);

  // Another replica sweeping inside the horizon must not take the reservation:
  // the horizon exceeds both one sweep span and the declared provisioning
  // ceiling, so neither a slow sweeper nor a slow but live create loses it.
  await renewAndReap(b, configFor("replica-b"), new Set(), Date.now() + CONFIG.reclaimHorizonMs - 1);
  assert.equal(shared.peek()!.entries.length, 1, "held throughout the provisioning ceiling");

  await renewAndReap(b, configFor("replica-b"), new Set(), Date.now() + CONFIG.reclaimHorizonMs + 1);
  assert.equal(shared.peek()!.entries.length, 0, "and released only past it");
});

test("a bound slot is never released while a handle record still names its target", async () => {
  const shared = sharedStore();
  const a = shared.store("replica-a");
  const b = shared.store("replica-b");
  const claim = await claimProvisionalSlot(a, CONFIG);
  assert.ok(claim.ok);
  await bindSlot(a, CONFIG, claim.token, "sandbox-live");

  await renewAndReap(
    b, configFor("replica-b"), new Set(["sandbox-live"]), Date.now() + CONFIG.reclaimHorizonMs * 10,
  );
  assert.equal(shared.peek()!.entries.length, 1,
    "releasing a slot for a target still being pinged is what carries the fleet "
      + "past the ceiling");
  assert.equal(shared.peek()!.entries[0].claimedBy, "replica-b", "it is adopted and renewed");
});

test("a sweeper mid-tick takes on remote registrations past the reserve boundary", async () => {
  const shared = sharedStore();
  const a = shared.store("replica-a");
  // At the reserve boundary: ordinary admission is already refused.
  await fill(a, CONFIG, CONFIG.ceiling - CONFIG.reconciliationReserve);
  assert.equal((await claimProvisionalSlot(a, CONFIG)).ok, false);

  // Handle records written by another replica appear for identities the roster
  // does not hold, one of them holding the active background shell.
  const remote = ["remote-idle-1", "remote-active", "remote-idle-2"];
  const result = await reconcileTargets(a, CONFIG, [...remote, "sandbox-0"]);

  assert.deepEqual(result.admitted, remote,
    "every un-admitted identity is bound straight in before the sweep serves it, "
      + "and the ceiling refuses none of them");
  assert.ok(shared.peek()!.entries.some((e) => e.identity === "remote-active"),
    "the target holding live work is admitted rather than left to residual capacity");
  assert.equal(result.breach, true, "and the resulting size above the ceiling is declared");
  assert.deepEqual(result.beyondCeiling.length, result.rosterSize - CONFIG.ceiling);
});

test("a declared breach refuses ordinary claims and expires nothing", async () => {
  const shared = sharedStore();
  const a = shared.store("replica-a");
  await fill(a, CONFIG, CONFIG.ceiling - CONFIG.reconciliationReserve);
  const before = shared.peek()!.entries.map((e) => e.identity);

  const remote = Array.from({ length: 5 }, (_, i) => `remote-${i}`);
  const result = await reconcileTargets(a, CONFIG, remote);
  assert.ok(result.breach);
  assert.equal((await claimProvisionalSlot(a, CONFIG)).ok, false,
    "ordinary admission stays refused while the breach stands");

  for (const identity of before) {
    assert.ok(shared.peek()!.entries.some((e) => e.identity === identity),
      "nothing is dropped, expired, reclaimed or evicted on account of the breach");
  }
  // Under the breach the deferral count degrades equally for every target --
  // finite, equal, and indefinite for none.
  assert.equal(deferralCount(result.rosterSize, 4), Math.ceil(result.rosterSize / 4) - 1);
});

test("a replica configured at a different ceiling refuses rather than reconciling", async () => {
  const shared = sharedStore();
  await claimProvisionalSlot(shared.store("replica-a"), CONFIG);

  await assert.rejects(
    () => claimProvisionalSlot(shared.store("replica-b"), { ...CONFIG, ceiling: 99 }),
    (err: unknown) => err instanceof CeilingDisagreement && err.stamped === CONFIG.ceiling,
    "one value governs the whole fleet, and a second would prove a different "
      + "activity gap against the same handles",
  );
});

test("from two slots below the boundary both replicas succeed", async () => {
  const shared = sharedStore();
  const a = shared.store("replica-a");
  const b = shared.store("replica-b");
  await fill(a, configFor("replica-a"), CONFIG.ceiling - CONFIG.reconciliationReserve - 2);

  const [first, second] = await Promise.all([
    claimProvisionalSlot(a, configFor("replica-a")),
    claimProvisionalSlot(b, configFor("replica-b")),
  ]);
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.token, second.token);
  assert.equal(shared.peek()!.entries.length, CONFIG.ceiling - CONFIG.reconciliationReserve);
});
