// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn with no text and no tool call is not the end of the task.
 *
 * It used to be: an empty `end_turn` finished the loop, the run reported
 * success, and the task completed with nothing in it -- though the model had
 * never said it was done. Such a turn is now answered with one nudge, and a
 * top-level run that stays silent through it fails instead of succeeding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, EmptyAgentTurnError, type LoopOptions } from "../src/agent/agent-loop.js";
import { isRetryable } from "../src/infra/retry.js";

const usage = { input_tokens: 10, output_tokens: 1, cache_create: 0, cache_read: 0 };
const empty = { content: [], stopReason: "end_turn" };
const say = (text: string) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

/** A session that answers with `turns` in order and records what it was sent. */
function scripted(turns: Array<{ content: unknown[]; stopReason: string }>) {
  const sent: Message[][] = [];
  const session: LlmSession = {
    async streamTurn(messages) {
      sent.push(messages.slice());
      const next = turns.shift();
      if (!next) throw new Error("the loop asked for more turns than the script has");
      return { ...next, usage, firstByteMs: 1, promptTokens: 10 } as unknown as LlmTurnResult;
    },
    async complete() { return "summary"; },
  };
  return { session, sent };
}

function options(session: LlmSession, events: Array<Record<string, unknown>>, depth = 0): LoopOptions {
  return {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 10, depth,
    router: ({ route: async () => "tool ok", setHands: () => {} }) as unknown as ToolRouter,
    sessionId: "s-empty", userId: "u", llmSession: session,
    onEvent: async (e) => { events.push(e as Record<string, unknown>); },
  };
}

const prompt = [{ role: "user", content: "do the thing" } as Message];

test("an empty turn is answered with a nudge, and the reply after it is the result", async () => {
  const { session, sent } = scripted([empty, say("done: 3 files written")]);
  const events: Array<Record<string, unknown>> = [];
  const result = await agentLoop(prompt, [] as ToolSchema[], options(session, events));

  assert.equal(sent.length, 2, "the empty turn did not end the loop");
  const last = sent[1][sent[1].length - 1];
  assert.equal(last.role, "user");
  assert.match(String(last.content), /^\[system-notice\]: Your last reply was empty/);
  assert.equal(result.finalText, "done: 3 files written");
  const results = events.filter((e) => e.type === "ResultMessage");
  assert.equal(results.length, 1, "exactly one terminal result, after the real reply");
});

test("a top-level run that stays silent through the nudge fails instead of succeeding", async () => {
  const { session, sent } = scripted([empty, empty]);
  const events: Array<Record<string, unknown>> = [];
  await assert.rejects(
    agentLoop(prompt, [] as ToolSchema[], options(session, events)),
    (err: unknown) => err instanceof EmptyAgentTurnError,
  );
  assert.equal(sent.length, 2, "one nudge, not a loop of them");
  // The runner routes a non-retryable error to the failed outcome; a retryable
  // one would redeliver the same silent conversation instead.
  assert.equal(isRetryable(new EmptyAgentTurnError()), false);
  assert.equal(
    events.filter((e) => e.type === "ResultMessage").length, 0,
    "no success result was emitted for a run that produced nothing",
  );
});

test("a run that already reported something still ends normally after two empty turns", async () => {
  // The defect is a task completed with nothing in it. A run whose model wrote
  // its report before going quiet has something, and failing it would turn a
  // finished task into a failed one.
  const { session } = scripted([
    { content: [{ type: "text", text: "report: all green" },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "true" } }], stopReason: "tool_use" },
    empty,
    empty,
  ]);
  const events: Array<Record<string, unknown>> = [];
  const result = await agentLoop(prompt, [] as ToolSchema[], options(session, events));
  assert.equal(result.finalText, "report: all green");
  assert.equal(events.filter((e) => e.type === "ResultMessage").length, 1);
});

test("a sub-agent's silence goes back to its caller rather than failing the task", async () => {
  const { session } = scripted([empty, empty]);
  const events: Array<Record<string, unknown>> = [];
  const result = await agentLoop(prompt, [] as ToolSchema[], options(session, events, 1));
  assert.equal(result.finalText, "");
});

test("the nudge is re-armed by a turn that did something", async () => {
  // Once per silence, not once per run: a long run can go quiet more than once.
  const { session, sent } = scripted([
    empty,
    { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "true" } }], stopReason: "tool_use" },
    empty,
    say("finished"),
  ]);
  const events: Array<Record<string, unknown>> = [];
  const result = await agentLoop(prompt, [] as ToolSchema[], options(session, events));
  assert.equal(sent.length, 4);
  const nudges = sent[3].filter((m) => typeof m.content === "string"
    && m.content.startsWith("[system-notice]: Your last reply was empty"));
  assert.equal(nudges.length, 2, "the second silence was nudged too");
  assert.equal(result.finalText, "finished");
});

test("an empty turn on the only allowed turn fails rather than ending on the cap", async () => {
  // The nudge is only an answer if the model is asked again. With maxTurns 1
  // it never is, and the loop used to return an empty result the runner then
  // reported as a success.
  const { session, sent } = scripted([empty]);
  const events: Array<Record<string, unknown>> = [];
  await assert.rejects(
    agentLoop(prompt, [] as ToolSchema[], { ...options(session, events), maxTurns: 1 }),
    (err: unknown) => err instanceof EmptyAgentTurnError && /last allowed turn/.test(err.message),
  );
  assert.equal(sent.length, 1);
  assert.equal(events.filter((e) => e.type === "ResultMessage").length, 0);
});

test("an empty turn on the last of several allowed turns fails rather than ending on the cap", async () => {
  const tool = { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "true" } }],
    stopReason: "tool_use" };
  const { session, sent } = scripted([tool, { ...tool, content: [{ ...tool.content[0], id: "t2" }] }, empty]);
  const events: Array<Record<string, unknown>> = [];
  await assert.rejects(
    agentLoop(prompt, [] as ToolSchema[], { ...options(session, events), maxTurns: 3 }),
    (err: unknown) => err instanceof EmptyAgentTurnError,
  );
  assert.equal(sent.length, 3);
  assert.equal(events.filter((e) => e.type === "ResultMessage").length, 0);
});

test("an empty last turn after a report, or in a sub-agent, still ends normally", async () => {
  const reported = scripted([
    { content: [{ type: "text", text: "report: all green" },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "true" } }], stopReason: "tool_use" },
    empty,
  ]);
  const events: Array<Record<string, unknown>> = [];
  const result = await agentLoop(prompt, [] as ToolSchema[],
    { ...options(reported.session, events), maxTurns: 2 });
  assert.equal(result.finalText, "report: all green");

  const sub = scripted([empty]);
  const subResult = await agentLoop(prompt, [] as ToolSchema[],
    { ...options(sub.session, [], 1), maxTurns: 1 });
  assert.equal(subResult.finalText, "");
});
