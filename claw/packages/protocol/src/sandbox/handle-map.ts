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
 * The class is thin on top of {@link KVStore}. **It does not itself provide
 * concurrency safety**, whatever an earlier version of this comment claimed:
 * `KVStore` carries no revision, so every write here is an unconditional
 * read-modify-write and two writers racing lose one of the two. Both
 * production writers therefore do their own revision-conditional writes
 * against the bucket -- `replaceDagHandle` in brain, `destroyHandleCas` in
 * api -- and reach this class only for the paths where that does not matter.
 * Anything added here that writes is subject to the same caveat.
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

/**
 * Write `name` onto a handle row without going through a prototype setter.
 *
 * `row[name] = info` looks total and is not: a handle legitimately named
 * `__proto__` hits `Object.prototype`'s setter, so the assignment sets the
 * row's prototype instead of adding a key and the row serialises as `{}`.
 * Admission accepts that name, so a DAG can declare it -- and the result is a
 * registration that reports success while storing nothing, which Backend then
 * reads as a DAG holding no sandbox. `defineProperty` stores it as an own
 * property, which is also what `JSON.parse` produces when reading it back.
 */
export function setHandleEntry(
  row: Record<string, unknown>,
  name: string,
  info: HandleInfo,
): void {
  Object.defineProperty(row, name, {
    value: info, enumerable: true, writable: true, configurable: true,
  });
}

/**
 * Read one handle off a row, by own property only.
 *
 * The mirror of the write above: `row["__proto__"]` on a row that has no such
 * key answers `Object.prototype`, and `row["constructor"]` answers a function
 * -- neither is a handle, and both would be judged by shape rather than by
 * whether the row actually holds them.
 */
export function getHandleEntry(row: Record<string, unknown>, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, name) ? row[name] : undefined;
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
    const prev = coerceToHandleInfo(getHandleEntry(existing, handleName));
    if (prev) {
      if (prev.workload_id === info.workload_id) {
        // Same workload -- merge in any newly known fields so a subsequent
        // sandbox.use sees the freshest hands_url / token.
        setHandleEntry(existing, handleName, { ...prev, ...info });
        await this.kv.put(k, existing);
        return;
      }
      throw new Error(
        `handle '${handleName}' for dag ${dagRootTaskId} already maps to ${prev.workload_id}, refusing to overwrite with ${info.workload_id}`,
      );
    }
    setHandleEntry(existing, handleName, {
      ...info, created_at: info.created_at ?? new Date().toISOString(),
    });
    await this.kv.put(k, existing);
  }

  /** Resolve a handle to its full HandleInfo, or null if not registered. */
  async lookup(dagRootTaskId: string, handleName: string): Promise<HandleInfo | null> {
    const entry = await this.kv.get(keyOf(dagRootTaskId));
    if (!entry) return null;
    return coerceToHandleInfo(getHandleEntry(entry, handleName));
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
    const prev = coerceToHandleInfo(getHandleEntry(existing, handleName));
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
      // Same reason the row itself is written this way: a handle named
      // `__proto__` assigned onto the OUTPUT object vanishes just as
      // completely, and this is the enumeration teardown walks -- so the
      // stored entry would be correct and the DAG would still look empty.
      if (info) setHandleEntry(out, name, info);
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
        if (info) setHandleEntry(map, name, info);
      }
      return [dagId, map] as [string, Record<string, HandleInfo>];
    });
  }
}
