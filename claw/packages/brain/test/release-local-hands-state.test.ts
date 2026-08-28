// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Dropping a deleted session's local references, whatever the teardown did.
 *
 * destroyHands does this too, but it only runs once the resources are confirmed
 * gone -- it deletes the `hands.<sid>` entry, which an unfinished teardown still
 * needs. So the local half is split out and runs on every path, and the
 * unfinished path is where it matters most: a replica that keeps its keepalive
 * registration goes on exec-ing into a stopped workload every 60s, which
 * refreshes SaFE's lastActivity and suppresses the very GC that would otherwise
 * reclaim the pod.
 *
 * The token is the observable half, so that is what these check. The keepalive
 * deregistration behind it is a private map with no reader to assert against.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { bindHandsKv, isValidHandsToken, registerHandsToken } from "../src/sandbox/registry.js";
import { releaseLocalHandsState } from "../src/sandbox/reaper.js";

const sc = StringCodec();

/** A KV holding whatever `hands.*` entries the test seeds. */
function bindKvWith(entries: Record<string, unknown>): void {
  const store = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(entries)) {
    store.set(key, sc.encode(JSON.stringify(value)));
  }
  bindHandsKv({
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value, revision: 1 } : null;
    },
    async keys() {
      const matched = [...store.keys()];
      return (async function* () {
        for (const k of matched) yield k;
      })();
    },
  } as unknown as KV);
}

test("the session's token stops being accepted", async () => {
  // Tokens live in a process-level registry, so each test uses its own value.
  const token = "hands-token-local-1";
  const sid = "sess-local-1";
  bindKvWith({});
  registerHandsToken(sid, token);
  assert.equal(await isValidHandsToken(token), true, "precondition");

  releaseLocalHandsState(sid);

  assert.equal(await isValidHandsToken(token), false);
});

test("it does not depend on the KV entry, which an unfinished teardown keeps", async () => {
  // The entry is deliberately still there -- parked for the idle-reclaim sweeper.
  // Revoking must not require reading it, or the incomplete path would keep
  // accepting a deleted session's token.
  const token = "hands-token-local-2";
  const sid = "sess-local-2";
  // Shaped as parkForIdleReclaim leaves it: kept for the sweeper, token cleared.
  bindKvWith({ [`hands.${sid}`]: { token: "", status: "ready", keepalive: false } });
  registerHandsToken(sid, token);

  releaseLocalHandsState(sid);

  // Nothing can revive it. The local registry is cleared, and the entry the
  // sweeper still needs no longer carries the token for isValidHandsToken's KV
  // scan to match -- which is what makes the revocation immediate on every
  // replica rather than lasting until the parked entry expires.
  assert.equal(await isValidHandsToken(token), false);
});

test("one session's release leaves another's token alone", async () => {
  const mine = "hands-token-local-3a";
  const theirs = "hands-token-local-3b";
  bindKvWith({});
  registerHandsToken("sess-local-3a", mine);
  registerHandsToken("sess-local-3b", theirs);

  releaseLocalHandsState("sess-local-3a");

  assert.equal(await isValidHandsToken(mine), false);
  assert.equal(await isValidHandsToken(theirs), true);
});

test("releasing a session that was never registered is harmless", () => {
  bindKvWith({});
  releaseLocalHandsState("sess-local-never-seen"); // must not throw
});
