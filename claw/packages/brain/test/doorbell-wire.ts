// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A doorbell delivery, and a record of whether a claim was attempted.
 *
 * The kill-switch is read at import, so the two values need two processes and
 * therefore two test files; this is what they share rather than copy. The
 * claim recorder replaces `fetch` because the decline has to be proved as "no
 * claim attempted", not merely as "no error".
 */

import { StringCodec, type JsMsg, type KV } from "nats";
import { RUN_DOORBELL_KIND, type RunDoorbell } from "@claw/protocol";

import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { bindTaskDispatchKv } from "../src/tasks/dispatch.js";
import { bindTaskLockKv } from "../src/tasks/lock.js";
import { bindTaskRunnerDeps } from "../src/tasks/runner.js";

const sc = StringCodec();

export interface FakeDelivery {
  msg: JsMsg;
  verdicts: string[];
}

export function doorbellPayload(overrides: Partial<RunDoorbell> = {}): RunDoorbell {
  return {
    kind: RUN_DOORBELL_KIND,
    task_id: "ktsk_wire",
    session_id: "sess-wire",
    message_id: "claw-wire",
    claim_url: "http://api/v1/internal/tasks/ktsk_wire/claim",
    ...overrides,
  };
}

export function fakeDelivery(payload: unknown, deliveryCount = 1): FakeDelivery {
  const verdicts: string[] = [];
  const msg = {
    data: sc.encode(JSON.stringify(payload)),
    redelivered: deliveryCount > 1,
    seq: 7,
    info: { deliveryCount },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  };
  return { msg: msg as unknown as JsMsg, verdicts };
}

/** Count every claim POST this delivery makes, and answer as a lost race. */
export function recordClaims(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ ok: true, request: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

/**
 * Enough of the KV surface for the lock and tombstone reads a fat delivery
 * makes, so the non-doorbell control reaches the handler instead of failing on
 * an unbound binding.
 */
export function fakeKv(): KV {
  const store = new Map<string, Uint8Array>();
  return {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value, operation: "PUT" } : null;
    },
    async create(key: string, value: Uint8Array) {
      if (store.has(key)) throw new Error("wrong last sequence: key exists");
      store.set(key, value);
      return 1;
    },
    async put(key: string, value: Uint8Array) { store.set(key, value); return 1; },
    async delete(key: string) { store.delete(key); },
  } as unknown as KV;
}

/**
 * Bind every module-level dependency a delivery reaches through, and hand back
 * the events it emitted. The fat control needs all three: a doorbell that is
 * declined touches none of them, which is the difference under test.
 */
export function bindDelivery(): { events: Array<Record<string, unknown>> } {
  const kv = fakeKv();
  bindTaskDispatchKv(kv);
  bindTaskLockKv(kv);
  const events: Array<Record<string, unknown>> = [];
  bindTaskRunnerDeps({
    kv,
    kvCkpt: kv,
    emitter: {
      async emit(_s: string, evt: Record<string, unknown>) { events.push(evt); },
    } as unknown as NatsEmitter,
    engine: {} as Engine,
    sideEffects: { postAgentDone: (async () => {}) as never },
  });
  return { events };
}
