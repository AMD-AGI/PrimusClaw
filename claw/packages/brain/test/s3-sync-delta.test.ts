// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The post-turn workspace sync uploads what changed, not everything.
 *
 * Measured on the live fleet: the sync that runs between the answer and
 * `task.completed` re-uploaded every file each turn, median 4.1 s (a turn
 * that wrote nothing still pushed the session's twenty skill files), worst 380.8 s for a
 * 3,466-file session -- all of it spent with the session still `running`.
 *
 * These run the real `syncWorkspaceToS3` against a sandbox stand-in that executes
 * its `bash` calls in a real shell over a real directory (so `find`, `stat` and
 * `sha256sum` are the real ones, not a model of them), records what `upload_to_s3`
 * was asked for, and keeps its manifest where the real sandbox does -- only the
 * paths are redirected from /workspace and /tmp/.claw-s3-sync into a temp dir.
 * What is asserted is the thing that matters: which files were sent to S3.
 *
 * The prune afterwards talks to an object store that is not there (connection
 * refused) and is caught, which is what a prune failure does in production; its
 * own behaviour is pinned in s3-prune.test.ts.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.S3_API_ENDPOINT = "http://127.0.0.1:1";
process.env.S3_SANDBOX_ENDPOINT = "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY = "AK";
process.env.S3_SECRET_KEY = "SK";
process.env.S3_BUCKET = "claw";

const { syncWorkspaceToS3 } = await import("../src/workspace/s3-uploader.js");
const {
  invalidateSyncManifest, parseDigestListing, parseStatListing, planUploadDelta, SYNC_STATE_DIR,
} = await import("../src/workspace/sync-delta.js");
const { findExcludeArgs, s3Excludes } = await import("../src/workspace/excludes.js");
import type { HandsClient } from "../src/clients/hands.js";

const created: string[] = [];
after(() => { for (const d of created) rmSync(d, { recursive: true, force: true }); });

/** A sandbox: a directory standing in for /workspace and one for the state dir. */
class Sandbox {
  readonly root = mkdtempSync(join(tmpdir(), "claw-delta-ws-"));
  readonly state = `${this.root}-state`;
  /** Every `upload_to_s3` batch, as the /workspace paths it was sent. */
  batches: string[][] = [];
  /** Every bash command, as sent. */
  commands: string[] = [];
  failPaths = new Set<string>();
  /** When set, `stat` is unusable in this sandbox. */
  noStat = false;
  uploadDelayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  private clock = 1_700_000_000;

  constructor() { created.push(this.root, this.state); }

  /** Write a file with an explicit mtime, so two writes never share one by accident. */
  put(relPath: string, contents: string, mtime?: number): void {
    const p = join(this.root, relPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contents);
    const t = mtime ?? (this.clock += 10);
    utimesSync(p, t, t);
  }

  /** Same bytes, a later mtime: what the engine does to the skill files each turn. */
  touch(relPath: string): void {
    const t = (this.clock += 10);
    utimesSync(join(this.root, relPath), t, t);
  }

  remove(relPath: string): void { rmSync(join(this.root, relPath)); }

  get uploaded(): string[] { return this.batches.flat().sort(); }
  resetUploads(): void { this.batches = []; }
  digestCalls(): number { return this.commands.filter((c) => c.includes("sha256sum")).length; }
  manifestFiles(): string[] {
    return existsSync(this.state) ? readdirSync(this.state).filter((f) => f.endsWith(".json")) : [];
  }

  private local(cmd: string): string {
    return cmd.replaceAll(SYNC_STATE_DIR, this.state).replaceAll("/workspace", this.root);
  }
  private remote(out: string): string {
    return out.replaceAll(this.state, SYNC_STATE_DIR).replaceAll(this.root, "/workspace");
  }

  readonly client = {
    callTool: async (tool: string, args: Record<string, unknown>): Promise<string> => {
      if (tool === "bash") {
        const command = String(args.command);
        this.commands.push(command);
        if (this.noStat && command.includes("stat -c")) return "";
        const r = spawnSync("bash", ["-c", this.local(command)], { encoding: "utf-8" });
        return this.remote(r.stdout ?? "");
      }
      if (tool === "write") {
        const p = this.local(String(args.path));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(args.contents));
        return `Written to ${args.path}`;
      }
      if (tool === "log_s3_upload_manifest") return JSON.stringify({ ok: true });
      if (tool === "upload_to_s3") {
        const files = args.files as Array<{ local_path: string }>;
        this.batches.push(files.map((f) => f.local_path));
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        if (this.uploadDelayMs) await new Promise((r) => setTimeout(r, this.uploadDelayMs));
        this.inFlight--;
        const ok = files.map((f) => f.local_path).filter((p) => !this.failPaths.has(p));
        const failed = files.map((f) => f.local_path).filter((p) => this.failPaths.has(p))
          .map((path) => ({ path, status: 500, error: "injected" }));
        return JSON.stringify({ ok, failed, total: files.length });
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  } as unknown as HandsClient;

  sync(prefixOverride?: string) {
    return syncWorkspaceToS3(this.client, "sess-1", "user-1",
      prefixOverride ? { s3PrefixOverride: prefixOverride } : undefined);
  }
}

function threeFiles(): Sandbox {
  const sb = new Sandbox();
  sb.put("a.txt", "alpha");
  sb.put("dir/b.txt", "bravo");
  sb.put("dir/c.txt", "charlie");
  return sb;
}

// ===== what a sync uploads =====

test("D1 the first sync uploads everything, and a second with nothing changed uploads nothing", async () => {
  const sb = threeFiles();

  const first = await sb.sync();
  assert.deepEqual(sb.uploaded, ["/workspace/a.txt", "/workspace/dir/b.txt", "/workspace/dir/c.txt"]);
  assert.equal(first.uploaded, 3);
  assert.equal(first.exhausted, false);

  sb.resetUploads();
  const second = await sb.sync();
  assert.deepEqual(sb.uploaded, [], "nothing changed, so nothing is sent");
  assert.equal(second.uploaded, 0);
  assert.equal(second.unchanged, 3);
  assert.equal(second.totalFiles, 3, "the listing is still all three: the prune reads it");
  assert.equal(second.exhausted, false, "an empty upload list is a finished sync, not a failed one");
  assert.equal(second.empty, false);
});

test("D2 a file whose content changed is uploaded and the others are not", async () => {
  const sb = threeFiles();
  await sb.sync();
  sb.resetUploads();

  sb.put("dir/b.txt", "BRAVO"); // same size, different bytes, newer mtime
  await sb.sync();

  assert.deepEqual(sb.uploaded, ["/workspace/dir/b.txt"]);
});

test("D3 a file rewritten with the content it already had is not uploaded (the per-turn skill files)", async () => {
  const sb = threeFiles();
  await sb.sync();
  sb.resetUploads();

  sb.touch("a.txt");
  sb.touch("dir/c.txt");
  const r = await sb.sync();
  assert.deepEqual(sb.uploaded, [], "a newer mtime alone is not a change");
  assert.equal(r.unchanged, 3);

  // And the manifest was refreshed with the new mtimes, so the next sync does not
  // have to read the files again to learn the same thing.
  const digestsBefore = sb.digestCalls();
  await sb.sync();
  assert.equal(sb.digestCalls(), digestsBefore, "unchanged by size and mtime: no digest needed");
});

test("D4 a deleted file is forgotten, so bringing it back uploads it again", async () => {
  const sb = threeFiles();
  await sb.sync();

  // A sync with nothing to upload and one file gone. Its object is pruned from S3,
  // so a record that still vouched for it would take the file's return -- even at
  // the very same size and mtime -- as "already there".
  sb.remove("dir/c.txt");
  sb.resetUploads();
  const gone = await sb.sync();
  assert.deepEqual(sb.uploaded, []);
  assert.equal(gone.totalFiles, 2, "the deleted file is out of the listing");

  sb.put("dir/c.txt", "charlie", 1_700_000_030);
  sb.resetUploads();
  await sb.sync();
  assert.deepEqual(sb.uploaded, ["/workspace/dir/c.txt"]);
});

test("D4b a new file is uploaded and nothing else is", async () => {
  const sb = threeFiles();
  await sb.sync();
  sb.resetUploads();

  sb.put("new.txt", "fresh");
  const r = await sb.sync();
  assert.deepEqual(sb.uploaded, ["/workspace/new.txt"]);
  assert.equal(r.totalFiles, 4);
  assert.equal(r.unchanged, 3);
});

test("D5 a name with a quote and spaces is digested like any other", async () => {
  const sb = new Sandbox();
  sb.put("it's a file.txt", "same bytes");
  await sb.sync();
  sb.resetUploads();

  sb.touch("it's a file.txt");
  const r = await sb.sync();
  assert.deepEqual(sb.uploaded, [], "found unchanged by digest, which needed the name quoted");
  assert.equal(r.unchanged, 1);
});

// ===== when the sandbox's record cannot be trusted =====

test("D6 a failed upload is not recorded: the next sync sends it again", async () => {
  const sb = threeFiles();
  sb.failPaths.add("/workspace/dir/b.txt");

  const failed = await sb.sync();
  assert.equal(failed.exhausted, true);
  assert.equal(failed.failedCount, 1);
  assert.deepEqual(sb.manifestFiles(), [], "a sync that did not land leaves no manifest");

  sb.failPaths.clear();
  sb.resetUploads();
  const retry = await sb.sync();
  assert.equal(retry.exhausted, false);
  assert.ok(sb.uploaded.includes("/workspace/dir/b.txt"), "the file that failed is sent again");

  sb.resetUploads();
  await sb.sync();
  assert.deepEqual(sb.uploaded, [], "and once it landed, it is recorded");
});

test("D7 a sandbox without a manifest (a rebuilt one) uploads everything", async () => {
  const sb = threeFiles();
  await sb.sync();
  rmSync(sb.state, { recursive: true, force: true });
  sb.resetUploads();

  await sb.sync();
  assert.equal(sb.uploaded.length, 3);
});

test("D8 a sandbox that cannot stat uploads everything every time and records nothing", async () => {
  const sb = threeFiles();
  sb.noStat = true;

  await sb.sync();
  sb.resetUploads();
  const r = await sb.sync();

  assert.equal(sb.uploaded.length, 3, "no way to say what changed, so everything goes, as before");
  assert.equal(r.unchanged, undefined);
  assert.deepEqual(sb.manifestFiles(), []);
});

test("D9 the checkpoint prefix has a record of its own", async () => {
  const sb = threeFiles();
  await sb.sync();
  sb.resetUploads();

  await sb.sync("checkpoints/sess-1/");
  assert.equal(sb.uploaded.length, 3, "what the session prefix holds says nothing about the checkpoint prefix");

  sb.resetUploads();
  await sb.sync("checkpoints/sess-1/");
  assert.deepEqual(sb.uploaded, []);
  await sb.sync();
  assert.deepEqual(sb.uploaded, [], "and the two do not disturb each other");
});

test("D10 invalidating the record makes the next sync upload everything", async () => {
  // What the checkpoint recovery does after it copies an older snapshot over the
  // session prefix: the objects are no longer what the record says they are.
  const sb = threeFiles();
  await sb.sync();
  assert.equal(await invalidateSyncManifest(sb.client, "users/user-1/sessions/sess-1/"), true);
  sb.resetUploads();

  await sb.sync();
  assert.equal(sb.uploaded.length, 3);
});

test("D11 a record that is not whole is not believed", async () => {
  const files = ["/workspace/a", "/workspace/b", "/workspace/c", "/workspace/d", "/workspace/e"];
  const sb = new Sandbox();
  for (const f of files) sb.put(f.slice("/workspace/".length), f);
  const exclude = findExcludeArgs(s3Excludes());
  const prefix = "users/u/sessions/s/";

  const plan = await planUploadDelta(sb.client, prefix, files, exclude, { shardFiles: 2 });
  assert.equal(plan?.pending.length, 5);
  await plan?.commit();
  assert.equal(sb.manifestFiles().length, 3, "five files in shards of two");

  const again = await planUploadDelta(sb.client, prefix, files, exclude, { shardFiles: 2 });
  assert.equal(again?.unchanged, 5, "read back across the shards");

  // A shard missing.
  const shards = sb.manifestFiles();
  const lost = readFileSync(join(sb.state, shards[1]), "utf-8");
  rmSync(join(sb.state, shards[1]));
  const missing = await planUploadDelta(sb.client, prefix, files, exclude, { shardFiles: 2 });
  assert.equal(missing?.pending.length, 5, "an incomplete record vouches for nothing");

  // A shard from a different write beside the others.
  writeFileSync(join(sb.state, shards[1]), lost.replace(/"gen":"[0-9a-f]+"/, '"gen":"0000000000000000"'));
  const mixed = await planUploadDelta(sb.client, prefix, files, exclude, { shardFiles: 2 });
  assert.equal(mixed?.pending.length, 5, "shards from two writes are not one record");

  // A record that is not JSON at all.
  for (const s of sb.manifestFiles()) writeFileSync(join(sb.state, s), "not json\n");
  const junk = await planUploadDelta(sb.client, prefix, files, exclude, { shardFiles: 2 });
  assert.equal(junk?.pending.length, 5);
});

test("D12 the record is dropped before the first upload, so a crash mid-sync leaves none", async () => {
  const sb = threeFiles();
  await sb.sync();
  assert.ok(sb.manifestFiles().length > 0);

  sb.put("a.txt", "changed");
  let manifestsWhenUploading = -1;
  const original = sb.client.callTool.bind(sb.client);
  (sb.client as unknown as { callTool: unknown }).callTool = async (tool: string, args: Record<string, unknown>) => {
    if (tool === "upload_to_s3") manifestsWhenUploading = sb.manifestFiles().length;
    return original(tool, args);
  };
  await sb.sync();

  assert.equal(manifestsWhenUploading, 0, "the old record was gone by the time the first byte went up");
  assert.ok(sb.manifestFiles().length > 0, "and a record is written back once everything is up");
});

// ===== uploads =====

test("D13 batches go up side by side, within a bound, and every file arrives once", async () => {
  const sb = new Sandbox();
  for (let i = 0; i < 450; i++) sb.put(`f/${String(i).padStart(4, "0")}.txt`, `file ${i}`);
  sb.uploadDelayMs = 15;

  const r = await sb.sync();

  assert.equal(r.uploaded, 450);
  assert.equal(r.exhausted, false);
  assert.equal(new Set(sb.uploaded).size, 450, "each file exactly once");
  assert.equal(sb.batches.length, 5, "batches of at most 100");
  assert.ok(sb.maxInFlight > 1, `batches overlapped (max in flight ${sb.maxInFlight})`);
  assert.ok(sb.maxInFlight <= 4, `but within the bound (max in flight ${sb.maxInFlight})`);
});

test("D14 a batch that throws fails only its own files, which the next round sends again", async () => {
  const sb = new Sandbox();
  for (let i = 0; i < 250; i++) sb.put(`f/${String(i).padStart(4, "0")}.txt`, `file ${i}`);
  let thrown = false;
  const original = sb.client.callTool.bind(sb.client);
  (sb.client as unknown as { callTool: unknown }).callTool = async (tool: string, args: Record<string, unknown>) => {
    if (tool === "upload_to_s3" && !thrown) { thrown = true; throw new Error("transport reset"); }
    return original(tool, args);
  };

  const r = await sb.sync();

  assert.equal(r.exhausted, false);
  assert.equal(r.uploaded, 250);
  assert.equal(new Set(sb.uploaded).size, 250);
});

// ===== the parsers =====

test("P1 the stat listing is read by its shape, and a truncated one is not read at all", () => {
  const ok = parseStatListing(
    "5 2026-10-27 14:12:07.123456789 +0000 /workspace/a.txt\n"
    + "12 2026-10-27 14:12:08.000000000 +0000 /workspace/with space/it's.txt\n"
    + "not a stat line\n",
  );
  assert.deepEqual([...(ok ?? [])], [
    ["/workspace/a.txt", { size: "5", mtime: "2026-10-27 14:12:07.123456789 +0000" }],
    ["/workspace/with space/it's.txt", { size: "12", mtime: "2026-10-27 14:12:08.000000000 +0000" }],
  ]);
  assert.equal(
    parseStatListing("5 2026-10-27 14:12:07 +0000 /workspace/a\n[stdout truncated; 4096 bytes dropped]\n"),
    null,
    "Hands says it dropped output: what is left is not the whole tree",
  );
});

test("P2 the digest listing takes both sha256sum spellings and ignores what it cannot read", () => {
  const h = "a".repeat(64);
  const got = parseDigestListing(
    `${h}  /workspace/a.txt\n${h} */workspace/b.bin\n\\${h}  /workspace/escaped\\nname\nsha256sum: nope: No such file\n`,
  );
  assert.deepEqual([...got], [["/workspace/a.txt", h], ["/workspace/b.bin", h]]);
});

// ===== wiring =====

test("W1 the checkpoint recovery forgets the record after it copies a snapshot over the session prefix", () => {
  // A guard on a wiring whose failure is silent: without it a recovered prefix
  // holds older objects than the sandbox's record says, and nothing uploads them.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/tasks/runner.ts"), "utf-8");
  const at = src.indexOf("private async recoverInflightCheckpoint");
  const body = src.slice(at, src.indexOf("private async resolvePlatformKey"));
  const copy = body.indexOf("copyS3Prefix");
  const call = body.search(/await invalidateSyncManifest\(this\.hands, sessionPrefix\)/);
  assert.ok(copy > 0);
  assert.ok(call > copy, "the record for the session prefix is invalidated, after the copy");
});
