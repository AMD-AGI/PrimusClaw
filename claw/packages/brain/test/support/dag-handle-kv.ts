// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An in-memory DAG_HANDLES bucket, for a test that drives `ensureHands` to the registration it performs at the end of a create.
 * Imported by the test after the environment it needs is set (the deployment mode is read when config loads), never statically.
 */
export async function bindDagHandles(): Promise<void> {
  const { bindDagHandleKvForTest } = await import("../../src/sandbox/handles.js");
  const rows: Record<string, unknown> = {};
  const revs: Record<string, number> = {};
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  bindDagHandleKvForTest({
    async get(key: string) {
      return rows[key] === undefined
        ? null
        : { key, value: enc.encode(JSON.stringify(rows[key])), revision: revs[key]!, operation: "PUT" };
    },
    async create(key: string, value: Uint8Array) {
      if (rows[key] !== undefined) throw new Error("wrong last sequence: key exists");
      rows[key] = JSON.parse(dec.decode(value)); revs[key] = 1; return 1;
    },
    async update(key: string, value: Uint8Array, rev: number) {
      if (revs[key] !== rev) throw new Error("wrong last sequence");
      rows[key] = JSON.parse(dec.decode(value)); revs[key] = rev + 1; return revs[key];
    },
    async delete(key: string) { delete rows[key]; delete revs[key]; },
    async keys() { return (async function* () { for (const k of Object.keys(rows)) yield k; })(); },
  } as never);
}

/**
 * The same in-memory bucket bound for the whole handles module (`bindDagHandlesForTest`): registrations, lookups and the release that
 * frees a name all over one store, for a test that drives a handle from its registration to a later turn that looks it up.
 */
export async function bindDagHandleModule(): Promise<() => void> {
  const { bindDagHandlesForTest } = await import("../../src/sandbox/handles.js");
  const { matchesKvFilter } = await import("../fixtures/kv-filter.js");
  const rows = new Map<string, { value: Uint8Array; revision: number }>();
  const conflict = (seq: number) => new Error(`wrong last sequence: ${seq}`);
  return bindDagHandlesForTest({
    async get(key: string) {
      const held = rows.get(key);
      return held ? { key, value: held.value, revision: held.revision, operation: "PUT" } : null;
    },
    async put(key: string, value: Uint8Array) {
      const revision = (rows.get(key)?.revision ?? 0) + 1;
      rows.set(key, { value, revision });
      return revision;
    },
    async create(key: string, value: Uint8Array) {
      if (rows.has(key)) throw conflict(rows.get(key)!.revision);
      rows.set(key, { value, revision: 1 });
      return 1;
    },
    async update(key: string, value: Uint8Array, revision: number) {
      if (rows.get(key)?.revision !== revision) throw conflict(rows.get(key)?.revision ?? 0);
      rows.set(key, { value, revision: revision + 1 });
      return revision + 1;
    },
    async delete(key: string, opts?: { previousSeq?: number }) {
      const held = rows.get(key);
      if (opts?.previousSeq && (!held || held.revision !== opts.previousSeq)) throw conflict(held?.revision ?? 0);
      rows.delete(key);
    },
    async keys(filter = ">") {
      const matched = [...rows.keys()].filter((k) => matchesKvFilter(k, filter));
      return (async function* () { for (const k of matched) yield k; })();
    },
  } as never);
}
