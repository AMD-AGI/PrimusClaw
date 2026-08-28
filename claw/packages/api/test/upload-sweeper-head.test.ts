// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the upload sweeper does when it cannot read an object's expiry.
 *
 * The listing gives a `LastModified` and nothing else, so the authoritative
 * answer -- the `claw-expires-at` metadata the upload route stamps at PUT time,
 * which is what honours a per-request TTL override -- takes a second request per
 * object. A HEAD that does not come back therefore leaves the question
 * unanswered, and the sweeper used to answer it anyway: it fell back to
 * `LastModified` against the global cutoff and deleted on that, so a timeout or
 * a transient 5xx against the object store deleted a file whose real expiry was
 * never read, from a user who had been promised a longer one.
 *
 * The asymmetry is what settles it. Skipping costs one more entry in the next
 * listing, and the next sweep runs on a fixed interval whether or not anything
 * was skipped. Deleting costs the user their upload, and nothing anywhere
 * records that the decision was a guess.
 *
 * Skipping for ever is a different promise broken, though, so the second half of
 * this file is about the pass as a whole: which verdict reaches which action,
 * and what a sweep that could not inspect anything says about itself. A policy
 * without HeadObject permission skips every object on every pass, which turns
 * `UPLOAD_TTL_DAYS` into "never expires" while every line in the log still reads
 * like a healthy sweep.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import {
  classifyUpload, headSaysObjectGone, runSweepPass, sweepOnce, sweepReporter, sweepReports,
  uninspectedAlarm, unlistableAlarm, uploadStore, type SweepReport,
} from "../src/sessions/upload-sweeper.js";

const HOUR_MS = 3600 * 1000;
const NOW = Date.UTC(2026, 0, 2, 0, 0, 0);
/** A week's TTL, so "before the cutoff" and "long ago" are the same thing. */
const BOUNDS = { cutoffMs: NOW - 7 * 24 * HOUR_MS, nowMs: NOW };
const TTL_DAYS = 7;

const LONG_AGO = BOUNDS.cutoffMs - HOUR_MS;
const RECENT = NOW - HOUR_MS;

/** A HEAD that answers, with whatever metadata is passed. */
function head(metadata?: Record<string, string>) {
  return async () => ({ Metadata: metadata });
}

/** A HEAD that fails the way the AWS SDK reports `status`. */
function headFails(status: number, name = "InternalError") {
  return async (): Promise<{ Metadata?: Record<string, string> }> => {
    throw Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  };
}

/** The verdict alone, for the cases where the cause is not the point. */
async function verdict(
  lastModifiedMs: number,
  h: () => Promise<{ Metadata?: Record<string, string> }>,
): Promise<string> {
  return (await classifyUpload(lastModifiedMs, h, BOUNDS)).verdict;
}

// ===== the ordinary decisions =====

test("an object past the global cutoff with no metadata is expired", async () => {
  assert.equal(await verdict(LONG_AGO, head()), "expired");
});

test("a recent object is left alone", async () => {
  assert.equal(await verdict(RECENT, head()), "live");
});

test("the stamped expiry beats the global cutoff in both directions", async () => {
  // The reason the HEAD is worth making at all: a per-request TTL override lives
  // only in the metadata, so it can extend an object past the global cutoff as
  // well as end one early.
  assert.equal(
    await verdict(LONG_AGO, head({ "claw-expires-at": new Date(NOW + HOUR_MS).toISOString() })),
    "live",
    "an upload given a longer TTL than the global one must keep it",
  );
  assert.equal(
    await verdict(RECENT, head({ "claw-expires-at": new Date(NOW - HOUR_MS).toISOString() })),
    "expired",
    "and a shorter one must be honoured too",
  );
});

test("unparseable metadata is not a decision, even when LastModified would expire it", async () => {
  // Present-but-garbage used to fall through to LastModified, so a corrupt
  // stamp deleted an object whose real expiry was never read -- worse than
  // a HEAD that failed, which already returns unknown.
  const decision = await classifyUpload(
    LONG_AGO, head({ "claw-expires-at": "yesterday-ish" }), BOUNDS,
  );
  assert.equal(decision.verdict, "unknown");
  assert.equal(decision.cause, "unparseable_expiry");
});

// ===== a HEAD that does not answer is not a decision =====

test("a 404 is the one failure that is an answer", async () => {
  // A listing is a snapshot, so a key it returned may already have been removed
  // by a concurrent session delete or by an earlier pass of this same sweep.
  assert.equal(await verdict(LONG_AGO, headFails(404, "NotFound")), "gone");
});

test("a timed-out HEAD does not delete the object it failed to inspect", async () => {
  // The defect this pins: the fallback ran, `LastModified` was older than the
  // global cutoff, and the object was deleted on the strength of a request that
  // never arrived at the metadata that would have kept it.
  assert.equal(await verdict(LONG_AGO, headFails(0, "TimeoutError")), "unknown");
});

test("neither does a transient server error", async () => {
  for (const status of [500, 502, 503]) {
    assert.equal(
      await verdict(LONG_AGO, headFails(status)),
      "unknown",
      `${status} says nothing about when this object expires`,
    );
  }
});

test("nor does being refused permission to look", async () => {
  // A misconfigured policy would otherwise expire the whole bucket in one pass,
  // since every object's real expiry becomes unreadable at once.
  assert.equal(await verdict(LONG_AGO, headFails(403, "AccessDenied")), "unknown");
});

test("an unreadable object carries why, so an outage can be reported once", async () => {
  // The per-object warning this replaces was one line per object per pass, so a
  // policy missing HeadObject printed a page of identical warnings and no
  // statement of the thing that mattered. The cause is coarse on purpose: it has
  // to group, and a key or a message would make every object its own bucket.
  const decision = await classifyUpload(LONG_AGO, headFails(403, "AccessDenied"), BOUNDS);
  assert.equal(decision.cause, "AccessDenied:403");

  const noStatus = await classifyUpload(LONG_AGO, headFails(0, "TimeoutError"), BOUNDS);
  assert.equal(noStatus.cause, "TimeoutError");
});

test("the absence verdict is recognised however the SDK spells it", async () => {
  // Different S3 implementations report a missing key by status, by `NotFound`
  // on HEAD, or by `NoSuchKey`; reading only one of them would turn the common
  // already-deleted case into a permanent skip.
  assert.equal(headSaysObjectGone({ $metadata: { httpStatusCode: 404 } }), true);
  assert.equal(headSaysObjectGone({ name: "NotFound" }), true);
  assert.equal(headSaysObjectGone({ name: "NoSuchKey" }), true);

  assert.equal(headSaysObjectGone({ name: "TimeoutError" }), false);
  assert.equal(headSaysObjectGone({ $metadata: { httpStatusCode: 503 } }), false);
  assert.equal(headSaysObjectGone(new Error("socket hang up")), false);
  assert.equal(headSaysObjectGone(undefined), false);
});

// ===== what the pass does with the four verdicts =====

const originalQuery = db.query;
const originalStore = { ...uploadStore };
const originalConnect = db.lockPool.connect;
const originalEmit = sweepReporter.emit;
after(() => {
  db.query = originalQuery;
  Object.assign(uploadStore, originalStore);
  db.lockPool.connect = originalConnect;
  sweepReporter.emit = originalEmit;
});

interface Listed {
  key: string;
  lastModifiedMs: number;
  head: () => Promise<{ Metadata?: Record<string, string> }>;
}

/** The sessions a pass walks, which is one prefix each. */
function stubSessions(count: number): void {
  const rows = Array.from({ length: count }, (_, i) => ({
    session_id: `s-${i + 1}`, user_id: "u-1",
  }));
  db.query = (async () => ({ rows, rowCount: rows.length })) as unknown as typeof db.query;
}

/** One session whose upload prefix holds `objects`, with scripted HEADs. */
function stubSweep(objects: Listed[]): { removed: string[] } {
  const removed: string[] = [];
  const heads = new Map(objects.map((o) => [o.key, o.head]));
  stubSessions(1);
  Object.assign(uploadStore, {
    list: async () => ({
      objects: objects.map(({ key, lastModifiedMs }) => ({ key, lastModifiedMs })),
    }),
    head: async (key: string) => await heads.get(key)!(),
    remove: async (key: string) => { removed.push(key); },
  });
  return { removed };
}

test("each verdict reaches exactly one outcome", async () => {
  // The wiring, in one pass: only `expired` is deleted, `live` and `gone` are
  // neither deleted nor counted as a skip -- a key the listing returned and the
  // HEAD says is already absent needs nothing done and is not evidence of
  // anything wrong -- and `unknown` is counted so a pass that decides nothing
  // cannot read as a pass that found nothing to do.
  const { removed } = stubSweep([
    { key: "u/expired", lastModifiedMs: LONG_AGO, head: head() },
    { key: "u/live", lastModifiedMs: RECENT, head: head() },
    { key: "u/gone", lastModifiedMs: LONG_AGO, head: headFails(404, "NotFound") },
    { key: "u/unknown", lastModifiedMs: LONG_AGO, head: headFails(503) },
  ]);

  const outcome = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });

  assert.deepEqual(removed, ["u/expired"]);
  assert.equal(outcome.scanned, 4);
  assert.equal(outcome.deleted, 1);
  assert.equal(outcome.skipped, 1, "the unknown one, and only it");
  assert.deepEqual(outcome.skipCauses, { "InternalError:503": 1 });
});

test("an object whose expiry could not be read never reaches the delete list", async () => {
  // Its `LastModified` is well past the cutoff, which is precisely the number the
  // old fallback deleted on. Nothing here may use it: the object may carry a
  // stamped expiry a year out that the failed HEAD would have returned.
  const { removed } = stubSweep([
    { key: "u/unreadable", lastModifiedMs: LONG_AGO, head: headFails(0, "TimeoutError") },
  ]);

  const outcome = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });

  assert.deepEqual(removed, [], "a timeout is not permission to delete");
  assert.equal(outcome.deleted, 0);
  assert.equal(outcome.skipped, 1);
});

test("a pass that could inspect nothing is distinguishable from a quiet one", async () => {
  // The escape valve's input. A policy without HeadObject fails identically on
  // every object, so the sweep skips the whole bucket on every pass and
  // UPLOAD_TTL_DAYS quietly becomes "never expires" -- a retention promise
  // withdrawn, with a count in an info line as its only trace.
  const denied = () => headFails(403, "AccessDenied");
  const { removed } = stubSweep([
    { key: "u/a", lastModifiedMs: LONG_AGO, head: denied() },
    { key: "u/b", lastModifiedMs: LONG_AGO, head: denied() },
    { key: "u/c", lastModifiedMs: RECENT, head: denied() },
  ]);

  const outcome = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });

  assert.deepEqual(removed, []);
  assert.equal(outcome.skipped, outcome.scanned,
    "nothing was inspected, which is what the loud report is keyed on");
  assert.deepEqual(outcome.skipCauses, { "AccessDenied:403": 3 },
    "one entry naming the cause, not one entry per object");
});

test("a disabled sweeper does no work at all", async () => {
  const { removed } = stubSweep([
    { key: "u/expired", lastModifiedMs: LONG_AGO, head: head() },
  ]);

  const outcome = await sweepOnce({ ttlDays: 0, nowMs: NOW });

  assert.deepEqual(removed, []);
  assert.equal(outcome.scanned, 0);
});

test("the pass reports the TTL it actually enforced", async () => {
  // `sweepOnce` takes an override and decides every expiry against it, so a
  // report quoting the module default describes a cutoff the pass did not use.
  stubSweep([{ key: "u/expired", lastModifiedMs: LONG_AGO, head: head() }]);

  const outcome = await sweepOnce({ ttlDays: 3, nowMs: NOW });

  assert.equal(outcome.ttlDays, 3);
});

// ===== how loudly a pass complains about itself =====

test("a single unreadable object in a small sweep is churn, not a broken TTL", async () => {
  // Most sessions have an empty `.uploads/`, so a whole pass legitimately scans a
  // handful of objects and one stray 503 among them satisfies skipped === scanned.
  // Without a floor that arithmetic reported the TTL as enforcing nothing, which
  // is the docstring's own definition of the ordinary snapshot churn a warning is
  // for.
  stubSweep([{ key: "u/only", lastModifiedMs: LONG_AGO, head: headFails(503) }]);

  const outcome = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });

  assert.equal(outcome.skipped, outcome.scanned, "the ratio alone still says everything failed");
  assert.equal(uninspectedAlarm(outcome), "warn");
});

test("a bucket-wide failure over a real sample is still the loud case", async () => {
  // The floor must not cost the signal it guards: a policy without HeadObject
  // fails on every object it meets, so any cluster with uploads in it clears it.
  const denied = () => headFails(403, "AccessDenied");
  stubSweep(Array.from({ length: 12 }, (_, i) => ({
    key: `u/${i}`, lastModifiedMs: LONG_AGO, head: denied(),
  })));

  const outcome = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });

  assert.equal(uninspectedAlarm(outcome), "error");
});

/**
 * Prefix listings that fail for the first `failures` prefixes, as a denied one
 * does.
 *
 * `pagedFirst` hands out one page before failing, which is the other shape a
 * failed listing takes: a prefix that broke on its second page had its first one
 * scanned, so the pass holds a verdict about some objects as well as a listing it
 * could not finish.
 */
function stubUnlistable(sessions: number, failures: number, pagedFirst = false): void {
  stubSessions(sessions);
  let seen = 0;
  Object.assign(uploadStore, {
    list: async (prefix: string, token?: string) => {
      if (pagedFirst && !token) {
        return { objects: [{ key: `${prefix}page-1`, lastModifiedMs: RECENT }], nextToken: "p2" };
      }
      if (seen++ < failures) {
        throw Object.assign(new Error("s3 api: Access Denied for ListBucket"), {
          name: "AccessDenied", $metadata: { httpStatusCode: 403 },
        });
      }
      return { objects: [] };
    },
    head: async () => ({}),
    remove: async () => {},
  });
}

test("a sweep that could list nothing is not a sweep with nothing to do", async () => {
  // The likeliest way to enforce no TTL at all, and the one the skip report
  // cannot see: a denied ListBucket or an unreachable endpoint fails on every
  // prefix, so nothing is scanned and nothing is skipped, and the counts are
  // those of an idle cluster.
  stubUnlistable(12, 12);

  const outcome = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });

  assert.equal(outcome.prefixes, 12);
  assert.equal(outcome.prefixesFailed, 12);
  assert.equal(outcome.scanned, 0);
  assert.deepEqual(outcome.listCauses, { "AccessDenied:403": 12 },
    "one entry naming the cause, not one warning per session");
  assert.equal(unlistableAlarm(outcome), "error");
  assert.equal(uninspectedAlarm(outcome), "none",
    "which is why this report exists rather than being folded into that one");
});

test("a small cluster that still saw objects is churn, not a broken TTL", async () => {
  // The prefix count is the number of rows in the session table, so on a dev or
  // freshly installed cluster the whole sample is one to three -- and one
  // transient 5xx then satisfies "every prefix failed". The floor the object
  // report already had belongs here for the same reason and by the same
  // arithmetic; without it, this pass claimed no session's uploads could be
  // listed at all.
  stubUnlistable(3, 3, true);

  const outcome = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });

  assert.equal(outcome.prefixesFailed, outcome.prefixes,
    "the ratio alone still says everything failed");
  assert.ok(outcome.scanned > 0, "and the pass reached objects before it broke");
  assert.equal(unlistableAlarm(outcome), "warn");
});

test("a small cluster that saw nothing at all is the loud case anyway", async () => {
  // Where the floor has to give way. Under it the level is withheld because the
  // other report still lands, but nothing was scanned, so `uninspectedAlarm` has
  // no sample to speak from and the pass would carry one warn line about a bucket
  // that refused every listing asked of it.
  stubUnlistable(3, 3);

  const outcome = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });

  assert.equal(outcome.scanned, 0);
  assert.equal(uninspectedAlarm(outcome), "none", "there is no second report to defer to");
  assert.equal(unlistableAlarm(outcome), "error");
});

test("one prefix out of many failing is churn again", async () => {
  // A session deleted mid-pass, or one slow request. The sweep goes on to the
  // next prefix, and the next pass runs on its interval anyway.
  stubUnlistable(3, 1);

  const outcome = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });

  assert.equal(outcome.prefixesFailed, 1);
  assert.equal(unlistableAlarm(outcome), "warn");
});

// ===== what a finished pass says about itself =====

/** The one report of that level, or a failure naming what was there instead. */
function reportAt(reports: SweepReport[], level: "warn" | "error"): SweepReport {
  const found = reports.filter((r) => r.level === level);
  assert.equal(found.length, 1, `expected one ${level}, got ${JSON.stringify(reports)}`);
  return found[0];
}

test("both whole-pass failures say so at a level somebody sees", async () => {
  // The level is the whole value of these signals and nothing observable depends
  // on it. A warning would sit beside the ordinary churn above; these two say
  // the TTL is not being applied to anything.
  stubUnlistable(12, 12);
  const unlistable = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });
  assert.match(reportAt(sweepReports(unlistable), "error").message, /no_listing_completed/);

  const denied = () => headFails(403, "AccessDenied");
  stubSweep(Array.from({ length: 12 }, (_, i) => ({
    key: `u/${i}`, lastModifiedMs: LONG_AGO, head: denied(),
  })));
  const uninspected = await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW });
  assert.match(reportAt(sweepReports(uninspected), "error").message, /nothing_inspected/);
});

test("each report quotes the TTL the pass ran with, not the module's", async () => {
  // Both of them, and independently: with one report quoting `outcome.ttlDays`
  // the other could go back to the module constant unnoticed, and it describes a
  // cutoff the pass did not use -- the pass takes an override and decides every
  // expiry against it.
  stubUnlistable(3, 1);
  const listing = await sweepOnce({ ttlDays: 3, nowMs: NOW });
  assert.equal(reportAt(sweepReports(listing), "warn").fields.ttlDays, 3);

  stubSweep([{ key: "u/only", lastModifiedMs: LONG_AGO, head: headFails(503) }]);
  const inspection = await sweepOnce({ ttlDays: 5, nowMs: NOW });
  assert.equal(reportAt(sweepReports(inspection), "warn").fields.ttlDays, 5);
});

test("a partial listing failure names the session it happened to", async () => {
  // The half of the old per-prefix warning worth keeping. When every prefix
  // fails, the cause is the whole answer and the prefixes are interchangeable;
  // when one does, the question is which session -- its bucket policy, the
  // number of objects under it -- and neither the session nor what the store
  // actually said survives a tally of causes.
  stubUnlistable(3, 1);

  const report = reportAt(sweepReports(await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW })), "warn");

  assert.equal(report.fields.firstFailedPrefix, "users/u-1/sessions/s-1/.uploads/");
  assert.deepEqual(report.fields.messages,
    { "AccessDenied:403": "s3 api: Access Denied for ListBucket" },
    "the cause groups, the message explains, and one of each is enough for a pass");
});

test("a pass with nothing wrong says nothing", async () => {
  stubSweep([{ key: "u/expired", lastModifiedMs: LONG_AGO, head: head() }]);

  assert.deepEqual(sweepReports(await sweepOnce({ ttlDays: TTL_DAYS, nowMs: NOW })), []);
});

test("the tick that runs a pass is the tick that reports it", async () => {
  // Deleting the emit at the end of the tick leaves every alarm above correct,
  // every report above built, and an operator with nothing but the info line
  // that reads like a healthy sweep.
  stubUnlistable(12, 12);
  db.lockPool.connect = (async () => ({
    query: async (sql: string) => ({
      rows: [sql.includes("pg_try_advisory_lock") ? { ok: true } : { released: true }],
    }),
    release: () => {},
  })) as unknown as typeof db.lockPool.connect;
  const emitted: SweepReport[] = [];
  sweepReporter.emit = (report) => { emitted.push(report); };

  await runSweepPass();

  assert.match(reportAt(emitted, "error").message, /no_listing_completed/);
});

test("a replica that is not the leader sweeps nothing and reports nothing", async () => {
  // The control for the case above, which would pass just as well if every tick
  // reported regardless of whether a pass had run.
  stubUnlistable(12, 12);
  db.lockPool.connect = (async () => ({
    query: async () => ({ rows: [{ ok: false }] }),
    release: () => {},
  })) as unknown as typeof db.lockPool.connect;
  const emitted: SweepReport[] = [];
  sweepReporter.emit = (report) => { emitted.push(report); };

  await runSweepPass();

  assert.deepEqual(emitted, []);
});
