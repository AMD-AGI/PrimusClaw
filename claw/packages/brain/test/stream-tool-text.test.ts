// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A tool call's `text` read while the model writes it (`StreamTurnOptions.toolText`): the partial-JSON reader, what the Anthropic
 * session sends and reports, and what the loop publishes (`toolTextDelta`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolSchema } from "@claw/protocol";
import { partialStringField } from "../src/llm/partial-json.js";
import { buildAnthropicSession } from "../src/llm/anthropic-provider.js";

test("the text field of a JSON object still being written is read as far as it has arrived", () => {
  assert.equal(partialStringField('{"text": "Hel', "text"), "Hel");
  assert.equal(partialStringField('{"item_id":"#3","text":"a\\nb', "text"), "a\nb");
  assert.equal(partialStringField('{"text":"done"}', "text"), "done");
  // Not started, not a string, or not an object at all: nothing.
  assert.equal(partialStringField('{"te', "text"), null);
  assert.equal(partialStringField('{"text"', "text"), null);
  assert.equal(partialStringField('{"text": ', "text"), null);
  assert.equal(partialStringField('{"text": 12}', "text"), null);
  assert.equal(partialStringField('["text", "x"]', "text"), null);
  assert.equal(partialStringField("", "text"), null);
});

test("only the outer object's field is the text: a nested one, or the word inside another value, is not", () => {
  assert.equal(partialStringField('{"meta": {"text": "inner"}, "text": "outer', "text"), "outer");
  assert.equal(partialStringField('{"note": "the \\"text\\": field", "text": "real', "text"), "real");
  assert.equal(partialStringField('{"list": ["text", {"text": "no"}], "text": "yes"}', "text"), "yes");
  // The field has not come yet while an earlier value is still open.
  assert.equal(partialStringField('{"meta": {"text": "inner"', "text"), null);
  assert.equal(partialStringField('{"note": "text', "text"), null);
});

test("an escape cut off at the end waits for the rest, so every value read is a prefix of the final one", () => {
  const final = 'He said "hi"\\ 你好 😀 é\tend\n';
  const json = JSON.stringify({ item_id: "#12", text: final, extra: { text: "x" } });
  // The model's own escaping too: a \uXXXX form of every non-ASCII character, surrogate pairs included.
  const escaped = json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  for (const s of [json, escaped]) {
    let last = "";
    for (let i = 0; i <= s.length; i++) {
      const got = partialStringField(s.slice(0, i), "text");
      if (got === null) continue;
      assert.ok(final.startsWith(got), `prefix ${i} of ${s === json ? "plain" : "escaped"} gave ${JSON.stringify(got)}`);
      // Never half a character: a surrogate pair whose second half has not arrived is not shown at all.
      assert.ok(got.isWellFormed(), `prefix ${i} ends inside a character`);
      assert.ok(got.length >= last.length, "the text never shrinks");
      last = got;
    }
    assert.equal(last, final);
  }
});

/** A stream whose one tool call's arguments arrive in `parts`, as `input_json_delta` events. */
function toolStream(name: string, parts: string[], id = "toolu_1") {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { model: "m", usage: { input_tokens: 3 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } };
      for (const p of parts) yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: p } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } };
      yield { type: "message_stop" };
    },
  };
}

const CLAUDE = "claude-sonnet-5.5";
const TOOLS: ToolSchema[] = [
  { name: "mcp__assistant__say", description: "say", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "mcp__safe__node_list", description: "nodes", input_schema: { type: "object" } },
];

function stub(stream: unknown) {
  const bodies: Array<Record<string, any>> = [];
  const client = { messages: { create: async (body: Record<string, any>) => { bodies.push(structuredClone(body)); return stream; } } };
  return { client: client as any, bodies };
}

test("a streamed tool is sent with eager input streaming and its text is reported as it grows; the call is whole at the end", async () => {
  const parts = ['{"te', 'xt": "Nodes: ', "12 rea", 'dy, 3 \\', 'u4e0d', ' busy"}'];
  const { client, bodies } = stub(toolStream("mcp__assistant__say", parts));
  const seen: Array<{ id: string; name: string; text: string }> = [];
  const res = await buildAnthropicSession(client, CLAUDE).streamTurn([{ role: "user", content: "q" }], TOOLS, undefined, {
    toolText: { tools: new Set(["mcp__assistant__say"]), onText: (c) => seen.push(c) },
  });
  assert.deepEqual(seen.map((s) => s.text), ["Nodes: ", "Nodes: 12 rea", "Nodes: 12 ready, 3 ", "Nodes: 12 ready, 3 不", "Nodes: 12 ready, 3 不 busy"]);
  assert.ok(seen.every((s) => s.id === "toolu_1" && s.name === "mcp__assistant__say"));
  assert.deepEqual((res.content[0] as any).input, { text: "Nodes: 12 ready, 3 不 busy" });
  const sent = bodies[0].tools as Array<Record<string, unknown>>;
  assert.equal(sent.find((t) => t.name === "mcp__assistant__say")?.eager_input_streaming, true);
  assert.equal("eager_input_streaming" in sent.find((t) => t.name === "mcp__safe__node_list")!, false);
});

test("without the option, or for a tool it does not name, nothing is reported and the request is as before", async () => {
  const parts = ['{"text": "a', 'b"}'];
  for (const options of [undefined, { toolText: { tools: new Set(["mcp__assistant__say"]), onText: () => assert.fail("not named") } }]) {
    const { client, bodies } = stub(toolStream(options ? "mcp__safe__node_list" : "mcp__assistant__say", parts));
    await buildAnthropicSession(client, CLAUDE).streamTurn([{ role: "user", content: "q" }], TOOLS, undefined, options);
    const sayTool = (bodies[0].tools as Array<Record<string, unknown>>).find((t) => t.name === "mcp__assistant__say")!;
    assert.equal("eager_input_streaming" in sayTool, options !== undefined);
  }
});

test("a model that is not Claude is asked for nothing new and reports no text", async () => {
  const { client, bodies } = stub(toolStream("mcp__assistant__say", ['{"text": "a', 'b"}']));
  const res = await buildAnthropicSession(client, "gpt-4o").streamTurn([{ role: "user", content: "q" }], TOOLS, undefined, {
    toolText: { tools: new Set(["mcp__assistant__say"]), onText: () => assert.fail("no text from a model that was not asked to stream it") },
  });
  assert.ok((bodies[0].tools as Array<Record<string, unknown>>).every((t) => !("eager_input_streaming" in t)));
  assert.deepEqual((res.content[0] as any).input, { text: "ab" });
});

test("a reader that throws does not end the turn", async () => {
  const { client } = stub(toolStream("mcp__assistant__say", ['{"text": "x', 'y"}']));
  const res = await buildAnthropicSession(client, CLAUDE).streamTurn([{ role: "user", content: "q" }], TOOLS, undefined, {
    toolText: { tools: new Set(["mcp__assistant__say"]), onText: () => { throw new Error("reader broke"); } },
  });
  assert.deepEqual((res.content[0] as any).input, { text: "xy" });
});
