// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The terminal claim: set, renewed, lapsing on its own, and never read as absent when unreadable. */

import test from "node:test";
import assert from "node:assert/strict";
import { putTerminalHold, readTerminalHold, terminalHoldKey } from "@claw/protocol";

function fakeKv(): { store: Map<string, Uint8Array>; kv: Parameters<typeof putTerminalHold>[0] & Parameters<typeof readTerminalHold>[0] } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    kv: {
      async get(k: string) { const v = store.get(k); return v ? { value: v } : null; },
      async put(k: string, v: Uint8Array) { store.set(k, v); },
    },
  };
}

test("a claim holds until its bound and then lapses without anyone deleting it", async () => {
  const { kv } = fakeKv();
  await putTerminalHold(kv, "s1", 1_000, 10_000);
  assert.deepEqual(await readTerminalHold(kv, "s1", 10_500), { state: "held", until: 11_000 });
  assert.deepEqual(await readTerminalHold(kv, "s1", 11_000), { state: "none" });
});

test("renewing moves the bound; the key never matches hands.*", async () => {
  const { kv } = fakeKv();
  await putTerminalHold(kv, "s1", 1_000, 10_000);
  await putTerminalHold(kv, "s1", 1_000, 10_900);
  assert.deepEqual(await readTerminalHold(kv, "s1", 11_500), { state: "held", until: 11_900 });
  assert.ok(!terminalHoldKey("s1").startsWith("hands."));
  assert.ok(!terminalHoldKey("s1").slice("termhold.".length).includes("."), "one token after the prefix");
});

test("another session's claim says nothing about this one", async () => {
  const { kv } = fakeKv();
  await putTerminalHold(kv, "s1", 1_000, 10_000);
  assert.deepEqual(await readTerminalHold(kv, "s2", 10_100), { state: "none" });
});

test("an unreadable bucket or record is unreadable, not none", async () => {
  const broken = { async get() { throw new Error("bucket down"); } };
  assert.equal((await readTerminalHold(broken, "s1")).state, "unreadable");
  const { kv, store } = fakeKv();
  store.set(terminalHoldKey("s1"), new TextEncoder().encode("not json"));
  assert.equal((await readTerminalHold(kv, "s1")).state, "unreadable");
  store.set(terminalHoldKey("s1"), new TextEncoder().encode('{"until":"soon"}'));
  assert.equal((await readTerminalHold(kv, "s1")).state, "unreadable");
});
