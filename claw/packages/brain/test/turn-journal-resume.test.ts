// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A run stopped part-way through a turn's tool calls must not make a call
// again when it resumes.
//
// A checkpoint is written at a turn boundary, so a run stopped inside a turn
// -- a SIGTERM drain, a failure that is retried -- used to go back to the
// start of that turn and ask the model again. The model issued its calls
// afresh, and a call that had already left the process (a review comment, a
// message sent to a person) was made a second time. On 2026-11-06 every work
// item resumed after a brain rollout replayed one model turn.
//
// These drive the real agent loop through an interruption and a resume from
// whatever the interrupted attempt persisted, and count the side effects.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import type { CheckpointState } from "../src/agent/index.js";
import { agentLoop, INTERRUPTED_TOOL_RESULT, type LoopOptions } from "../src/agent/agent-loop.js";

interface Scripted {
  session: LlmSession;
  prompts: Message[][];
}

/** A model that answers each call with the next scripted turn and records what it was shown. */
function scriptedSession(turns: Array<Partial<LlmTurnResult>>): Scripted {
  const prompts: Message[][] = [];
  let i = 0;
  const session = {
    async streamTurn(messages: Message[]) {
      prompts.push(structuredClone(messages));
      const turn = turns[i++];
      if (!turn) throw new Error(`scripted session exhausted after ${i - 1} turns`);
      return {
        content: turn.content ?? [],
        stopReason: turn.stopReason ?? "end_turn",
        usage: turn.usage ?? { input_tokens: 10, output_tokens: 5, cache_create: 0, cache_read: 0 },
        firstByteMs: 1,
      };
    },
    async complete() { return "summary"; },
  } as unknown as LlmSession;
  return { session, prompts };
}

/**
 * A model asked to resume: shown the interrupted turn's prompt again (the last
 * message is the person's, not a tool result), it issues the turn's calls
 * afresh, as a real model does; shown the results, it finishes.
 */
function modelThatRedoes(redo: Partial<LlmTurnResult>, finish: Partial<LlmTurnResult>): Scripted {
  const prompts: Message[][] = [];
  const session = {
    async streamTurn(messages: Message[]) {
      prompts.push(structuredClone(messages));
      const last = messages.at(-1)!;
      const answeredTools = Array.isArray(last.content)
        && (last.content as Array<{ type?: string }>).some((b) => b.type === "tool_result");
      const turn = answeredTools ? finish : redo;
      return {
        content: turn.content ?? [],
        stopReason: turn.stopReason ?? "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_create: 0, cache_read: 0 },
        firstByteMs: 1,
      };
    },
    async complete() { return "summary"; },
  } as unknown as LlmSession;
  return { session, prompts };
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): LlmContentBlock {
  return { type: "tool_use", id, name, input } as LlmContentBlock;
}
function text(t: string): LlmContentBlock {
  return { type: "text", text: t } as LlmContentBlock;
}

const TOOLS: ToolSchema[] = [
  { name: "read", description: "read a file", input_schema: { type: "object", properties: {} } },
  { name: "post_comment", description: "post a review comment", input_schema: { type: "object", properties: {} } },
  { name: "say", description: "send a message", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

function baseOpts(over: Partial<LoopOptions> & Record<string, unknown>): LoopOptions {
  return {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: 10,
    onEvent: async () => {},
    sessionId: "sess-journal",
    userId: "user-1",
    ...over,
  } as unknown as LoopOptions;
}

/** The store a checkpoint lands in: the last write wins, as in the KV bucket. */
function store() {
  let latest: CheckpointState | undefined;
  return {
    get latest() { return latest; },
    onCheckpoint: async (s: CheckpointState) => { latest = structuredClone(s); },
    onTurnJournal: async (s: CheckpointState) => { latest = structuredClone(s); },
  };
}

/** Every side effect any attempt caused, by what it carried. */
function sideEffects() {
  const done: string[] = [];
  return {
    done,
    count: (what: string) => done.filter((d) => d === what).length,
  };
}

test("J1: a write that finished before the stop is not made again on resume, and the model is not asked again", async () => {
  const effects = sideEffects();
  const kv = store();
  const ac = new AbortController();

  // Attempt 1: the model posts a comment and then sends a message. The drain
  // begins once the comment is posted, before the message is dispatched.
  const first = scriptedSession([
    { content: [text("posting"), toolUse("c1", "post_comment", { body: "LGTM" }), toolUse("s1", "say", { text: "done" })],
      stopReason: "tool_use" },
  ]);
  await agentLoop([{ role: "user", content: "review it" }], TOOLS, baseOpts({
    signal: ac.signal,
    llmSession: first.session,
    onCheckpoint: kv.onCheckpoint,
    onTurnJournal: kv.onTurnJournal,
    router: {
      route: async (name: string, input: Record<string, unknown>) => {
        effects.done.push(`${name}:${JSON.stringify(input)}`);
        if (name === "post_comment") ac.abort();
        return `${name} ok`;
      },
      setHands: () => {},
    } as unknown as ToolRouter,
  }));
  assert.equal(effects.count('post_comment:{"body":"LGTM"}'), 1);
  assert.equal(effects.count('say:{"text":"done"}'), 0, "the drain stopped the message before it was sent");
  assert.ok(kv.latest, "the interrupted attempt must have persisted something to resume from");

  // Attempt 2, on another brain, from what attempt 1 persisted. Asked the
  // interrupted turn again, this model would post the comment again under a
  // new id -- which is what a resumed run did before.
  const second = modelThatRedoes(
    { content: [toolUse("c2", "post_comment", { body: "LGTM!" }), toolUse("s2", "say", { text: "done" })],
      stopReason: "tool_use" },
    { content: [text("all done")], stopReason: "end_turn" },
  );
  const resumed = await agentLoop([{ role: "user", content: "review it" }], TOOLS, baseOpts({
    resumeFrom: kv.latest,
    llmSession: second.session,
    onCheckpoint: kv.onCheckpoint,
    onTurnJournal: kv.onTurnJournal,
    router: {
      route: async (name: string, input: Record<string, unknown>) => {
        effects.done.push(`${name}:${JSON.stringify(input)}`);
        return `${name} ok`;
      },
      setHands: () => {},
    } as unknown as ToolRouter,
  }));

  const comments = effects.done.filter((d) => d.startsWith("post_comment"));
  assert.deepEqual(comments, ['post_comment:{"body":"LGTM"}'], "exactly one comment, across both attempts");
  assert.equal(effects.count('say:{"text":"done"}'), 1,
    "the call the drain stopped before dispatch runs once, on resume");
  assert.equal(second.prompts.length, 1, "the resumed run asks the model only for the turn after the interrupted one");
  const lastUser = second.prompts[0].at(-1)!;
  const results = (lastUser.content as Array<{ type: string; tool_use_id: string; content: unknown }>);
  assert.deepEqual(results.map((r) => r.tool_use_id), ["c1", "s1"],
    "the model is shown its own interrupted turn, answered in order");
  assert.match(JSON.stringify(results[0].content), /post_comment ok/, "with the comment's recorded result");
  assert.equal(resumed.finalText, "posting\nall done", "the interrupted turn's text is kept once, not repeated");
  assert.equal(resumed.tokenUsage.turns, 2, "the replayed turn is not counted as a second model call");
});

test("J2: a write in flight when the run stopped is not made again, and the model is told it may have happened", async () => {
  const effects = sideEffects();
  const kv = store();
  const ac = new AbortController();

  const first = scriptedSession([
    { content: [toolUse("c1", "post_comment", { body: "LGTM" })], stopReason: "tool_use" },
  ]);
  await agentLoop([{ role: "user", content: "review it" }], TOOLS, baseOpts({
    signal: ac.signal,
    llmSession: first.session,
    onCheckpoint: kv.onCheckpoint,
    onTurnJournal: kv.onTurnJournal,
    router: {
      // The comment reaches the server, then the run is stopped before the
      // answer comes back: the call ends with the abort's error.
      route: async (name: string, input: Record<string, unknown>) => {
        effects.done.push(`${name}:${JSON.stringify(input)}`);
        ac.abort();
        throw new Error("This operation was aborted");
      },
      setHands: () => {},
    } as unknown as ToolRouter,
  }));
  assert.equal(effects.done.length, 1);

  const second = scriptedSession([{ content: [text("checked")], stopReason: "end_turn" }]);
  await agentLoop([{ role: "user", content: "review it" }], TOOLS, baseOpts({
    resumeFrom: kv.latest,
    llmSession: second.session,
    onCheckpoint: kv.onCheckpoint,
    onTurnJournal: kv.onTurnJournal,
    router: {
      route: async (name: string, input: Record<string, unknown>) => {
        effects.done.push(`${name}:${JSON.stringify(input)}`);
        return `${name} ok`;
      },
      setHands: () => {},
    } as unknown as ToolRouter,
  }));

  assert.equal(effects.done.length, 1, "a call that may already have taken effect is not made again");
  const results = second.prompts[0].at(-1)!.content as Array<{ tool_use_id: string; content: unknown }>;
  assert.equal(results[0].tool_use_id, "c1");
  assert.match(JSON.stringify(results[0].content), new RegExp(INTERRUPTED_TOOL_RESULT.slice(0, 40)),
    "the model is told the call was interrupted, not handed the abort's error to retry on");
});

test("J3: a turn of reads only writes no journal, and a completed turn leaves none behind", async () => {
  const kv = store();
  const journals: CheckpointState[] = [];
  const s = scriptedSession([
    { content: [toolUse("r1", "read")], stopReason: "tool_use" },
    { content: [toolUse("c1", "post_comment", { body: "x" })], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end_turn" },
  ]);
  await agentLoop([{ role: "user", content: "go" }], TOOLS, baseOpts({
    llmSession: s.session,
    onCheckpoint: kv.onCheckpoint,
    onTurnJournal: async (st: CheckpointState) => { journals.push(structuredClone(st)); await kv.onTurnJournal(st); },
    router: { route: async () => "ok", setHands: () => {} } as unknown as ToolRouter,
  }));
  assert.deepEqual(journals.map((j) => j.pending_turn?.turn), [1, 1],
    "one write before the comment and one after it, and none for the turn of reads");
  assert.deepEqual(journals[0].pending_turn?.started, ["c1"]);
  assert.deepEqual(journals[1].pending_turn?.results, { c1: "ok" });
  assert.equal(kv.latest?.pending_turn, undefined, "the boundary checkpoint after the turn carries no journal");
});
