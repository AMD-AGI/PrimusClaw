// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * DagHandleMap: cross-instance sandbox handle registry (task-design.md §9.4).
 *
 * Each DAG instance owns one KV row keyed by `dag-handles.<dag_root_task_id>`,
 * whose value is a `{handle_name -> safe_workload_id}` mapping; see the
 * per-method docs below for how entries are created, looked up, and torn
 * down.
 *
 * The class is thin on top of {@link KVStore}; concurrency safety relies on
 * the backend's per-key atomic compare-and-set semantics. NATS JetStream KV
 * provides revision-based CAS; the in-memory store is single-threaded by
 * construction, so callers do not need their own mutex.
 */
import type { KVStore } from "@claw/utils";

export const HANDLE_MAP_PREFIX = "dag-handles";

/**
 * Per-handle record stored in DagHandleMap. `workload_id` is the only
 * field Backend's sandbox-stopper needs; the rest are populated by Brain
 * after a successful ensureHands so downstream DAG nodes can `sandbox.use`
 * without re-querying SaFE.
 */
export interface HandleInfo {
  workload_id: string;
  hands_url?: string;
  token?: string;
  platform_key?: string;
  image?: string;
  created_at?: string;
  // agent-sandbox (kubernetes) reuse: SaFE has no workload_id, so downstream
  // `sandbox.use` needs the provider + agent-sandbox identity to re-attach and
  // register keepalive against the correct provider.
  provider?: "safe-workload" | "agent-sandbox";
  sandbox_name?: string;
  namespace?: string;
  user_id?: string;
  session_id?: string;
}

function keyOf(dagRootTaskId: string): string {
  return `${HANDLE_MAP_PREFIX}.${dagRootTaskId}`;
}

function isHandleInfo(v: unknown): v is HandleInfo {
  return !!v && typeof v === "object" && typeof (v as { workload_id?: unknown }).workload_id === "string";
}

/** Backward-compat: accept legacy string-only values (just a workload id). */
function coerceToHandleInfo(v: unknown): HandleInfo | null {
  if (typeof v === "string" && v.length > 0) return { workload_id: v };
  return isHandleInfo(v) ? v : null;
}

export class DagHandleMap {
  constructor(private readonly kv: KVStore) {}

  /**
   * Register a freshly-created sandbox under `handleName` for this DAG.
   *
   * Idempotency: if the same `workload_id` was already registered under the
   * same name we treat it as a no-op (Brain retries should not fail). A
   * mismatch (different workload id under the same name) throws so we never
   * silently lose the previous reference.
   */
  async create(
    dagRootTaskId: string,
    handleName: string,
    info: HandleInfo,
  ): Promise<void> {
    const k = keyOf(dagRootTaskId);
    const existing = (await this.kv.get(k)) ?? {};
    const prev = coerceToHandleInfo(existing[handleName]);
    if (prev) {
      if (prev.workload_id === info.workload_id) {
        // Same workload -- merge in any newly known fields so a subsequent
        // sandbox.use sees the freshest hands_url / token.
        existing[handleName] = { ...prev, ...info };
        await this.kv.put(k, existing);
        return;
      }
      throw new Error(
        `handle '${handleName}' for dag ${dagRootTaskId} already maps to ${prev.workload_id}, refusing to overwrite with ${info.workload_id}`,
      );
    }
    existing[handleName] = { ...info, created_at: info.created_at ?? new Date().toISOString() };
    await this.kv.put(k, existing);
  }

  /** Resolve a handle to its full HandleInfo, or null if not registered. */
  async lookup(dagRootTaskId: string, handleName: string): Promise<HandleInfo | null> {
    const entry = await this.kv.get(keyOf(dagRootTaskId));
    if (!entry) return null;
    return coerceToHandleInfo(entry[handleName]);
  }

  /**
   * Remove the handle and return the workload id Backend should issue
   * `SaFE workload stop` for; null when the handle was already gone.
   *
   * When the row becomes empty we delete it entirely so the bucket does
   * not accumulate empty entries for long-lived DAGs.
   */
  async destroy(dagRootTaskId: string, handleName: string): Promise<string | null> {
    const k = keyOf(dagRootTaskId);
    const existing = (await this.kv.get(k)) ?? {};
    const prev = coerceToHandleInfo(existing[handleName]);
    if (!prev) return null;
    delete existing[handleName];
    if (Object.keys(existing).length === 0) {
      await this.kv.delete(k);
    } else {
      await this.kv.put(k, existing);
    }
    return prev.workload_id;
  }

  /** Snapshot view of every handle currently registered for this DAG. */
  async listForDag(dagRootTaskId: string): Promise<Record<string, HandleInfo>> {
    const entry = await this.kv.get(keyOf(dagRootTaskId));
    if (!entry) return {};
    const out: Record<string, HandleInfo> = {};
    for (const [name, raw] of Object.entries(entry)) {
      const info = coerceToHandleInfo(raw);
      if (info) out[name] = info;
    }
    return out;
  }

  /**
   * Enumerate every DAG with at least one live handle. Used by Sweeper to
   * reconcile against `claw_tasks.status` (R-3 path).
   *
   * Returns `[dag_root_task_id, handles]` tuples. The order is not
   * guaranteed; callers must not rely on it.
   */
  async listAll(): Promise<Array<[string, Record<string, HandleInfo>]>> {
    const raw = await this.kv.scanPrefix(`${HANDLE_MAP_PREFIX}.`);
    return raw.map(([k, entry]) => {
      const dagId = k.slice(HANDLE_MAP_PREFIX.length + 1);
      const map: Record<string, HandleInfo> = {};
      for (const [name, v] of Object.entries(entry)) {
        const info = coerceToHandleInfo(v);
        if (info) map[name] = info;
      }
      return [dagId, map] as [string, Record<string, HandleInfo>];
    });
  }
}
