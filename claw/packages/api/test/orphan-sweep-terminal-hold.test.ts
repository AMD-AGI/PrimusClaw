// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The orphan sweep leaves a sandbox alone while its owner has a terminal open,
 * and reaps it as any orphan once the claim has lapsed. An unreadable claim
 * holds, like every other unknown on this path.
 */

import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { putTerminalHold, readTerminalHold } from "@claw/protocol";

process.env.SAFE_API_URL = "http://safe.test";

const { db } = await import("../src/infra/db.js");
const { handleRegistry, unreleasedRecord } = await import("../src/tasks/sandbox-stopper.js");
const { reapOrphanHandles } = await import("../src/tasks/sweeper.js");

const originalQuery = db.query;
const originalRegistry = { ...handleRegistry };
const originalRecord = { ...unreleasedRecord };
const originalFetch = globalThis.fetch;
function restoreAll(): void {
  db.query = originalQuery;
  Object.assign(handleRegistry, originalRegistry);
  Object.assign(unreleasedRecord, originalRecord);
  globalThis.fetch = originalFetch;
}
after(restoreAll);
afterEach(restoreAll);

let stopped: string[];

beforeEach(() => {
  stopped = [];
  handleRegistry.retained = async () => false;
  handleRegistry.backgroundWork = async () => ({ state: "clear", reason: "no_binding" });
  unreleasedRecord.mark = async () => {};
  unreleasedRecord.clear = async () => {};
  unreleasedRecord.any = async () => false;
  const live = new Map([["main", { workload_id: "w-1", session_id: "s-1" }]]);
  const rows = () => Object.fromEntries(live);
  handleRegistry.listAll = async () => [["t-chat", rows()]];
  handleRegistry.listForDag = async () => rows();
  handleRegistry.listForDagConsistent = async () => rows();
  handleRegistry.listDagRoots = async () => ["t-chat"];
  handleRegistry.lookup = async (_d: string, n: string) => live.get(n) ?? null;
  handleRegistry.destroy = async (_d: string, n: string) => {
    const w = live.get(n)?.workload_id ?? null;
    live.delete(n);
    return w;
  };
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT status, session_id FROM claw_tasks")) {
      return { rows: [{ status: "completed", session_id: "s-1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    stopped.push(/\/workloads\/([^/]+)\/stop$/.exec(url)?.[1] ?? url);
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
});

/** A bucket holding (or not) the session's terminal claim, read by the real reader. */
async function bucketWithClaim(ttlMs: number | null, now = Date.now()): Promise<void> {
  const store = new Map<string, Uint8Array>();
  if (ttlMs !== null) await putTerminalHold({ put: async (k, v) => { store.set(k, v); } }, "s-1", ttlMs, now);
  handleRegistry.terminalHold = (sid: string) => readTerminalHold(
    { get: async (k: string) => { const v = store.get(k); return v ? { value: v } : null; } }, sid,
  );
}

test("a terminal claim in force keeps the sandbox: nothing is stopped", async () => {
  await bucketWithClaim(60_000);
  await reapOrphanHandles();
  assert.deepEqual(stopped, []);
});

test("CONTROL: with no claim the same sweep stops the orphan", async () => {
  await bucketWithClaim(null);
  await reapOrphanHandles();
  assert.deepEqual(stopped, ["w-1"]);
});

test("a claim that has lapsed no longer holds: the next sweep reaps the sandbox", async () => {
  await bucketWithClaim(1_000, Date.now() - 10_000);
  await reapOrphanHandles();
  assert.deepEqual(stopped, ["w-1"]);
});

test("an unreadable claim holds the stop", async () => {
  handleRegistry.terminalHold = async () => ({ state: "unreadable", reason: "bucket down" });
  await reapOrphanHandles();
  assert.deepEqual(stopped, []);
});
