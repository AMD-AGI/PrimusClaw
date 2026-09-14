// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Backend-side sandbox destruction (task-design.md §9.4 / §9.5).
 *
 * Backend is the *only* normal destroyer; Brain only rolls back sandboxes
 * it created when KV bookkeeping fails inside its own create path. Three
 * entry points feed this module:
 *
 *   1. agent_done callback handler: if the calling task is the last user
 *      of any handle (per DAG `handle_last_user` derived map).
 *   2. DAG root transition handler: tear every remaining handle of a
 *      finished / cancelled DAG.
 *   3. Sweeper: orphan handles whose DAG row no longer exists.
 *
 * Both KV destroy and SaFE workload stop are idempotent.
 */
import { DagHandleMap, type HandleInfo } from "@claw/protocol";
import type { KVStore } from "@claw/utils";
import pino from "pino";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { SAFE_API_URL } from "../config.js";
import { kv as natsKv } from "../infra/nats.js";
import { db } from "../infra/db.js";

const logger = pino({ name: "sandbox-stopper" });

let _handleMap: DagHandleMap | null = null;

/** Build the DagHandleMap on demand using the existing NATS KV bucket. */
function handleMap(): DagHandleMap {
  if (_handleMap) return _handleMap;
  // Adapt the in-process NATS KV (which the API already owns) into the
  // KVStore interface DagHandleMap expects. We rely on the same encoding
  // contract Brain uses to write handle entries: a JSON object payload.
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const ks: KVStore = {
    async get(key) {
      try {
        const entry = await natsKv.get(key);
        if (!entry) return null;
        return JSON.parse(dec.decode(entry.value)) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    async put(key, value) {
      await natsKv.put(key, enc.encode(JSON.stringify(value)));
    },
    async delete(key) {
      await natsKv.delete(key);
    },
    async scanPrefix(prefix) {
      const filter = prefix.endsWith(".") ? `${prefix}>` : `${prefix}.>`;
      const iter = await natsKv.keys(filter);
      const out: Array<[string, Record<string, unknown>]> = [];
      for await (const key of iter) {
        if (!key.startsWith(prefix)) continue;
        const entry = await natsKv.get(key);
        if (!entry) continue;
        try {
          out.push([key, JSON.parse(dec.decode(entry.value))]);
        } catch { /* skip */ }
      }
      return out;
    },
  };
  _handleMap = new DagHandleMap(ks);
  return _handleMap;
}

/**
 * Seam over the handle registry, in the shape `events/consumer.ts` uses for the
 * tombstone bucket and for the same reason: `handleMap()` closes over the
 * module-scoped NATS KV, which is a live binding on a frozen module namespace
 * and so cannot be substituted. A plain object can be, and every registry call
 * on the teardown path goes through these two methods, which is what makes the
 * outcomes below testable without a NATS server.
 */
export const handleRegistry = {
  destroy(dagRootTaskId: string, handleName: string): Promise<string | null> {
    return handleMap().destroy(dagRootTaskId, handleName);
  },
  listForDag(dagRootTaskId: string): Promise<Record<string, HandleInfo>> {
    return handleMap().listForDag(dagRootTaskId);
  },
};

/**
 * What a caller is entitled to believe about a sandbox after a teardown ran.
 *
 * The three values are deliberately not a boolean. "the stop failed" and "there
 * was never anything to stop" have the same shape -- nothing is running for this
 * task now -- but opposite meanings for whoever is counting leaked GPUs, and a
 * caller that cannot tell them apart is back where it started.
 *
 *   - `confirmed`   SaFE acknowledged the stop for every handle held (2xx, or a
 *                   404 that says the workload is already gone).
 *   - `unconfirmed` at least one handle's stop was not acknowledged: a non-2xx,
 *                   a timeout, an unset `SAFE_API_URL`, or a handle this path
 *                   cannot stop at all. The workload may still be running.
 *   - `nothing_held` no handle was ever recorded, so nothing was leaked.
 *
 * `unconfirmed` is the conservative answer and every uncertain case collapses
 * into it; it never means "definitely still running", only "not established".
 */
export type ReleaseOutcome = "confirmed" | "unconfirmed" | "nothing_held";

/**
 * Stop one SaFE workload and say whether SaFE acknowledged it.
 *
 * Every branch that used to `return` after a `logger.warn` now answers
 * `unconfirmed` instead, which is the entire point: the logging was already
 * correct, it just went somewhere no caller could read. Failure is still not
 * thrown -- cleanup must not fail the cancellation that triggered it.
 *
 * A 404 counts as `confirmed`. SaFE does not know the workload, which is the
 * state the stop was trying to reach.
 */
async function safeStopWorkload(
  workloadId: string,
  platformKey: string,
): Promise<ReleaseOutcome> {
  // Defensive, and no longer the only guard: stopSandboxByHandle answers the
  // empty-workload-id case before reaching here, because it is the one caller
  // that can tell an unstoppable handle from an absent one. Kept so a future
  // caller cannot turn "no id to call with" into a silent success.
  if (!workloadId) return "unconfirmed";
  if (!SAFE_API_URL) {
    logger.warn({ workloadId }, "safe.stop_skipped_no_url");
    return "unconfirmed";
  }
  try {
    const resp = await fetch(`${SAFE_API_URL}/api/v1/workloads/${workloadId}/stop`, {
      method: "POST",
      headers: platformKey ? { Authorization: `Bearer ${platformKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok && resp.status !== 404) {
      const body = await resp.text();
      logger.warn({ workloadId, status: resp.status, body: body.slice(0, 200) }, "safe.stop_failed");
      return "unconfirmed";
    }
    return "confirmed";
  } catch (e) {
    logger.warn({ workloadId, err: (e as Error).message }, "safe.stop_exception");
    return "unconfirmed";
  }
}

async function loadPlatformKeyForSession(sessionId: string): Promise<string> {
  const r = await db.query(`SELECT config FROM claw_sessions WHERE session_id = $1`, [sessionId]);
  if (r.rowCount === 0) return "";
  return readTrustedSessionCredentials(r.rows[0].config).platformKey;
}

/**
 * Destroy one handle's mapping and stop the workload behind it, reporting
 * which of the two actually happened.
 *
 * The ordering below is load-bearing and is the reason this function has to
 * return anything at all: `destroy` runs FIRST and the stop may then fail, so
 * after this returns the handle map is empty either way. **An empty handle map
 * is evidence the attempt was made, not that it worked** -- nothing downstream
 * may infer release from it, which leaves this return value as the only place
 * the answer exists.
 *
 * `destroy` distinguishes two falsy results and so does this:
 *   - `null`  -- no handle of that name was registered: `nothing_held`.
 *   - `""`    -- a handle was registered with no SaFE workload id behind it.
 *                agent-sandbox handles are written this way (see Brain's
 *                ensureHands), and this path has never had a way to stop one.
 *                Something is held and this code did not release it, so the
 *                honest answer is `unconfirmed`, not `nothing_held`.
 */
export async function stopSandboxByHandle(
  dagRootTaskId: string,
  handleName: string,
  sessionId: string,
): Promise<ReleaseOutcome> {
  const wid = await handleRegistry.destroy(dagRootTaskId, handleName);
  if (wid === null) return "nothing_held";
  if (wid === "") {
    logger.warn({ dagRootTaskId, handleName }, "sandbox.stop_unsupported_handle");
    return "unconfirmed";
  }
  const platformKey = await loadPlatformKeyForSession(sessionId);
  const released = await safeStopWorkload(wid, platformKey);
  logger.info({ dagRootTaskId, handleName, workloadId: wid, released }, "sandbox.destroyed");
  return released;
}

/**
 * Tear down every handle currently registered for the given DAG and aggregate
 * what that established.
 *
 * `confirmed` requires every handle to be confirmed, so one failing stop in a
 * DAG of many cannot be averaged away by its neighbours. A per-handle
 * `nothing_held` inside a DAG that did hold handles is also not confirmation:
 * it means the entry vanished between the snapshot and the destroy, so some
 * other destroyer took it and this call cannot vouch for what that one did.
 *
 * Only a DAG holding no handles at all answers `nothing_held`.
 */
export async function stopAllHandlesForDag(
  dagRootTaskId: string,
  sessionId: string,
): Promise<ReleaseOutcome> {
  const entries = await handleRegistry.listForDag(dagRootTaskId);
  const handles = Object.keys(entries);
  if (handles.length === 0) return "nothing_held";
  let allConfirmed = true;
  for (const handle of handles) {
    const released = await stopSandboxByHandle(dagRootTaskId, handle, sessionId);
    if (released !== "confirmed") allConfirmed = false;
  }
  return allConfirmed ? "confirmed" : "unconfirmed";
}

export { handleMap };
