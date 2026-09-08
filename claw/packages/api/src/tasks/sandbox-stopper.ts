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
import { DagHandleMap } from "@claw/protocol";
import type { KVStore } from "@claw/utils";
import pino from "pino";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { SAFE_API_URL } from "../config.js";
import { dagHandlesBucket } from "../infra/dag-handles.js";
import { db } from "../infra/db.js";

const logger = pino({ name: "sandbox-stopper" });

let _handleMap: DagHandleMap | null = null;

/**
 * The bucket the map is built over, injectable because which one it is *is*
 * the defect this seam exists for: built over the registry bucket the map
 * enumerated an empty set and every sweep walking it reaped nothing.
 */
export const stopperPorts = { dagHandlesBucket };

/** Drop the memoised map so a test can rebind the bucket. */
export function resetHandleMapForTest(): void { _handleMap = null; }

/**
 * Build the DagHandleMap over the bucket Brain actually writes.
 *
 * `DAG_HANDLES`, not the registry bucket this process's own KV handle points
 * at: Brain never writes `dag-handles.*` keys there, so a map built over the
 * registry enumerates an empty set and every sweep that walks it reaps nothing
 * -- silently, because finding no rows is indistinguishable from finding no
 * orphans. Rows then accumulate for the life of the cluster.
 */
async function handleMap(): Promise<DagHandleMap> {
  if (_handleMap) return _handleMap;
  const bucket = await stopperPorts.dagHandlesBucket();
  // We rely on the same encoding contract Brain uses to write handle entries:
  // a JSON object payload.
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const ks: KVStore = {
    async get(key) {
      try {
        const entry = await bucket.get(key);
        if (!entry) return null;
        return JSON.parse(dec.decode(entry.value)) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    async put(key, value) {
      await bucket.put(key, enc.encode(JSON.stringify(value)));
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async scanPrefix(prefix) {
      const filter = prefix.endsWith(".") ? `${prefix}>` : `${prefix}.>`;
      const iter = await bucket.keys(filter);
      const out: Array<[string, Record<string, unknown>]> = [];
      for await (const key of iter) {
        if (!key.startsWith(prefix)) continue;
        const entry = await bucket.get(key);
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

async function safeStopWorkload(workloadId: string, platformKey: string): Promise<void> {
  if (!workloadId) return;
  if (!SAFE_API_URL) {
    logger.warn({ workloadId }, "safe.stop_skipped_no_url");
    return;
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
    }
  } catch (e) {
    logger.warn({ workloadId, err: (e as Error).message }, "safe.stop_exception");
  }
}

async function loadPlatformKeyForSession(sessionId: string): Promise<string> {
  const r = await db.query(`SELECT config FROM claw_sessions WHERE session_id = $1`, [sessionId]);
  if (r.rowCount === 0) return "";
  return readTrustedSessionCredentials(r.rows[0].config).platformKey;
}

export async function stopSandboxByHandle(
  dagRootTaskId: string,
  handleName: string,
  sessionId: string,
): Promise<void> {
  const wid = await (await handleMap()).destroy(dagRootTaskId, handleName);
  if (!wid) return;
  const platformKey = await loadPlatformKeyForSession(sessionId);
  await safeStopWorkload(wid, platformKey);
  logger.info({ dagRootTaskId, handleName, workloadId: wid }, "sandbox.destroyed");
}

/** Tear down every handle currently registered for the given DAG. */
export async function stopAllHandlesForDag(dagRootTaskId: string, sessionId: string): Promise<void> {
  const entries = await (await handleMap()).listForDag(dagRootTaskId);
  for (const handle of Object.keys(entries)) {
    await stopSandboxByHandle(dagRootTaskId, handle, sessionId);
  }
}

export { handleMap };
