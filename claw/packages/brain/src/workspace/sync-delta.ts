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
 *
 * "Removed" has to be something the sandbox said, not something nobody objected
 * to: see `bash` below for why a call that came back is not a command that
 * worked, and `invalidateSyncManifest` for what happens when `rm` cannot.
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

/**
 * What a command prints, last, when the shell ran it to the end.
 *
 * `HandsClient.callTool` returns the text of the answer and drops `isError`, and
 * Hands does not throw for a command that went wrong: a non-zero exit comes back
 * as `exit N\nstdout: ...\nstderr: ...`, a deadline as `timeout after Ns ...`,
 * a refused call as `Error: ...` -- all returned, all `isError: true`, none of it
 * distinguishable from a success by whether the call threw. So a call that came
 * back is not a command that worked, and nothing in this module reads it as one:
 * the command says so itself, in the one place an envelope cannot put it, the
 * last line of stdout. (`callToolFull` would keep `isError`, but it is not
 * wrapped in the deadline `withHandsTimeout` puts on every RPC here; the
 * workspace listing in s3-uploader fences its `find` with a marker for the same
 * reason.)
 */
const DONE = "__claw_sync_done__";

/**
 * The output of a command that ran to its marker, without the marker; null for
 * anything else -- a non-zero exit, a timeout, a refusal, output cut short, or
 * output Hands truncated (its notice follows the marker, so the marker is not
 * last). The envelopes Hands wraps a failure in always end with `stderr: ...`,
 * so none of them can end with the marker.
 */
export function finishedOutput(raw: string): string | null {
  const lines = raw.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  if (end === 0 || lines[end - 1] !== DONE) return null;
  return lines.slice(0, end - 1).join("\n");
}

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
 *
 * Returns the answer's text and nothing about whether the command succeeded; the
 * callers read that off `finishedOutput`.
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
    // `; echo` rather than `; true`: individual files may fail to stat, which
    // just leaves them out, but a command that did not finish is a listing that
    // is not whole, and half a listing is not "the files that changed".
    const raw = finishedOutput(await bash(
      hands,
      `find /workspace -type f ${excludeArgs} -exec stat -c '%s %y %n' {} + 2>/dev/null; echo ${DONE}`,
      STAT_TIMEOUT_SEC,
    ));
    if (raw === null) {
      logger.warn("s3.sync_delta.stat_unfinished");
      return null;
    }
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
      const raw = finishedOutput(
        await bash(hands, `sha256sum -- ${args} 2>/dev/null; echo ${DONE}`, DIGEST_TIMEOUT_SEC),
      );
      if (raw === null) {
        // A chunk that did not finish contributes no digests, not the ones it got to.
        logger.warn("s3.sync_delta.digest_unfinished");
        return;
      }
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
  let raw: string | null;
  try {
    raw = finishedOutput(await bash(hands, `cat ${statePrefix(s3Prefix)}.*.json 2>/dev/null; echo ${DONE}`, STATE_TIMEOUT_SEC));
  } catch {
    return null;
  }
  if (raw === null || TRUNCATED_FOOTER.test(raw)) return null;
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
 * Prefixes whose record this process could not neutralise, per sandbox client.
 *
 * A record that can neither be removed nor overwritten stays on disk, and the
 * next sync that finds every file matching it believes it -- after S3 has moved
 * on (a pruned object whose file comes back, an upload that did not finish). The
 * sandbox cannot be asked to remember that, since whatever stopped it taking the
 * record away stops it holding a note too, so this process does, for as long as
 * it talks to that sandbox: a poisoned prefix is not planned from until the
 * record has been confirmed gone.
 */
const unneutralised = new WeakMap<HandsClient, Set<string>>();

function markUnneutralised(hands: HandsClient, s3Prefix: string, yes: boolean): void {
  let set = unneutralised.get(hands);
  if (!set) unneutralised.set(hands, (set = new Set()));
  if (yes) set.add(s3Prefix); else set.delete(s3Prefix);
}

/**
 * Make this prefix's manifest unusable. True only when the sandbox confirmed it.
 *
 * Exported for the paths that rewrite the S3 prefix behind the sync's back (the
 * in-flight checkpoint recovery copies an older snapshot over it), after which
 * the manifest would be vouching for objects that are no longer what it says.
 *
 * The confirmation is the command's own: `rm` exited zero and a second look finds
 * nothing left under the name, and only then does it print the marker. Hands
 * reports a failed `rm` (EACCES, EROFS) as text, so "the call returned" says
 * nothing about it.
 *
 * `bash` is not necessarily the identity that wrote the shards. Where the sandbox
 * runs commands under a per-run identity, the `write` tool that created them is
 * Hands' own, and the other cannot unlink what the first made. A manifest that
 * stays on disk is trusted again by whichever sync next finds every file matching
 * it -- e.g. after a file went back to content the manifest remembers -- so
 * "do not use it for this sync" is not enough. When `rm` could not, the identity
 * that wrote it overwrites the first shard with one `readManifest` refuses, which
 * is as unusable as a missing one (every shard has to be present and of one write).
 * Only when both fail is the answer false: the caller does not use the record,
 * and this process stops planning from that prefix until a later call confirms it
 * gone (`unneutralised`).
 */
export async function invalidateSyncManifest(
  hands: HandsClient, s3Prefix: string, timeoutSec: number = STATE_TIMEOUT_SEC,
): Promise<boolean> {
  const ok = await tryInvalidate(hands, s3Prefix, timeoutSec);
  markUnneutralised(hands, s3Prefix, !ok);
  return ok;
}

async function tryInvalidate(hands: HandsClient, s3Prefix: string, timeoutSec: number): Promise<boolean> {
  const shards = `${statePrefix(s3Prefix)}.*.json`;
  let answered: string;
  try {
    answered = await bash(
      hands, `rm -f ${shards} && ! ls ${shards} >/dev/null 2>&1 && echo ${DONE}`, timeoutSec,
    );
  } catch (e) {
    // Nobody answered, so the same sandbox will not answer a second call either.
    logger.warn({ err: (e as Error)?.message ?? String(e) }, "s3.sync_delta.invalidate_failed");
    return false;
  }
  if (finishedOutput(answered) !== null) return true;
  logger.warn({ s3Prefix, answer: answered.slice(0, 200) }, "s3.sync_delta.invalidate_unconfirmed");
  try {
    const out = await withHandsTimeout<string>(
      hands,
      "write",
      {
        path: `${statePrefix(s3Prefix)}.0.json`,
        contents: `${JSON.stringify({ v: 0, invalidated: true })}\n`,
      },
      (timeoutSec + 5) * 1000,
    );
    // `write` reports a failure as text rather than by throwing.
    if (/^Written to /.test(out)) return true;
    logger.warn({ s3Prefix, answer: out.slice(0, 200) }, "s3.sync_delta.invalidate_overwrite_refused");
  } catch (e) {
    logger.warn({ err: (e as Error)?.message ?? String(e) }, "s3.sync_delta.invalidate_failed");
  }
  return false;
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
  // A record this process could not take away is not planned from, and is taken
  // away again first: the sandbox may have been fixed since.
  if (unneutralised.get(hands)?.has(s3Prefix) && !(await invalidateSyncManifest(hands, s3Prefix))) return null;
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
  // Nothing to upload but a file gone is still a sync that changes S3: the prune
  // that follows deletes its object, and the record would go on saying it is there.
  const forgets = prev !== null && toUpload.length === 0 && prev.size !== entries.size;
  if (toUpload.length > 0 || forgets) {
    // Before the first upload (or the prune), not after the last: once an object is
    // replaced or deleted the manifest's claim about it is false, and a sync that
    // dies in the middle must not leave that claim behind. If it cannot be
    // removed, do not use it -- here, or in a later sync of this process.
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
