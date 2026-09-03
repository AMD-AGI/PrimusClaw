// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Keeping the completion callback deliverable.
 *
 * A run that finishes its work and cannot report it is recorded as never having
 * reported at all, and everything in the body goes with it. Captures were
 * already bounded where they are produced; `final_text` was not, and on the
 * script path it is the last step's whole stdout -- which Hands will hand over
 * up to 10 MiB of, against the 4 MiB the API accepts.
 *
 * Coverage:
 *   R1 an oversized final_text is truncated, and says so
 *   R2 a 413 sheds the body once instead of retrying it identically
 *   R3 the shed retry still carries the outcome
 *   R4 a first 413 on attempt three still sends the lean body exactly once
 *   R5 the shed body is bounded by what it keeps, not by what it was handed
 *   R6 the shed body keeps the facts a stranded run is found again by
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import { postAgentDone } from "../src/tasks/callback.js";

const REQUEST = {
  task_id: "ktsk_big", callback_url: "http://api.test/v1/internal/tasks/ktsk_big",
} as ExecuteRequest;

function result(over: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    finalText: "ok", turns: 1, pendingMemories: [], pendingSkills: [],
    skillsUsed: {}, errorCount: 0, abortReason: "completed",
    ...over,
  } as ExecuteResult;
}

/** Captures every body posted, answering with the given statuses in order. */
function capture(statuses: number[]): { bodies: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  let i = 0;
  globalThis.fetch = (async (_u: string, init: { body: string }) => {
    seen.push(JSON.parse(init.body));
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return { ok: status < 400, status } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { bodies: seen };
}

test("R1 an oversized final_text is truncated, and says so", async () => {
  const original = globalThis.fetch;
  const cap = capture([200]);
  try {
    await postAgentDone(REQUEST, result({ finalText: "x".repeat(2 * 1024 * 1024) }));
  } finally {
    globalThis.fetch = original;
  }
  const text = cap.bodies[0].final_text as string;
  assert.ok(text.length < 300_000, `still ${text.length} chars`);
  assert.match(
    text, /\[final text truncated at \d+ bytes\]$/,
    "a consumer has to be able to tell a cut document from a short one",
  );
});

test("R2 a 413 sheds the body once instead of retrying it identically", async () => {
  // The previous behaviour posted the same oversized body three times, threw,
  // left the JetStream message unacked, and failed the same way on every
  // redelivery -- forever, for a run that had done its work.
  const original = globalThis.fetch;
  const cap = capture([413, 200]);
  try {
    await postAgentDone(REQUEST, result({
      finalText: "the answer",
      captures: { report: "y".repeat(1000) },
    } as Partial<ExecuteResult>));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(cap.bodies.length, 2, "one refusal, one shed retry");
  assert.deepEqual(cap.bodies[0].captures, { report: "y".repeat(1000) });
  assert.deepEqual(cap.bodies[1].captures, {}, "the second carries no payload");
  assert.match(String(cap.bodies[1].final_text), /exceeded the size/);
});

test("R3 the shed retry still carries the outcome", async () => {
  // A row that lands with the outcome and none of the output is a far smaller
  // loss than a row that never lands, but only if the outcome survives.
  const original = globalThis.fetch;
  const cap = capture([413, 200]);
  try {
    await postAgentDone(REQUEST, result({
      abortReason: "error", failureReason: "sandbox_lost", turns: 7,
    } as Partial<ExecuteResult>));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(cap.bodies[1].task_id, "ktsk_big");
  assert.equal(cap.bodies[1].abort_reason, "error");
  assert.equal(cap.bodies[1].failure_reason, "sandbox_lost");
  assert.equal(cap.bodies[1].turns, 7);
});

test("R4 a first 413 on attempt three gets one lean-body attempt", async () => {
  const original = globalThis.fetch;
  const cap = capture([500, 503, 413, 200]);
  try {
    await postAgentDone(REQUEST, result({ captures: { report: "payload" } }));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(cap.bodies.length, 4);
  assert.deepEqual(cap.bodies[2].captures, { report: "payload" });
  assert.deepEqual(cap.bodies[3].captures, {});
});

test("R4b the dedicated lean-body attempt is still bounded", async () => {
  const original = globalThis.fetch;
  const cap = capture([500, 503, 413, 413]);
  try {
    await assert.rejects(
      () => postAgentDone(REQUEST, result({ captures: { report: "payload" } })),
      /HTTP 413/,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(cap.bodies.length, 4, "the lean body was retried more than once");
});

/**
 * The size of a shed body must be a property of `withoutPayload`, not of its
 * input. It used to be the latter: the function spread the original body and
 * overwrote the fields somebody had thought of, so `token_usage`, `metadata`
 * and the `platform_*` strings went out at full size. If one of those was what
 * drew the 413 -- a malformed SaFE payload with a megabyte in `message`, say --
 * the shed body was refused too, every attempt failed, the JetStream message
 * never acked, and the redelivery repeated it for as long as the stream held
 * it. Every field below is individually enormous, so any one of them surviving
 * uncapped fails this.
 */
const HUGE = 1024 * 1024;

function pathologicalResult(): ExecuteResult {
  return result({
    finalText: "f".repeat(HUGE),
    captures: { report: "c".repeat(HUGE) },
    tokenUsage: { input_tokens: 1, note: "t".repeat(HUGE) },
    toolStats: { bash: { calls: 1, note: "s".repeat(HUGE) } },
    failureReason: "r".repeat(HUGE),
    abortReason: "a".repeat(HUGE),
    waitExternalId: "e".repeat(HUGE),
    platformFacts: {
      message: "m".repeat(HUGE),
      node: "n".repeat(HUGE),
      containerReason: "k".repeat(HUGE),
      exitCode: 137,
    },
  } as unknown as Partial<ExecuteResult>);
}

test("R5 the shed body is bounded by what it keeps, not by what it was handed", async () => {
  const original = globalThis.fetch;
  const cap = capture([413, 200]);
  try {
    await postAgentDone(REQUEST, pathologicalResult());
  } finally {
    globalThis.fetch = original;
  }

  const sent = Buffer.byteLength(JSON.stringify(cap.bodies[0]), "utf8");
  const shed = Buffer.byteLength(JSON.stringify(cap.bodies[1]), "utf8");
  assert.ok(sent > 4 * 1024 * 1024, `the first body was meant to be oversized, was ${sent}`);
  assert.ok(shed < 32 * 1024, `the shed body is still ${shed} bytes`);

  // Named individually as well as in the total, because a single unbounded
  // field is exactly the bug, and a total alone would not say which one.
  for (const field of [
    "final_text", "failure_reason", "abort_reason",
    "platform_message", "platform_node", "platform_container_reason",
  ]) {
    const value = cap.bodies[1][field] as string;
    assert.ok(
      Buffer.byteLength(value, "utf8") < 16 * 1024,
      `${field} went out at ${Buffer.byteLength(value, "utf8")} bytes`,
    );
  }

  // Dropped rather than trimmed: neither has a shape this side can trim to.
  assert.ok(!("token_usage" in cap.bodies[1]), "token_usage rode along");
  assert.ok(!("tool_stats" in cap.bodies[1]), "tool_stats rode along");
});

test("R6 the shed body keeps the facts a stranded run is found again by", async () => {
  // Bounding must not turn into shedding: a run ending in waiting_external is
  // reachable only through metadata.external_id, and the platform's account of
  // how a run ended is the thing a body with no output is being sent for.
  const original = globalThis.fetch;
  const cap = capture([413, 200]);
  try {
    await postAgentDone(REQUEST, pathologicalResult());
  } finally {
    globalThis.fetch = original;
  }

  const body = cap.bodies[1];
  assert.equal(body.task_id, "ktsk_big");
  assert.equal(body.platform_exit_code, 137);
  const metadata = body.metadata as { external_id?: string } | undefined;
  assert.ok(metadata?.external_id?.startsWith("e"), "the external id did not survive");
  assert.ok(
    Buffer.byteLength(metadata.external_id!, "utf8") < 16 * 1024,
    "the external id survived unbounded",
  );
  assert.deepEqual(Object.keys(metadata!), ["external_id"], "nothing else rode along under metadata");
});
