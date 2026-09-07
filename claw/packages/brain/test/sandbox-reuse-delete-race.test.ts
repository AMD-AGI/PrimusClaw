// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reuse path and the idle sweep racing for one parked handle.
 *
 * Reactivate-wins is safe on its own: the sweep's delete is conditional on the
 * revision reuse just bumped, so it loses and releases nothing. Delete-wins was
 * not. The sweep deleted the record and gave the admission slot back, and reuse
 * -- which had already read the entry and passed its health gate -- swallowed
 * the failed write and registered the sandbox anyway. That puts a ping target
 * back on the fleet holding no slot, so the real target set can exceed the
 * ceiling admission exists to hold, reached through ordinary reuse rather than
 * through a race between two provisioners.
 *
 * The race is constructed deterministically: the bucket drops the record
 * between the read reuse decided on and the write it conditions on that read,
 * which is exactly the window the sweep lands in.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";

import { bindSandboxReuseEffects, tryReuseSessionSandbox } from "../src/sandbox/ensure-hands.js";
import { requestSpecFingerprint } from "../src/sandbox/ensure-hands.js";
import { resolveSandboxAction } from "../src/sandbox/params.js";

const realFetch = globalThis.fetch;
let restoreEffects: (() => void) | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreEffects?.();
  restoreEffects = null;
});

const SESSION = "s-race";
const REQUEST: ExecuteRequest = {
  session_id: SESSION,
  prompt: "carry on",
  sandbox_image: "example.io/torch:2.4",
};

function specOf(): string {
  const action = resolveSandboxAction(REQUEST);
  assert.equal(action.kind, "create", "this fixture has to describe a sandbox to build");
  return requestSpecFingerprint(REQUEST, action as never);
}

/** A parked handle: keepalive:false is what makes reuse try to clear markers. */
function parkedEntry(): Record<string, unknown> {
  return {
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-race",
    platformKey: "pk",
    sessionId: SESSION,
    sandboxName: "sb-race",
    namespace: "ns",
    handsUrl: "http://hands:9100/mcp",
    token: "tok",
    specFingerprint: specOf(),
    keepalive: false,
    idleSince: "2020-01-01T00:00:00.000Z",
  };
}

/**
 * A bucket whose record disappears once, between the read and the write.
 *
 * `whenGone` picks which side of the race wins: "deleted" is the sweep landing
 * first, "contended" is a sibling bumping the revision with the record intact.
 */
function racingKv(whenGone: "deleted" | "contended"): { kv: KV; updates: number } {
  const enc = new TextEncoder();
  const state = { present: true, revision: 7, updates: 0 };
  const kv = {
    async get(key: string) {
      if (!key.startsWith("hands.")) return null;
      if (!state.present) return null;
      return { key, value: enc.encode(JSON.stringify(parkedEntry())), revision: state.revision };
    },
    async update(_key: string, _value: Uint8Array, revision: number) {
      state.updates += 1;
      if (revision === 7) {
        // The window: the sweep ran between reuse's read and this write.
        if (whenGone === "deleted") state.present = false;
        state.revision = 8;
        throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      }
      return state.revision + 1;
    },
  };
  return { kv: kv as unknown as KV, get updates() { return state.updates; } };
}

interface Registration { sessionId: string }

function stubEffects(): { registered: Registration[]; destroyed: string[] } {
  const registered: Registration[] = [];
  const destroyed: string[] = [];
  restoreEffects = bindSandboxReuseEffects({
    destroyHands: async (sessionId: string) => { destroyed.push(sessionId); },
    registerSandbox: ((sessionId: string) => { registered.push({ sessionId }); }) as never,
    probeSandboxContainer: async () => ({ verdict: "alive" as const, reason: "exec_ok" as const }),
  });
  return { registered, destroyed };
}

function attempt(kv: KV) {
  return tryReuseSessionSandbox({
    kv,
    sessionId: SESSION,
    request: REQUEST,
    requestedSpec: specOf(),
    onEvent: async () => {},
  } as never);
}

test("a handle deleted by the sweep mid-reactivation is not re-admitted", async () => {
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  const { registered } = stubEffects();
  const { kv } = racingKv("deleted");

  const reused = await attempt(kv);

  assert.equal(reused, null,
    "reuse returned a sandbox whose admission slot the sweep had already released");
  assert.deepEqual(registered, [],
    "an unadmitted ping target was registered, so the target set can pass the ceiling");
});

test("a handle merely contended mid-reactivation is still reused", async () => {
  // The positive control: without it, refusing every lost CAS would pass the
  // test above while rebuilding a live sandbox on every heartbeat collision.
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  const { registered } = stubEffects();
  const { kv } = racingKv("contended");

  const reused = await attempt(kv);

  assert.notEqual(reused, null, "a lost CAS on a record that is still there is not a lost sandbox");
  assert.deepEqual(registered.map((r) => r.sessionId), [SESSION]);
});
