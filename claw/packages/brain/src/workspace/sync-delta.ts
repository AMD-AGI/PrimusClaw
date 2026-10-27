// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which workspace files a sync has to upload.
 *
 * `syncWorkspaceToS3` used to re-upload every file under /workspace after every
 * turn, so the time a finished turn kept its session busy grew with the size of
 * the workspace and not with what the turn changed: a turn that wrote
 * nothing still pushed the session's twenty skill files (4.1 s median), and one session
 * with 3,466 files held `agent_status=running` for 380.8 s after the answer was
 * already on screen.
 *
 * This module answers the narrower question "what has changed since the last
 * sync that landed", from a manifest the sandbox keeps of what it uploaded:
 * for each file its size, its mtime and a content digest. It is part of the one
 * sync, not a second one -- the listing, the upload batches, the retry rounds
 * and the prune are all still `syncWorkspaceToS3`'s; this only shortens the list
 * the upload step is handed.
 *
 * The comparison is rsync's, plus one step rsync does not need. A file whose size
 * and mtime match the manifest is unchanged. A file whose mtime differs is only
 * *possibly* changed, and the step on top is a digest: the engine rewrites the
 * session's skill files on every turn with the content they already had, which
 * bumps every mtime and would defeat a size-and-mtime check on exactly the files
 * the median turn is made of.
 *
 * Where the manifest lives, and why:
 *
 *   - In the sandbox, under /tmp, outside the workspace, so it is never uploaded,
 *     restored, listed or pruned, and no consumer of the S3 prefix has to know it
 *     exists. It describes what THIS sandbox's filesystem last put in S3, so it
 *     is only as valid as the sandbox: a rebuilt sandbox starts without one and
 *     syncs everything, which is the old behaviour.
 *   - One per S3 prefix, because the in-flight checkpoint writes to its own prefix
 *     and a manifest for one says nothing about the other.
 *   - In shards, because the tool that writes it is bounded by Hands' request
 *     body limit and a large workspace's manifest is not.
 *
 * Every failure here degrades to "upload it": an unreadable manifest, a `stat`
 * the sandbox does not have, a digest that does not parse. The only way this
 * can leave S3 wrong is a manifest that claims an object is current when it is
 * not, so a manifest is removed before the first byte of an upload that would
 * make it false and only written back once every pending file is up. A crash in
 * between leaves no manifest, and the next sync does the full upload.
 */

import { createHash, randomBytes } from "node:crypto";
import pino from "pino";
import { withHandsTimeout, type HandsClient } from "../clients/hands.js";

const logger = pino({ name: "s3-sync-delta" });

/** Where sandboxes keep their manifests. Outside /workspace on purpose. */
export const SYNC_STATE_DIR = "/tmp/.claw-s3-sync";
const WORKSPACE_ROOT = "/workspace/";
const MANIFEST_VERSION = 1;
/** Files per manifest shard: ~130 B each, so a shard stays far under Hands' ~1MB body. */
const SHARD_FILES = 2000;
/** A file larger than this is never digested; if its mtime moves it is re-uploaded. */
const DIGEST_MAX_BYTES = 16 * 1024 * 1024;
/** Bytes of file names per `sha256sum` command line. */
const DIGEST_CHUNK_BYTES = 48 * 1024;
const STAT_TIMEOUT_SEC = 60;
const DIGEST_TIMEOUT_SEC = 120;
const STATE_TIMEOUT_SEC = 20;

/** [size, mtime, digest]; the digest is "" for a file that was not digested. */
type Entry = [string, string, string];

interface FileStat {
  size: string;
  mtime: string;
}

/**
 * One bash call in the sandbox, under a ceiling of its own a little past the
 * command's. Every RPC in this module goes through `withHandsTimeout`, like the
 * rest of the workspace code: the post-turn sync also runs from the SIGTERM path,
 * where a wedged sandbox must not be able to hold the grace window open.
 */
function bash(hands: HandsClient, command: string, timeoutSec: number): Promise<string> {
  return withHandsTimeout<string>(hands, "bash", { command, timeout: timeoutSec }, (timeoutSec + 5) * 1000);
}

const rel = (path: string): string =>
  path.startsWith(WORKSPACE_ROOT) ? path.slice(WORKSPACE_ROOT.length) : path;

/** POSIX single-quoting, which has no character it cannot carry but NUL. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Hands' own statement that it dropped output; see TRUNCATED_FOOTER in s3-uploader. */
const TRUNCATED_FOOTER = /^\[stdout truncated; \d+ bytes dropped\]$/m;

function statePrefix(s3Prefix: string): string {
  return `${SYNC_STATE_DIR}/${createHash("sha256").update(s3Prefix).digest("hex").slice(0, 24)}`;
}

/**
 * `size mtime name` for every file the listing's `find` would visit, or null when
 * the sandbox could not say.
 *
 * `%y` rather than `%Y`: where the filesystem keeps nanoseconds it prints them,
 * which makes "same size, same mtime, different content" need a write within one
 * nanosecond of the previous one. It is only ever compared for equality, so a
 * sandbox whose `stat` prints seconds works the same way, coarser.
 */
export function parseStatListing(raw: string): Map<string, FileStat> | null {
  if (TRUNCATED_FOOTER.test(raw)) return null;
  const out = new Map<string, FileStat>();
  for (const line of raw.split("\n")) {
    const m = /^(\d+) (.+?) (\/workspace\/.+)$/.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (m) out.set(m[3], { size: m[1], mtime: m[2] });
  }
  return out;
}

async function statFiles(hands: HandsClient, excludeArgs: string): Promise<Map<string, FileStat> | null> {
  try {
    const raw = await bash(
      hands,
      `find /workspace -type f ${excludeArgs} -exec stat -c '%s %y %n' {} + 2>/dev/null; true`,
      STAT_TIMEOUT_SEC,
    );
    return parseStatListing(raw);
  } catch (e) {
    logger.warn({ err: (e as Error)?.message ?? String(e) }, "s3.sync_delta.stat_failed");
    return null;
  }
}

/** `sha256sum` output for the files it could read; anything else is simply absent. */
export function parseDigestListing(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](\/workspace\/.+)$/.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

async function digestFiles(hands: HandsClient, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let chunk: string[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (chunk.length === 0) return;
    const args = chunk.map(shq).join(" ");
    chunk = [];
    bytes = 0;
    try {
      const raw = await bash(hands, `sha256sum -- ${args} 2>/dev/null; true`, DIGEST_TIMEOUT_SEC);
      for (const [p, d] of parseDigestListing(raw)) out.set(p, d);
    } catch (e) {
      // Not fatal: a file without a digest is uploaded when its mtime moved.
      logger.warn({ err: (e as Error)?.message ?? String(e) }, "s3.sync_delta.digest_failed");
    }
  };
  for (const p of paths) {
    if (bytes + p.length > DIGEST_CHUNK_BYTES) await flush();
    chunk.push(p);
    bytes += p.length + 3;
  }
  await flush();
  return out;
}

/** The manifest for this prefix, or null when there is none or it is not whole. */
async function readManifest(hands: HandsClient, s3Prefix: string): Promise<Map<string, Entry> | null> {
  let raw: string;
  try {
    raw = await bash(hands, `cat ${statePrefix(s3Prefix)}.*.json 2>/dev/null; true`, STATE_TIMEOUT_SEC);
  } catch {
    return null;
  }
  if (TRUNCATED_FOOTER.test(raw)) return null;
  const files = new Map<string, Entry>();
  const seen = new Set<number>();
  let gen: string | undefined;
  let shards: number | undefined;
  try {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const shard = JSON.parse(line) as {
        v?: number; prefix?: string; gen?: string; n?: number; i?: number; files?: Record<string, unknown>;
      };
      if (shard.v !== MANIFEST_VERSION || shard.prefix !== s3Prefix) return null;
      if (typeof shard.gen !== "string" || typeof shard.n !== "number" || typeof shard.i !== "number") return null;
      // One write produced all of it, or it is not trusted: a shard from an older
      // write beside a newer one would vouch for files the newer one replaced.
      if (gen === undefined) { gen = shard.gen; shards = shard.n; }
      if (shard.gen !== gen || shard.n !== shards || seen.has(shard.i)) return null;
      seen.add(shard.i);
      for (const [path, e] of Object.entries(shard.files ?? {})) {
        if (!Array.isArray(e) || e.length !== 3 || e.some((x) => typeof x !== "string")) return null;
        files.set(path, e as Entry);
      }
    }
  } catch {
    return null;
  }
  if (shards === undefined || seen.size !== shards) return null;
  for (let i = 0; i < shards; i++) if (!seen.has(i)) return null;
  return files;
}

/**
 * Remove this prefix's manifest. True when the sandbox confirmed it is gone.
 *
 * Exported for the paths that rewrite the S3 prefix behind the sync's back (the
 * in-flight checkpoint recovery copies an older snapshot over it), after which
 * the manifest would be vouching for objects that are no longer what it says.
 */
export async function invalidateSyncManifest(
  hands: HandsClient, s3Prefix: string, timeoutSec: number = STATE_TIMEOUT_SEC,
): Promise<boolean> {
  try {
    await bash(hands, `rm -f ${statePrefix(s3Prefix)}.*.json`, timeoutSec);
    return true;
  } catch (e) {
    logger.warn({ err: (e as Error)?.message ?? String(e) }, "s3.sync_delta.invalidate_failed");
    return false;
  }
}

async function writeManifest(
  hands: HandsClient, s3Prefix: string, entries: Map<string, Entry>, shardFiles: number,
): Promise<boolean> {
  const rows = [...entries].map(([path, e]) => [rel(path), e] as const);
  const n = Math.max(1, Math.ceil(rows.length / shardFiles));
  const gen = randomBytes(8).toString("hex");
  for (let i = 0; i < n; i++) {
    const files: Record<string, Entry> = {};
    for (const [path, e] of rows.slice(i * shardFiles, (i + 1) * shardFiles)) files[path] = e;
    const out = await withHandsTimeout<string>(
      hands,
      "write",
      {
        path: `${statePrefix(s3Prefix)}.${i}.json`,
        contents: `${JSON.stringify({ v: MANIFEST_VERSION, prefix: s3Prefix, gen, n, i, files })}\n`,
      },
      STATE_TIMEOUT_SEC * 1000,
    );
    // `write` reports a failure as text rather than by throwing.
    if (!/^Written to /.test(out)) return false;
  }
  return true;
}

export interface UploadDelta {
  /** The files to upload, in listing order. */
  pending: string[];
  /** Files the manifest vouches are already in S3 as they are now. */
  unchanged: number;
  /**
   * Record that every pending file is up. Call it only after the upload step
   * succeeded in full (and the prune ran); never throws.
   */
  commit(): Promise<void>;
}

/**
 * Work out what to upload, or null to upload everything as before.
 *
 * `files` is the trusted listing, which stays the authority for what exists: this
 * narrows what is uploaded, never what is pruned.
 */
export async function planUploadDelta(
  hands: HandsClient,
  s3Prefix: string,
  files: string[],
  excludeArgs: string,
  opts: { shardFiles?: number } = {},
): Promise<UploadDelta | null> {
  if (files.length === 0) return null;
  const shardFiles = opts.shardFiles ?? SHARD_FILES;
  const stats = await statFiles(hands, excludeArgs);
  // A sandbox that cannot stat gets no optimisation and no manifest, not a guess.
  if (!stats || stats.size === 0) return null;
  const prev = await readManifest(hands, s3Prefix);

  const entries = new Map<string, Entry>();
  const pending = new Set<string>();
  const candidates: Array<{ path: string; st: FileStat; old?: Entry }> = [];
  let unchanged = 0;
  let refreshed = 0;
  for (const path of files) {
    const st = stats.get(path);
    if (!st) { pending.add(path); continue; }
    const old = prev?.get(rel(path));
    if (old && old[0] === st.size && old[1] === st.mtime) {
      entries.set(path, old);
      unchanged++;
    } else {
      candidates.push({ path, st, old });
    }
  }

  const digests = await digestFiles(
    hands, candidates.filter((c) => Number(c.st.size) <= DIGEST_MAX_BYTES).map((c) => c.path),
  );
  for (const { path, st, old } of candidates) {
    const digest = digests.get(path) ?? "";
    if (digest && old && old[0] === st.size && old[2] === digest) {
      entries.set(path, [st.size, st.mtime, digest]);
      unchanged++;
      refreshed++;
    } else {
      pending.add(path);
      entries.set(path, [st.size, st.mtime, digest]);
    }
  }

  const toUpload = files.filter((p) => pending.has(p));
  let dropped = false;
  if (toUpload.length > 0) {
    // Before the first upload, not after the last: once an object is replaced the
    // manifest's claim about it is false, and a sync that dies in the middle must
    // not leave that claim behind. If it cannot be removed, do not use it.
    dropped = await invalidateSyncManifest(hands, s3Prefix);
    if (!dropped) return null;
  }
  logger.info(
    { s3Prefix, files: files.length, pending: toUpload.length, unchanged, refreshed, hadManifest: prev !== null },
    "s3.sync_delta.planned",
  );

  return {
    pending: toUpload,
    unchanged,
    commit: async () => {
      try {
        // The manifest on disk is still exact when nothing moved and nothing was
        // deleted; rewriting it would be a round trip for no change.
        if (prev && toUpload.length === 0 && refreshed === 0 && prev.size === entries.size) return;
        if (!dropped && !(await invalidateSyncManifest(hands, s3Prefix))) return;
        if (!(await writeManifest(hands, s3Prefix, entries, shardFiles))) {
          logger.warn({ s3Prefix }, "s3.sync_delta.write_refused");
          await invalidateSyncManifest(hands, s3Prefix);
        }
      } catch (e) {
        logger.warn({ err: (e as Error)?.message ?? String(e), s3Prefix }, "s3.sync_delta.commit_failed");
        await invalidateSyncManifest(hands, s3Prefix).catch(() => false);
      }
    },
  };
}
