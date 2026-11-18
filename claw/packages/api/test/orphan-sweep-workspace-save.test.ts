// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The orphan sweep leaves a sandbox alone while the session's last turn is still saving its workspace from it, and
 * reaps it as any orphan once the save is over or its hold has run out. An unreadable hold holds.
 *
 * Measured on release 202611120049: a turn's completion closed its run row, the next sweep 4 s later destroyed the
 * sandbox as an orphan, and the save that was uploading from it lost all 2,725 files.
 */
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

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
/** The hold as the session row answers it; a thrown error is an unreadable row. */
let held: boolean | Error;

beforeEach(() => {
  stopped = [];
  held = false;
  handleRegistry.retained = async () => false;
  handleRegistry.backgroundWork = async () => ({ state: "clear", reason: "no_binding" });
  handleRegistry.terminalHold = async () => ({ state: "none" });
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
      // The run's row: closed by its completion.
      return { rows: [{ status: "completed", session_id: "s-1" }], rowCount: 1 };
    }
    if (sql.includes("workspace_save_until") && sql.includes("AS held FROM claw_sessions")) {
      if (held instanceof Error) throw held;
      return { rows: [{ held }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    stopped.push(/\/workloads\/([^/]+)\/stop$/.exec(url)?.[1] ?? url);
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
});

test("a save still running keeps the sandbox however many sweeps pass, and the first sweep after it ends reaps it", async () => {
  held = true;
  for (let i = 0; i < 3; i++) await reapOrphanHandles();
  assert.deepEqual(stopped, [], "the save is still uploading from it");
  held = false; // the save's finish released the hold (or it ran out)
  await reapOrphanHandles();
  assert.deepEqual(stopped, ["w-1"]);
});

test("CONTROL: with no save held the same sweep stops the orphan", async () => {
  await reapOrphanHandles();
  assert.deepEqual(stopped, ["w-1"]);
});

test("an unreadable hold holds the stop", async () => {
  held = new Error("database unavailable");
  await reapOrphanHandles();
  assert.deepEqual(stopped, []);
});
