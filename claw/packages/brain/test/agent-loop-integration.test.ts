// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Integration tests for agentLoop(): the LLM turn cycle, tool dispatch and the
// interception points layered in front of the router (plugin hooks, HITL,
// todo_write, exit_plan_mode, ask_user_question).
//
// These drive the real loop end to end. Nothing here reaches the network: the
// LLM is a scripted LlmSession handed in through LoopOptions.llmSession, and the
// tool router is a plain object recording calls. Everything else the loop needs
// already arrived through LoopOptions.
//
// Not covered here, deliberately:
//   - streamTurnWithRetry backoff, which sleeps 5s/15s/30s between attempts and
//     would trade a real minute of wall clock for the assertion.
//   - the `task` sub-agent path, which constructs its own loop through
//     runSubagent and needs a second layer of fakes.
//   - sandbox rebuild, which needs a HandsClient stand-in.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import type { CheckpointState } from "../src/agent/index.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { beginRun, endRun, setParkHooks } from "../src/tasks/run-phase.js";

// ── fakes ────────────────────────────────────────────────────────────────────

/** An LLM that replays a fixed list of turns and records what it was asked. */
function scriptedSession(turns: Array<Partial<LlmTurnResult>>): LlmSession & {
  calls: Array<{ messages: Message[]; tools: ToolSchema[] }>;
} {
  const calls: Array<{ messages: Message[]; tools: ToolSchema[] }> = [];
  let i = 0;
  return {
    calls,
    async streamTurn(messages, tools) {
      // Deep-copy: the loop keeps mutating its working messages, so holding the
      // live array would make every recorded call look like the last one.
      calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools: [...tools] });
      const turn = turns[i++];
      if (!turn) throw new Error(`scripted session exhausted after ${i - 1} turns`);
      return {
        content: turn.content ?? [],
        stopReason: turn.stopReason ?? "end_turn",
        usage: turn.usage ?? { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: turn.firstByteMs ?? 1,
        ...(turn.routedModel ? { routedModel: turn.routedModel } : {}),
      };
    },
    async complete() {
      return "summary";
    },
  };
}

/** A router that records every routed call and returns a canned result. */
function recordingRouter(
  handler: (name: string, input: Record<string, unknown>) => string | Promise<string> = () => "ok",
): ToolRouter & { calls: Array<{ name: string; input: Record<string, unknown> }> } {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    route: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input: JSON.parse(JSON.stringify(input)) });
      return handler(name, input);
    },
    setHands: () => {},
  } as unknown as ToolRouter & { calls: Array<{ name: string; input: Record<string, unknown> }> };
}

function textBlock(text: string): LlmContentBlock {
  return { type: "text", text };
}
function thinkingBlock(thinking: string): LlmContentBlock {
  return { type: "thinking", thinking };
}
function toolUse(id: string, name: string, input: Record<string, unknown> = {}): LlmContentBlock {
  return { type: "tool_use", id, name, input };
}

const TOOLS: ToolSchema[] = [
  { name: "read", description: "read a file", input_schema: { type: "object", properties: {} } },
  { name: "write", description: "write a file", input_schema: { type: "object", properties: {} } },
  { name: "todo_write", description: "track todos", input_schema: { type: "object", properties: {} } },
  { name: "exit_plan_mode", description: "leave plan mode", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

type Ev = Record<string, unknown>;

/** Build LoopOptions with an event collector, overriding whatever the test needs. */
function makeOpts(over: Partial<LoopOptions> = {}): { opts: LoopOptions; events: Ev[] } {
  const events: Ev[] = [];
  const opts: LoopOptions = {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: 10,
    router: recordingRouter(),
    onEvent: async (e: unknown) => {
      events.push(e as Ev);
    },
    sessionId: "sess-1",
    userId: "user-1",
    ...over,
  };
  return { opts, events };
}

const toolEvents = (events: Ev[], status?: string) =>
  events.filter((e) => e.type === "toolUsed" && (status === undefined || e.status === status));

// ── the turn cycle ───────────────────────────────────────────────────────────

test("routes a tool call, feeds the result back, and stops on end_turn", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "read", { path: "/a.txt" })], stopReason: "tool_use" },
    { content: [textBlock("done reading")], stopReason: "end_turn" },
  ]);
  const router = recordingRouter(() => "file contents");
  const { opts, events } = makeOpts({ llmSession: session, router });

  const result = await agentLoop([{ role: "user", content: "read /a.txt" }], TOOLS, opts);

  assert.equal(result.finalText, "done reading");
  assert.equal(result.turns, 2);
  assert.equal(result.errorCount, 0);
  assert.deepEqual(result.toolStats, { total_calls: 1, error_calls: 0, by_tool: { read: 1 } });

  assert.deepEqual(router.calls, [{ name: "read", input: { path: "/a.txt" } }]);

  // The second turn must carry the tool_result back to the model, keyed to the
  // tool_use id. Getting this wrong is not a soft failure: the provider rejects
  // a tool_use with no matching result.
  const secondTurnMessages = session.calls[1].messages;
  const resultBlock = secondTurnMessages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b: unknown) => (b as Ev)?.type === "tool_result") as Ev | undefined;
  assert.ok(resultBlock, "second turn must include a tool_result block");
  assert.equal(resultBlock.tool_use_id, "t1");
  assert.equal(resultBlock.content, "file contents");

  const statuses = toolEvents(events).map((e) => e.status);
  assert.deepEqual(statuses, ["start", "success"]);
});

test("stops at maxTurns even when the model keeps requesting tools", async () => {
  const session = scriptedSession(
    Array.from({ length: 10 }, (_, i) => ({
      content: [toolUse(`t${i}`, "read")],
      stopReason: "tool_use",
    })),
  );
  const { opts } = makeOpts({ llmSession: session, maxTurns: 3, router: recordingRouter() });

  const result = await agentLoop([{ role: "user", content: "loop forever" }], TOOLS, opts);

  assert.equal(result.turns, 3);
  assert.equal(session.calls.length, 3);
});

test("an already-aborted signal stops the loop before calling the model", async () => {
  const session = scriptedSession([{ content: [textBlock("never runs")] }]);
  const ctrl = new AbortController();
  ctrl.abort();
  const { opts } = makeOpts({ llmSession: session, signal: ctrl.signal });

  const result = await agentLoop([{ role: "user", content: "hi" }], TOOLS, opts);

  assert.equal(session.calls.length, 0, "no LLM call once aborted");
  assert.equal(result.finalText, "");
});

test("accumulates token usage across turns", async () => {
  const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_create: 0, cache_read: 0 });
  const session = scriptedSession([
    { content: [toolUse("t1", "read")], stopReason: "tool_use", usage: usage(100, 10) },
    { content: [textBlock("bye")], stopReason: "end_turn", usage: usage(200, 20) },
  ]);
  const { opts } = makeOpts({ llmSession: session, router: recordingRouter() });

  const result = await agentLoop([{ role: "user", content: "hi" }], TOOLS, opts);

  assert.equal(result.tokenUsage.input_tokens, 300);
  assert.equal(result.tokenUsage.output_tokens, 30);
  assert.equal(result.tokenUsage.turns, 2);
});

// ── interception points in front of the router ───────────────────────────────

test("a PreToolUse hook that blocks keeps the tool from reaching the router", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "write", { path: "/etc/passwd" })], stopReason: "tool_use" },
    { content: [textBlock("understood")], stopReason: "end_turn" },
  ]);
  const router = recordingRouter();
  const hooks = {
    has: () => true,
    run: async () => ({ block: true, reason: "policy: no writes outside the workspace" }),
  };
  const { opts, events } = makeOpts({
    llmSession: session,
    router,
    hooks: hooks as unknown as LoopOptions["hooks"],
  });

  await agentLoop([{ role: "user", content: "write it" }], TOOLS, opts);

  assert.deepEqual(router.calls, [], "a blocked tool must never be routed");

  const errored = toolEvents(events, "error");
  assert.equal(errored.length, 1);
  assert.match(String(errored[0].description), /no writes outside the workspace/);

  // The model has to be told why, or it retries the same call forever.
  const feedback = session.calls[1].messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b: unknown) => (b as Ev)?.type === "tool_result") as Ev | undefined;
  assert.match(String(feedback?.content), /no writes outside the workspace/);
});

test("a PreToolUse hook can rewrite the tool input", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "write", { path: "/tmp/a", content: "raw" })], stopReason: "tool_use" },
    { content: [textBlock("ok")], stopReason: "end_turn" },
  ]);
  const router = recordingRouter();
  const hooks = {
    has: () => true,
    run: async () => ({ block: false, updatedInput: { path: "/tmp/a", content: "rewritten" } }),
  };
  const { opts } = makeOpts({
    llmSession: session,
    router,
    hooks: hooks as unknown as LoopOptions["hooks"],
  });

  await agentLoop([{ role: "user", content: "write" }], TOOLS, opts);

  assert.deepEqual(router.calls, [{ name: "write", input: { path: "/tmp/a", content: "rewritten" } }]);
});

test("HITL denial keeps the tool from reaching the router", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "write", { path: "/tmp/a" })], stopReason: "tool_use" },
    { content: [textBlock("ok")], stopReason: "end_turn" },
  ]);
  const router = recordingRouter();
  const hitl = {
    willAsk: () => true,
    beforeToolUse: async () => ({ action: "deny", reason: "user declined" }),
  };
  const { opts, events } = makeOpts({
    llmSession: session,
    router,
    hitl: hitl as unknown as LoopOptions["hitl"],
  });

  await agentLoop([{ role: "user", content: "write" }], TOOLS, opts);

  assert.deepEqual(router.calls, []);
  assert.match(String(toolEvents(events, "error")[0]?.description), /user declined/);
});

test("HITL approval with an edited input routes the edited input, not the original", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "write", { path: "/tmp/a", content: "original" })], stopReason: "tool_use" },
    { content: [textBlock("ok")], stopReason: "end_turn" },
  ]);
  const router = recordingRouter();
  const hitl = {
    willAsk: () => true,
    beforeToolUse: async () => ({ action: "allow", input: { path: "/tmp/a", content: "edited by user" } }),
  };
  const { opts } = makeOpts({
    llmSession: session,
    router,
    hitl: hitl as unknown as LoopOptions["hitl"],
  });

  await agentLoop([{ role: "user", content: "write" }], TOOLS, opts);

  assert.deepEqual(router.calls, [
    { name: "write", input: { path: "/tmp/a", content: "edited by user" } },
  ]);
});

test("a tool nobody has to approve does not park the run", async () => {
  // Approval is off by default and most tools are auto-allowed when it is on,
  // and that path returns without awaiting anything. Parking around it anyway
  // hands the pod's execution slot back and takes it again on every single tool
  // call -- which admits another run each time, so a busy pod fills to its
  // resident ceiling in sandboxes within seconds of turning approval on.
  const session = scriptedSession([
    { content: [toolUse("t1", "read", { path: "/a.txt" })], stopReason: "tool_use" },
    { content: [textBlock("ok")], stopReason: "end_turn" },
  ]);
  const parkEvents: string[] = [];
  setParkHooks({
    park: () => { parkEvents.push("park"); return true; },
    unpark: async () => { parkEvents.push("unpark"); },
  });
  const hitl = {
    willAsk: () => false,
    beforeToolUse: async (req: { input: Record<string, unknown> }) =>
      ({ action: "allow", input: req.input }),
  };
  const { opts } = makeOpts({
    llmSession: session,
    router: recordingRouter(() => "contents"),
    hitl: hitl as unknown as LoopOptions["hitl"],
    runKey: "run-parking",
  });

  beginRun("run-parking");
  try {
    await agentLoop([{ role: "user", content: "read" }], TOOLS, opts);
  } finally {
    endRun("run-parking");
    setParkHooks(null);
  }

  assert.deepEqual(parkEvents, [], "there was nothing to wait for");
});

test("hooks run before HITL, and a hook block means HITL is never consulted", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "write")], stopReason: "tool_use" },
    { content: [textBlock("ok")], stopReason: "end_turn" },
  ]);
  let hitlConsulted = false;
  const hooks = { has: () => true, run: async () => ({ block: true, reason: "denied by policy" }) };
  const hitl = {
    willAsk: () => true,
    beforeToolUse: async () => {
      hitlConsulted = true;
      return { action: "allow", input: {} };
    },
  };
  const { opts } = makeOpts({
    llmSession: session,
    router: recordingRouter(),
    hooks: hooks as unknown as LoopOptions["hooks"],
    hitl: hitl as unknown as LoopOptions["hitl"],
  });

  await agentLoop([{ role: "user", content: "write" }], TOOLS, opts);

  assert.equal(hitlConsulted, false, "no point asking a user to approve an already-blocked call");
});

// ── loop-intercepted tools ───────────────────────────────────────────────────

test("todo_write is handled inside the loop and never routed", async () => {
  const session = scriptedSession([
    {
      content: [toolUse("t1", "todo_write", {
        todos: [{ id: "a", content: "first", status: "pending" }],
      })],
      stopReason: "tool_use",
    },
    { content: [textBlock("tracked")], stopReason: "end_turn" },
  ]);
  const router = recordingRouter();
  const { opts, events } = makeOpts({ llmSession: session, router });

  await agentLoop([{ role: "user", content: "plan" }], TOOLS, opts);

  assert.deepEqual(router.calls, [], "todo_write is a loop concern, not a sandbox one");
  const ok = toolEvents(events, "success").find((e) => e.tool === "todo_write");
  assert.ok(ok, "todo_write should report success");
  assert.equal(ok.description, "1 todos updated");
});

test("todo_write with merge=false rejects items missing content or status", async () => {
  const session = scriptedSession([
    {
      content: [toolUse("t1", "todo_write", {
        merge: false,
        todos: [{ id: "a", content: "fine", status: "pending" }, { id: "b" }],
      })],
      stopReason: "tool_use",
    },
    { content: [textBlock("ok")], stopReason: "end_turn" },
  ]);
  const { opts, events } = makeOpts({ llmSession: session, router: recordingRouter() });

  await agentLoop([{ role: "user", content: "plan" }], TOOLS, opts);

  const err = toolEvents(events, "error").find((e) => e.tool === "todo_write");
  assert.ok(err, "an incomplete todo list must be rejected rather than half-applied");
  assert.match(String(err.description), /must include content and status/);
});

test("todo_write merges into existing state rather than replacing it", async () => {
  const session = scriptedSession([
    {
      content: [toolUse("t1", "todo_write", {
        todos: [
          { id: "a", content: "first", status: "pending" },
          { id: "b", content: "second", status: "pending" },
        ],
      })],
      stopReason: "tool_use",
    },
    {
      content: [toolUse("t2", "todo_write", {
        merge: true,
        todos: [{ id: "a", status: "completed" }],
      })],
      stopReason: "tool_use",
    },
    { content: [textBlock("done")], stopReason: "end_turn" },
  ]);
  const { opts, events } = makeOpts({ llmSession: session, router: recordingRouter() });

  await agentLoop([{ role: "user", content: "plan" }], TOOLS, opts);

  const updates = toolEvents(events, "success").filter((e) => e.tool === "todo_write");
  assert.equal(updates.length, 2);
  // A merge that dropped the untouched item would leave one todo here.
  const merged = (updates[1].argumentsDetail as Ev).todo_write as { todos: Array<Ev> };
  assert.equal(merged.todos.length, 2);
  assert.equal(merged.todos.find((t) => t.id === "a")?.status, "completed");
  assert.equal(merged.todos.find((t) => t.id === "b")?.status, "pending");
});

// ── plan mode ────────────────────────────────────────────────────────────────

test("plan mode hides write tools from the model until exit_plan_mode", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "exit_plan_mode", { plan: "the plan" })], stopReason: "tool_use" },
    { content: [textBlock("proceeding")], stopReason: "end_turn" },
  ]);
  const { opts } = makeOpts({
    llmSession: session,
    router: recordingRouter(),
    startInPlanMode: true,
  });

  await agentLoop([{ role: "user", content: "plan it" }], TOOLS, opts);

  const firstTurnTools = session.calls[0].tools.map((t) => t.name);
  assert.ok(firstTurnTools.includes("read"), "read is allowed while planning");
  assert.ok(!firstTurnTools.includes("write"), "write must be hidden while planning");

  // After exit_plan_mode the restriction lifts, otherwise the agent leaves plan
  // mode and still cannot act.
  const secondTurnTools = session.calls[1].tools.map((t) => t.name);
  assert.ok(secondTurnTools.includes("write"), "write becomes available after exiting plan mode");
});

// ── checkpointing and resume ─────────────────────────────────────────────────

function checkpoint(over: Partial<CheckpointState> = {}): CheckpointState {
  return {
    messages: [{ role: "user", content: "earlier work" }],
    turns_completed: 4,
    usage: { input_tokens: 50, output_tokens: 5, cache_create: 0, cache_read: 0, turns: 4 },
    text_parts: ["work so far"],
    error_count: 1,
    tool_calls_by_name: { read: 3 },
    total_tool_calls: 3,
    elapsed_ms_before: 1234,
    setup_commands: [],
    ...over,
  };
}

test("resuming from a checkpoint continues the prior run rather than restarting it", async () => {
  const session = scriptedSession([{ content: [textBlock("resumed")], stopReason: "end_turn" }]);
  const { opts } = makeOpts({ llmSession: session, resumeFrom: checkpoint() });

  const result = await agentLoop([{ role: "user", content: "ignored on resume" }], TOOLS, opts);

  assert.equal(result.turns, 1, "turns counts this run's work, not the resumed history");
  assert.equal(result.tokenUsage.input_tokens, 50, "usage carries over from the checkpoint");
  assert.equal(result.tokenUsage.turns, 5, "cumulative turn count includes the resumed turns");
  assert.equal(result.errorCount, 1, "prior errors are not forgotten on resume");
  assert.equal(result.toolStats.total_calls, 3, "prior tool calls are not forgotten on resume");
  // Text from before the interruption has to survive, or a resumed task returns
  // only the tail of its own answer.
  assert.match(result.finalText, /work so far/);
  assert.match(result.finalText, /resumed/);
});

test("resuming replays the checkpoint's messages, not the caller's original prompt", async () => {
  const session = scriptedSession([{ content: [textBlock("ok")], stopReason: "end_turn" }]);
  const { opts } = makeOpts({
    llmSession: session,
    resumeFrom: checkpoint({ messages: [{ role: "user", content: "the real history" }] }),
  });

  await agentLoop([{ role: "user", content: "stale prompt" }], TOOLS, opts);

  const sent = JSON.stringify(session.calls[0].messages);
  assert.match(sent, /the real history/);
  assert.ok(!sent.includes("stale prompt"), "the checkpoint supersedes the passed-in messages");
});

test("onCheckpoint fires with state that can be resumed from", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "read")], stopReason: "tool_use" },
    { content: [textBlock("done")], stopReason: "end_turn" },
  ]);
  const saved: CheckpointState[] = [];
  const { opts } = makeOpts({
    llmSession: session,
    router: recordingRouter(),
    onCheckpoint: async (s) => {
      // Copy: the loop keeps mutating its state after handing it over.
      saved.push(JSON.parse(JSON.stringify(s)));
    },
  });

  await agentLoop([{ role: "user", content: "go" }], TOOLS, opts);

  assert.ok(saved.length >= 1, "at least one checkpoint should be written");
  const last = saved[saved.length - 1];
  assert.ok(last.turns_completed >= 1);
  assert.ok(Array.isArray(last.text_parts));
  assert.ok(Array.isArray(last.messages) && last.messages.length > 0);
});

test("puts routed_model on AssistantMessage and ThinkingMessage", async () => {
  const session = scriptedSession([
    {
      content: [thinkingBlock("plan"), textBlock("hello")],
      stopReason: "end_turn",
      routedModel: "claude-haiku-4-5",
    },
  ]);
  const { opts, events } = makeOpts({ llmSession: session });

  await agentLoop([{ role: "user", content: "hi" }], TOOLS, opts);

  const thinking = events.find((e) => e.type === "ThinkingMessage") as Ev | undefined;
  const assistant = events.find((e) => e.type === "AssistantMessage") as Ev | undefined;
  assert.equal(thinking?.routed_model, "claude-haiku-4-5");
  assert.equal(assistant?.routed_model, "claude-haiku-4-5");
});

test("a turn that reported no model leaves routed_model off entirely", async () => {
  const session = scriptedSession([
    { content: [textBlock("hello")], stopReason: "end_turn" },
  ]);
  const { opts, events } = makeOpts({ llmSession: session });

  await agentLoop([{ role: "user", content: "hi" }], TOOLS, opts);

  const assistant = events.find((e) => e.type === "AssistantMessage") as Ev;
  assert.equal("routed_model" in assistant, false);
});

test("a tool-only turn emits nothing, whatever it routed to", async () => {
  // The turn carries a routed model and still produces no event of its own.
  // This is the whole blast radius of the feature: an extra content-less
  // AssistantMessage per tool-only turn would land on the wire, in
  // claw_session_events, and in every history replay -- and every attempt to
  // gate it on "a router chose this" has fired on deployments with no router,
  // because LiteLLM stamps x-litellm-model-name on everything it proxies.
  const session = scriptedSession([
    { content: [toolUse("t1", "read")], stopReason: "tool_use", routedModel: "claude-haiku-4-5" },
    { content: [textBlock("done")], stopReason: "end_turn", routedModel: "claude-opus-4-7" },
  ]);
  const { opts, events } = makeOpts({ llmSession: session, router: recordingRouter() });

  await agentLoop([{ role: "user", content: "read" }], TOOLS, opts);

  const assistants = events.filter((e) => e.type === "AssistantMessage") as Ev[];
  assert.equal(assistants.length, 1, "the tool-only turn must add no event");
  assert.deepEqual(assistants[0].data, { content: [{ type: "text", text: "done" }] });
  assert.equal(assistants[0].turn, 1);
  assert.equal(assistants[0].routed_model, "claude-opus-4-7");
  assert.equal(
    events.filter((e) => {
      const c = (e.data as { content?: unknown[] } | undefined)?.content;
      return e.type === "AssistantMessage" && Array.isArray(c) && c.length === 0;
    }).length,
    0,
    "no content-less AssistantMessage may reach the wire",
  );
});
