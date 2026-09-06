// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * B38 -- the send window is finished, not stranded.
 *
 * The `dispatched` state is written durably before the request is handed to the
 * transport, which closes the spawn-then-crash window. That write can itself be
 * crash-interrupted: the row lands, the process dies, and the request never
 * goes out. Deciding from the row alone answers that request `unknown` forever
 * and refuses to dispatch it, for work that in fact never ran.
 *
 * The two acts cannot be made one -- a key-value entry and an HTTP call are two
 * systems with no shared transaction -- so the window is closed by finishing the
 * send instead: under the current generation, beneath a readable epoch marker,
 * a readable subtree holding no record says no claim landed, because the claim
 * precedes the spawn and nothing deletes a record while its sandbox lives. Each
 * gate is fail-closed and sends nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveStart, type RecordProbe } from "../src/sandbox/bg-start.js";
import type { BgHandleRow } from "../src/sandbox/bg-handle-rows.js";

const ADDRESS = { ownerScope: "sess", runIdentity: "ktsk_1", shellId: "bg-1" };
const row = (state: BgHandleRow["state"], generation = "gen-1"): BgHandleRow =>
  ({ ...ADDRESS, generation, state });
const probing = (kind: RecordProbe["kind"]) => async () => ({ kind }) as RecordProbe;
const never = async (): Promise<RecordProbe> => {
  throw new Error("the sandbox must not be read on this branch");
};

test("a crash between the dispatched write and the handoff retransmits, not strands", async () => {
  const out = await resolveStart({
    row: row("dispatched"),
    rowReadable: true,
    currentGeneration: "gen-1",
    probe: probing("determinately_absent"),
  });

  assert.equal(out.action, "retransmit",
    "answering unknown here would refuse dispatch forever for a request that "
      + "never went out");
  assert.equal(out.reported, "first_call");
  assert.match(out.reason, /no claim landed/);
});

test("the retransmission is safe because the sandbox arbitrates, not the read", async () => {
  // A send that did land after all is answered by the exclusive create with the
  // existing shell, never with a second process.
  const landed = await resolveStart({
    row: row("dispatched"),
    rowReadable: true,
    currentGeneration: "gen-1",
    probe: probing("record_present"),
  });
  assert.equal(landed.action, "resolve");
  assert.equal(landed.reported, "deduplicated");
});

test("every gate that cannot answer sends nothing", async () => {
  const cases: Array<[string, Parameters<typeof resolveStart>[0]]> = [
    ["subtree or marker unreadable", {
      row: row("dispatched"), rowReadable: true, currentGeneration: "gen-1",
      probe: probing("indeterminate"),
    }],
    ["a prior generation", {
      row: row("dispatched", "gen-0"), rowReadable: true, currentGeneration: "gen-1", probe: never,
    }],
    ["a sandbox destroyed and not replaced", {
      row: row("dispatched"), rowReadable: true, currentGeneration: null, probe: never,
    }],
    ["an unreadable row", {
      row: null, rowReadable: false, currentGeneration: "gen-1", probe: never,
    }],
  ];
  for (const [name, input] of cases) {
    const out = await resolveStart(input);
    assert.equal(out.action, "refuse", name);
    assert.equal(out.reported, "unknown", name);
    assert.equal(out.shellClass, "unknown", name);
  }
});

test("a confirmed row is never retransmitted, whatever the sandbox says now", async () => {
  // The row attests a shell, so a record that is not there is record loss and
  // not a claim that never landed -- the one distinction a generation
  // comparison alone cannot make.
  const lost = await resolveStart({
    row: row("spawn_confirmed"), rowReadable: true, currentGeneration: "gen-1",
    probe: probing("determinately_absent"),
  });
  assert.equal(lost.action, "resolve");
  assert.equal(lost.reported, "deduplicated");
  assert.equal(lost.shellClass, "lost");

  const replaced = await resolveStart({
    row: row("spawn_confirmed", "gen-0"), rowReadable: true, currentGeneration: "gen-1",
    probe: never,
  });
  assert.equal(replaced.action, "resolve");
  assert.equal(replaced.shellClass, "lost", "no second process runs against a replaced sandbox");
});

test("a first call is dispatched, and asks the sandbox nothing", async () => {
  for (const r of [null, row("issued")]) {
    const out = await resolveStart({
      row: r, rowReadable: true, currentGeneration: "gen-1", probe: never,
    });
    assert.equal(out.action, "dispatch");
    assert.equal(out.reported, "first_call");
  }
});
