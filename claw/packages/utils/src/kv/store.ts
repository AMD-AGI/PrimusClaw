// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Minimal JSON-valued KV abstraction used by `DagHandleMap` and any other
 * cross-instance coordination state shared between Brain and Backend
 * (task-design.md §9.6).
 *
 * Two implementations: InMemoryKVStore (process-local) and natsKvStore()
 * (NATS JetStream KV adapter via NatsLikeKv). The wider Backend pool
 * (api-server + sweeper + ExternalResolver) and Brain pods all consume the
 * same interface so the choice of backend is a runtime configuration
 * concern, not a code one.
 */
export interface KVStore {
  get(key: string): Promise<Record<string, unknown> | null>;
  put(key: string, value: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Enumerate every key whose name starts with `prefix` and return its
   * decoded JSON value. Backends that cannot stream may materialize all keys
   * before returning -- callers should treat the result as a snapshot.
   */
  scanPrefix(prefix: string): Promise<Array<[string, Record<string, unknown>]>>;
}

/** Process-local store; safe for single-replica harness or tests. */
export class InMemoryKVStore implements KVStore {
  private readonly map = new Map<string, Record<string, unknown>>();

  async get(key: string): Promise<Record<string, unknown> | null> {
    const v = this.map.get(key);
    return v ? deepClone(v) : null;
  }

  async put(key: string, value: Record<string, unknown>): Promise<void> {
    this.map.set(key, deepClone(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async scanPrefix(prefix: string): Promise<Array<[string, Record<string, unknown>]>> {
    const out: Array<[string, Record<string, unknown>]> = [];
    for (const [k, v] of this.map.entries()) {
      if (k.startsWith(prefix)) out.push([k, deepClone(v)]);
    }
    return out;
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * NATS JetStream KV bucket adapter. We do not import `nats` at the type
 * level here so that the utils package stays NATS-free; callers wire the
 * concrete client via duck-typed factory below.
 */
export interface NatsLikeKv {
  get(key: string): Promise<{ value: Uint8Array } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  keys(filter?: string): Promise<AsyncIterable<string>>;
}

/**
 * The factory takes the bucket so callers can pre-configure TTL / replicas
 * and inject test doubles freely.
 */
export function natsKvStore(kv: NatsLikeKv): KVStore {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    async get(key) {
      const entry = await kv.get(key);
      if (!entry) return null;
      const text = dec.decode(entry.value);
      if (!text) return null;
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    async put(key, value) {
      await kv.put(key, enc.encode(JSON.stringify(value)));
    },
    async delete(key) {
      await kv.delete(key);
    },
    async scanPrefix(prefix) {
      const filter = prefix.endsWith(".") ? `${prefix}>` : `${prefix}.>`;
      const iter = await kv.keys(filter);
      const out: Array<[string, Record<string, unknown>]> = [];
      for await (const key of iter) {
        if (!key.startsWith(prefix)) continue;
        const entry = await kv.get(key);
        if (!entry) continue;
        try {
          out.push([key, JSON.parse(dec.decode(entry.value))]);
        } catch {
          continue;
        }
      }
      return out;
    },
  };
}
