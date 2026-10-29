// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session whose stored tool call carried an input that is not a JSON object
 * never answers again: history is replayed in full on every turn, the model
 * endpoint refuses the whole request ("function.arguments must be a JSON
 * object"), and nothing in the session can change what was stored.
 *
 * The concrete trigger: Brain's redactor replaced the whole `argumentsDetail`
 * entry with the string "<redacted>" for a tool named like a credential field
 * (`mcp__safe__apikey_list`). reconstructHistory used that string as the
 * tool_use input. These rows feed it every shape a stored input can take and
 * require the replay to be valid, with the tool_result pairing intact.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { reconstructHistory } = await import("../src/sessions/context-builder.js");

type Block = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function replay(argumentsDetail: unknown, extra: Record<string, unknown> = {}) {
  const turns = [
    {
      role: "assistant",
      content: "done",
      tool_calls: [
        { type: "toolUsed", tool: "mcp__safe__apikey_list", actionId: "call_1", status: "start", argumentsDetail, ...extra },
        { type: "toolUsed", tool: "bash", actionId: "call_2", status: "start", argumentsDetail: { bash: { command: "ls" } } },
      ],
      tool_results: [
        { type: "toolUsed", tool: "mcp__safe__apikey_list", actionId: "call_1", status: "success", description: "ok-1" },
        { type: "toolUsed", tool: "bash", actionId: "call_2", status: "success", description: "ok-2" },
      ],
    },
  ];
  return reconstructHistory(turns, 100_000);
}

const shapes: Array<{ name: string; detail: unknown; want: Record<string, unknown> }> = [
  // The exact stored shape of the failing session.
  { name: "redaction placeholder string", detail: { mcp__safe__apikey_list: "<redacted>" }, want: { value: "<redacted>" } },
  { name: "public-API placeholder string", detail: { mcp__safe__apikey_list: "[REDACTED]" }, want: { value: "[REDACTED]" } },
  { name: "JSON string holding an object", detail: { mcp__safe__apikey_list: '{"limit":5}' }, want: { limit: 5 } },
  { name: "empty string", detail: { mcp__safe__apikey_list: "" }, want: {} },
  { name: "array", detail: { mcp__safe__apikey_list: [1, 2] }, want: { value: [1, 2] } },
  { name: "empty array", detail: { mcp__safe__apikey_list: [] }, want: {} },
  { name: "number", detail: { mcp__safe__apikey_list: 3 }, want: { value: 3 } },
  { name: "null", detail: { mcp__safe__apikey_list: null }, want: {} },
  { name: "key absent", detail: {}, want: {} },
  { name: "argumentsDetail absent", detail: undefined, want: {} },
  { name: "plain object", detail: { mcp__safe__apikey_list: { limit: 5 } }, want: { limit: 5 } },
];

for (const c of shapes) {
  test(`reconstructHistory replays a valid tool_use for: ${c.name}`, () => {
    const msgs = replay(c.detail);
    assert.equal(msgs.length, 2, "assistant + tool_result user message");
    const assistant = msgs[0].content as Block[];
    const toolUses = assistant.filter((b) => b.type === "tool_use");
    assert.equal(toolUses.length, 2);
    for (const tu of toolUses) {
      assert.ok(isObject(tu.input), `tool_use ${String(tu.id)} input must be an object`);
      // What the OpenAI wire sends: it must decode to an object.
      assert.ok(isObject(JSON.parse(JSON.stringify(tu.input))));
    }
    assert.deepEqual(toolUses[0].input, c.want);
    assert.deepEqual(toolUses[1].input, { command: "ls" });

    // The pairing is what makes the replay valid at all.
    const results = (msgs[1].content as Block[]).filter((b) => b.type === "tool_result");
    assert.deepEqual(results.map((r) => r.tool_use_id), ["call_1", "call_2"]);
    assert.deepEqual(results.map((r) => r.content), ["ok-1", "ok-2"]);
  });
}

test("a legacy stored `input` field is coerced as well", () => {
  const turns = [{
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c1", name: "t", input: "not json" }],
    tool_results: [{ id: "c1", content: "r" }],
  }];
  const msgs = reconstructHistory(turns, 100_000);
  const tu = (msgs[0].content as Block[]).find((b) => b.type === "tool_use")!;
  assert.deepEqual(tu.input, { value: "not json" });
});
