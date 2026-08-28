// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Hands sandbox bookkeeping shared by the ensure-hands/reaper modules.
 *
 *   - BRAIN_REGISTRY KV handle: bound once at boot (same pattern as
 *     sandbox/handles.ts initDagHandles), so this package never needs a
 *     circular import back into index.ts just to read/write the
 *     `hands.<sessionId>` entries.
 *   - Per-sandbox bearer token registry backing the `/internal/assets/*`
 *     auth check.
 */
import { LRUCache } from "lru-cache";
import type { KV } from "nats";
import { isTombstone } from "../tasks/lock.js";
import { StringCodec } from "nats";
import { isValidDagHandleToken } from "./handles.js";

const sc = StringCodec();

let _kv: KV | null = null;

/** Bind the BRAIN_REGISTRY KV bucket. Called once from index.ts main() boot. */
export function bindHandsKv(kv: KV): void {
  _kv = kv;
}

/** Read back the bound KV bucket. Throws if bindHandsKv() was never called. */
export function getHandsKv(): KV {
  if (!_kv) throw new Error("sandbox/registry.not_bound -- call bindHandsKv(kv) at boot");
  return _kv;
}

// ── Per-sandbox token registry for /internal/assets/* auth ──────────────
// In-memory only: tokens are issued by ensureHands and revoked when a session
// is torn down. On a multi-replica brain Deployment this is per-pod, so the
// auth check falls back to the NATS KV `hands.<sessionId>.token` when a local
// lookup misses (covers cross-pod rolling cases); the local check alone is
// normally sufficient because the sandbox's bootstrap curl lands on the same
// pod that just ran ensureHands via kube-proxy per-IP affinity.

/**
 * How many tokens a pod keeps hot. Bounded because entries are only removed on
 * an explicit session teardown, while most sessions end by idling out instead —
 * nothing on that path reaches Brain, so an unbounded registry would grow for
 * the whole process lifetime. Eviction costs nothing but a KV scan on the next
 * use of that token, which re-memoizes it.
 */
const HANDS_TOKEN_CACHE_MAX = 1000;

/**
 * Live tokens → the session that issued them.
 *
 * Keyed by token so validation stays O(1), with the session as the value
 * because revocation is driven by teardown, which knows the session id but not
 * the token. Looking the token up in `hands.<sid>` instead is exactly what does
 * not work: teardown deletes that entry, from two directions, so the revocation
 * that matters most is the one whose read loses the race.
 */
const handsTokens = new LRUCache<string, string>({ max: HANDS_TOKEN_CACHE_MAX });

/**
 * Tokens that failed validation recently, so a replay costs nothing.
 *
 * A miss on `handsTokens` is expensive in a way the hit is not: it scans the
 * whole `hands.*` bucket with a `get` per key, and then the whole DAG handle
 * bucket the same way. The endpoint that calls this serves the Hands binary to
 * code running inside a sandbox, so a token nobody ever issued can be replayed
 * as fast as the network allows, and each replay pays for both scans against
 * NATS. Remembering the denial for a few seconds bounds that to one scan per
 * token per window.
 *
 * Short, and cleared by `registerHandsToken`, because the one thing this must
 * not do is outlive a token's issuance: a sandbox coming up asks for its binary
 * within moments of its token being written.
 */
const deniedTokens = new LRUCache<string, true>({
  max: HANDS_TOKEN_CACHE_MAX,
  ttl: 5_000,
});

/** Record a freshly issued token against its session. */
export function registerHandsToken(sessionId: string, token: string): void {
  if (!sessionId || !token) return;
  handsTokens.set(token, sessionId);
  deniedTokens.delete(token);
}

/**
 * Revoke whatever token a session holds, without needing its value.
 *
 * Called on teardown by every replica, since this registry is process-local.
 * Scans rather than indexing both ways: a session has one token, teardown is
 * rare, and the map is bounded.
 */
export function revokeSessionHandsToken(sessionId: string): void {
  if (!sessionId) return;
  const owned: string[] = [];
  for (const [token, sid] of handsTokens.entries()) {
    if (sid === sessionId) owned.push(token);
  }
  for (const token of owned) handsTokens.delete(token);
}

/** Revoke one sandbox token without touching DAG siblings sharing a session. */
export function revokeHandsToken(token: string): void {
  if (token) handsTokens.delete(token);
}

/** Validate a sandbox-issued bearer token. Cheap path: the local registry on
 *  this brain pod. Slow path: scan NATS KV hands.* entries for a matching
 *  token — needed when curl lands on a pod that did not create the sandbox. */
/**
 * Is a task actually running for this session, anywhere in the fleet?
 *
 * `lock.<sessionId>` is the run lease: a task in flight re-proves it on a
 * heartbeat and it expires shortly after the worker holding it dies. It lives
 * in this bucket alongside `hands.*`, so any replica can read it.
 *
 * Reclaim paths need this rather than the local registry. `registeredSandboxCount`
 * answers "is THIS replica running it", which is the wrong question for a
 * sweeper: with three brain replicas, the two that are not running the session
 * see zero and conclude the sandbox is idle. The entry alone cannot settle it
 * either -- a reuse whose idle markers could not be cleared still reads as
 * `keepalive:false` with a stale `idleSince`, which is exactly the shape a
 * reclaim treats as its licence.
 */
export async function sessionHasActiveRunLease(
  kv: KV,
  sessionId: string,
  runScope?: unknown,
): Promise<boolean> {
  // `pickRunScope` keys the lease by DAG root when the run has one, so looking
  // under the session id finds nothing for precisely the runs that own
  // multi-node clusters. Entries written before this field existed fall back to
  // the session, which is what a single-node run uses anyway.
  const scope = typeof runScope === "string" && runScope ? runScope : sessionId;
  const lock = await kv.get(`lock.${scope}`).catch(() => null);
  // A released lease is deleted, and a delete leaves a readable entry with an
  // empty value -- so `!!lock` reads every finished run as a running one, and
  // the reclaim this guard fronts would be skipped for the tombstone's whole
  // lifetime. isTombstone is the same check task-lock already applies to these
  // keys for the same reason.
  return !!lock && !isTombstone(lock);
}

export async function isValidHandsToken(token: string): Promise<boolean> {
  if (!token) return false;
  // get() rather than has(), so a token in active use stays hot. Presence is
  // what validates, not the value.
  if (handsTokens.get(token) !== undefined) return true;
  if (deniedTokens.get(token)) return false;
  // Whether the store actually answered. A denial is only worth remembering if
  // it means "searched, not there"; caching "could not search" turns one blip
  // into a five-second lockout of a token that is perfectly valid -- and
  // bootstrap tries all of its binary sources back to back with no delay, so a
  // single blip during the first can fail every one of them and the sandbox
  // never comes up.
  let searched = true;
  try {
    const kv = getHandsKv();
    // Filtered server-side: this bucket also holds `lock.*`, `deleted.*` and
    // `brain.min_version`, and every miss here walks the whole key space before
    // it can answer. Matches the filter sweepStaleHands already uses.
    const keys = await kv.keys("hands.*");
    for await (const key of keys) {
      const e = await kv.get(key).catch(() => null);
      if (!e) continue;
      try {
        const info = JSON.parse(sc.decode(e.value));
        if (info?.token === token) {
          // Memoize against the owning session, not just the token: a token
          // learned here must still be revocable by teardown, which only has
          // the session id to go on. The key carries it.
          handsTokens.set(token, key.slice("hands.".length));
          return true;
        }
      } catch { /* malformed — skip */ }
    }
  } catch { searched = false; /* KV unavailable — deny, but do not remember */ }
  // A DAG handle token is not written back to `handsTokens`: that map is keyed
  // by token with the session as the value precisely so teardown can revoke by
  // session, and a handle row carries no session to file it under. Caching it
  // with a wrong owner would keep a revoked token valid until the entry aged
  // out, which is a worse bug than the scan. The denial below is what gets
  // cached instead.
  if (await isValidDagHandleToken(token)) return true;
  if (searched) deniedTokens.set(token, true);
  return false;
}
