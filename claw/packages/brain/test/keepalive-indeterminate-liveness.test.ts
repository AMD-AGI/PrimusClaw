// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * "The unanswered probe keeps the sandbox" has to stay true at every streak
 * length.
 *
 * Both shapes of unanswered probe -- one that never arrives, and one that
 * arrives saying the sandbox cannot read its own durable state -- are the same
 * fact for this decision: nobody established what is running there. Repeating
 * either is not evidence of an empty sandbox; a sandbox whose records were lost
 * is precisely where the orphaned work lives. What a long streak buys is a
 * report an operator can act on, never a licence to reclaim.
 *
 * Driven over enough sweeps to pass the reporting threshold several times, both
 * because that is where the bug was and because the pod must still be there.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import {
  resetBackgroundWorkStateForTest, runKeepaliveTickForTest,
} from "../src/sandbox/keepalive.js";
import { HandsLivenessIndeterminate } from "../src/clients/hands.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-indeterminate";
const KEY = `hands.${SESSION}`;
/** Idle, so the sweep probes it -- and long past the reuse window, so a verdict
 *  of `idle` would expire the handle outright. */
const IDLE_ENTRY = JSON.stringify({
  status: "ready", provider: "safe-workload", workloadId: "wl-1",
  platformKey: "pk", namespace: "ns", handsUrl: "http://sandbox:9100/mcp",
  token: "tok", keepalive: false, idleSince: 0,
});

let values: Map<string, Uint8Array>;
let kv: KV;
let restoreProviders: (() => void) | null = null;

function makeKv(): KV {
  const revisions = new Map<string, number>();
  return {
    async get(key: string) {
      if (!values.has(key)) return null;
      return { value: values.get(key)!, revision: revisions.get(key) ?? 1 };
    },
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...values.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async put(key: string, value: Uint8Array) { values.set(key, value); return 1; },
    async update(key: string, value: Uint8Array) { values.set(key, value); return 1; },
    async delete(key: string) { values.delete(key); },
  } as unknown as KV;
}

beforeEach(() => {
  values = new Map([[KEY, sc.encode(IDLE_ENTRY)]]);
  kv = makeKv();
  resetBackgroundWorkStateForTest();
  restoreProviders = bindSandboxProviders({
    safeWorkload: {
      async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    } as unknown as SandboxProvider,
  });
});

afterEach(() => {
  restoreProviders?.();
  restoreProviders = null;
  resetBackgroundWorkStateForTest();
});

/** Enough sweeps to pass the give-up threshold several times over. */
const SWEEPS = 12;

async function sweep(countActiveShells: () => Promise<number>): Promise<void> {
  for (let i = 0; i < SWEEPS; i++) {
    await runKeepaliveTickForTest({ kv, countActiveShells });
    await new Promise((r) => setImmediate(r));
  }
}

test("a sandbox that says it cannot tell is never given up on", async () => {
  await sweep(async () => { throw new HandsLivenessIndeterminate("records unreadable"); });

  assert.ok(values.has(KEY),
    "the handle survives every sweep: no number of repetitions turns 'I cannot "
      + "read my own records' into 'nothing is running here'");
});

test("a probe that simply never arrives is not given up on either", async () => {
  // The two shapes were kept apart on the theory that a transport failure
  // repeated long enough means an empty sandbox. It does not: it means nobody
  // asked and got an answer, and reclaiming on it destroys whatever was running
  // in exactly the sandbox least able to say so.
  await sweep(async () => { throw new Error("ETIMEDOUT"); });

  assert.ok(values.has(KEY),
    "an unanswered probe was converted into an idle verdict by repetition");
});

test("a sandbox that answers with live work keeps its handle", async () => {
  await sweep(async () => 1);
  assert.ok(values.has(KEY));
});
