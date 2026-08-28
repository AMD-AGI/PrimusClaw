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
      return { Contents: objects.filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })) };
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

  assert.deepEqual(
    s3.listed,
    ["users/default/sessions/sess-abc/", "checkpoints/default/sess-abc/"],
    "the fallback has to reach both prefixes a session's objects are written under",
  );
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

test("the budget is honoured inside a page, not only between prefixes", async () => {
  // A thousand-key page deleted unconditionally is how an inline request spends
  // minutes after its budget, overlapping the sweeper that thought it owned the
  // rest. Stopping at a delete-batch boundary is still resumable: the next
  // attempt lists from the start and the keys already gone are not returned.
  const keys = Array.from({ length: 40 }, (_, i) => `users/u-1/sessions/sess-abc/f${i}`);
  const s3 = stubS3(keys, undefined, async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const outcome = await deleteSessionWorkspaceObjects("u-1", "sess-abc", Date.now() + 5);

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
