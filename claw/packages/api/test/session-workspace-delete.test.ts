// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Deleting a session used to leave every one of its files in S3.
 *
 * The delete route ran nine cleanup steps and none of them touched object
 * storage; there was no DeleteObject anywhere in the API. The lifecycle rules
 * do not reach workspace objects either -- they match `imports/staging/` by
 * prefix and two tags the workspace uploader never sets -- so "delete my
 * session" left the files there indefinitely. That is invariant I9, and it is
 * a compliance question rather than a tidiness one.
 *
 * What is pinned here is the prefix, because the prefix is the entire safety
 * argument for a bulk delete: it has to match what Brain writes, exactly, and
 * it has to be impossible to widen.
 *
 * The rest of what a delete has to let go of is here too -- the gate lock and
 * the workspace reference -- because they fail the same way the objects do:
 * quietly, against a session that is already gone to every reader, with the
 * recorded cleanup state as the only trace.
 *
 * The deletion's two halves are pinned in session-deletion.test.ts; what is
 * here is what the object half has to get right.
 */
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";

import {
  deleteSessionWorkspaceObjects, sessionCheckpointPrefix, sessionGateLockKeys,
  isUsableId, teardownPorts, teardownSession,
} from "../src/sessions/teardown.js";
import { sessionWorkspacePrefix } from "../src/workspace/prefix.js";
import { stubDb, type Answer, type DbStub } from "./support/db-stub.js";

const originalPorts = { ...teardownPorts };
let dbStub: DbStub | null = null;

afterEach(() => {
  Object.assign(teardownPorts, originalPorts);
  dbStub?.restore();
  dbStub = null;
});

/** Every collaborator that leaves this process, succeeding, so a test can fail one. */
function harness(answer?: Answer): void {
  dbStub = stubDb(answer);
  teardownPorts.writeTombstones = async () => "written";
  teardownPorts.notifyCleanup = () => true;
  teardownPorts.parkHands = async () => "parked";
  teardownPorts.purgeSessionEvents = async () => {};
  teardownPorts.deleteGateLocks = async () => true;
  teardownPorts.deleteWorkspaceObjects = async () => ({ deleted: 2, failed: 0, complete: true });
  teardownPorts.releaseWorkspaceRefs = async () => "released";
}

/**
 * A database that answers the workspace lookup and refuses the release.
 *
 * Used with the real release wired back in, on purpose: a port replaced by a
 * stub that throws proves the cleanup reports a throw, and the defect was that
 * nothing on this path ever throws -- the lookup catches, and `releaseRef` logs
 * a warn and returns. What has to be pinned is the outcome the real code
 * produces.
 */
const refusingTheRefRelease: Answer = (sql) => {
  if (/claw_workspace_refs SET released_at/.test(sql)) {
    throw new Error("terminating connection due to administrator command");
  }
  if (/^SELECT w\.workspace_id/.test(sql)) return [{ workspace_id: "kws_1" }];
};

test("the prefix matches the one Brain uploads to", () => {
  // Brain builds `users/${userId}/sessions/${sessionId}/` in workspace/s3-uploader.ts.
  // If these two ever disagree the delete addresses an empty prefix, reports
  // success, and leaves every object in place.
  assert.equal(
    sessionWorkspacePrefix("user-42", "sess-abc"),
    "users/user-42/sessions/sess-abc/",
  );
});

test("an absent owner id lands where the writers put it", () => {
  // Brain's callers pass `request.user_id || "default"`, and so do the upload
  // sweeper and the session file routes. Agreeing about this one case is the
  // difference between deleting a session's objects and refusing to name them.
  assert.equal(sessionWorkspacePrefix("", "sess-abc"), "users/default/sessions/sess-abc/");
  // `user_id` is nullable, so a row hands the column over absent as often as
  // blank. Both have to name the same prefix, or a delete addresses one of them
  // and every writer filled the other.
  assert.equal(sessionWorkspacePrefix(null, "sess-abc"), "users/default/sessions/sess-abc/");
});

test("one session's prefix cannot select another's objects", () => {
  // The trailing separator is what stops `sessions/s1` from also matching
  // `sessions/s10`. Deleting by prefix without it takes the neighbours too.
  const prefix = sessionWorkspacePrefix("u", "s1");
  assert.ok(prefix.endsWith("/"));
  assert.equal(sessionWorkspacePrefix("u", "s10").startsWith(prefix), false);
});

test("an id that could widen the prefix is refused", () => {
  // A slash is the dangerous character: an owner id of ".." or a session id
  // carrying a path segment turns a scoped delete into a broader one, and
  // nothing downstream would notice -- ListObjectsV2 would simply return more.
  assert.equal(isUsableId("../.."), false);
  assert.equal(isUsableId("users/other"), false);
  assert.equal(isUsableId(""), false);
  assert.equal(isUsableId(undefined), false);
  assert.equal(isUsableId(null), false);
  assert.equal(isUsableId("dev-user"), true);
  assert.equal(isUsableId("byok-0123456789abcdef"), true);
});

test("the gate lock a delete drops is the one the run actually holds", () => {
  // The gate was rekeyed onto the workspace, and the teardown went on deleting
  // `lock.<sid>` -- a key that no longer exists on a default deployment, so the
  // step deleted nothing while the lock left behind kept every reader of it
  // believing a run was still alive on those files.
  assert.deepEqual(sessionGateLockKeys("s-1", "kws_1"), ["lock.ws.kws_1", "lock.s-1"]);
  // The session key stays in the union rather than replacing it: RUN_GATE_KEY
  // can be set back to `session`, and a message from an API too old to bind
  // workspaces falls back to it, so during a rollout both are in use.
  assert.deepEqual(sessionGateLockKeys("s-1", undefined), ["lock.s-1"],
    "a session that never had a workspace can only have taken the old key");
});

test("a workspace reference that could not be released is reported", async () => {
  // The one step of the cleanup no later pass reaches on its own: a deleted
  // session is never dispatched to again, so it never releases anything again,
  // and a live reference outranks every signal the collector has. Swallowed,
  // the row would be recorded as cleaned up while the files it was about waited
  // on the idle sweep nobody knew to expect.
  harness(refusingTheRefRelease);
  teardownPorts.releaseWorkspaceRefs = originalPorts.releaseWorkspaceRefs;

  const incomplete = await teardownSession({ sessionId: "s-1", ownerId: "u-1", platformKey: "k" });

  assert.deepEqual(incomplete, ["workspace_refs"]);
  // The backoff write specifically: the commit writes a schedule of its own, so
  // a looser pattern would match a deletion whose outcome was never recorded.
  assert.ok(dbStub?.ran(/cleanup_next_at = NOW\(\) \+ \(\s*LEAST/),
    "the sweeper coming back is the only thing that finishes this");
});

test("a session that held no reference is not reported as a failure", async () => {
  // The lookup missing and the release failing are the same silence from here,
  // and reporting them alike would make every session that predates workspaces
  // an unfinished cleanup -- which is how a pending set stops being alertable.
  harness();
  teardownPorts.releaseWorkspaceRefs = originalPorts.releaseWorkspaceRefs;

  assert.deepEqual(
    await teardownSession({ sessionId: "s-1", ownerId: "u-1", platformKey: "k" }),
    [],
  );
});

test("a release that lands is not reported either", async () => {
  harness((sql) => (/^SELECT w\.workspace_id/.test(sql) ? [{ workspace_id: "kws_1" }] : []));
  teardownPorts.releaseWorkspaceRefs = originalPorts.releaseWorkspaceRefs;

  assert.deepEqual(
    await teardownSession({ sessionId: "s-1", ownerId: "u-1", platformKey: "k" }),
    [],
  );
});

test("the files are released with no retention lease of their own", async () => {
  // The lease is for files that might still be wanted -- an accidental delete,
  // a download in progress -- and this is the deliberate delete whose S3 copy
  // the step before this one has already removed. A week's lease here would
  // leave the two copies of the same workspace disagreeing by a week.
  harness();
  const asked: unknown[] = [];
  teardownPorts.releaseWorkspaceRefs = async (_sid, opts) => {
    asked.push(opts?.retentionDays);
    return "released";
  };

  await teardownSession({ sessionId: "s-1", ownerId: "u-1", platformKey: "k" });

  assert.deepEqual(asked, [0]);
});

test("the gate locks are dropped after the run rows are closed", async () => {
  // The delete is not holder-checked and cannot be -- the API never holds these
  // locks -- and a run still unwinding fails its next CAS renewal against the
  // revision this bump leaves. What the position buys is that a worker coming
  // back for one of these runs reads a row that is already terminal, and it is
  // now structural: the rows are closed by the transaction, and the locks are
  // dropped by the cleanup that only runs once it has committed.
  const order: string[] = [];
  harness((sql) => { if (/status = 'cancelled'/.test(sql)) order.push("close_runs"); });
  teardownPorts.deleteGateLocks = async () => { order.push("locks"); return true; };

  await teardownSession({ sessionId: "s-1", ownerId: "u-1", platformKey: "k" });

  assert.deepEqual(order, ["close_runs", "locks"]);
});

test("refusing an id is a failure, not an empty workspace", async () => {
  // The refusal and a session that genuinely has no files are the same two
  // numbers, so reporting counts here reads as success: the caller records
  // nothing incomplete and hides the session, and every object of a deleted
  // session stays in the bucket with only a warn line to say so.
  await assert.rejects(
    () => deleteSessionWorkspaceObjects("users/other", "sess-abc"),
    /unusable id/,
  );
  await assert.rejects(() => deleteSessionWorkspaceObjects("u", ""), /unusable id/);
});

/**
 * Intercept the SDK rather than the module's private client, so the prefix under
 * test is the one that reaches S3.
 */
const originalSend = S3Client.prototype.send;
after(() => { S3Client.prototype.send = originalSend; });

/**
 * Answer one ListObjectsV2 request the way S3 does: everything under the
 * prefix without a delimiter, or the direct children -- objects and the
 * common prefixes that stand for the directories below -- with one. Paginated
 * by `MaxKeys` over the merged, sorted entries, with the last entry returned
 * as the continuation token.
 */
function listLevel(
  objects: string[],
  input: { Prefix?: string; Delimiter?: string; MaxKeys?: number; ContinuationToken?: string },
): {
  Contents: Array<{ Key: string }>;
  CommonPrefixes: Array<{ Prefix: string }>;
  IsTruncated: boolean;
  NextContinuationToken?: string;
} {
  const { Prefix = "", Delimiter, MaxKeys = 1000, ContinuationToken } = input;
  const entries = new Map<string, "key" | "prefix">();
  for (const key of objects) {
    if (!key.startsWith(Prefix)) continue;
    const cut = Delimiter ? key.indexOf(Delimiter, Prefix.length) : -1;
    if (cut >= 0) entries.set(key.slice(0, cut + Delimiter!.length), "prefix");
    else entries.set(key, "key");
  }
  const sorted = [...entries.keys()].sort()
    .filter((e) => ContinuationToken === undefined || e > ContinuationToken);
  const page = sorted.slice(0, MaxKeys);
  const truncated = sorted.length > page.length;
  return {
    Contents: page.filter((e) => entries.get(e) === "key").map((Key) => ({ Key })),
    CommonPrefixes: page.filter((e) => entries.get(e) === "prefix").map((P) => ({ Prefix: P })),
    IsTruncated: truncated,
    NextContinuationToken: truncated ? page[page.length - 1] : undefined,
  };
}

function stubS3(
  objects: string[],
  onList?: () => Promise<void>,
  onDelete?: () => Promise<void>,
): {
  listed: string[];
  deleted: string[];
  clients: S3Client[];
} {
  const listed: string[] = [];
  const deleted: string[] = [];
  const clients: S3Client[] = [];
  S3Client.prototype.send = (async function (this: S3Client, command: unknown) {
    clients.push(this);
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      listed.push(prefix);
      await onList?.();
      return listLevel(objects.filter((k) => !deleted.includes(k)), command.input);
    }
    if (command instanceof DeleteObjectCommand) {
      await onDelete?.();
      deleted.push(command.input.Key ?? "");
      return {};
    }
    throw new Error("unexpected S3 command");
  }) as typeof S3Client.prototype.send;
  return { listed, deleted, clients };
}

/** The timeouts a client was built with. A client built without them has none. */
async function handlerTimeouts(client: S3Client): Promise<{
  connectionTimeout?: number;
  requestTimeout?: number;
  throwOnRequestTimeout?: boolean;
}> {
  const handler = client.config.requestHandler as unknown as {
    configProvider: Promise<{
      connectionTimeout?: number;
      requestTimeout?: number;
      throwOnRequestTimeout?: boolean;
    }>;
  };
  return await handler.configProvider;
}

test("a session with no owner id is deleted where its files were written", async () => {
  // Every writer resolves a blank `user_id` to `default` -- the upload sweeper,
  // the session file routes, and Brain's uploader through what its callers pass.
  // This one interpolated the blank straight in and then refused it as unusable,
  // so the delete reported `workspace_objects` incomplete, hid the session
  // anyway, and left every object of it in the bucket: the compliance hole this
  // module exists to close, reached through the one owner id nobody tests with.
  const s3 = stubS3(["users/default/sessions/sess-abc/workspace/main.py"]);

  const { deleted, failed } = await deleteSessionWorkspaceObjects("", "sess-abc");

  const roots = ["users/default/sessions/sess-abc/", "checkpoints/default/sess-abc/"];
  assert.deepEqual(
    s3.listed.filter((p) => roots.includes(p)),
    roots,
    "the fallback has to reach both prefixes a session's objects are written under",
  );
  assert.ok(s3.listed.every((p) => roots.some((r) => p.startsWith(r))),
    "nothing outside the session's two prefixes is listed");
  assert.deepEqual(s3.deleted, ["users/default/sessions/sess-abc/workspace/main.py"]);
  assert.equal(deleted, 1);
  assert.equal(failed, 0);
});

test("a long run's checkpoint copy goes with the session", async () => {
  // The in-flight checkpoint is a whole copy of /workspace, written every half
  // hour by any run past thirty minutes, and it is filed outside the session
  // prefix so that the restore and the archive cannot rehydrate it. That is also
  // why the delete used to walk straight past it: a deleted session left one
  // complete copy of its workspace per long run in the bucket, indefinitely,
  // which is the hole this module says it closes.
  const s3 = stubS3([
    "users/u-1/sessions/sess-abc/workspace/main.py",
    "checkpoints/u-1/sess-abc/msg-1/inflight/main.py",
    "checkpoints/u-1/sess-abc/msg-2/inflight/main.py",
    // A neighbour that must not be caught by either prefix.
    "checkpoints/u-1/sess-abcdef/msg-1/inflight/main.py",
  ]);

  const { deleted, failed } = await deleteSessionWorkspaceObjects("u-1", "sess-abc");

  assert.deepEqual(s3.deleted, [
    "users/u-1/sessions/sess-abc/workspace/main.py",
    "checkpoints/u-1/sess-abc/msg-1/inflight/main.py",
    "checkpoints/u-1/sess-abc/msg-2/inflight/main.py",
  ]);
  assert.equal(deleted, 3);
  assert.equal(failed, 0);
});

test("a walk that runs out of budget says so instead of reporting an empty prefix", async () => {
  // Nothing deleted and nothing failed is also what a session with no files
  // looks like, so a walk that stopped early has to be distinguishable from one
  // that finished: on the wrong answer the caller records the cleanup as done
  // and every object left behind stays in the bucket for good.
  const s3 = stubS3(["users/u-1/sessions/sess-abc/workspace/main.py"]);

  const outcome = await deleteSessionWorkspaceObjects("u-1", "sess-abc", Date.now() - 1);

  assert.equal(outcome.complete, false);
  assert.deepEqual(s3.listed, [], "a walk past its deadline does not start one more listing");
});

test("the budget is honoured inside a page, not only between prefixes", async (t) => {
  // A thousand-key page deleted unconditionally is how an inline request spends
  // minutes after its budget, overlapping the sweeper that thought it owned the
  // rest. Stopping at a delete-batch boundary is still resumable: the next
  // attempt lists from the start and the keys already gone are not returned.
  //
  // The deadline is an epoch time, so the clock here is the test's own. A real
  // few-millisecond budget is spent by a runner that deschedules this process
  // between computing the deadline and starting the first batch, and the walk
  // then stops at its first check having deleted nothing: the property pinned
  // is "a batch that started finishes, the next one does not", which no amount
  // of waiting can establish and no amount of starvation can break.
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  const keys = Array.from({ length: 40 }, (_, i) => `users/u-1/sessions/sess-abc/f${i}`);
  // Deleting is what spends the budget: the first delete of the first batch
  // moves the clock past the deadline, and every other delete of that batch is
  // already in flight.
  const s3 = stubS3(keys, undefined, async () => { now += 10; });

  const outcome = await deleteSessionWorkspaceObjects("u-1", "sess-abc", now + 5);

  assert.equal(outcome.deleted, 16, "one batch starts before the clock is checked again");
  assert.equal(outcome.complete, false);
  assert.equal(s3.deleted.length, 16);
});

test("the checkpoint prefix matches the one Brain writes", () => {
  // Brain builds `checkpoints/${userId}/${sessionId}/${messageId}/inflight/` in
  // tasks/runner.ts, from `request.user_id || "default"`. One level up covers
  // every run of the session; disagreeing about the segments above it makes this
  // delete address nothing and report success.
  assert.equal(sessionCheckpointPrefix("user-42", "sess-abc"), "checkpoints/user-42/sess-abc/");
  assert.equal(sessionCheckpointPrefix("", "sess-abc"), "checkpoints/default/sess-abc/");
  const prefix = sessionCheckpointPrefix("u", "s1");
  assert.equal(sessionCheckpointPrefix("u", "s10").startsWith(prefix), false);
});

test("the delete cannot wait on the object store for ever", async () => {
  // This runs inside a request handler and now walks two prefixes, and its client
  // was built without any of the three bounds the upload sweeper's has. An
  // endpoint that accepts the connection and then stops answering leaves the
  // request pending for the life of the process, with the session already
  // tombstoned and its sandbox destroyed.
  const s3 = stubS3(["users/u-1/sessions/sess-abc/workspace/main.py"]);

  await deleteSessionWorkspaceObjects("u-1", "sess-abc");

  const timeouts = await handlerTimeouts(s3.clients[0]);
  assert.equal(timeouts.connectionTimeout, 5_000);
  assert.equal(timeouts.requestTimeout, 30_000);
  assert.equal(timeouts.throwOnRequestTimeout, true,
    "requestTimeout on its own only warns, and the call goes on hanging");
});

test("resolving the blank owner does not resolve a dangerous one", async () => {
  // The fallback is for an id that is merely absent. An id shaped like a path is
  // still the one thing the prefix cannot survive, and is refused before any
  // request goes out.
  const s3 = stubS3(["users/default/sessions/sess-abc/workspace/main.py"]);

  await assert.rejects(
    () => deleteSessionWorkspaceObjects("users/other", "sess-abc"),
    /unusable id/,
  );
  assert.deepEqual(s3.listed, [], "a refusal that listed anything has already widened the delete");
});

/** The error the SDK raises when a request outlasts its `requestTimeout`. */
function requestTimedOut(requestTimeoutMs: number): Error {
  const err = new Error(`a request has exceeded the configured ${requestTimeoutMs} ms requestTimeout.`);
  err.name = "TimeoutError";
  return err;
}

/**
 * A store whose listing takes longer the more keys a page holds, as MinIO's
 * does: it answers a listing by reading each object's metadata off its drives.
 * A page that would outlast the client's own request timeout fails the way the
 * SDK fails it, with nothing listed -- which is what the configured timeout does
 * to such a request on a real endpoint.
 */
function stubSlowListingS3(
  objects: string[],
  msPerKey: number,
  requestTimeoutMs: number,
): { pages: Array<number | undefined>; deleted: string[] } {
  const remaining = new Set(objects);
  const pages: Array<number | undefined> = [];
  const deleted: string[] = [];
  S3Client.prototype.send = (async function (this: S3Client, command: unknown) {
    if (command instanceof ListObjectsV2Command) {
      const { MaxKeys } = command.input;
      pages.push(MaxKeys);
      // The API's own default when a request names no page size.
      const asked = MaxKeys ?? 1000;
      if (asked * msPerKey >= requestTimeoutMs) throw requestTimedOut(requestTimeoutMs);
      return listLevel([...remaining], { ...command.input, MaxKeys: asked });
    }
    if (command instanceof DeleteObjectCommand) {
      const key = command.input.Key ?? "";
      remaining.delete(key);
      deleted.push(key);
      return {};
    }
    throw new Error("unexpected S3 command");
  }) as typeof S3Client.prototype.send;
  return { pages, deleted };
}

test("a workspace larger than one page is deleted on a store that lists slowly", async () => {
  // Measured on a production MinIO: 1000 keys in 45-48 s, so a page of the
  // API's default size outlasted the client's thirty-second timeout. Every
  // cleanup of a session with more files than that failed on its first
  // listing, deleted nothing, and failed the same way on every retry -- the
  // row stayed pending for good, the stuck report fired every pass, and the
  // files of a deleted session stayed in the bucket.
  const probe = stubS3([]);
  await deleteSessionWorkspaceObjects("u-1", "sess-probe");
  const { requestTimeout } = await handlerTimeouts(probe.clients[0]);
  assert.ok(requestTimeout && requestTimeout > 0, "the client has a request timeout to fit inside");

  const keys = Array.from({ length: 1_250 }, (_, i) =>
    `users/u-1/sessions/sess-abc/workspace/f${String(i).padStart(4, "0")}`);
  const s3 = stubSlowListingS3(keys, 48, requestTimeout);

  const outcome = await deleteSessionWorkspaceObjects("u-1", "sess-abc");

  assert.equal(outcome.failed, 0);
  assert.equal(outcome.complete, true);
  assert.equal(outcome.deleted, keys.length, "every object of the workspace is gone");
  assert.deepEqual(new Set(s3.deleted), new Set(keys));
  assert.ok(s3.pages.length > 2, "the walk follows the continuation token across pages");
  for (const maxKeys of s3.pages) {
    assert.ok(maxKeys !== undefined && maxKeys * 48 < requestTimeout,
      `every listing asks for a page the store can answer inside the timeout (asked ${maxKeys})`);
  }
});

/**
 * A store whose first page costs what the walk behind it costs, as MinIO's does.
 *
 * MinIO answers a listing out of a metadata cache it fills by walking the
 * drives, and the first page waits for that cache's first block, which is
 * thousands of entries -- so a recursive listing of a prefix holding fewer
 * than that does not come back until the whole subtree has been read, however
 * few keys the request asked for. A listing with a delimiter walks one level.
 * Pages after the first come from the cache and cost little.
 */
function stubWalkingListingS3(
  objects: string[],
  msPerEntryWalked: number,
  requestTimeoutMs: number,
): { listings: Array<{ prefix: string; delimiter?: string; ms: number }>; deleted: string[] } {
  const remaining = new Set(objects);
  const listings: Array<{ prefix: string; delimiter?: string; ms: number }> = [];
  const deleted: string[] = [];
  S3Client.prototype.send = (async function (this: S3Client, command: unknown) {
    if (command instanceof ListObjectsV2Command) {
      const { Prefix = "", Delimiter, ContinuationToken } = command.input;
      const level = listLevel([...remaining], { ...command.input, MaxKeys: Number.MAX_SAFE_INTEGER });
      const walked = Delimiter
        ? level.Contents.length + level.CommonPrefixes.length
        : [...remaining].filter((k) => k.startsWith(Prefix)).length;
      const ms = ContinuationToken === undefined ? walked * msPerEntryWalked : 0;
      listings.push({ prefix: Prefix, delimiter: Delimiter, ms });
      if (ms >= requestTimeoutMs) throw requestTimedOut(requestTimeoutMs);
      return listLevel([...remaining], command.input);
    }
    if (command instanceof DeleteObjectCommand) {
      const key = command.input.Key ?? "";
      remaining.delete(key);
      deleted.push(key);
      return {};
    }
    throw new Error("unexpected S3 command");
  }) as typeof S3Client.prototype.send;
  return { listings, deleted };
}

test("a deep workspace is deleted on a store whose first page costs the whole walk", async () => {
  // Measured on the production MinIO (2026-11-07) for a deleted session that
  // stayed pending: 4,470 objects in 978 directories, thirteen deep. Its first
  // hundred-key page took 161 s -- the whole subtree, not the page -- so every
  // cleanup timed out on its first listing three times over, deleted nothing,
  // and the stuck report fired every minute. Walked a directory at a time the
  // same prefix took 979 listings, none over 7.5 s.
  const probe = stubS3([]);
  await deleteSessionWorkspaceObjects("u-1", "sess-probe");
  const { requestTimeout } = await handlerTimeouts(probe.clients[0]);
  assert.ok(requestTimeout && requestTimeout > 0, "the client has a request timeout to fit inside");

  const keys: string[] = [];
  for (let a = 0; a < 20; a++) {
    for (let b = 0; b < 15; b++) {
      for (let c = 0; c < 15; c++) {
        keys.push(`users/u-1/sessions/sess-abc/workspace/repo/d${a}/e${b}/f${c}.ts`);
      }
    }
  }
  // A neighbour whose name extends this session's: never listed, never deleted.
  keys.push("users/u-1/sessions/sess-abcdef/workspace/keep.ts");
  const s3 = stubWalkingListingS3(keys, 36, requestTimeout);

  const outcome = await deleteSessionWorkspaceObjects("u-1", "sess-abc");

  assert.equal(outcome.failed, 0);
  assert.equal(outcome.complete, true);
  assert.equal(outcome.deleted, keys.length - 1, "every object of the workspace is gone");
  assert.ok(!s3.deleted.includes("users/u-1/sessions/sess-abcdef/workspace/keep.ts"));
  for (const listing of s3.listings) {
    assert.ok(listing.ms < requestTimeout,
      `every listing fits inside the request timeout (${listing.prefix} took ${listing.ms} ms)`);
    assert.ok(listing.prefix.startsWith("users/u-1/sessions/sess-abc/")
      || listing.prefix.startsWith("checkpoints/u-1/sess-abc/"),
      `nothing outside the session's prefixes is listed (${listing.prefix})`);
  }
});

test("a walk stopped by its deadline has deleted what it reached, so the next one goes further", async (t) => {
  // The sweeper gives a pass half a tick. A directory walk that stops there
  // must have deleted something -- otherwise the cleanup reports no progress
  // and backs off, which is the stuck row again by another route -- and the
  // next pass, listing from the top, must find less than the last one did.
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  const keys: string[] = [];
  for (let a = 0; a < 10; a++) {
    for (let c = 0; c < 20; c++) keys.push(`users/u-1/sessions/sess-abc/workspace/d${a}/f${c}`);
  }
  const s3 = stubWalkingListingS3(keys, 0, 30_000);
  const realSend = S3Client.prototype.send;
  S3Client.prototype.send = (async function (this: S3Client, command: unknown) {
    if (command instanceof ListObjectsV2Command) now += 100;
    return realSend.call(this, command as never);
  }) as typeof S3Client.prototype.send;

  const passes: number[] = [];
  for (let pass = 0; pass < 50 && s3.deleted.length < keys.length; pass++) {
    const outcome = await deleteSessionWorkspaceObjects("u-1", "sess-abc", now + 350);
    passes.push(outcome.deleted);
    if (!outcome.complete) assert.ok(outcome.deleted > 0, `pass ${pass} stopped having deleted nothing`);
  }
  assert.equal(new Set(s3.deleted).size, keys.length, "the passes together delete everything");
  assert.ok(passes.length > 1, "the deadline did cut the walk short");
});

test("a level holding only directories, pages of them, does not use up a pass before a delete", async (t) => {
  // Listing every page of such a level before descending spends the pass on
  // listings and stops with nothing deleted -- recorded as no progress, so
  // the cleanup backs off and every later pass does the same. The walk has to
  // reach a file after one listing per level.
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  const keys: string[] = [];
  for (let a = 0; a < 500; a++) keys.push(`users/u-1/sessions/sess-abc/d${String(a).padStart(3, "0")}/f`);
  const s3 = stubWalkingListingS3(keys, 0, 30_000);
  const realSend = S3Client.prototype.send;
  S3Client.prototype.send = (async function (this: S3Client, command: unknown) {
    if (command instanceof ListObjectsV2Command) now += 100;
    return realSend.call(this, command as never);
  }) as typeof S3Client.prototype.send;

  const outcome = await deleteSessionWorkspaceObjects("u-1", "sess-abc", now + 450);

  assert.equal(outcome.complete, false);
  assert.ok(outcome.deleted > 0, "a pass that stopped on the clock had deleted something");
  assert.equal(s3.deleted.length, outcome.deleted);
});

test("every listing in this package asks for a bounded page", async () => {
  // The closed set, rather than the callers someone remembered: the file list,
  // the archive download, the upload sweep and the plugin walk page through
  // prefixes the same way the delete does, and on the same store a full page
  // times out there too. A listing added later without a page size is the same
  // defect again.
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts")) files.push(path);
    }
  };
  walk(root);

  let listings = 0;
  const unbounded: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (let at = src.indexOf("new ListObjectsV2Command("); at >= 0;
      at = src.indexOf("new ListObjectsV2Command(", at + 1)) {
      listings += 1;
      // The input is an object literal; its closing brace ends the arguments.
      const input = src.slice(at, src.indexOf("})", at) + 2);
      if (!/\bMaxKeys\s*:/.test(input)) {
        unbounded.push(`${file.slice(root.length + 1)}:${src.slice(0, at).split("\n").length}`);
      }
    }
  }
  assert.ok(listings >= 6, `the scan found the listings it is meant to check (found ${listings})`);
  assert.deepEqual(unbounded, [], "a listing without MaxKeys asks for the API's thousand-key default");
});
