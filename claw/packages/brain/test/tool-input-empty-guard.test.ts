// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// tool-input-empty-guard.test.ts
//
// A tool_use carrying `{}` was rejected as "likely truncated" on both wires.
// It cannot mean truncation where the check sits: a cut stream leaves
// stop_reason null and is thrown one guard earlier, and a fragment that
// arrived but did not parse becomes `_raw` and is thrown one guard later.
// What was left was a model calling a no-required-argument tool correctly --
// `ls`, whose only property is optional and whose description names a default.
// Live, that failed the session after four retries, each of which reproduced
// the same legitimate call. Nothing in this repo covered the guard at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import { buildAnthropicSession } from "../src/llm/anthropic-provider.js";
import { requiredArgToolNames } from "../src/llm/tool-schema.js";

/** `ls`: every property optional, exactly as tools/router.ts publishes it. */
const LS: ToolSchema = {
  name: "ls",
  description: "List directory contents",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
} as ToolSchema;

/** `bash`: cannot do anything without its command -- the guard's real target. */
const BASH: ToolSchema = {
  name: "bash",
  description: "run",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
} as ToolSchema;

/** A stream whose tool_use block receives zero input_json_delta fragments. */
function toolStreamNoArgs(name: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { model: "claude-sonnet-5", usage: { input_tokens: 7 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t0", name, input: {} } };
      // No content_block_delta at all: the model asked for the tool's default.
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } };
      yield { type: "message_stop" };
    },
  };
}

function sessionFor(name: string, tools: ToolSchema[]) {
  const client = { messages: { create: async () => toolStreamNoArgs(name) } };
  const s = buildAnthropicSession(client as any, "claude-sonnet-5", {} as any);
  const msgs: Message[] = [{ role: "user", content: "list the workspace" }];
  return () => s.streamTurn(msgs, tools as any, undefined);
}

test("a no-argument call to a tool that requires none is delivered", async () => {
  const res = await sessionFor("ls", [LS, BASH])();
  const tu = res.content.find((b: any) => b.type === "tool_use") as any;
  assert.equal(tu.name, "ls");
  assert.deepEqual(tu.input, {}, "the empty input is the call, not a symptom");
});

test("a no-argument call to a tool that requires arguments is still rejected", async () => {
  await assert.rejects(sessionFor("bash", [LS, BASH])(), (e: any) => {
    assert.equal(e.code, "TOOL_INPUT_EMPTY");
    return true;
  });
});

test("the schema question is asked of the tool that was called", async () => {
  // bash requires arguments, but bash is not what the model called. A guard
  // keyed on "any tool requires arguments" would reject this too.
  const res = await sessionFor("ls", [BASH, LS])();
  assert.ok(res.content.some((b: any) => b.type === "tool_use"));
});

test("requiredArgToolNames reads both schema spellings and tolerates junk", () => {
  const got = requiredArgToolNames([
    LS,
    BASH,
    { name: "wire", function: { parameters: { required: ["q"] } } },
    { name: "emptyRequired", input_schema: { required: [] } },
    { name: "noSchema" },
    null,
    { description: "nameless" },
  ]);
  assert.deepEqual([...got].sort(), ["bash", "wire"]);
});

// ── The same guard on the OpenAI wire ────────────────────────────────────────
// It was edited in the same breath as the Anthropic one and would otherwise be
// covered by nothing: rule is that a guard lands on every path INTO the state,
// and a test that only walks one of them cannot say it did.

import { buildOpenAiSession } from "../src/llm/openai-provider.js";

/** A tool_call whose `arguments` never receive a fragment. */
function openAiClientCalling(name: string) {
  return {
    chat: { completions: { create: async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "t0", function: { name, arguments: "" } }] }, finish_reason: null }] };
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 1 } };
      },
    }) } },
  } as any;
}

test("openai wire: a no-argument call to a tool that requires none is delivered", async () => {
  const res = await buildOpenAiSession(openAiClientCalling("ls"), "gpt-4o")
    .streamTurn([{ role: "user", content: "list it" }], [LS, BASH] as any, undefined);
  const tu = res.content.find((b: any) => b.type === "tool_use") as any;
  assert.equal(tu.name, "ls");
  assert.deepEqual(tu.input, {});
});

test("openai wire: a no-argument call to a tool that requires arguments is still rejected", async () => {
  await assert.rejects(
    buildOpenAiSession(openAiClientCalling("bash"), "gpt-4o")
      .streamTurn([{ role: "user", content: "run it" }], [LS, BASH] as any, undefined),
    (e: any) => e.code === "TOOL_INPUT_EMPTY",
  );
});
