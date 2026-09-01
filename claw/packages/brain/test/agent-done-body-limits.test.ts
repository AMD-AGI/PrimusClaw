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
