// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One implementation of "delete this session", for both endpoints that offer it.
 *
 * There were two, and they disagreed about eight things. The standard route ran
 * nine hand-written steps; the Anthropic-compatible one published an interrupt,
 * dropped queued messages, and soft-deleted the row -- leaving the tombstone,
 * the KV lock, the parked sandbox handle, the event purge, and the soft delete
 * of turns, summaries and events undone, so a session deleted through that
 * endpoint kept its content and could still have work dispatched to it.
 *
 * The root cause is further down and not fixed here: `claw_tasks` and the
 * session tables carry no foreign keys, so nothing cascades and every deletion
 * has to be spelled out. Spelling it out twice is what guarantees the two
 * copies drift. Spelling it out once is the part that can be fixed today.
 *
 * The shape is two halves with one commit between them.
 *
 * {@link commitSessionDeletion} does everything that lives in this database, in
 * a single transaction: the queued messages go, the runs that were still open
 * are cancelled, the conversation is stamped `deleted_at`, the session is
 * hidden, and the work that is left over is written onto the row as
 * `cleanup_state = 'pending'`. Before that commit nothing has happened at all,
 * so any failure is a 503 over an untouched session; after it, the session is
 * gone as far as anybody can see and the deletion is a promise this process has
 * made.
 *
 * {@link runSessionCleanup} keeps that promise, outside the database: the
 * tombstone, the cleanup notification, the parked sandbox handle, the gate
 * locks, the event stream, the objects in S3, and the workspace reference. Every
 * step of it is idempotent and it has two callers -- this request and the
 * sweeper in sessions/cleanup-sweep.ts, each on a time budget of its own --
 * because a store that is unavailable for the length of one request is not a
 * reason to lose a delete. Whatever the request could not finish stays `pending` and the
 * sweeper finishes it.
 *
 * What that buys is the property the old order could not have: the session is
 * never visible and tombstoned at once, and a delete that answered 200 is never
 * a delete that stopped half way. What it costs is that 200 means "accepted and
 * guaranteed" rather than "finished", so a cleanup nothing can finish has to be
 * alerted on rather than noticed in a response -- see the stuck report in
 * sessions/cleanup-sweep.ts.
 *
 * The compute side is deliberately not in the cleanup body. Brain owns it, and
 * it has three ways to reach it that do not involve this process: the
 * `cleanup.*` notification, the `hands.<sid>` handle this parks with
 * `sessionDeleted` on it, and the platform's own idle collection once the
 * keepalive stops. This process has no admin credential for the platform, so a
 * sweeper here could not authenticate a workload delete at all -- see
 * sweepStaleHands in brain/src/sandbox/reaper.ts for the end of that path.
 */

import type { KV } from "nats";
import type { S3Client } from "@aws-sdk/client-s3";
import { ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { cleanupSubject, encodeCleanupPayload, parkHandsHandle, type ParkOutcome } from "@claw/protocol";
import pino from "pino";

import { db, inTransaction, type Querier } from "../infra/db.js";
import { sessionWorkspacePrefix, workspaceOwnerId } from "../workspace/prefix.js";
import { getS3Client } from "../infra/s3-client.js";
import { releaseSessionRefs, workspaceForSession } from "../workspace/store.js";
import { sc, nc, kv, kvTombstones, jsm, EVENT_STREAM } from "../infra/nats.js";
import { rememberSessionDeleted } from "./deleted-cache.js";
import { S3_BUCKET, envInt } from "../config.js";

const logger = pino({ name: "session-teardown" });

/** In-flight DeleteObject calls. Batched delete is unavailable; see below. */
const DELETE_CONCURRENCY = 16;

/**
 * How long the deleting request may spend finishing the job itself.
 *
 * The request runs the cleanup inline because on a healthy cluster it takes
 * milliseconds and finishing it there means the pending queue is empty, which
 * is what makes "anything pending for more than a few minutes is a real fault"
 * a usable alert. It is not the mechanism, though: the sweeper is, and this
 * budget is what keeps the fast path from becoming a slow one. A store that has
 * stopped answering holds each of its own calls for as long as their timeouts
 * allow, and without a budget a delete of a session with six figures of objects
 * would hold the connection for as long as the walk takes.
 *
 * Five seconds because it is well past a healthy pass and well under what a
 * client waits out. Checked between steps, between pages of a listing, and
 * between delete batches inside a page, rather than enforced with a cancel, so
 * the work stops at a boundary it can be resumed from -- every step is
 * idempotent, and the sweeper repeats the ones that were skipped.
 */
const INLINE_CLEANUP_BUDGET_MS = envInt("SESSION_CLEANUP_INLINE_BUDGET_MS", 5_000, { min: 1 });

/**
 * How long a failed cleanup waits before the sweeper tries it again, and the
 * ceiling that backoff climbs to.
 *
 * Exponential from the tick interval, because the failures this retries are
 * whole-store outages: an S3 endpoint that refused one delete refuses the next
 * one a second later, and the retries of every session deleted that day arrive
 * together. Capped so that a store coming back is noticed within a quarter of
 * an hour rather than after the backoff of however many attempts have piled up.
 */
const CLEANUP_RETRY_BASE_SEC = envInt("SESSION_CLEANUP_RETRY_BASE_SEC", 60, { min: 1 });
/** Exported because the stuck report's threshold is derived from it. */
export const CLEANUP_RETRY_MAX_SEC = envInt("SESSION_CLEANUP_RETRY_MAX_SEC", 900, { min: 1 });

/**
 * Where a session's in-flight workspace snapshots live, which is deliberately
 * not under the session prefix {@link sessionWorkspacePrefix} builds.
 *
 * A run past thirty minutes copies the whole of `/workspace` here every half
 * hour, so that a terminal sync which fails has something to fall back on. It
 * sits outside the session prefix on purpose -- inside it, the restore, the
 * listing and the per-run archive would all rehydrate a snapshot into the
 * workspace it was taken from and upload it again. That is exactly why a delete
 * scoped to the session prefix has to name this one separately: the reason it is
 * invisible to every routine path is the reason it survived deletion, leaving a
 * complete copy of a deleted session's workspace in the bucket for every long
 * run it ever had.
 *
 * Brain builds `checkpoints/<user>/<sid>/<messageId>/` per run, so one level up
 * covers every run of the session -- provided the owner segment is the same one
 * Brain used. Nothing guarantees that: no type relates the two, and no test
 * exercises them together. It does not hold on the A2A path, where the session row
 * is inserted with the literal `"a2a"` as `user_id` while the task payload carries
 * the authenticated caller's id, and Brain builds the prefix from the payload -- so
 * for an authenticated A2A caller Brain writes under their real id and this looks
 * under `checkpoints/a2a/`. The workspace prefix diverges the same way for
 * the same reason; both are the pre-existing A2A ownership question rather than
 * anything this function can settle, and the mismatch is silent, because a delete
 * addressing an empty prefix reports nothing deleted and nothing failed.
 */
export function sessionCheckpointPrefix(ownerId: string, sessionId: string): string {
  return `checkpoints/${workspaceOwnerId(ownerId)}/${sessionId}/`;
}

/**
 * Reject an id that would widen the prefix.
 *
 * The prefix is the entire safety argument for a bulk delete, so an id
 * carrying a slash, or an empty one, has to be refused rather than
 * interpolated: `users//sessions//` is harmless, but it is one edit away from
 * addressing every object of every user, and nothing downstream would notice.
 *
 * An owner id is resolved through {@link workspaceOwnerId} before it gets here,
 * so "empty" no longer describes a session whose `user_id` column is blank --
 * those objects exist, under `default`, and are deleted. What is left to refuse
 * is an id that is absent altogether or shaped like a path.
 */
export function isUsableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("/");
}

/**
 * Delete every object belonging to a session's workspace.
 *
 * Unlike the sync-time prune, this exempts nothing. The prune spares
 * `.uploads/`, `.zip-cache/`, `.transcripts/` and past-run archives because they
 * outlive the current contents of `/workspace`; they do not outlive the session
 * itself, and leaving them would mean a deleted session still had files in S3 --
 * exactly the compliance hole this closes. Everything under the session prefix
 * goes, which is why a new reserved directory needs nothing added here.
 *
 * Two prefixes, because a session's objects are written under two: the workspace
 * and the in-flight checkpoints that {@link sessionCheckpointPrefix} explains.
 * Anything filed outside both is not covered by this and has to be added here,
 * which is the property worth remembering when a new writer picks a prefix.
 *
 * Throws on an id it will not interpolate. Returning a count would say the same
 * thing an empty prefix says -- nothing deleted, nothing failed -- and the
 * caller would take it for a session that had no files and record the cleanup
 * as finished, leaving every object of a deleted session in the bucket: the
 * compliance hole this exists to close, reached by the one path that reports
 * success while doing nothing.
 *
 * `deadline` is an epoch-millisecond stop time for the walk, which the inline
 * caller sets and the sweeper does not. Reaching it leaves objects behind and
 * says so, rather than reporting a partial walk as a complete one -- the
 * distinction the caller records as "still pending".
 *
 * @returns how many objects were removed, how many refused to go, and whether
 *          both prefixes were walked to the end.
 */
export async function deleteSessionWorkspaceObjects(
  ownerId: string | null,
  sessionId: string,
  deadline?: number,
): Promise<{ deleted: number; failed: number; complete: boolean }> {
  const owner = workspaceOwnerId(ownerId);
  if (!isUsableId(owner) || !isUsableId(sessionId)) {
    throw new Error(
      `refusing to delete a workspace with an unusable id (owner=${JSON.stringify(owner)}, `
      + `session=${JSON.stringify(sessionId)}): the prefix is the whole safety argument`,
    );
  }
  const s3 = getS3Client();
  const prefixes = [
    sessionWorkspacePrefix(owner, sessionId),
    sessionCheckpointPrefix(owner, sessionId),
  ];

  let deleted = 0;
  let failed = 0;
  let complete = true;
  for (const prefix of prefixes) {
    if (pastDeadline(deadline)) { complete = false; break; }
    const outcome = await deletePrefix(s3, prefix, sessionId, deadline);
    deleted += outcome.deleted;
    failed += outcome.failed;
    complete &&= outcome.complete;
  }

  logger.info({ sessionId, prefixes, deleted, failed, complete }, "session.workspace_deleted");
  return { deleted, failed, complete };
}

/** Whether a caller's stop time, if it set one, has passed. */
function pastDeadline(deadline?: number): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

/**
 * Delete everything under one prefix, a page at a time.
 *
 * Each page is deleted before the next is listed, rather than collecting every
 * key first. A workspace archive is written per turn, so a long session reaches
 * six figures of objects, and holding all of them costs memory in a request
 * handler for no benefit -- they are deleted one page later anyway. Safe to
 * interleave: a continuation token resumes after the last key returned, so
 * removing keys already listed does not disturb the walk.
 *
 * The page boundary is where a deadline is honoured between listings. Inside a
 * page the delete batches honour it too: finishing a thousand-key page after
 * the clock has stopped is how an inline delete spends minutes in a request
 * handler, and how it overlaps a sweeper pass that thought it had the rest.
 * Stopping mid-page is still resumable -- the next attempt lists from the
 * start and the keys already gone are simply not returned.
 */
async function deletePrefix(
  s3: S3Client,
  prefix: string,
  sessionId: string,
  deadline?: number,
): Promise<{ deleted: number; failed: number; complete: boolean }> {
  let deleted = 0;
  let failed = 0;
  let token: string | undefined;
  do {
    if (pastDeadline(deadline)) return { deleted, failed, complete: false };
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((key): key is string => Boolean(key));
    const outcome = await deleteObjects(s3, keys, sessionId, deadline);
    deleted += outcome.deleted;
    failed += outcome.failed;
    if (!outcome.complete) return { deleted, failed, complete: false };
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { deleted, failed, complete: true };
}

/**
 * Delete a set of keys, a few at a time, reporting rather than throwing.
 *
 * One object per call. MinIO requires a Content-MD5 header on the batch
 * endpoint that aws-sdk v3 does not attach, so DeleteObjects fails every time
 * with "Missing required header for this request: Content-Md5".
 */
async function deleteObjects(
  s3: S3Client,
  keys: string[],
  sessionId: string,
  deadline?: number,
): Promise<{ deleted: number; failed: number; complete: boolean }> {
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    if (pastDeadline(deadline)) return { deleted, failed, complete: false };
    const batch = keys.slice(i, i + DELETE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((Key) => s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key }))),
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === "fulfilled") {
        deleted++;
      } else {
        failed++;
        logger.warn(
          {
            sessionId,
            key: batch[j],
            err: errorText((results[j] as PromiseRejectedResult).reason),
          },
          "session.workspace_delete_object_failed",
        );
      }
    }
  }
  return { deleted, failed, complete: true };
}

/**
 * The delete was not confirmed.
 *
 * The only failure a caller of this module can act on, and the only one it
 * raises: the transaction either commits or does not, so there is no
 * half-deleted session to describe. Almost always nothing was touched at all --
 * the session is still there with every row it had, and the same request run
 * again is what finishes the job once the database is back. A `COMMIT` that
 * failed after the server had written it is the exception, and there the session
 * is already deleted, with `cleanup_state` committed beside it so the sweeper
 * finishes the rest; the retry then answers 404, which is the right answer.
 *
 * Either way the caller's move is the same, which is why this is one exception
 * and a 503 -- where the plain error a route cannot recognise would be a 500
 * telling the caller to stop.
 *
 * Everything after the commit is retried by the sweeper instead of raised,
 * because by then the answer to the client is already 200 and the retry is not
 * theirs to make.
 */
export class TeardownRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeardownRefused";
  }
}

/** Whatever a rejected promise carried, as something safe to log. */
function errorText(reason: unknown): string {
  return (reason as Error | undefined)?.message ?? String(reason);
}

/** What came of trying to mark a session deleted in both buckets. */
export type TombstoneOutcome = "written" | "legacy_missing" | "failed";

/**
 * Mark a session deleted, in both places that answer the question.
 *
 * The durable bucket is the one that outlives every window a message can come
 * back from; the registry copy is what a Brain replica from before that bucket
 * existed still reads, and during a rolling upgrade both kinds are running. The
 * registry copy expires on its own five-minute TTL and needs no cleanup.
 *
 * First in the cleanup body, because it is the step whose absence is unsafe
 * rather than untidy. A message accepted before the delete can come back for as
 * long as its stream retains it -- a task for the length of the redelivery
 * budget, an event for the event stream's retention, which is a day by default
 * and whatever an operator widened it to on a cluster that keeps history for an
 * audit window -- and with nothing to check against, Brain dispatches it into a
 * session that is gone, or the event consumer writes conversation content back
 * under it. The transaction that precedes the cleanup has already dropped the
 * queue and cancelled the open runs, so what this closes is the window for
 * deliveries that were already in flight.
 *
 * The registry copy is not required. Five minutes against a redelivery window
 * measured in hours makes it a bridge for replicas mid-upgrade rather than
 * protection, and losing it is worth a line, not a retry of the whole body.
 *
 * It is also written second, and only if the first one landed. Issued together,
 * the registry copy survives the durable write failing -- and Brain treats
 * either mark as the session being gone, so the cleanup would look partly done
 * while the mark that actually outlives a redelivery is missing.
 */
export async function writeSessionTombstones(
  durableKv: KV,
  legacyKv: KV,
  sessionId: string,
): Promise<TombstoneOutcome> {
  try {
    await durableKv.put(`deleted.${sessionId}`, sc.encode("1"));
  } catch (err) {
    logger.error(
      { sessionId, err: errorText(err) },
      "session.tombstone_write_failed (a message already in flight would be dispatched "
      + "into this deleted session until the cleanup is retried)",
    );
    return "failed";
  }
  // This replica's event consumer would otherwise keep a live answer for up to
  // ten seconds and admit the trailing exec_complete the cleanup notification
  // is about to provoke. Other replicas hear that notification; this one has
  // to remember here, because the write landed before the publish.
  rememberSessionDeleted(sessionId);
  try {
    await legacyKv.put(`deleted.${sessionId}`, sc.encode("1"));
  } catch (err) {
    logger.warn(
      { sessionId, err: errorText(err) },
      "session.tombstone_legacy_copy_failed",
    );
    return "legacy_missing";
  }
  return "written";
}

/**
 * Tell the fleet to stop this session and let go of what it is holding.
 *
 * One message, deliberately: it carries both "stop the running task" and
 * "destroy the resources". Two core-NATS publishes would make "only one
 * arrived" reachable -- either the task keeps running against destroyed
 * resources, or the resources leak while the task stops.
 *
 * This is also where the Anthropic route used to differ: it published a bare
 * interrupt, which stops the task and leaks everything attached to it.
 *
 * @returns whether the notification went out.
 */
function notifyCleanup(sessionId: string, platformKey: string): boolean {
  try {
    nc.publish(cleanupSubject(sessionId), sc.encode(encodeCleanupPayload({ platformKey })));
    return true;
  } catch {
    return false;
  }
}

/**
 * The gate keys a session's runs can be holding a lock under.
 *
 * Both of them, because which one a run took is not this process's decision to
 * know: the gate keys on the workspace now, `RUN_GATE_KEY=session` is still a
 * supported deployment, and a message from an API too old to bind workspaces
 * falls back to the session key -- during a rollout the two coexist. Brain's
 * workspace reaper reads the same union for the same reason.
 *
 * The workspace key comes first because on a default deployment it is the only
 * one that exists. Deleting `lock.<sid>` alone therefore deleted nothing at
 * all, and the lock the interrupted run really holds was left for the registry
 * TTL to clear -- during which everything that reads a lock as "a run is alive
 * here" believes it, including the reaper that would otherwise reclaim the
 * directory of the session just deleted.
 */
export function sessionGateLockKeys(sessionId: string, workspaceId?: string): string[] {
  const keys = workspaceId ? [`lock.ws.${workspaceId}`] : [];
  keys.push(`lock.${sessionId}`);
  return keys;
}

/**
 * Drop the gate locks, so nothing waits behind a session that is gone.
 *
 * The workspace is looked up with released references included, because the
 * question here is where this session's files are rather than what it is still
 * using. Two ways the narrow lookup misses it: an idle sweep can have released
 * the session's reference while a run of its own holds one and a lock to go with
 * it, and every retry of this cleanup arrives after an earlier attempt released
 * the references itself -- so the sweeper, which is the caller that exists for
 * the locks nobody else will drop, is exactly the one the narrow lookup would
 * fail. On the request's own path the references are still live at this point,
 * the release being three steps later.
 *
 * A lookup that fails is reported as a failure rather than as a session that
 * never had a workspace. The two are the same absent row from here, and the
 * difference is whether the key that matters was addressed at all.
 *
 * @returns whether every lock this session could hold was accounted for.
 */
async function deleteGateLocks(sessionId: string): Promise<boolean> {
  const ws = await workspaceForSession(sessionId, { includeReleased: true })
    .catch(() => "unreadable" as const);
  const workspaceId = ws === "unreadable" ? undefined : ws?.workspace_id;
  let complete = ws !== "unreadable";
  for (const key of sessionGateLockKeys(sessionId, workspaceId)) {
    await kv.delete(key).catch(() => { complete = false; });
  }
  return complete;
}

/**
 * The steps of the cleanup that leave this process, in one object.
 *
 * A seam, because the order is the part that was wrong and the part no test
 * could see: the tombstone had its own unit test, passed it, and was still
 * written after the sandbox had been destroyed. Reading the function is not
 * enough to keep that from coming back -- a step added in the wrong place
 * looks exactly like a step added in the right one.
 *
 * The KV, S3 and workspace-bookkeeping calls are here for a second reason.
 * Every one of them reaches something a unit test has no copy of, so without a
 * seam the cleanup cannot be run at all -- and whether it ran to the end is what
 * decides between a session whose deletion is finished and one the sweeper has
 * to come back for.
 */
export const teardownPorts = {
  writeTombstones: (sessionId: string): Promise<TombstoneOutcome> =>
    writeSessionTombstones(kvTombstones, kv, sessionId),
  notifyCleanup,
  purgeSessionEvents: async (sessionId: string): Promise<void> => {
    await jsm.streams.purge(EVENT_STREAM, { filter: `events.${sessionId}` } as never);
  },
  deleteGateLocks,
  deleteWorkspaceObjects: deleteSessionWorkspaceObjects,
  releaseWorkspaceRefs: releaseSessionRefs,
  parkHands: (sessionId: string): Promise<ParkOutcome> =>
    parkHandsForIdleReclaim(kv, sessionId),
};

export interface TeardownInput {
  sessionId: string;
  /**
   * The row's `user_id`, which owns the files -- not the caller's id. Nullable
   * because it is the column: both routes hand it over as they read it, and
   * {@link workspaceOwnerId} resolves a blank or absent one to the segment the
   * writers filed the objects under.
   */
  ownerId: string | null;
  /**
   * The caller's SaFE key, when there is a caller.
   *
   * It rides on the cleanup notification so a Brain replica that has no
   * `hands.<sid>` entry of its own can still authenticate the workload delete.
   * Absent when the sweeper is the caller, which is why Brain reads the key from
   * the parked handle as well -- see readSessionPlatformKey there.
   */
  platformKey?: string;
}

/**
 * Everything the deletion does inside this database, as one transaction.
 *
 * These four writes used to be four statements among nine other steps, each
 * deciding for itself whether its failure blocked the delete. They belong to one
 * store and they answer one question -- is this session gone? -- so a partial
 * result is not a state anybody has a use for. Together they are also the
 * commitment: past the commit the session is gone to every reader, and the work
 * left outside this database is recorded on the row rather than left to whether
 * this request survives.
 *
 * The order inside the transaction does not matter, because nothing observes it.
 * What each write is for does:
 *
 *   - the queued messages have no soft delete and no sweeper of their own, and
 *     each row carries the body of a message with the env and key snapshot it
 *     was queued with;
 *   - the open runs are cancelled because nothing else will close them. Their
 *     `exec_complete` will not arrive -- Brain drops the task on the tombstone
 *     -- and the deadline backstop skips chat rows, so they used to sit at
 *     `preparing` for ever. Cancelled rather than failed: the run did not go
 *     wrong, it was taken away;
 *   - `deleted_at` on the three content tables is the only gate on a deleted
 *     session's conversation, since the context builder filters the history on
 *     `claw_conversation_turns.deleted_at`;
 *   - the session row is what makes it invisible, and carries the work item.
 *
 * `COALESCE` on `deleted_at` rather than a `deleted_at IS NULL` guard, so that a
 * second commit over a session already deleted rebuilds the work item without
 * moving the delete's timestamp -- which is what every retention window is
 * measured from. Both routes filter on `deleted_at IS NULL` and answer 404 before
 * they reach this, so the second commit is not a path anything takes today; the
 * guard is here because the timestamp is not this statement's to move, and a
 * caller that does not look first should not be able to move it.
 *
 * The work item is due one inline budget from now rather than immediately, which
 * is how the caller about to run the cleanup itself and the sweeper stay out of
 * each other's way. Due now, a tick landing in the next few milliseconds would
 * take the same session and run the same seven steps beside the request -- safe,
 * every one of them being idempotent, but it walks the same S3 prefixes twice and
 * lets the loser record an error against a cleanup the winner had finished. By
 * the time this is due the inline attempt has either finished, in which case the
 * row is `done` and no longer selected, or written a schedule of its own.
 *
 * @throws {TeardownRefused} when the transaction did not commit, in which case
 *         the session and every row it has are exactly as they were.
 */
export async function commitSessionDeletion(sessionId: string): Promise<void> {
  try {
    await inTransaction(async (query: Querier) => {
      await query("DELETE FROM claw_pending_messages WHERE session_id = $1", [sessionId]);
      await query(
        `UPDATE claw_tasks
            SET status = 'cancelled',
                failure_reason = 'session_deleted',
                error_message = 'the session this run belonged to was deleted',
                completed_at = NOW()
          WHERE session_id = $1
            AND status IN ('waiting_deps','waiting_external','queued','preparing','running','cancelling')`,
        [sessionId],
      );
      for (const table of CONTENT_TABLES) {
        await query(
          `UPDATE ${table} SET deleted_at = NOW() WHERE session_id = $1 AND deleted_at IS NULL`,
          [sessionId],
        );
      }
      await query(
        `UPDATE claw_sessions
            SET deleted_at = COALESCE(deleted_at, NOW()),
                updated_at = NOW(),
                cleanup_state = 'pending',
                cleanup_attempts = 0,
                cleanup_next_at = NOW() + ($2::int * INTERVAL '1 millisecond'),
                cleanup_error = NULL
          WHERE session_id = $1`,
        [sessionId, INLINE_CLEANUP_BUDGET_MS],
      );
    });
  } catch (err) {
    throw new TeardownRefused(
      `session ${sessionId} was not confirmed deleted: the transaction that hides it `
      + `and drops its rows did not commit (${errorText(err)}). Retry the delete -- `
      + "either nothing has been changed and the retry does the work, or the commit "
      + "landed and the retry says so with a 404.",
    );
  }
}

/** The tables whose rows a deleted session hides behind `deleted_at`. */
const CONTENT_TABLES = [
  "claw_session_summaries",
  "claw_conversation_turns",
  "claw_session_events",
] as const;

/**
 * What a cleanup reports when it ran out of time rather than went wrong.
 *
 * Kept apart from the step labels because the two ask for opposite things from
 * the schedule: a store that refused should be tried again slowly, and a walk
 * that was making progress when the clock stopped should be tried again at once.
 * Which is why it is only reported when there was progress -- see
 * {@link NO_PROGRESS} for the other half, and {@link recordCleanupOutcome} for
 * what the schedule does with each.
 */
export const BUDGET_EXHAUSTED = "budget";

/**
 * What a cleanup reports when the clock ran out before it had reached the files.
 *
 * Told apart from {@link BUDGET_EXHAUSTED} because only one of the two is a
 * cleanup worth coming straight back to. A pass that reached the files and
 * then hit its deadline *having deleted something* is long, and re-running it
 * at once continues it. Reaching the files step is not the same as progress:
 * listing two empty prefixes and stopping before the second one, or listing a
 * page and then running out of time before any DeleteObject, deleted nothing,
 * and treating that as the budget hides it from the stuck report (which
 * requires an attempt) and parks the row at the tail of the due set. That
 * pass is recorded as a failure: it takes the backoff, it counts as an
 * attempt, and counting is what puts it in the stuck report.
 */
export const NO_PROGRESS = "no_progress";

/**
 * How a step ended: finished, out of time with work behind it, or neither.
 *
 * `"budget"` is only for a step that stopped at a boundary of its own having
 * got somewhere, with work left and nothing failed -- the S3 walk is the only
 * one long enough to need it.
 */
type StepOutcome = boolean | typeof BUDGET_EXHAUSTED | typeof NO_PROGRESS;

/** One thing the cleanup has to make true, and what to call it when it does not. */
interface CleanupStep {
  label: string;
  run: () => Promise<StepOutcome>;
  /** The event this step logged under before, where retiring one would retire an alert. */
  event?: string;
  /**
   * Stop the rest of this pass when this step does not finish.
   *
   * The default is to keep going: each later step is independently worth doing
   * and a store that is down should not hold the others. The tombstone is the
   * exception -- it is what later events and tasks are checked against, and
   * destroying the sandbox or the files while that mark is missing is the
   * race the step exists to close. A later pass retries from the top.
   */
  haltOnFailure?: boolean;
}

/**
 * Say that a step did not finish, however it failed to.
 *
 * One line for both, because from here they are the same outcome and the
 * difference is already in the record: a step that returned false has logged
 * whatever it knows at the site that knows it, and one that threw carries the
 * error. Naming them apart would only mean an operator had two events to
 * subscribe to for one condition -- and the step that has an event of its own
 * keeps it on both paths, which is the point of carrying it.
 */
function reportUnfinished(step: CleanupStep, sessionId: string, err?: unknown): void {
  logger.warn({ err, sessionId, step: step.label }, step.event ?? "session.cleanup_step_unfinished");
}

/**
 * The cleanup, in order, as the list of things that have to end up true.
 *
 * A list rather than a sequence of statements because the order is the part
 * that was wrong before and the part no test could see, and because both
 * callers -- the request and the sweeper -- have to run exactly the same one.
 *
 * Each step is idempotent, which is what lets a partial run be repeated rather
 * than reconciled: a tombstone written twice is the same tombstone, a lock
 * deleted twice is the same absence, and a prefix already emptied lists nothing.
 */
function cleanupSteps(input: TeardownInput, deadline?: number): CleanupStep[] {
  const { sessionId, ownerId, platformKey } = input;
  return [
    // First, and the only step whose absence is unsafe rather than untidy: it is
    // what a redelivered task or event is checked against. See
    // writeSessionTombstones. A lost legacy copy is not counted -- it expires in
    // five minutes anyway, and a bucket that has gone for good would otherwise
    // hold this session pending for ever.
    {
      label: "tombstone",
      haltOnFailure: true,
      run: async () => (await teardownPorts.writeTombstones(sessionId)) !== "failed",
    },
    // One message carrying both "stop the running task" and "destroy the
    // resources": two publishes would make "only one arrived" reachable.
    {
      label: "cleanup_notify",
      run: async () => teardownPorts.notifyCleanup(sessionId, platformKey ?? ""),
    },
    // The handle is parked rather than deleted, which is what makes the
    // notification above an optimisation rather than the mechanism: a parked
    // entry carries `sessionDeleted`, and Brain's sweeps act on that with no
    // message needed. It is also the only route left to this session's GPU
    // clusters, since the key that authenticates their delete lives in it.
    {
      label: "hands_park",
      run: async () => (await teardownPorts.parkHands(sessionId)) !== "failed",
    },
    // The gate locks, which the transaction's cancelled runs no longer release
    // themselves. Every reader treats a lock as a live run on those files,
    // including the collector that would otherwise never reclaim the directory.
    { label: "lock_release", run: () => teardownPorts.deleteGateLocks(sessionId) },
    {
      label: "events_purge",
      run: async () => {
        await teardownPorts.purgeSessionEvents(sessionId);
        return true;
      },
    },
    // The files. `complete` is not the same question as `failed`: a walk cut
    // short by the budget deleted everything it reached and left the rest, which
    // is a cleanup to come back to at once rather than one that went wrong -- so
    // it is reported as the budget and not as this step, and the schedule reads
    // it as progress. Reaching the step without deleting anything is not
    // progress: the next pass has the same work it started with, and calling
    // that the budget parks the row behind every other due deletion and keeps
    // it out of the stuck report.
    {
      label: "workspace_objects",
      event: "session.workspace_delete_failed",
      run: async () => {
        const outcome = await teardownPorts.deleteWorkspaceObjects(ownerId, sessionId, deadline);
        if (outcome.failed > 0) return false;
        if (outcome.complete) return true;
        return outcome.deleted > 0 ? BUDGET_EXHAUSTED : NO_PROGRESS;
      },
    },
    // Last, and after the objects it is about: the reference is what tells the
    // collector these files are still in use, and a deleted session never
    // releases anything again on its own. Released with no retention lease at
    // all, because the lease exists for files that might still be wanted -- an
    // accidental delete, a download in progress -- and this is the deliberate
    // delete the S3 copy has already been removed for. The shared-filesystem
    // copy then goes on the collector's next pass, into a trash directory it
    // holds for another day, which is where the second thoughts live now.
    {
      label: "workspace_refs",
      run: async () =>
        (await teardownPorts.releaseWorkspaceRefs(sessionId, { retentionDays: 0 })) !== "failed",
    },
  ];
}

/**
 * Finish a deletion everywhere outside this database.
 *
 * Called twice for the same session in the normal case -- once by the request
 * that committed the deletion, once more only if that attempt left something --
 * and any number of times when a store is down. Nothing here reports a failure
 * upwards: the client has already been told the session is deleted, and the
 * caller's only job is to write down whether the sweeper has to come back.
 *
 * `budgetMs` bounds the attempt. Both callers set one -- the request so it does
 * not hold a client, the sweeper so one dead endpoint cannot spend a whole tick
 * that has run-liveness reapers waiting behind it -- and they differ only in how
 * much. The budget is checked between steps rather than enforced with a cancel,
 * so what it produces is a shorter list of finished steps and never a
 * half-finished one; the step that walks S3 checks it between pages for the same
 * reason.
 *
 * @returns what did not finish: the labels of the steps that failed,
 *          {@link BUDGET_EXHAUSTED} if it ran out of time after reaching the
 *          files, {@link NO_PROGRESS} if it ran out before that. Empty means
 *          done.
 */
export async function runSessionCleanup(
  input: TeardownInput,
  opts: { budgetMs?: number } = {},
): Promise<string[]> {
  const { sessionId } = input;
  const deadline = opts.budgetMs === undefined ? undefined : Date.now() + opts.budgetMs;
  const incomplete: string[] = [];
  let reachedFiles = false;
  for (const step of cleanupSteps(input, deadline)) {
    if (pastDeadline(deadline)) {
      // Running out between steps is only worth retrying at once if the files
      // were reached. The five steps in front of them return true on a healthy
      // cluster without deleting anything, and the sweeper can hand a session
      // at the back of a busy pass a millisecond -- calling that the budget
      // would hide a cleanup that never reaches S3, and would clear the
      // backoff a real failure had just set.
      incomplete.push(reachedFiles ? BUDGET_EXHAUSTED : NO_PROGRESS);
      break;
    }
    let outcome: StepOutcome = false;
    let failure: unknown;
    try {
      outcome = await step.run();
    } catch (err) {
      failure = err;
    }
    if (outcome === true) {
      if (step.label === "workspace_objects") reachedFiles = true;
      continue;
    }
    if (outcome === BUDGET_EXHAUSTED) {
      incomplete.push(BUDGET_EXHAUSTED);
      break;
    }
    if (outcome === NO_PROGRESS) {
      incomplete.push(NO_PROGRESS);
      break;
    }
    reportUnfinished(step, sessionId, failure);
    incomplete.push(step.label);
    if (step.haltOnFailure) break;
  }
  return incomplete;
}

/**
 * Write down what the cleanup managed, so the sweeper knows whether to return.
 *
 * Three answers, and the state itself is only ever written on the first: a row
 * stays `pending` until a run of the whole body finishes, which is what makes the
 * pending set exactly the set of unfinished deletions.
 *
 *   - finished: 'done', with no schedule left;
 *   - out of time with work behind it: due again immediately, and not counted
 *     as an attempt. A walk that stopped on the clock is only this when it had
 *     already deleted something -- reaching the files step, or listing an empty
 *     prefix, is not progress, and those report {@link NO_PROGRESS} so they
 *     take the backoff and show up in the stuck report. Not counting a walk
 *     that was actually in the files also keeps a merely-large session out of
 *     that report, which is right: it is not stuck, it is long.
 *   - something failed: the backoff below, and counted, because how many
 *     attempts a session took is the difference between a cluster that is slow
 *     and one that is stuck.
 *
 * Failing to record is not failing the cleanup. The work is done or it is not,
 * and this only decides when somebody looks again -- a row whose update was lost
 * keeps whatever `cleanup_next_at` it had, so the sweeper picks it up on a tick
 * of the same order. Logged at error on the completing path, though: that is the
 * one where the state is now wrong in the expensive direction, a finished
 * cleanup that will be run again.
 */
export async function recordCleanupOutcome(
  sessionId: string,
  incomplete: string[],
): Promise<void> {
  try {
    if (!incomplete.length) {
      await db.query(
        `UPDATE claw_sessions
            SET cleanup_state = 'done',
                cleanup_attempts = cleanup_attempts + 1,
                cleanup_next_at = NULL,
                cleanup_error = NULL
          WHERE session_id = $1`,
        [sessionId],
      );
      return;
    }
    if (incomplete.every((label) => label === BUDGET_EXHAUSTED)) {
      await db.query(
        `UPDATE claw_sessions
            SET cleanup_next_at = NOW(),
                cleanup_error = $2
          WHERE session_id = $1`,
        [sessionId, BUDGET_EXHAUSTED],
      );
      return;
    }
    // The backoff is computed from the value the row already holds, since every
    // SET here reads the old row: the first retry waits the base interval and
    // each one after it twice as long, up to the ceiling.
    await db.query(
      `UPDATE claw_sessions
          SET cleanup_attempts = cleanup_attempts + 1,
              cleanup_error = $2,
              cleanup_next_at = NOW() + (
                LEAST($3::float8 * POWER(2, LEAST(cleanup_attempts, 16)), $4::float8)
                * INTERVAL '1 second'
              )
        WHERE session_id = $1`,
      [sessionId, incomplete.join(","), CLEANUP_RETRY_BASE_SEC, CLEANUP_RETRY_MAX_SEC],
    );
  } catch (err) {
    logger.error(
      { err: errorText(err), sessionId, incomplete },
      "session.cleanup_state_not_recorded",
    );
  }
}

/**
 * Delete a session: commit the deletion, then finish as much of it as fits.
 *
 * The commit is the whole of the caller's risk. Before it nothing has happened
 * and a failure is theirs to retry; after it the session is deleted whatever
 * becomes of this process, and what the inline attempt buys is that on a healthy
 * cluster the job is finished by the time the response is written -- which keeps
 * the pending set empty, and an empty pending set is what makes "anything
 * pending" worth alerting on.
 *
 * @throws {TeardownRefused} when the transaction did not commit. Nothing has
 *         been changed, and the same request run again is the repair -- which is
 *         a 503 rather than the 500 an unrecognised error becomes.
 * @returns the steps left for the sweeper, empty when the deletion is finished.
 */
export async function teardownSession(input: TeardownInput): Promise<string[]> {
  const { sessionId } = input;
  await commitSessionDeletion(sessionId);
  const incomplete = await runSessionCleanup(input, { budgetMs: INLINE_CLEANUP_BUDGET_MS });
  await recordCleanupOutcome(sessionId, incomplete);
  if (incomplete.length) {
    // Warn rather than error: the deletion is recorded and the sweeper owns it
    // from here. What is worth paging about is a cleanup that stays pending, and
    // that report belongs to the sweeper, which is the only thing that can tell
    // a slow one from a stuck one.
    logger.warn({ sessionId, incomplete }, "session.cleanup_deferred");
  }
  return incomplete;
}

/**
 * Leave a deleted session's `hands.<sid>` handle behind as an idle marker so
 * Brain's multi-node idle sweeper can still reclaim its GPU clusters.
 *
 * Those clusters are reached only through the cleanup.* notification, an
 * unretried core-NATS publish: when no Brain replica is up at that moment it is
 * lost, and an entry deleted here would leave them running until the workload's
 * own timeout. Parked, sweepIdleMultiNodeClusters finds them via the platformKey
 * this entry carries.
 *
 * The shape it leaves behind is shared with Brain's own park, in @claw/utils --
 * the sweep selects on those fields, so the two agreeing is the whole point. Only
 * the reporting differs, and it differs here because this is the one path with no
 * second chance behind it.
 */
export async function parkHandsForIdleReclaim(
  kvStore: KV,
  sessionId: string,
): Promise<ParkOutcome> {
  const { outcome, error } = await parkHandsHandle(kvStore, sessionId);
  switch (outcome) {
    case "parked":
      logger.info({ sessionId }, "session.hands_parked_for_idle_reclaim");
      break;
    case "gone":
    case "superseded":
      // A Brain replica handled the cleanup and rewrote or removed the entry
      // first. That is the good outcome -- it got further than parking would
      // have -- so it is not reported as a failure.
      logger.info({ sessionId }, "session.hands_park_superseded");
      break;
    case "failed":
      // Nothing else picks this up on its own. The clusters are only reachable
      // through the entry this failed to write, so losing it costs the reclaim
      // path and leaves them to the workload's own timeout. Reported rather than
      // raised, like every step: the deletion is already committed, and what a
      // failure here buys is the sweeper coming back to park it.
      logger.warn(
        { err: (error as Error)?.message || String(error), sessionId },
        "session.hands_park_failed",
      );
      break;
  }
  return outcome;
}
