// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A JetStream stall is something a run waits out, not something it dies of.
//
// 2026-11-06: one storage node rebooted under the R3 streams and JetStream did
// not answer for about twenty seconds. Every publish in that window failed with
// the client's NatsError{code:"TIMEOUT", message:"TIMEOUT"}, and three things
// went wrong with it, each pinned here:
//
//   S1 the retry policy matched "nats" in the message, which "TIMEOUT" does not
//      contain, so two runs were failed and acked instead of redelivered;
//   S2 the failure classifier read the bare word as the *model* timing out and
//      told the user so (failure_reason upstream_timeout);
//   S3 the event emitter published once and threw, so a stall shorter than a
//      turn still ended the run that was emitting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NatsError } from "nats";

import { isRetryable } from "../src/infra/retry.js";
import { isTransientNatsError } from "../src/infra/nats-transient.js";
import { __test__ } from "../src/tasks/runner.js";
import { EMIT_RETRY_DELAYS_MS, EmitStoodDownError, NatsEmitter } from "../src/events/emitter.js";

const { classifyTaskFailure, classifyRetryableReason } = __test__;

const natsTimeout = () => NatsError.errorForCode("TIMEOUT");

test("S1 a JetStream TIMEOUT, a 503 and a reconnect are retryable; a refusal is not", () => {
  assert.equal(isRetryable(natsTimeout()), true, "the 2026-11-06 error itself");
  assert.equal(isRetryable(NatsError.errorForCode("503")), true, "no responders: a stream between leaders");
  assert.equal(isRetryable(NatsError.errorForCode("DISCONNECT")), true);
  assert.equal(isRetryable(NatsError.errorForCode("CONNECTION_REFUSED")), true);

  // Things a second attempt cannot change stay terminal.
  assert.equal(isRetryable(NatsError.errorForCode("PERMISSIONS_VIOLATION")), false);
  assert.equal(isRetryable(NatsError.errorForCode("MAX_PAYLOAD_EXCEEDED")), false);
  // Matched on the client's own name, never on prose: a plain Error saying
  // TIMEOUT is not this.
  assert.equal(isTransientNatsError(new Error("TIMEOUT")), false);
});

test("S2 a NatsError TIMEOUT is not reported as the model timing out", () => {
  const err = natsTimeout();
  const failure = classifyTaskFailure(err.message, err);
  assert.equal(failure.reason, "infra_transient");
  assert.doesNotMatch(failure.userText, /model/i);
  assert.equal(classifyRetryableReason(err), "nats_transient");

  // The model's own timeout is still its own.
  assert.equal(classifyTaskFailure("Request timeout after 600s").reason, "upstream_timeout");
});

/** An emitter whose JetStream is a script the test writes. */
function scriptedEmitter(outcomes: Array<Error | null>) {
  const calls: Array<{ subject: string; msgID?: string }> = [];
  const slept: number[] = [];
  const emitter = new NatsEmitter();
  (emitter as unknown as { js: unknown }).js = {
    async publish(subject: string, _payload: Uint8Array, opts?: { msgID?: string }) {
      calls.push({ subject, msgID: opts?.msgID });
      const next = outcomes.shift();
      if (next) throw next;
      return { seq: calls.length, duplicate: false, stream: "S" };
    },
  };
  (emitter as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => { slept.push(ms); };
  return { emitter, calls, slept };
}

test("S3 an event is published through a stall, once, under one id", async () => {
  const { emitter, calls, slept } = scriptedEmitter([natsTimeout(), natsTimeout(), NatsError.errorForCode("503"), null]);
  await emitter.emit("sess-1", { type: "AssistantMessage" });

  assert.equal(calls.length, 4, "three failures, then the publish that landed");
  const ids = new Set(calls.map((c) => c.msgID));
  assert.equal(ids.size, 1, "every attempt carries the same de-duplication id");
  assert.ok([...ids][0], "and it has one even though the caller supplied none");
  assert.deepEqual(slept, EMIT_RETRY_DELAYS_MS.slice(0, 3));
});

test("S3 a caller's own msgID is the one retried", async () => {
  const { emitter, calls } = scriptedEmitter([natsTimeout(), null]);
  await emitter.emit("sess-1", { type: "x" }, { msgID: "fixed-id" });
  assert.deepEqual(calls.map((c) => c.msgID), ["fixed-id", "fixed-id"]);
});

test("S3 a refusal is thrown at once, and a stall that outlasts the budget is thrown in the end", async () => {
  const refused = scriptedEmitter([NatsError.errorForCode("PERMISSIONS_VIOLATION")]);
  await assert.rejects(refused.emitter.emit("s", { type: "x" }), /PERMISSIONS_VIOLATION|Permissions/i);
  assert.equal(refused.calls.length, 1);

  const forever = scriptedEmitter(Array.from({ length: 50 }, natsTimeout));
  await assert.rejects(forever.emitter.emit("s", { type: "x" }), (e: unknown) => isTransientNatsError(e));
  assert.equal(forever.calls.length, EMIT_RETRY_DELAYS_MS.length + 1, "bounded");
  // The bound is what was measured, with room: the 2026-11-06 stall was ~20s.
  const sleptMs = EMIT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert.ok(sleptMs >= 20_000 && sleptMs <= 60_000, `retry sleeps total ${sleptMs}ms`);
});

test("S4 a publish whose sender stands down mid-stall is not sent again", async () => {
  const { emitter, calls } = scriptedEmitter([natsTimeout(), natsTimeout(), null]);
  let mine = true;
  (emitter as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => { mine = false; };
  await assert.rejects(
    emitter.emit("s1", { type: "exec_complete" }, { stillMine: () => mine }),
    (err) => err instanceof EmitStoodDownError,
  );
  assert.equal(calls.length, 1, "the one attempt made before the stand-down, and no retry after it");
  const { emitter: e2, calls: c2 } = scriptedEmitter([null]);
  await assert.rejects(e2.emit("s1", { type: "exec_complete" }, { stillMine: () => false }));
  assert.equal(c2.length, 0, "nothing at all once it has already stood down");
});
