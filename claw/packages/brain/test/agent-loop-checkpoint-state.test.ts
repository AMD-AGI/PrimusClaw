// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What does a resumed loop remember?
//
// The checkpoint used to carry the conversation and the counters but not three
// pieces of in-memory state, so a resume silently changed behaviour:
//
//   - plan_mode is an authorization latch, not a preference. It confines the
//     loop to a read-only allowlist until the user approves via
//     exit_plan_mode. Rebuilding it from the request parameter either re-locks
//     an approved run or, worse, hands write tools to a run that was never
//     approved.
//   - rebuilds_used and recoveries_used are the per-task budgets that stop an
//     infinite recovery loop against a doomed sandbox. Resetting either on
//     resume means that budget never actually binds.
//   - todo_state is the in-loop todo list, which just disappeared.
//
// Also pinned here: tool-call *inputs* are bounded before they enter the
// conversation history (they were not, so one large write put the whole file
// body into every subsequent checkpoint), and a cancelled batch stops
// dispatching instead of running to the end.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import type { CheckpointState } from "../src/agent/index.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";

function scriptedSession(
  turns: Array<Partial<LlmTurnResult>>,
  onTurn?: (messages: Message[], tools: ToolSchema[]) => void,
): LlmSession {
  let i = 0;
  return {
    async streamTurn(messages: Message[], tools: ToolSchema[]) {
      onTurn?.(messages, tools);
      const turn = turns[i++];
      if (!turn) throw new Error(`scripted session exhausted after ${i - 1} turns`);
      return {
        content: turn.content ?? [],
        stopReason: turn.stopReason ?? "end_turn",
        usage: turn.usage ?? { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: turn.firstByteMs ?? 1,
      };
    },
    async complete() {
      return "summary";
    },
  } as unknown as LlmSession;
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): LlmContentBlock {
  return { type: "tool_use", id, name, input } as LlmContentBlock;
}

function text(t: string): LlmContentBlock {
  return { type: "text", text: t } as LlmContentBlock;
}

/** `write` is deliberately outside PLAN_MODE_ALLOWLIST; `read` is inside it. */
const TOOLS: ToolSchema[] = [
  { name: "read", description: "read a file", input_schema: { type: "object", properties: {} } },
  { name: "write", description: "write a file", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

/** A checkpoint that resumes at turn 3 with nothing else going on. */
function checkpointAt(turn: number, extra: Partial<CheckpointState> = {}): CheckpointState {
  return {
    messages: [{ role: "user", content: "carry on" }],
    turns_completed: turn,
    usage: { input_tokens: 1, output_tokens: 1, cache_create: 0, cache_read: 0, turns: turn },
    text_parts: [],
    error_count: 0,
    tool_calls_by_name: {},
    total_tool_calls: 0,
    elapsed_ms_before: 1000,
    setup_commands: [],
    ...extra,
  } as CheckpointState;
}

function baseOpts(over: Record<string, unknown>): LoopOptions {
  return {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: 10,
    router: { route: async () => "ok", setHands: () => {} } as unknown as ToolRouter,
    onEvent: async () => {},
    sessionId: "sess-ckpt",
    userId: "user-1",
    ...over,
  } as unknown as LoopOptions;
}

test("plan mode is restored from the checkpoint, not from the request parameter", async () => {
  const offered: string[][] = [];
  await agentLoop(
    [{ role: "user", content: "hi" }],
    TOOLS,
    baseOpts({
      // The request says "not in plan mode" — the state that matters says otherwise.
      startInPlanMode: false,
      resumeFrom: checkpointAt(3, { plan_mode: true }),
      llmSession: scriptedSession(
        [{ content: [text("still planning")], stopReason: "end_turn" }],
        (_m, tools) => offered.push(tools.map((t) => t.name)),
      ),
    }),
  );

  assert.deepEqual(offered[0], ["read"],
    "a run resumed while in plan mode must keep the read-only allowlist");
});

test("a checkpoint written before plan_mode existed falls back to the request parameter", async () => {
  const offered: string[][] = [];
  await agentLoop(
    [{ role: "user", content: "hi" }],
    TOOLS,
    baseOpts({
      startInPlanMode: true,
      // No plan_mode key at all: the shape older writers produced.
      resumeFrom: checkpointAt(3),
      llmSession: scriptedSession(
        [{ content: [text("planning")], stopReason: "end_turn" }],
        (_m, tools) => offered.push(tools.map((t) => t.name)),
      ),
    }),
  );

  assert.deepEqual(offered[0], ["read"],
    "an absent plan_mode must not silently unlock write tools");
});

test("plan mode off in the checkpoint keeps write tools available", async () => {
  const offered: string[][] = [];
  await agentLoop(
    [{ role: "user", content: "hi" }],
    TOOLS,
    baseOpts({
      startInPlanMode: true,
      // Approved earlier via exit_plan_mode: resume must not re-lock it.
      resumeFrom: checkpointAt(3, { plan_mode: false }),
      llmSession: scriptedSession(
        [{ content: [text("executing")], stopReason: "end_turn" }],
        (_m, tools) => offered.push(tools.map((t) => t.name)),
      ),
    }),
  );

  assert.deepEqual(offered[0], ["read", "write"],
    "a run that already left plan mode must not be re-locked by a resume");
});

test("todo_state and rebuilds_used survive a resume and are written back", async () => {
  const todos = [{ id: "1", content: "first", status: "completed" },
                 { id: "2", content: "second", status: "in_progress" }];
  const seen: CheckpointState[] = [];

  await agentLoop(
    [{ role: "user", content: "hi" }],
    TOOLS,
    baseOpts({
      resumeFrom: checkpointAt(3, { todo_state: todos, rebuilds_used: 2 }),
      onCheckpoint: async (s: CheckpointState) => { seen.push(s); },
      llmSession: scriptedSession([
        { content: [toolUse("t1", "read")], stopReason: "tool_use" },
        { content: [text("done")], stopReason: "end_turn" },
      ]),
    }),
  );

  assert.ok(seen.length > 0, "a resumed run must still checkpoint");
  assert.deepEqual(seen[0]!.todo_state, todos, "the todo list must survive the resume");
  assert.equal(seen[0]!.rebuilds_used, 2,
    "the rebuild budget must carry over, otherwise it never binds");
});

test("the recovery budget carries across a resume while the sandbox stays broken", async () => {
  // Same argument as rebuilds_used, for the budget that bounds repairs which
  // leave the sandbox in place: one reset per resume would let a run
  // repair-without-progress indefinitely, a resume at a time.
  const seen: CheckpointState[] = [];

  await agentLoop(
    [{ role: "user", content: "hi" }],
    TOOLS,
    baseOpts({
      resumeFrom: checkpointAt(3, { recoveries_used: 2 }),
      onCheckpoint: async (s: CheckpointState) => { seen.push(s); },
      router: {
        route: async () => { throw new Error("sandbox still unreachable"); },
        setHands: () => {},
      } as unknown as ToolRouter,
      llmSession: scriptedSession([
        { content: [toolUse("t1", "read")], stopReason: "tool_use" },
        { content: [text("done")], stopReason: "end_turn" },
      ]),
    }),
  );

  assert.equal(seen[0]!.recoveries_used, 2,
    "an unrepaired sandbox must not have the budget handed back to it");
});

test("a sandbox tool that works again clears the recovery budget", async () => {
  // The other half of the rule, and why the budget bounds repetition without
  // progress rather than capping how many blips a long run may survive: a
  // sandbox call that answered is the evidence that the last repair worked.
  const seen: CheckpointState[] = [];

  await agentLoop(
    [{ role: "user", content: "hi" }],
    TOOLS,
    baseOpts({
      resumeFrom: checkpointAt(3, { recoveries_used: 2 }),
      onCheckpoint: async (s: CheckpointState) => { seen.push(s); },
      llmSession: scriptedSession([
        { content: [toolUse("t1", "read")], stopReason: "tool_use" },
        { content: [text("done")], stopReason: "end_turn" },
      ]),
    }),
  );

  assert.equal(seen[0]!.recoveries_used, 0,
    "a successful sandbox call means the repair held, so the budget resets");
});

test("a large tool_use input is bounded in history but the tool still receives it whole", async () => {
  const body = "x".repeat(200_000);
  let received = "";
  const seen: CheckpointState[] = [];

  await agentLoop(
    [{ role: "user", content: "hi" }],
    TOOLS,
    baseOpts({
      router: {
        route: async (_name: string, input: Record<string, unknown>) => {
          received = String(input.content ?? "");
          return "written";
        },
        setHands: () => {},
      } as unknown as ToolRouter,
      onCheckpoint: async (s: CheckpointState) => { seen.push(s); },
      llmSession: scriptedSession([
        { content: [toolUse("t1", "write", { path: "/workspace/big.txt", content: body })],
          stopReason: "tool_use" },
        { content: [text("done")], stopReason: "end_turn" },
      ]),
    }),
  );

  assert.equal(received, body, "truncation must happen on persist, never on dispatch");

  const persisted = seen.at(-1)!.messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []) as any[])
    .find((b) => b?.type === "tool_use");
  assert.ok(persisted, "the assistant tool_use block must be in the persisted history");
  assert.ok(persisted.input.content.length < body.length,
    "an oversized tool input must not reach the checkpoint verbatim");
  assert.equal(persisted.input.path, "/workspace/big.txt",
    "every input key must survive truncation so the schema still holds");
});

test("cancelling mid-batch stops dispatch but every tool_use still gets a result", async () => {
  const routed: string[] = [];
  const ac = new AbortController();
  const seen: CheckpointState[] = [];

  await agentLoop(
    [{ role: "user", content: "hi" }],
    TOOLS,
    baseOpts({
      signal: ac.signal,
      router: {
        route: async (name: string) => {
          routed.push(name);
          ac.abort();
          return "ok";
        },
        setHands: () => {},
      } as unknown as ToolRouter,
      onCheckpoint: async (s: CheckpointState) => { seen.push(s); },
      llmSession: scriptedSession([
        { content: [toolUse("t1", "read"), toolUse("t2", "read"), toolUse("t3", "read")],
          stopReason: "tool_use" },
        { content: [text("done")], stopReason: "end_turn" },
      ]),
    }),
  );

  assert.equal(routed.length, 1,
    "the abort must be observed between tool calls, not only at the turn boundary");
});
