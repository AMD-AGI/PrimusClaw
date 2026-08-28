// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_REGION, S3_API_ENDPOINT,
  S3_PRUNE_MAX_OBJECTS,
} from "../config.js";
import { HandsClient } from "../clients/hands.js";
import { isSessionDeletedLocally } from "../infra/deleted-sessions.js";
import { s3Excludes, findExcludeArgs } from "./excludes.js";
import pino from "pino";

const logger = pino({ name: "s3-uploader" });

/** Max age for a presigned PUT URL. Short by design — we resign on retry. */
const PRESIGN_EXPIRES_SEC = 300;
/** Upload rounds total (initial + retries). */
const MAX_UPLOAD_ROUNDS = 3;
/** Per-batch file count cap. Caps the JSON body sent to Hands so we stay under
 *  Hands' fastify body limit (~1MB) even when /workspace has hundreds of files
 *  and presigned URLs are ~700B each. Empirically 100 paths × ~800B ≈ 80KB. */
const UPLOAD_BATCH_SIZE = 100;
/** Sandbox liveness probe timeout. Long enough to absorb a TCP retry, short
 *  enough that a dead sandbox fails fast instead of holding the sync open for
 *  the deadline of the `find` below. */
const SANDBOX_PROBE_TIMEOUT_SEC = 5;
/** Hard cap for the workspace-listing `find` call. Without this, a half-dead
 *  sandbox (TCP up, MCP server hung) blocks the whole sync for whatever a bash
 *  call's ceiling allows — an hour, where background shells are off. */
const FIND_TIMEOUT_SEC = 60;
/** S3/MinIO returns 503 SlowDownWrite (and occasionally 429) as write
 *  backpressure when the cluster's write throughput is saturated — observed
 *  only as short bursts when several large workspaces checkpoint at once. It
 *  is transient, so throttled retry rounds are spaced out with exponential
 *  backoff + full jitter instead of hammering the same overloaded backend. */
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
/** In-flight DeleteObject calls; see pruneRemovedObjects for why not batched. */
const PRUNE_CONCURRENCY = 16;
/**
 * Fences around the workspace listing.
 *
 * Pruning deletes every object with no counterpart in this listing, so a
 * listing that is short for any reason other than the user deleting files is
 * a request to delete live data. Four things shorten it, and none of them
 * were distinguishable from a genuine deletion before:
 *
 *   - `find` exits non-zero having walked only part of the tree. The command
 *     used to end in `|| true`, which discarded precisely that.
 *   - Hands caps bash output at BASH_OUTPUT_BYTES (10MB) using a ring buffer
 *     that drops from the *front*. A trailing marker survives that untouched,
 *     which is why the head fence is the one that catches it.
 *   - The call times out and stdout comes back as a fragment.
 *   - A file is named so that it prints as a closing fence. Filenames may
 *     contain newlines and the agent chooses them, so the region between the
 *     fences is attacker-controlled text; see parseWorkspaceListing.
 *
 * Both fences must be present, the closing one must be a line of its own with a
 * zero exit status on it, and every line between them must be a path. When any
 * of that fails the upload still proceeds -- the files we did find are worth
 * storing -- but nothing is deleted on the authority of a listing that cannot
 * vouch for itself.
 */
const LS_BEGIN = "__claw_ls_begin__";
const LS_END = "__claw_ls_end__";
/**
 * The trailing fence as a whole line and nothing else: the marker, a colon, and
 * `find`'s exit status. Built from the marker so the two cannot drift.
 *
 * A prefix match was not enough. The region between the fences is filenames,
 * and a filename is chosen by whatever ran in the sandbox -- so matching
 * loosely, or matching the first candidate rather than the last, hands the
 * agent a way to say where the listing ends.
 */
const LS_END_LINE = new RegExp(`^${LS_END}:(\\d+)$`);

/**
 * Hands' footer for output its ring buffer dropped, matched as a whole line.
 *
 * Written by `collectOutput` in hands/src/tools/shell/process-runner.ts on exactly
 * the condition that bytes were dropped, which makes it the one thing in this
 * output that reports truncation rather than being evidence of it.
 *
 * Matched as a whole line for the reason the trailing fence is: a filename can
 * contain anything, so a listing could print this text itself. That direction
 * is harmless -- it refuses a prune that would have been allowed, and a prune
 * refused deletes nothing.
 */
const TRUNCATED_FOOTER = /^\[stdout truncated; \d+ bytes dropped\]$/;

/**
 * The tag that lets a lifecycle rule address workspace objects at all.
 *
 * The existing rules match `imports/staging/` by prefix and two tags set by
 * the API (`origin=user-upload`, `origin=zip-cache`). Workspace objects carry
 * neither, and their prefix -- `users/<uid>/sessions/<sid>/` -- cannot be
 * expressed as a lifecycle filter, because those take a literal prefix with no
 * wildcard and the only common ancestor is `users/`. So without a tag there is
 * no rule that can be written; with one, there is.
 *
 * Note that this only makes such a rule *possible*. None is added here: an
 * expiry on workspace objects would delete the last remaining copy of a
 * dormant session, since the shared-disk reaper already takes its snapshot at
 * seven days. What the retention should be is a product decision.
 */
const WORKSPACE_TAG = "origin=workspace";

/**
 * Escape hatch, not a rollout gate.
 *
 * Tagging needs no cooperation from the uploader: the presigner hoists
 * `x-amz-tagging` into the query string rather than signing it as a header
 * (verified -- `X-Amz-SignedHeaders` comes back as just `host`), so the URL
 * carries the tag on its own and Hands sends exactly what it sent before. That
 * also rules out the opposite approach: passing the header alongside would be
 * an unsigned `x-amz-*` header on a presigned request, which S3 rejects
 * outright.
 *
 * The flag exists for the one uncertainty left, which is whether this object
 * store applies a hoisted tagging parameter or ignores it. Ignoring it costs
 * an untagged object; anything worse can be switched off without a rollback.
 */
const TAGGING_ENABLED = process.env.S3_WORKSPACE_TAGGING !== "false";

interface UploadBatchResult {
  ok: string[];
  failed: Array<{ path: string; status: number; error: string }>;
  total: number;
}

/** Structured outcome of `syncWorkspaceToS3` so the caller can decide what
 *  user-facing event to emit. The function still throws on unrecoverable
 *  early errors (probe failure, find failure) so existing try/catch sites
 *  remain backward compatible. */
export interface SyncWorkspaceResult {
  uploaded: number;
  totalFiles: number;
  failedCount: number;
  /** True when all retries used up but some files still failed. */
  exhausted: boolean;
  /** True when /workspace had zero files at sync time (sandbox tear-down
   *  in progress, or a genuinely empty workspace). */
  empty: boolean;
}

let _s3: S3Client | null = null;

function getS3Client(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: S3_REGION,
      endpoint: S3_API_ENDPOINT || undefined,
      forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    });
  }
  return _s3;
}

/** Generate a pre-signed PUT URL for uploading to S3. */
async function presignPut(
  s3Key: string,
  tagging?: string,
  expiresIn = PRESIGN_EXPIRES_SEC,
): Promise<string> {
  const client = getS3Client();
  const cmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: s3Key, Tagging: tagging });
  return getSignedUrl(client, cmd, { expiresIn });
}

/** Generate a pre-signed GET URL for downloading from S3. */
async function presignGet(s3Key: string, expiresIn = PRESIGN_EXPIRES_SEC): Promise<string> {
  const client = getS3Client();
  const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key });
  return getSignedUrl(client, cmd, { expiresIn });
}

function localPathToS3Key(localPath: string, s3Prefix: string): string {
  return `${s3Prefix}${localPath.replace("/workspace/", "")}`;
}

/** Build upload list with freshly signed URLs (caller passes relative-time windows). */
async function buildUploadList(paths: string[], s3Prefix: string, tagging?: string) {
  const list: Array<{ local_path: string; presigned_url: string }> = [];
  for (const p of paths) {
    list.push({
      local_path: p,
      presigned_url: await presignPut(localPathToS3Key(p, s3Prefix), tagging),
    });
  }
  return list;
}

/** One upload sub-batch: sends UPLOAD_BATCH_SIZE paths to Hands at most. */
async function uploadSubBatch(
  hands: HandsClient,
  paths: string[],
  s3Prefix: string,
  tagging?: string,
): Promise<UploadBatchResult> {
  const files = await buildUploadList(paths, s3Prefix, tagging);
  const raw = await hands.callTool("upload_to_s3", { files });
  try {
    const parsed = JSON.parse(raw) as UploadBatchResult;
    if (Array.isArray(parsed.ok) && Array.isArray(parsed.failed)) return parsed;
  } catch { /* fall through */ }
  // Legacy/unparseable response: treat everything as failed so the retry loop
  // picks it up — better than silently dropping.
  return { ok: [], failed: paths.map(p => ({ path: p, status: -1, error: "unparseable response" })), total: paths.length };
}

/** One upload round: chunk the path list into UPLOAD_BATCH_SIZE-sized sub-
 *  batches so a single MCP request body never exceeds Hands' fastify limit
 *  (root cause of the 413 / FST_ERR_CTP_BODY_TOO_LARGE failure mode). */
async function uploadRound(
  hands: HandsClient,
  paths: string[],
  s3Prefix: string,
  tagging?: string,
): Promise<UploadBatchResult> {
  const ok: string[] = [];
  const failed: UploadBatchResult["failed"] = [];
  for (let i = 0; i < paths.length; i += UPLOAD_BATCH_SIZE) {
    const slice = paths.slice(i, i + UPLOAD_BATCH_SIZE);
    try {
      const r = await uploadSubBatch(hands, slice, s3Prefix, tagging);
      ok.push(...r.ok);
      failed.push(...r.failed);
    } catch (e: unknown) {
      // A whole sub-batch threw (transport error, 413, etc.). Treat every
      // path in the slice as failed so the outer retry loop reschedules
      // them; otherwise we'd silently drop them.
      const msg = (e as { message?: string })?.message ?? String(e);
      for (const p of slice) failed.push({ path: p, status: -1, error: msg.slice(0, 200) });
    }
  }
  return { ok, failed, total: paths.length };
}

/** True when a round's failures look like S3 write backpressure / a transient
 *  status the server wants us to retry after a pause (503 SlowDownWrite, 429),
 *  as opposed to a hard 4xx we should not spin on. */
function isThrottleFailure(failed: UploadBatchResult["failed"]): boolean {
  return failed.some(
    f => f.status === 503 || f.status === 429 ||
      /slowdown|throttl|too many requests/i.test(f.error ?? ""),
  );
}

/** Exponential backoff with full jitter, capped at RETRY_MAX_DELAY_MS.
 *  `round` is 1-based; the chosen delay is uniform in [0, exp] so concurrent
 *  sessions that hit the same throttle window de-correlate their retries. */
function throttleBackoffMs(round: number): number {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (round - 1));
  return Math.floor(Math.random() * exp);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Remove objects under the session prefix that the workspace no longer has.
 *
 * Without this the S3 copy is not a snapshot at all. Uploads only ever added,
 * so what accumulated under a session prefix was the union of every file that
 * had ever existed there -- and a file the user deleted came back the next time
 * the session was rehydrated. Nothing anywhere deleted a workspace object:
 * there was no `DeleteObject` call in this file, the lifecycle rules match by
 * tag or by an unrelated prefix, and the upload sweeper only touches
 * `.uploads/`.
 *
 * Four things are deliberately never deleted here:
 *
 *   - `.uploads/`, which has its own expiry.
 *   - `.zip-cache/`, likewise.
 *   - `.transcripts/`, which Brain writes to and no sandbox ever has, so every
 *     prune sees the whole directory as stale.
 *   - `claw-<timestamp>/` archive directories, which are the point-in-time
 *     copies of past runs. They are supposed to outlive the current workspace.
 *
 * Takes the whole listing rather than the derived key set so that the proof
 * that the listing is complete cannot be left behind at a call site: an
 * unfenced listing reaches here and stops here.
 *
 * @returns how many objects were removed.
 */
async function pruneRemovedObjects(
  sessionId: string,
  s3Prefix: string,
  listing: WorkspaceListing,
): Promise<number> {
  if (!listing.trusted) {
    logger.warn(
      { sessionId, s3Prefix, reason: listing.reason, listed: listing.files.length },
      "s3.prune.skipped_untrusted_listing",
    );
    return 0;
  }
  const expectedKeys = new Set(listing.files.map((f) => localPathToS3Key(f, s3Prefix)));
  const client = getS3Client();
  const stale: string[] = [];
  let total = 0;
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: s3Prefix,
      ContinuationToken: token,
    }));
    for (const obj of page.Contents ?? []) {
      const key = obj.Key;
      if (!key) continue;
      total++;
      if (expectedKeys.has(key)) continue;
      if (isPruneExempt(key.slice(s3Prefix.length))) continue;
      stale.push(key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  if (stale.length === 0) return 0;

  const { doomed, deferred } = prunePlan(stale);
  if (deferred > 0) {
    logger.warn(
      { sessionId, s3Prefix, stale: stale.length, deleting: doomed.length, deferred, total },
      "s3.prune.capped",
    );
  }

  // One object per call. The batch endpoint (POST ?delete) would be the obvious
  // choice, but MinIO requires a Content-MD5 header on it that aws-sdk v3 does
  // not attach, so every batch comes back "Missing required header for this
  // request: Content-Md5" -- a prune written that way would have failed on
  // every sync and only ever shown up as a warning. Single-object DeleteObject
  // carries no such requirement; the upload sweeper has been deleting this way
  // in production all along. Concurrency keeps it comparable to a batch.
  let deleted = 0;
  for (let i = 0; i < doomed.length; i += PRUNE_CONCURRENCY) {
    const batch = doomed.slice(i, i + PRUNE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((Key) => client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key }))),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        deleted++;
      } else {
        // A failed prune leaves objects that should have gone, which is the
        // state this has been in all along. Not worth failing a sync whose
        // uploads succeeded.
        logger.warn(
          {
            sessionId,
            key: batch[j],
            err: (r.reason as { message?: string })?.message ?? String(r.reason),
          },
          "s3.prune.delete_failed",
        );
      }
    }
  }
  logger.info({ sessionId, s3Prefix, deleted, total }, "s3.pruned");
  return deleted;
}

/**
 * Where Brain writes run transcripts, relative to the session prefix.
 *
 * A reserved directory rather than a flat `<runId>.jsonl` beside the workspace,
 * because a name is not a fact anyone here can check: a run id is `claw-<ts>`
 * from chat, the task id from a DAG node, and whatever the client sent for A2A,
 * so no pattern tells a transcript from a `results.jsonl` a user's own run
 * wrote. Guessing was wrong in both directions at once -- the prune had to spare
 * every flat `.jsonl`, so a file the user deleted was restored again for ever,
 * and transcripts landed in `/workspace`, to be re-listed on every turn and
 * copied into every per-run archive. A reserved directory settles the question
 * instead, and `WORKSPACE_EXCLUDES` is what reserves it: the sandbox listing
 * drops this name, so a user who creates it does not end up with files under a
 * directory neither filter will ever restore or prune.
 *
 * Exported because the writer is in tasks/runner.ts and the two filters below
 * are here: a transcript written outside this directory is one the prune deletes
 * on the next sync.
 *
 * Which is what the transcripts already written flat are, and they are left that
 * way: ordinary workspace files, restored and listed and pruned when the user
 * deletes them, under the same rate limit in `prunePlan` that every file they sit
 * beside is deleted under. Sparing them would take a guess at the name, and the
 * only guess available -- every flat `.jsonl` -- spared the user's own
 * `results.jsonl` too, which then came back on the next restore however often
 * they deleted it. Their exposure is now the one every file in a workspace has
 * rather than a rule of their own.
 */
export const TRANSCRIPT_PREFIX = ".transcripts/";

/** Paths under the session prefix that belong to another lifecycle. */
export function isPruneExempt(rel: string): boolean {
  return rel.startsWith(".uploads/")
    || rel.startsWith(".zip-cache/")
    || rel.startsWith(TRANSCRIPT_PREFIX)
    || isArchiveRelPath(rel);
}

/** A workspace listing together with whether it may be believed. */
export interface WorkspaceListing {
  files: string[];
  /** Whether this listing may be used to decide what no longer exists. */
  trusted: boolean;
  /** Why not, when it may not. */
  reason?: string;
}

/**
 * Read a fenced listing back, and decide whether it proved itself.
 *
 * See LS_BEGIN for what the fences are for. The fences are validated rather
 * than searched for, because the text between them is filenames and a filename
 * can contain a newline: a file called `x\n__claw_ls_end__:0` prints as two
 * lines, the second indistinguishable from the real trailing fence. Taking the
 * first candidate ended the region there, so the listing became whatever the
 * agent had put before its forgery and every genuine path after it read as a
 * file the user had deleted -- which is a request to delete it from S3, issued
 * by choosing a filename. The last candidate is the real one, since everything
 * `find` prints comes before the closing `echo`.
 *
 * A line inside the region that is not a path is not dropped either, which is
 * the other half of the same problem: dropping it is what let a forgery pass for
 * a clean listing, since the marker the attacker planted disappeared and the
 * remainder still read as a tidy list of paths. The paths themselves are still
 * uploaded, as they are for every other kind of doubt here -- what is refused is
 * using the listing to decide what no longer exists.
 *
 * What Hands adds to the output of its own accord falls outside the fenced
 * region, so none of it can be read as a path -- and the one thing it adds
 * there is worth more than that. Hands appends `[stdout truncated; N bytes
 * dropped]` exactly when it dropped bytes, so its presence is not a hint about
 * truncation but a statement of it, and it is read first.
 *
 * That closes the forgery this function is mostly about, rather than narrowing
 * it. The counting below rests on a truncated listing leaving a partial line in
 * front of a planted marker, which it usually does -- but the ring buffer cuts
 * on a byte, the attacker chooses both the filenames and their lengths, and a
 * cut landing exactly on the newline before a planted marker leaves nothing in
 * front of it to count. The footer does not depend on where the cut fell. The
 * counting stays as the layer beneath it.
 */
export function parseWorkspaceListing(raw: string): WorkspaceListing {
  const lines = raw.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const begin = lines.indexOf(LS_BEGIN);
  let end = -1;
  let exitCode = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = LS_END_LINE.exec(lines[i]);
    if (m) {
      end = i;
      exitCode = Number(m[1]);
      break;
    }
  }

  const files: string[] = [];
  // An empty line is not evidence of anything -- a name ending in a newline
  // produces one -- so only lines with content on them have to be paths.
  let stray = 0;
  for (const line of lines.slice(begin >= 0 ? begin + 1 : 0, end >= 0 ? end : undefined)) {
    if (line.startsWith("/workspace/")) files.push(line);
    else if (line !== "") stray++;
  }
  // Content in front of the opening fence, which is the head-side mirror of the
  // forged trailing fence: the `echo` is the first thing the command runs, so on
  // a healthy listing there is nothing there. When the ring buffer drops the
  // front of the output the real fence goes with it, and the first candidate left
  // is whatever comes next -- including a line a filename could have printed.
  // Searching backwards is not the fix here, since the real fence is the first
  // one; what makes the difference is that the truncated `find` output still
  // sitting in front of the forgery is counted rather than skipped.
  for (const line of lines.slice(0, Math.max(begin, 0))) {
    if (line !== "") stray++;
  }

  // Hands' own account of what it lost, and the only signal here that does not
  // have to be inferred from what the output looks like afterwards.
  if (lines.some((l) => TRUNCATED_FOOTER.test(l))) {
    return { files, trusted: false, reason: "listing_truncated" };
  }
  if (begin < 0) return { files, trusted: false, reason: "listing_head_dropped" };
  if (end < 0) return { files, trusted: false, reason: "listing_unterminated" };
  if (exitCode !== 0) return { files, trusted: false, reason: `find_exit_${exitCode}` };
  if (stray) return { files, trusted: false, reason: "listing_unexpected_lines" };
  return { files, trusted: true };
}

/**
 * An untrusted listing that yielded nothing, thrown instead of reported empty.
 *
 * `empty` is how the caller tells the user their run produced no files, so
 * returning it for a listing that never parsed reports a failed sync as a
 * finished one -- the single outcome indistinguishable from success. Throwing
 * puts it on the path a listing call that never came back already takes.
 *
 * Named rather than a bare `Error` because the caller derives the user-facing
 * `workspace_sync_failed` reason from the error's type, and a bare one arrives
 * as the literal string "Error", which names nothing anybody can act on. Which
 * of these failures happened is the listing's own verdict -- `find_exit_1`,
 * `listing_head_dropped` -- and it is in the message. The class name is the whole
 * of that coupling: the caller reads it off whatever it caught, so renaming this
 * renames what the user is shown.
 *
 * That path also copies the newest in-flight checkpoint back into the session
 * prefix, and this keeps it deliberately. The copy cannot un-delete anything: a
 * sync that throws prunes nothing, so the session prefix still holds the state
 * from before this run, in which every file the user deleted mid-run is present
 * regardless. What the copy adds is the files this run created, which exist
 * nowhere else once the workspace cannot be listed -- and the commonest way of
 * arriving here is exactly that, a sandbox tearing down with `/workspace`
 * already unmounted. The one case it does resurrect is a file created and then
 * deleted inside this same run with a checkpoint written between the two, which
 * no listing this process is willing to trust could settle either way.
 */
class WorkspaceListingUntrusted extends Error {
  constructor(reason: string | undefined) {
    super(`workspace listing could not be trusted: ${reason}`);
    this.name = "WorkspaceListingUntrusted";
  }
}

/**
 * How much of the stale set a single sync may remove.
 *
 * Now that the listing has to prove it is complete before it is believed at
 * all, the job left for a limit is not to second-guess it but to bound the
 * rate: a mistake in the fencing or the exemptions should cost a bounded
 * number of objects and leave `s3.prune.capped` in the log for someone to
 * find. Whatever is deferred is still stale on the next sync, so a genuine
 * large deletion converges over a few of them.
 *
 * The guard this replaces refused the whole prune above a proportion of the
 * prefix, which did not converge: the stale set that tripped it was the same
 * size on every subsequent sync, so a workspace that lost more than half its
 * files at once was never reconciled again, and the deleted files kept coming
 * back on restore.
 */
export function prunePlan(stale: string[]): { doomed: string[]; deferred: number } {
  const doomed = stale.slice(0, S3_PRUNE_MAX_OBJECTS);
  return { doomed, deferred: stale.length - doomed.length };
}

async function logUploadManifestToHandsLog(
  hands: HandsClient,
  sessionId: string,
  s3Prefix: string,
  files: string[],
): Promise<void> {
  try {
    await hands.callTool("log_s3_upload_manifest", { sessionId, s3Prefix, files });
  } catch (e: unknown) {
    logger.warn({ err: e, sessionId }, "s3.upload_manifest_log_failed");
  }
}

/**
 * Sync workspace files to S3 via pre-signed URLs.
 * Brain generates URLs (has S3 credentials), Hands uploads directly (no credentials needed).
 * Failed uploads are retried with freshly signed URLs up to MAX_UPLOAD_ROUNDS.
 *
 * Throws when the sandbox is unreachable at probe time, when the workspace
 * listing call fails, and when the listing comes back unusable with nothing in
 * it (see WorkspaceListingUntrusted) — caller should catch and emit a
 * `sandboxStatus` `workspace_sync_failed` event. Returns a structured result on
 * a happy path (including partial / exhausted / empty cases) so the caller can
 * decide whether to surface a `workspace_sync_partial` / `workspace_sync_empty`
 * event to the user.
 */
export async function syncWorkspaceToS3(
  hands: HandsClient,
  sessionId: string,
  userId: string,
  options?: { s3PrefixOverride?: string },
): Promise<SyncWorkspaceResult> {
  // A run being torn down still has a final flush on its way, and the delete
  // that stopped it has already listed the prefix. Landing now would re-create
  // objects belonging to a session that no longer exists, which nothing
  // downstream would ever notice. Reported as empty because that is what it is
  // from the caller's side: a tear-down in progress, nothing to keep.
  if (isSessionDeletedLocally(sessionId)) {
    logger.info({ sessionId }, "s3.sync_skipped_session_deleted");
    return { uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true };
  }

  const s3Prefix = options?.s3PrefixOverride
    ?? `users/${userId}/sessions/${sessionId}/`;

  // Sandbox liveness probe before any heavy work. This catches the most
  // common ghost-session pattern (sandbox pod GC'd while Brain still holds
  // its KV entry / hands_url): without the probe, a dead-MCP request is only
  // given up on when the `find` below reaches its own deadline, which is the
  // timeout it asks for plus transport slack — minutes of the sync spent
  // waiting on a sandbox that is already gone.
  await hands.callTool("bash", {
    command: "echo ok",
    timeout: SANDBOX_PROBE_TIMEOUT_SEC,
  });

  // List files in workspace via Hands. The skips come from the one list in
  // workspace/excludes.ts, shared with the shared-filesystem sync -- the two
  // used to disagree about most of their contents, so restoring from S3 and
  // restoring from the shared disk gave different workspaces, and S3 was
  // carrying gigabytes of ROCm kernel objects and compile caches that are
  // regenerated on first use. `.skills/` is the one deliberate difference and
  // is still uploaded; see that module for why.
  //
  // Fenced on both sides so the prune can tell a complete listing from a
  // curtailed one; see LS_BEGIN. The trailing `echo` also keeps the shell's
  // own exit status at zero, which matters because Hands reformats a non-zero
  // exit into an `exit N\nstdout: ...` envelope that no longer parses as a
  // list of paths.
  const fileList = await hands.callTool("bash", {
    command:
      `echo ${LS_BEGIN}; find /workspace -type f ${findExcludeArgs(s3Excludes())}`
      + ` 2>/dev/null; echo "${LS_END}:$?"`,
    timeout: FIND_TIMEOUT_SEC,
  });
  const listing = parseWorkspaceListing(fileList);
  const files = listing.files;
  if (!listing.trusted) {
    logger.warn(
      { sessionId, s3Prefix, reason: listing.reason, listed: files.length },
      "s3.sync.listing_untrusted",
    );
    // A listing that did not parse and yielded nothing is not an empty
    // workspace; see WorkspaceListingUntrusted for what reporting it as one
    // costs, and for what the failure path then does.
    if (!files.length) {
      throw new WorkspaceListingUntrusted(listing.reason);
    }
  }
  if (!files.length) {
    // A fenced, zero-exit listing with nothing in it: `find` walked /workspace
    // and there was nothing to find. The sandbox tearing down with /workspace
    // unmounted no longer reaches here -- `find` exits non-zero on a missing
    // directory, which is `find_exit_1` and refused above -- so this is a run
    // that genuinely produced no files. Still logged, because the user will read
    // it as artifacts that went missing and the correlation is worth having.
    logger.warn({ sessionId, s3Prefix }, "s3.sync.empty_workspace");
    return { uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true };
  }
  await logUploadManifestToHandsLog(hands, sessionId, s3Prefix, files);

  let pending = files;
  let uploaded = 0;
  let lastFailures: UploadBatchResult["failed"] = [];

  for (let round = 1; round <= MAX_UPLOAD_ROUNDS && pending.length > 0; round++) {
    const result = await uploadRound(
      hands,
      pending,
      s3Prefix,
      TAGGING_ENABLED ? WORKSPACE_TAG : undefined,
    );
    uploaded += result.ok.length;
    lastFailures = result.failed;
    if (result.failed.length === 0) {
      // Only once every file is up. A prune after a partial upload would be
      // deleting the old copy of something whose new copy did not arrive.
      const pruned = await pruneRemovedObjects(sessionId, s3Prefix, listing)
        .catch((e: unknown) => {
        logger.warn(
          { sessionId, err: (e as { message?: string })?.message ?? String(e) },
          "s3.prune.failed",
        );
        return 0;
      });
      logger.info({ sessionId, round, totalUploaded: uploaded, total: files.length, pruned, s3Prefix }, "s3.synced");
      return { uploaded, totalFiles: files.length, failedCount: 0, exhausted: false, empty: false };
    }
    logger.warn(
      { sessionId, round, ok: result.ok.length, failed: result.failed.length, sample: result.failed.slice(0, 3) },
      "s3.sync.round_failed",
    );
    pending = result.failed.map(f => f.path);

    // Method A: on S3 write backpressure (503 SlowDownWrite / 429), pause
    // before the next round with exponential backoff + jitter so we let the
    // throttle window drain instead of immediately re-hammering the same
    // saturated backend. Non-throttle failures keep the prior immediate-retry
    // behaviour (e.g. a 413 body-too-large is reshaped by sub-batching, not
    // by waiting).
    if (round < MAX_UPLOAD_ROUNDS && pending.length > 0 && isThrottleFailure(result.failed)) {
      const delayMs = throttleBackoffMs(round);
      logger.warn({ sessionId, round, delayMs, pending: pending.length }, "s3.sync.throttle_backoff");
      await sleep(delayMs);
    }
  }

  // Ran out of rounds with some files still failing — surface loudly so it's
  // not a silent data loss event.
  logger.error(
    { sessionId, uploaded, totalFailed: lastFailures.length, sample: lastFailures.slice(0, 5), s3Prefix },
    "s3.sync.exhausted",
  );
  return {
    uploaded,
    totalFiles: files.length,
    failedCount: lastFailures.length,
    exhausted: true,
    empty: false,
  };
}

// ===== Download: S3 → sandbox (session rehydration) =====

interface DownloadBatchResult {
  ok: string[];
  failed: Array<{ path: string; status: number; error: string }>;
  total: number;
}

/** Returns true when rel points into a historical per-message archive dir
 *  (e.g. "claw-1776xxxxx/hyperloom/foo"), so current-workspace listing skips it. */
function isArchiveRelPath(rel: string): boolean {
  if (!rel.startsWith("claw-")) return false;
  const slash = rel.indexOf("/");
  return slash > 5; // at least "claw-X/"
}

/**
 * Returns true when rel is something Brain or the platform put under the session
 * prefix, which a sandbox must therefore not be given back.
 *
 * `.hands-binary` is a stale bootstrap artifact. `.transcripts/` is Brain's
 * record of past runs: restored, every transcript would be poured into
 * `/workspace`, where the next `find` uploads them all again and the next
 * archive copies them -- so a session's transcripts would be squared with every
 * run. Transcripts already sitting in the flat location are deliberately not
 * named here, and the prune no longer spares them either: shape cannot tell one
 * from a `results.jsonl` a user's own run wrote, so neither filter guesses and
 * both leave them as the workspace files they became. `.skills/` is intentionally
 * NOT in this list; per-session skill state is restored from S3.
 */
function isInternalRelPath(rel: string): boolean {
  return rel === ".hands-binary" || rel.startsWith(TRANSCRIPT_PREFIX);
}

/**
 * Objects under the session prefix that are not part of the workspace.
 *
 * The mirror of isPruneExempt on everything the two share, and both decide by
 * prefix: what a path is called says nothing about whose it is, so the only
 * files either filter claims are the ones under a directory the sandbox listing
 * is not allowed to reach -- see `WORKSPACE_EXCLUDES` for the half that keeps
 * that true. `.uploads/` and `.zip-cache/` are the deliberate asymmetry -- exempt
 * from the prune because they have their own expiry, restored because the user
 * put them there to be worked on.
 *
 * Getting this wrong in this direction is the expensive one: a prune that spares
 * a file the user deleted leaves an unwanted object in S3, while a restore that
 * skips a file the user created destroys it, with nothing left to recover from.
 */
export function isRestoreSkipped(rel: string): boolean {
  return isArchiveRelPath(rel) || isInternalRelPath(rel);
}

/** List all object keys under prefix, paginated, minus everything that belongs
 *  to another lifecycle. */
async function listCurrentWorkspaceKeys(s3Prefix: string): Promise<string[]> {
  const s3 = getS3Client();
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET, Prefix: s3Prefix, ContinuationToken: continuationToken,
    }));
    for (const obj of resp.Contents || []) {
      const k = obj.Key;
      if (!k) continue;
      const rel = k.slice(s3Prefix.length);
      if (isRestoreSkipped(rel)) continue;
      keys.push(k);
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function buildDownloadList(keys: string[], s3Prefix: string) {
  const list: Array<{ local_path: string; presigned_url: string }> = [];
  for (const k of keys) {
    const rel = k.slice(s3Prefix.length);
    list.push({ local_path: `/workspace/${rel}`, presigned_url: await presignGet(k) });
  }
  return list;
}

async function downloadRound(
  hands: HandsClient,
  keys: string[],
  s3Prefix: string,
): Promise<DownloadBatchResult> {
  const files = await buildDownloadList(keys, s3Prefix);
  const raw = await hands.callTool("download_from_s3", { files });
  try {
    const parsed = JSON.parse(raw) as DownloadBatchResult;
    if (Array.isArray(parsed.ok) && Array.isArray(parsed.failed)) return parsed;
  } catch { /* fall through */ }
  return {
    ok: [],
    failed: keys.map(k => ({ path: `/workspace/${k.slice(s3Prefix.length)}`, status: -1, error: "unparseable response" })),
    total: keys.length,
  };
}

/**
 * Rehydrate a freshly-created sandbox with the "current" S3 workspace state
 * (top-level files, excluding historical claw-<mid> archive subdirs). Called
 * after ensureHands creates a new workload; skipped when reusing an existing
 * one. Failures are retried up to MAX_UPLOAD_ROUNDS with freshly signed URLs.
 */
export async function syncWorkspaceFromS3(
  hands: HandsClient,
  sessionId: string,
  userId: string,
  options?: { s3PrefixOverride?: string },
): Promise<number> {
  const s3Prefix = options?.s3PrefixOverride
    ?? `users/${userId}/sessions/${sessionId}/`;
  const keys = await listCurrentWorkspaceKeys(s3Prefix);
  if (!keys.length) {
    logger.info({ sessionId, s3Prefix }, "s3.restore.empty");
    return 0;
  }

  let pending = keys;
  let downloaded = 0;
  let lastFailures: DownloadBatchResult["failed"] = [];

  for (let round = 1; round <= MAX_UPLOAD_ROUNDS && pending.length > 0; round++) {
    const result = await downloadRound(hands, pending, s3Prefix);
    downloaded += result.ok.length;
    lastFailures = result.failed;
    if (result.failed.length === 0) {
      logger.info({ sessionId, round, totalDownloaded: downloaded, total: keys.length, s3Prefix }, "s3.restored");
      return downloaded;
    }
    logger.warn(
      { sessionId, round, ok: result.ok.length, failed: result.failed.length, sample: result.failed.slice(0, 3) },
      "s3.restore.round_failed",
    );
    // Map failed local_paths back to S3 keys for the next round.
    pending = result.failed.map(f => `${s3Prefix}${f.path.replace("/workspace/", "")}`);
  }

  logger.error(
    { sessionId, downloaded, totalFailed: lastFailures.length, sample: lastFailures.slice(0, 5), s3Prefix },
    "s3.restore.exhausted",
  );
  return downloaded;
}

// ===== Recovery: copy a checkpoint prefix back to the session prefix =====

/**
 * Server-side copy every object under `srcPrefix` to `dstPrefix` (preserving
 * the relative path). Used as a last-resort recovery when the post-exec
 * `syncWorkspaceToS3` call fails entirely (sandbox unreachable / 413 / etc.):
 * if a periodic in-flight checkpoint had been written earlier, we can still
 * surface those files at the session prefix so the user does not see an
 * empty /workspace despite a successful `exec_complete`.
 *
 * Returns the number of objects copied. Errors per-key are logged and
 * counted as failed; the function never throws — callers treat it as
 * best-effort.
 */
export async function copyS3Prefix(
  sessionId: string,
  srcPrefix: string,
  dstPrefix: string,
): Promise<{ copied: number; failed: number }> {
  const s3 = getS3Client();
  const keys = await listCurrentWorkspaceKeys(srcPrefix).catch((e: unknown) => {
    logger.warn({ err: e, sessionId, srcPrefix }, "s3.recover.list_failed");
    return [] as string[];
  });
  if (!keys.length) return { copied: 0, failed: 0 };

  let copied = 0;
  let failed = 0;
  const concurrency = 8;
  const queue = [...keys];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const key = queue.shift();
      if (!key) break;
      const rel = key.slice(srcPrefix.length);
      const dstKey = `${dstPrefix}${rel}`;
      try {
        const copySource = `/${S3_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
        await s3.send(new CopyObjectCommand({
          Bucket: S3_BUCKET, CopySource: copySource, Key: dstKey,
        }));
        copied++;
      } catch (e: unknown) {
        const msg = (e as { message?: string })?.message ?? String(e);
        logger.warn({ err: msg, sessionId, src: key, dst: dstKey }, "s3.recover.copy_failed");
        failed++;
      }
    }
  }));
  logger.info({ sessionId, srcPrefix, dstPrefix, copied, failed }, "s3.recovered");
  return { copied, failed };
}

// ===== Archive: S3-native per-message snapshot via CopyObject =====

/**
 * After a successful syncWorkspaceToS3, server-side copy the top-level objects
 * into a per-message archive prefix `claw-<messageId>/`. Zero body transfer
 * (S3 metadata op) — Brain just issues CopyObject calls. The current top-level
 * layout stays intact so v1-compatible /files endpoints keep working; the
 * archive coexists for historical traceability.
 *
 * Errors are logged but non-fatal (archive is a nice-to-have, not blocking).
 */
export async function archiveRunToS3(
  sessionId: string,
  userId: string,
  messageId: string,
): Promise<number> {
  if (!messageId) return 0;
  // Same reason as the sync above: an archive written now is written under a
  // prefix that has just been emptied on the way to deleting the session.
  if (isSessionDeletedLocally(sessionId)) {
    logger.info({ sessionId }, "s3.archive_skipped_session_deleted");
    return 0;
  }
  const s3Prefix = `users/${userId}/sessions/${sessionId}/`;
  const archivePrefix = `${s3Prefix}${messageId}/`;
  const s3 = getS3Client();
  const keys = await listCurrentWorkspaceKeys(s3Prefix).catch((e) => {
    logger.warn({ err: e, sessionId }, "s3.archive.list_failed");
    return [] as string[];
  });
  if (!keys.length) return 0;

  let ok = 0;
  let failed = 0;
  // Parallelism is fine — these are cheap metadata ops, and we're bounded by
  // the file count per run (usually tens, occasionally hundreds).
  const concurrency = 8;
  const queue = [...keys];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const key = queue.shift();
      if (!key) break;
      const rel = key.slice(s3Prefix.length);
      // Don't archive archive — skip any residual claw-<mid>/ keys defensively.
      if (isArchiveRelPath(rel)) continue;
      // Don't archive user-uploaded files — those have their own TTL managed by
      // the upload-sweeper; duplicating them into per-message archives would
      // leave copies that outlive the user's expiration intent.
      if (rel.startsWith(".uploads/")) continue;
      const dstKey = `${archivePrefix}${rel}`;
      try {
        // CopySource encoding: AWS expects each path segment percent-encoded,
        // but path separators (`/`) must remain literal. The previous one-shot
        // `encodeURIComponent + replace %2F` failed for keys containing
        // already-percent characters or non-ASCII bytes. Encode segment-by-
        // segment instead so `(`, ` `, `+`, multibyte UTF-8 etc. round-trip.
        const copySource = `/${S3_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
        await s3.send(new CopyObjectCommand({
          Bucket: S3_BUCKET,
          CopySource: copySource,
          Key: dstKey,
        }));
        ok++;
      } catch (e: any) {
        logger.warn({ err: e?.message || String(e), sessionId, src: key, dst: dstKey }, "s3.archive.copy_failed");
        failed++;
      }
    }
  }));

  if (failed > 0) {
    logger.warn({ sessionId, messageId, ok, failed, archivePrefix }, "s3.archive.partial");
  } else {
    logger.info({ sessionId, messageId, count: ok, archivePrefix }, "s3.archived");
  }
  return ok;
}
