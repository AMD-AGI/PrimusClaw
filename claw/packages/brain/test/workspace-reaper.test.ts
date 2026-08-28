// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// workspace-reaper.test.ts
//
// Unit tests for the reaper logic, run with `npm run test:reaper`
// (node --test via tsx, no testcontainers, no NATS). The strategy is:
//
//   * Fake KV implements only get(); the reaper module uses nothing
//     else, and any other access would explode with a clear error.
//
//   * Each test owns an isolated tmp dir under os.tmpdir() so phase 1
//     rename and phase 2 rm are exercised against real fs APIs. This
//     catches misordered fs.mkdir / fs.rename / fs.rm calls that pure
//     mocks would silently accept.
//
//   * Time-sensitive tests synthesise mtimes via fs.utimes; we never
//     use a fake clock so we stay close to the production wall-clock
//     code path.
//
// Coverage map (workspace-reaper-design.md §15):
//   T1 classifyForReap stat_missing
//   T2 classifyForReap ckpt_alive
//   T3 classifyForReap lock_held
//   T4 classifyForReap too_young
//   T5 classifyForReap kv_grace
//   T6 classifyForReap expired (only path returning trash)
//   T7 trashSessionDir produces "<sid>-<unixms>" and is atomic
//   T8 runOneReapCycle dry-run does not call fs.rename
//   T9 runOneReapCycle obeys maxDeletePerRun cap
//   T10 runOneReapCycle Phase 2 respects trashGraceHours
//   T11 runOneReapCycle skips non-hex user dirs and bad sid names
//   T12 classifier "keep" on any KV error (INV-R5)

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyForReap, runOneReapCycle, trashSessionDir } from "../src/workspace/reaper.js";
import type { ReaperOpts } from "../src/workspace/reaper.js";
import { makeKv } from "./nats-kv-stub.js";

const UID = "a".repeat(32);
const SID = "b".repeat(36);

async function mkBase(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "reaper-test-"));
}

async function rmBase(base: string): Promise<void> {
  await fs.rm(base, { recursive: true, force: true });
}

async function mkSession(base: string, uid: string, sid: string, mtimeAgoMs = 0): Promise<string> {
  const dir = path.join(base, "users", uid, ".claw", "workspaces", sid);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "marker"), "x");
  if (mtimeAgoMs > 0) {
    const when = new Date(Date.now() - mtimeAgoMs);
    await fs.utimes(dir, when, when);
  }
  return dir;
}

function baseOpts(base: string, overrides: Partial<ReaperOpts> = {}): ReaperOpts {
  return {
    kv: makeKv() as ReaperOpts["kv"],
    kvCkpt: makeKv() as ReaperOpts["kvCkpt"],
    base,
    retentionDays: 7,
    kvGraceMin: 30,
    trashGraceHours: 24,
    maxDeletePerRun: 500,
    dryRun: false,
    ...overrides,
  };
}

describe("classifyForReap", () => {
  let base: string;
  beforeEach(async () => { base = await mkBase(); });
  afterEach(async () => { await rmBase(base); });

  it("T1 stat_missing when dir does not exist", async () => {
    const d = await classifyForReap(baseOpts(base), UID, SID);
    assert.deepEqual(d, { action: "keep", reason: "stat_missing" });
  });

  it("T2 ckpt_alive keeps even if mtime old", async () => {
    await mkSession(base, UID, SID, 30 * 24 * 3600 * 1000);
    // Checkpoints are keyed per run, so liveness is "any run under this
    // session", not a point lookup on the session id.
    const kvCkpt = makeKv(new Map([[`task-ckpt.${SID}.claw-123`, "blob"]]));
    const d = await classifyForReap(baseOpts(base, { kvCkpt: kvCkpt as ReaperOpts["kvCkpt"] }), UID, SID);
    assert.equal(d.action, "keep");
    assert.equal(d.reason, "ckpt_alive");
  });

  it("T2b a checkpoint belonging to another session does not keep this one", async () => {
    await mkSession(base, UID, SID, 8 * 24 * 3600 * 1000);
    const kvCkpt = makeKv(new Map([[`task-ckpt.${"c".repeat(36)}.claw-123`, "blob"]]));
    const d = await classifyForReap(baseOpts(base, {
      retentionDays: 7, kvGraceMin: 30, kvCkpt: kvCkpt as ReaperOpts["kvCkpt"],
    }), UID, SID);
    assert.deepEqual(d, { action: "trash", reason: "expired" },
      "the prefix scan must not widen liveness to unrelated sessions");
  });

  it("T3 lock_held keeps even if mtime old", async () => {
    await mkSession(base, UID, SID, 30 * 24 * 3600 * 1000);
    const kv = makeKv(new Map([[`lock.${SID}`, "owner"]]));
    const d = await classifyForReap(baseOpts(base, { kv: kv as ReaperOpts["kv"] }), UID, SID);
    assert.equal(d.action, "keep");
    assert.equal(d.reason, "lock_held");
  });

  it("T4 too_young keeps when mtime < retention", async () => {
    await mkSession(base, UID, SID, 3 * 24 * 3600 * 1000);
    const d = await classifyForReap(baseOpts(base, { retentionDays: 7 }), UID, SID);
    assert.deepEqual(d, { action: "keep", reason: "too_young" });
  });

  it("T5 kv_grace keeps when retention met but grace not yet", async () => {
    const retentionMs = 7 * 24 * 3600 * 1000;
    await mkSession(base, UID, SID, retentionMs + 5 * 60 * 1000);
    const d = await classifyForReap(baseOpts(base, { retentionDays: 7, kvGraceMin: 30 }), UID, SID);
    assert.deepEqual(d, { action: "keep", reason: "kv_grace" });
  });

  it("T6 expired is the ONLY path that yields trash", async () => {
    const ageMs = 8 * 24 * 3600 * 1000;
    await mkSession(base, UID, SID, ageMs);
    const d = await classifyForReap(baseOpts(base, { retentionDays: 7, kvGraceMin: 30 }), UID, SID);
    assert.deepEqual(d, { action: "trash", reason: "expired" });
  });

  it("T12 keep when KV throws (INV-R5 bias)", async () => {
    await mkSession(base, UID, SID, 8 * 24 * 3600 * 1000);
    const kvCkpt = makeKv(new Map(), new Set([`task-ckpt.${SID}.*`]));
    const kv = makeKv(new Map(), new Set([`lock.${SID}`]));
    const d = await classifyForReap(baseOpts(base, {
      kv: kv as ReaperOpts["kv"], kvCkpt: kvCkpt as ReaperOpts["kvCkpt"],
    }), UID, SID);
    assert.deepEqual(d, { action: "keep", reason: "kv_error" });
  });
});

describe("trashSessionDir", () => {
  let base: string;
  beforeEach(async () => { base = await mkBase(); });
  afterEach(async () => { await rmBase(base); });

  it("T7 renames into .trash/<sid>-<unixms>", async () => {
    const src = await mkSession(base, UID, SID);
    const dst = await trashSessionDir(baseOpts(base), UID, SID);
    assert.match(dst, new RegExp(`\\.claw/\\.trash/${SID}-\\d{10,}$`));
    // source must be gone, dest must exist with the marker file
    await assert.rejects(fs.stat(src));
    await fs.stat(path.join(dst, "marker"));
  });
});

describe("runOneReapCycle", () => {
  let base: string;
  beforeEach(async () => { base = await mkBase(); });
  afterEach(async () => { await rmBase(base); });

  it("T8 dry-run never moves anything", async () => {
    await mkSession(base, UID, SID, 8 * 24 * 3600 * 1000);
    const stats = await runOneReapCycle(baseOpts(base, { dryRun: true }));
    assert.equal(stats.scanned, 1);
    assert.equal(stats.trashed, 0);
    assert.equal(stats.kept, 1);
    // source still present
    await fs.stat(path.join(base, "users", UID, ".claw", "workspaces", SID));
  });

  it("T9 maxDeletePerRun caps trash count", async () => {
    const ageMs = 8 * 24 * 3600 * 1000;
    for (let i = 0; i < 5; i++) {
      const sid = i.toString(16).padStart(36, "0");
      await mkSession(base, UID, sid, ageMs);
    }
    const stats = await runOneReapCycle(baseOpts(base, { maxDeletePerRun: 2 }));
    assert.equal(stats.scanned, 5);
    assert.equal(stats.trashed, 2);
    assert.equal(stats.kept, 3);
  });

  it("T10 Phase 2 keeps young trash, removes old trash", async () => {
    const trashRoot = path.join(base, "users", UID, ".claw", ".trash");
    await fs.mkdir(trashRoot, { recursive: true });
    const tsOld = Date.now() - 30 * 3600 * 1000;
    const tsNew = Date.now() - 1 * 3600 * 1000;
    const oldDir = path.join(trashRoot, `${SID}-${tsOld}`);
    const newDir = path.join(trashRoot, `${SID.slice(0, -2)}cc-${tsNew}`);
    await fs.mkdir(oldDir);
    await fs.mkdir(newDir);
    const stats = await runOneReapCycle(baseOpts(base, { trashGraceHours: 24 }));
    assert.equal(stats.trashRemoved, 1);
    await assert.rejects(fs.stat(oldDir));
    await fs.stat(newDir);
  });

  it("T11 skips non-hex user dirs and bad sid names", async () => {
    await fs.mkdir(path.join(base, "users", "NOT-HEX", ".claw", "workspaces"), { recursive: true });
    await fs.mkdir(path.join(base, "users", UID, ".claw", "workspaces", "shorty"), { recursive: true });
    const stats = await runOneReapCycle(baseOpts(base));
    assert.equal(stats.scanned, 0);
    assert.equal(stats.trashed, 0);
  });
});
