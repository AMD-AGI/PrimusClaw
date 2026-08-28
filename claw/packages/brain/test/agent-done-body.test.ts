// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What `postAgentDone` actually puts on the wire.
//
// The task-runner tests can only reach as far as the ExecuteResult a terminal
// path hands this function; which of its fields survive into the request body
// is decided here, and the answer is not "all of them". `elapsedMs` has no
// field in AgentDoneBody and is dropped, so a runner test asserting it proves
// nothing about the DAG. The counts do travel, and travel into `claw_tasks`
// through the API's applyAgentDone -- which is why an absent count has to stay
// absent rather than arrive as a zero that reads as a measurement.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import { postAgentDone } from "../src/tasks/callback.js";

const REQUEST = {
  session_id: "sess-body",
  message_id: "msg-1",
  prompt: "hi",
  user_id: "u1",
  task_id: "task-body",
  callback_url: "http://api.test/v1/internal/tasks",
} as ExecuteRequest;

function baseResult(over: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    finalText: "done",
    turns: 4,
    pendingMemories: [],
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 2,
    elapsedMs: 3_600_000,
    ...over,
  } as ExecuteResult;
}

/** Post once against a stubbed fetch and hand back the parsed request body. */
async function postedBody(res: ExecuteResult): Promise<Record<string, unknown>> {
  const realFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200 } as Response;
  }) as typeof globalThis.fetch;
  try {
    await postAgentDone(REQUEST, res);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(body, "postAgentDone must have posted something");
  return body!;
}

test("the counts a terminal path reports reach the DAG", async () => {
  const body = await postedBody(baseResult({
    tokenUsage: { input_tokens: 10, output_tokens: 20, cache_read: 0, cache_create: 0, turns: 4 },
    toolStats: { total_calls: 9, error_calls: 2, by_tool: { bash: 7 } },
  }));

  assert.equal(body.turns, 4);
  assert.deepEqual(body.tool_stats, { total_calls: 9, error_calls: 2, by_tool: { bash: 7 } });
  assert.equal((body.token_usage as Record<string, number>).input_tokens, 10);
});

test("counts nothing measured arrive absent, not as zeroes", async () => {
  // applyAgentDone writes `payload.tool_stats ? JSON.stringify(...) : null`, so
  // this is the difference between a NULL column and a row claiming the run
  // made no tool calls.
  const body = await postedBody(baseResult({ tokenUsage: undefined, toolStats: undefined }));

  assert.ok(!("tool_stats" in body) || body.tool_stats === undefined,
    "a zeroed tool_stats here becomes a stored measurement of zero");
  assert.ok(!("token_usage" in body) || body.token_usage === undefined);
  assert.equal(body.turns, 4, "what was known still travels");
});

test("the duration does not reach the DAG at all", async () => {
  // Pinned so the next person to align `elapsedMs` across sinks finds out here
  // that the DAG sink has no field for it, rather than believing a runner test
  // that only ever inspected the argument.
  const body = await postedBody(baseResult());

  assert.ok(!("elapsed_ms" in body) && !("elapsedMs" in body),
    "AgentDoneBody has no duration field; add one before claiming the sinks agree");
});
