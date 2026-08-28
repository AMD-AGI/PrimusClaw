// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A deleted session's transcript stays deleted with the rest of its prefix.
 *
 * The guard that keeps a late write out of a deleted session's S3 prefix used
 * to sit only in front of the uploader, and the transcript is on the likelier
 * path of the two: `cleanup.<sid>` marks the session gone and then aborts the
 * run with no reason, which lands it on the interrupt path, whose very first
 * await is the transcript flush. So the object the race left behind most
 * reliably was the one object nobody was guarding, and it survived under a
 * prefix the delete had already listed with no row left to join it against.
 *
 * Driven through the real flushTranscript against a local endpoint standing in
 * for S3, because "no object was written" is the entire assertion here and a
 * stubbed uploader could only say that a stub went uncalled.
 *
 * D2 doubles as the one test of where a transcript is written at all. The
 * location is load bearing rather than tidy: only a reserved directory tells the
 * sync that this object is Brain's and not a `.jsonl` the user's own run left in
 * `/workspace`, so a transcript written anywhere else is restored into the next
 * sandbox, uploaded again, and copied into every later archive.
 *
 * Coverage:
 *   D1 an interrupt on a deleted session writes no transcript
 *   D2 the same interrupt on a live session still writes one, under .transcripts/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";

/** Every object key a PUT reached, in arrival order, minus the SDK's query. */
const puts: string[] = [];

const s3 = createServer((req, res) => {
  if (req.method === "PUT") puts.push((req.url ?? "").split("?")[0]!);
  req.resume();
  res.writeHead(200, { ETag: '"stub"' });
  res.end();
});
await new Promise<void>((resolve) => { s3.listen(0, "127.0.0.1", resolve); });
s3.unref();

// Set before the first import of config.ts, which reads each of these once at
// module scope; hence the dynamic imports below rather than static ones.
process.env.S3_API_ENDPOINT = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
process.env.S3_BUCKET = "claw-transcript-test";
process.env.S3_ACCESS_KEY = "stub-access-key";
process.env.S3_SECRET_KEY = "stub-secret-key";

const { markSessionDeleted, forgetDeletedSessions } = await import("../src/infra/deleted-sessions.js");
const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { activeAbort } = await import("../src/tasks/abort-registry.js");

const MESSAGE = "msg-transcript";

function fakeKv(): KV {
  return {
    async get() { return null; },
    async put() { return 1; },
    async delete() {},
  } as unknown as KV;
}

/**
 * Everything the run reaches for except the transcript flush, which is left as
 * the real implementation because it is the writer under test.
 */
function stubSideEffects(): Partial<TaskRunnerSideEffects> {
  const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  return {
    ensureHands: noop({ handsUrl: "http://hands.test", created: true, token: "t" }),
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => {}) as never,
    syncWorkspaceFromS3: noop(undefined),
    postAgentDone: noop(undefined),
    postTaskRunning: noop(undefined),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    makeHandsClient: (() => ({ close: async () => {} })) as never,
  };
}

/** Abort mid-turn the way the cleanup subscriber does: no reason attached. */
async function interruptedRun(sessionId: string): Promise<void> {
  const msg = {
    info: { deliveryCount: 1 },
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
  const kv = fakeKv();
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  const abortCtrl = new AbortController();
  const engine: Engine = {
    async execute(): Promise<ExecuteResult> {
      abortCtrl.abort();
      throw new Error("aborted mid-turn");
    },
  };

  bindTaskRunnerDeps({
    kv, kvCkpt: kv, emitter, engine, sideEffects: stubSideEffects(),
  });

  const request = {
    session_id: sessionId,
    prompt: "hi",
    user_id: "u1",
    platform_key: "pk",
  } as ExecuteRequest;
  const lockKey = `lock.${sessionId}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, sessionId, lockKey, MESSAGE, "u1", abortCtrl);
}

test("D1 an interrupt on a deleted session writes no transcript", async () => {
  forgetDeletedSessions();
  puts.length = 0;
  markSessionDeleted("sess-transcript-gone");

  await interruptedRun("sess-transcript-gone");

  assert.deepEqual(puts, [], "the delete already listed this prefix; nothing may land in it now");
});

test("D2 the same interrupt on a live session still writes one, under .transcripts/", async () => {
  // The guard sits in front of every transcript there is, so its inert case is
  // as much of the contract as its active one.
  forgetDeletedSessions();
  puts.length = 0;

  await interruptedRun("sess-transcript-live");

  assert.deepEqual(
    puts,
    [
      "/claw-transcript-test/users/u1/sessions/sess-transcript-live"
      + "/.transcripts/msg-transcript.jsonl",
    ],
    "an ordinary interrupt still has to persist what the run did",
  );
});
