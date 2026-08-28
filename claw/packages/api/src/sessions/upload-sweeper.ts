// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../infra/db.js";
import { getS3Client } from "../infra/s3-client.js";
import { sessionWorkspacePrefix } from "../workspace/prefix.js";
import { LEADER_LOCK_IDS, withLeaderLock } from "../infra/leader-lock.js";
import {
  S3_BUCKET, UPLOAD_TTL_DAYS, UPLOAD_SWEEP_INTERVAL_MIN,
} from "../config.js";
import pino from "pino";

const logger = pino({ name: "upload-sweeper" });

/** Metadata key the upload route stamps at PUT time; see `classifyUpload`. */
const EXPIRES_AT_KEY = "claw-expires-at";

/** What a sweep decided about one listed object. */
export type UploadVerdict = "expired" | "live" | "gone" | "unknown";

/** A verdict, and for `unknown` what stopped one being reached. */
export interface UploadDecision {
  verdict: UploadVerdict;
  /** Set only for `unknown`: how the HEAD failed, for the aggregate report. */
  cause?: string;
}

/**
 * How a failed request is labelled in the aggregate reports.
 *
 * Coarse on purpose. What an operator has to tell apart is a policy missing a
 * permission from an endpoint that has stopped answering, and the error's name
 * with its status says which; the key or prefix and the message would make every
 * object its own entry in the tally and defeat the aggregation. Shared by the
 * per-object HEAD and the per-prefix listing because both fail bucket-wide for
 * bucket-wide reasons, and both are reported once for the pass.
 */
function failureCause(err: unknown): string {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  const status = e?.$metadata?.httpStatusCode;
  return status ? `${e?.name || "Error"}:${status}` : (e?.name || "Error");
}

/** Add one to `label`'s count, so a report can name causes rather than objects. */
function tally(counts: Record<string, number>, label: string): void {
  counts[label] = (counts[label] ?? 0) + 1;
}

/** Whatever a failed call carried, as one line fit for a log field. */
function errorMessage(err: unknown): string {
  return (err as Error | undefined)?.message || String(err);
}

/**
 * Whether a HEAD failure means the object is not there any more.
 *
 * The only failure that answers a question is the one that says the object is
 * absent: a listing is a snapshot, so a key it returned may well have been
 * deleted by the time it is inspected -- by a concurrent session delete, or by
 * an earlier pass of this very sweep. Everything else is the request not
 * arriving at an answer, which is not the same thing and must not be read as
 * one.
 */
export function headSaysObjectGone(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.$metadata?.httpStatusCode === 404
    || e?.name === "NotFound"
    || e?.name === "NoSuchKey";
}

/**
 * Decide one listed upload's fate.
 *
 * The authoritative expiry is the `claw-expires-at` metadata the upload route
 * stamps at PUT time, because that is what honours a per-request TTL override;
 * the listing's `LastModified` against the global cutoff is the fallback for
 * objects written before the route stamped anything. Only HEAD returns
 * metadata, so the decision depends on a second request per object.
 *
 * A HEAD that does not answer therefore leaves the decision unmade, and this
 * used to fall back to `LastModified` and delete on it -- which deletes an
 * object whose real expiry was never read, on the strength of a timeout. The
 * same fallback ran when the metadata was present but unparseable, which is
 * the same "no judgement" case spelled as garbage rather than as a failed
 * request. The asymmetry is the whole point: skipping costs one more listing
 * entry on the next pass, which runs anyway on a fixed interval, while
 * deleting costs the user a file they uploaded and were promised until their
 * own TTL.
 *
 * The failure is returned rather than logged here. One line per object per pass
 * is proportionate to a stray timeout and nothing else: a policy missing
 * HeadObject permission, or an endpoint that has stopped answering, fails on
 * every object in the bucket, and the report that matters -- that this pass
 * enforced no TTL at all -- is one an operator cannot assemble out of thousands
 * of identical warnings. See `uninspectedReport`.
 */
export async function classifyUpload(
  lastModifiedMs: number,
  head: () => Promise<{ Metadata?: Record<string, string> }>,
  bounds: { cutoffMs: number; nowMs: number },
): Promise<UploadDecision> {
  let expired = lastModifiedMs < bounds.cutoffMs;
  try {
    const expiresAtRaw = (await head()).Metadata?.[EXPIRES_AT_KEY];
    if (expiresAtRaw) {
      const expiresAtMs = Date.parse(expiresAtRaw);
      if (!Number.isFinite(expiresAtMs)) {
        return { verdict: "unknown", cause: "unparseable_expiry" };
      }
      expired = expiresAtMs < bounds.nowMs;
    }
  } catch (e: unknown) {
    if (headSaysObjectGone(e)) return { verdict: "gone" };
    return { verdict: "unknown", cause: failureCause(e) };
  }
  return { verdict: expired ? "expired" : "live" };
}

/** One page of a prefix listing, with only the fields a verdict needs. */
interface ListedPage {
  objects: Array<{ key: string; lastModifiedMs: number }>;
  nextToken?: string;
}

/**
 * Seam over the object store.
 *
 * What is worth pinning about a sweep is which verdict sends an object to the
 * delete list and which one leaves it there -- and that was unreachable while
 * every call went straight from the traversal into an `S3Client` built out of
 * module state. Three methods, on a path that runs once an hour.
 *
 * Deletion is per object because MinIO's batch DeleteObjects (POST ?delete)
 * mandates a Content-MD5 header that aws-sdk v3 does not attach, so the batch
 * call fails with "Missing required header for this request: Content-Md5".
 * Single-object DeleteObject has no such requirement; it is the same call
 * plugins.ts uses successfully.
 */
export const uploadStore = {
  async list(prefix: string, continuationToken?: string): Promise<ListedPage> {
    const resp = await getS3Client().send(new ListObjectsV2Command({
      Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: continuationToken,
    }));
    return {
      objects: (resp.Contents || []).flatMap((o) => (
        o.Key && o.LastModified
          ? [{ key: o.Key, lastModifiedMs: o.LastModified.getTime() }]
          : []
      )),
      nextToken: resp.IsTruncated ? resp.NextContinuationToken : undefined,
    };
  },
  async head(key: string): Promise<{ Metadata?: Record<string, string> }> {
    return await getS3Client().send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  },
  async remove(key: string): Promise<void> {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  },
};

/**
 * One listing failure kept whole, since the tally cannot keep any.
 *
 * A cause and a count are what a bucket-wide failure needs, and they are all it
 * needs: the prefix that happened to be first says nothing about a policy that
 * denies every one of them. One prefix out of many failing is the opposite
 * question -- which session, and what did the store actually say -- and neither
 * half of it can even be asked from a tally. Kept to the first of each so a bad
 * pass still costs one line, the way the per-object skips do.
 */
export interface ListFailureSample {
  /** The first prefix a listing failed on. */
  prefix?: string;
  /** cause → the first message seen under it. */
  messages: Record<string, string>;
}

/** What one sweep pass did, and what it could not decide. */
export interface SweepOutcome {
  /** The TTL this pass actually enforced, override included. */
  ttlDays: number;
  scanned: number;
  deleted: number;
  /** Objects left alone because their expiry could not be read. */
  skipped: number;
  /** How those skips failed, as cause → count. */
  skipCauses: Record<string, number>;
  /** Session upload prefixes this pass set out to walk. */
  prefixes: number;
  /**
   * How many of them the listing did not get through. Not the same as nothing
   * under them having been seen: a prefix that failed on its second page had
   * its first page scanned, and the objects past the failure are the ones no
   * verdict was reached about.
   */
  prefixesFailed: number;
  /** How those listings failed, as cause → count. */
  listCauses: Record<string, number>;
  /** The first of them in full; see ListFailureSample. */
  listSample: ListFailureSample;
}

/**
 * One sweep pass: list `.uploads/` for every session and delete the objects
 * whose expiry has passed. Objects the sweep could not inspect are left for the
 * next pass and counted, never deleted on a guess.
 *
 * `nowMs` is taken once for the whole pass so that every object in it is judged
 * against one cutoff, however long the traversal takes.
 */
export async function sweepOnce(
  opts: { ttlDays?: number; nowMs?: number } = {},
): Promise<SweepOutcome> {
  const ttlDays = opts.ttlDays ?? UPLOAD_TTL_DAYS;
  const outcome: SweepOutcome = {
    ttlDays, scanned: 0, deleted: 0, skipped: 0, skipCauses: {},
    prefixes: 0, prefixesFailed: 0, listCauses: {}, listSample: { messages: {} },
  };
  if (ttlDays <= 0) return outcome;

  const nowMs = opts.nowMs ?? Date.now();
  const bounds = { cutoffMs: nowMs - ttlDays * 24 * 3600 * 1000, nowMs };

  // Gather all (userId, sessionId) pairs; soft-deleted sessions are still
  // candidates — we should clean their uploads too since they'll never be
  // accessed again.
  const rows = (await db.query(
    "SELECT session_id, user_id FROM claw_sessions",
  )).rows as Array<{ session_id: string; user_id: string | null }>;

  for (const { session_id, user_id } of rows) {
    // Built by the same function the teardown deletes with. The copy that used
    // to live here is how the two came to disagree about a session whose owner
    // id is blank: written under `default` here, refused as unusable there.
    const prefix = `${sessionWorkspacePrefix(user_id, session_id)}.uploads/`;
    outcome.prefixes++;
    await sweepPrefix(prefix, session_id, bounds, outcome);
  }

  return outcome;
}

/** Decide every object under one session's upload prefix, then delete. */
async function sweepPrefix(
  prefix: string,
  sessionId: string,
  bounds: { cutoffMs: number; nowMs: number },
  outcome: SweepOutcome,
): Promise<void> {
  const doomed: string[] = [];
  try {
    let continuationToken: string | undefined;
    do {
      const page = await uploadStore.list(prefix, continuationToken);
      for (const obj of page.objects) {
        outcome.scanned++;
        const { verdict, cause } = await classifyUpload(
          obj.lastModifiedMs,
          () => uploadStore.head(obj.key),
          bounds,
        );
        if (verdict === "expired") doomed.push(obj.key);
        if (verdict === "unknown") {
          outcome.skipped++;
          tally(outcome.skipCauses, cause ?? "Error");
        }
      }
      continuationToken = page.nextToken;
    } while (continuationToken);
  } catch (e: unknown) {
    // Counted rather than logged here, for the reason a failed HEAD is: a denied
    // ListBucket or an unreachable endpoint fails on every session, so a line per
    // prefix is thousands of identical lines and no statement of the thing that
    // matters -- that this pass could list nothing and therefore enforced no TTL
    // at all. See `unlistableReport`, which keeps the first one whole so that the
    // other case, one session's prefix failing on its own, still names a session.
    //
    // The prefix is abandoned rather than the sweep: whatever was already
    // decided under it has not been deleted yet, and one unreadable prefix must
    // not cost every session after it in the listing.
    outcome.prefixesFailed++;
    const cause = failureCause(e);
    tally(outcome.listCauses, cause);
    outcome.listSample.prefix ??= prefix;
    outcome.listSample.messages[cause] ??= errorMessage(e);
    return;
  }
  await deleteExpired(doomed, sessionId, outcome);
}

/** Delete the objects a pass condemned, bounded so one session cannot flood. */
async function deleteExpired(
  keys: string[],
  sessionId: string,
  outcome: SweepOutcome,
): Promise<void> {
  const CONCURRENCY = 16;
  const pending = [...keys];
  while (pending.length) {
    const batch = pending.splice(0, CONCURRENCY);
    const results = await Promise.allSettled(batch.map((key) => uploadStore.remove(key)));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        outcome.deleted += 1;
      } else {
        logger.warn(
          { err: errorMessage(r.reason), sessionId, key: batch[i] },
          "sweep.delete_failed",
        );
      }
    }
  }
}

/**
 * How loudly a sweep's own failures have to be reported.
 *
 * Decided apart from the logging because the level is the entire value of these
 * signals -- nothing observable changes with it -- and a report that lands beside
 * ordinary churn is a report nobody reads. Exported for the same reason: which
 * sample earns which level is the part that can be got wrong.
 */
export type SweepAlarm = "none" | "warn" | "error";

/**
 * The smallest sample a "none of them worked" verdict may be drawn from.
 *
 * Both reports below are keyed on every attempt having failed, and both of their
 * samples are routinely tiny. Most sessions have an empty `.uploads/`, so an
 * entire pass legitimately scans a handful of objects; the prefix count is the
 * number of rows in the session table, which is one to three on a dev cluster
 * or one that has just been installed. At those sizes a single stray 503
 * satisfies "all of them", and the ordinary snapshot churn a warning is for gets
 * reported as the TTL enforcing nothing.
 *
 * The floor is not free, and what it costs is worth stating plainly: on a
 * cluster whose whole sample is smaller than this -- fewer objects than that in
 * the bucket, or fewer sessions than that in the table -- a failure that really
 * is bucket-wide is reported at warn rather than error. The report is still
 * made; it is the level that is withheld, on exactly the clusters where the two
 * levels are worth least. `unlistableAlarm` takes back the one case where that
 * trade would leave the pass with no error-level report at all.
 */
const MIN_SAMPLE_TO_BLAME_THE_CONFIGURATION = 10;

/**
 * How loudly one sample of failures has to be reported.
 *
 * One function for both reports because they are the same judgement over
 * different samples, and a second copy of it is a second place for the floor to
 * be left out -- which is how the prefix report first came to have none.
 */
function sampleAlarm(failed: number, attempted: number): SweepAlarm {
  if (!failed) return "none";
  const allOfThem = failed === attempted
    && attempted >= MIN_SAMPLE_TO_BLAME_THE_CONFIGURATION;
  return allOfThem ? "error" : "warn";
}

/**
 * Whether the objects a pass could not inspect amount to a withdrawn promise.
 *
 * A skip is the safe answer to an unreadable object and stays that way, but the
 * safe answer repeated over every object is a retention promise quietly
 * withdrawn: `UPLOAD_TTL_DAYS` becomes "never expires", and the only trace used
 * to be a count in an info line that reads like any other successful pass.
 */
export function uninspectedAlarm(outcome: SweepOutcome): SweepAlarm {
  return sampleAlarm(outcome.skipped, outcome.scanned);
}

/**
 * Whether the prefixes a pass could not list amount to the same thing.
 *
 * Every prefix failing is the state `uninspectedAlarm` cannot see and the most
 * likely way of reaching it: nothing was listed, so nothing was scanned and
 * nothing was skipped, and a sweep that enforced no TTL anywhere reports the
 * same counts as a sweep with nothing to do. Some prefixes failing is churn of
 * the same kind a skip is -- a session deleted mid-pass, one slow request.
 *
 * That same state is why the sample floor is overridden here rather than shared
 * whole. The floor's bargain is that the level can be withheld because the other
 * report still lands, but there is no other report to land: with `scanned` at
 * zero `uninspectedAlarm` returns "none", so a cluster with fewer sessions than
 * the floor gets one warn line for a bucket that refused every listing it was
 * asked for. The exception is drawn narrowly -- every prefix failed *and* not one
 * object was seen -- and it is still deliberately louder than the floor would
 * be: one transient 5xx on a single-session cluster reaches error this way. That
 * is the direction to be wrong in, because the alternative is silence about a
 * TTL that is enforcing nothing.
 */
export function unlistableAlarm(outcome: SweepOutcome): SweepAlarm {
  const alarm = sampleAlarm(outcome.prefixesFailed, outcome.prefixes);
  if (alarm !== "warn") return alarm;
  const nothingSeenAtAll = outcome.prefixes > 0
    && outcome.prefixesFailed === outcome.prefixes
    && outcome.scanned === 0;
  return nothingSeenAtAll ? "error" : "warn";
}

/** One line a finished pass has to say about its own failures. */
export interface SweepReport {
  level: Exclude<SweepAlarm, "none">;
  fields: Record<string, unknown>;
  message: string;
}

/**
 * Say when the sweep could not read the expiry it deletes on.
 *
 * Once for the pass, naming the causes rather than the objects, because the
 * report that matters -- how completely this sweep failed, and which way -- is
 * one an operator cannot assemble out of thousands of identical warnings.
 * Nothing is deleted on a guess either way; what the level decides is whether
 * anybody finds out the policy or the endpoint needs fixing.
 */
function uninspectedReport(outcome: SweepOutcome): SweepReport | null {
  const alarm = uninspectedAlarm(outcome);
  if (alarm === "none") return null;
  const fields = {
    ttlDays: outcome.ttlDays,
    scanned: outcome.scanned,
    skipped: outcome.skipped,
    causes: outcome.skipCauses,
  };
  if (alarm === "error") {
    return {
      level: "error",
      fields,
      message: "upload-sweep.nothing_inspected (no object's expiry could be read, so "
        + "UPLOAD_TTL_DAYS is enforcing nothing and uploads do not expire)",
    };
  }
  return { level: "warn", fields, message: "upload-sweep.some_objects_not_inspected" };
}

/** Say when the sweep could not walk the listings it decides from. */
function unlistableReport(outcome: SweepOutcome): SweepReport | null {
  const alarm = unlistableAlarm(outcome);
  if (alarm === "none") return null;
  const fields = {
    ttlDays: outcome.ttlDays,
    prefixes: outcome.prefixes,
    prefixesFailed: outcome.prefixesFailed,
    causes: outcome.listCauses,
  };
  if (alarm === "error") {
    return {
      level: "error",
      fields,
      message: "upload-sweep.no_listing_completed (no session's uploads could be "
        + "listed through, so UPLOAD_TTL_DAYS is enforcing nothing past the point "
        + "each listing stopped and those uploads do not expire)",
    };
  }
  // The sample rides on this level and not the one above it. A bucket-wide
  // failure is answered by fixing the bucket, and naming one of the sessions it
  // hit adds nothing; a single prefix failing is a question about that session
  // -- its bucket policy, the number of objects under it -- and neither which
  // session nor what the store actually said survives the tally.
  return {
    level: "warn",
    fields: {
      ...fields,
      firstFailedPrefix: outcome.listSample.prefix,
      messages: outcome.listSample.messages,
    },
    message: "upload-sweep.some_listings_incomplete",
  };
}

/**
 * Everything one finished pass has to say about its own failures.
 *
 * Returned rather than logged so that the level and the fields -- which are the
 * whole of these signals, since nothing observable changes with them -- can be
 * asserted directly, which a pino call cannot be.
 */
export function sweepReports(outcome: SweepOutcome): SweepReport[] {
  return [unlistableReport(outcome), uninspectedReport(outcome)]
    .filter((report): report is SweepReport => report !== null);
}

/**
 * Where those reports go.
 *
 * A seam over the logger rather than a direct call, because emitting them is one
 * line inside a timer callback: drop it and every alarm above stays correct,
 * stays tested, and reaches nobody.
 */
export const sweepReporter = {
  emit(report: SweepReport): void {
    logger[report.level](report.fields, report.message);
  },
};

/**
 * One tick of the sweeper: take the lock, sweep, and say what happened.
 *
 * Exported so that a pass and its reports can be run without a timer, since the
 * reports are the only trace of a sweep that failed wholesale.
 */
export async function runSweepPass(): Promise<void> {
  const started = Date.now();
  try {
    // One replica per pass. Every replica otherwise walks every session's
    // prefix and HEADs every object in it to reach the same verdict, so the
    // S3 traffic multiplies by the replica count for no additional answer --
    // and the decision is a read-then-delete against objects another replica
    // may already have removed.
    const outcome = await withLeaderLock(
      LEADER_LOCK_IDS.uploadSweep,
      "upload_sweep",
      sweepOnce,
    );
    if (!outcome.ran) return;
    const { ttlDays, scanned, deleted, skipped } = outcome.result;
    logger.info({
      ttlDays, scanned, deleted, skipped, elapsedMs: Date.now() - started,
    }, "upload-sweep.done");
    for (const report of sweepReports(outcome.result)) sweepReporter.emit(report);
  } catch (err) {
    logger.error({ err }, "upload-sweep.failed");
  }
}

/** Start the background upload TTL sweeper. Runs once ~30s after boot to clean
 *  stale uploads from a previous deployment, then on a fixed interval. */
export function startUploadSweeper(): void {
  if (UPLOAD_TTL_DAYS <= 0) {
    logger.info("upload-sweeper.disabled (UPLOAD_TTL_DAYS=0)");
    return;
  }
  const periodMs = Math.max(1, UPLOAD_SWEEP_INTERVAL_MIN) * 60 * 1000;

  setTimeout(() => {
    runSweepPass();
    setInterval(runSweepPass, periodMs);
  }, 30_000);

  logger.info({
    ttlDays: UPLOAD_TTL_DAYS, intervalMin: UPLOAD_SWEEP_INTERVAL_MIN,
  }, "upload-sweeper.started");
}
