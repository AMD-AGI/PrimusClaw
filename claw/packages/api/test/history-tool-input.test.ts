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
    assert.equal(msgs.length, 5, "each call and its result, in turn, then the turn's text");
    const toolUses = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.content))
      .flatMap((m) => (m.content as Block[]).filter((b) => b.type === "tool_use"));
    assert.equal(toolUses.length, 2);
    for (const tu of toolUses) {
      assert.ok(isObject(tu.input), `tool_use ${String(tu.id)} input must be an object`);
      // What the OpenAI wire sends: it must decode to an object.
      assert.ok(isObject(JSON.parse(JSON.stringify(tu.input))));
    }
    assert.deepEqual(toolUses[0].input, c.want);
    assert.deepEqual(toolUses[1].input, { command: "ls" });

    // The pairing is what makes the replay valid at all: every tool_result right after its tool_use.
    for (let i = 0; i < 4; i += 2) {
      const use = (msgs[i].content as Block[])[0];
      const result = (msgs[i + 1].content as Block[])[0];
      assert.equal(msgs[i].role, "assistant");
      assert.equal(msgs[i + 1].role, "user");
      assert.equal(result.type, "tool_result");
      assert.equal(result.tool_use_id, use.id);
    }
    const results = msgs.filter((m) => m.role === "user").flatMap((m) => (m.content as Block[]).filter((b) => b.type === "tool_result"));
    assert.deepEqual(results.map((r) => r.tool_use_id), ["call_1", "call_2"]);
    assert.deepEqual(results.map((r) => r.content), ["ok-1", "ok-2"]);
  });
}

test("a turn that looked something up and then answered replays in that order: the answer after the lookup's result", () => {
  // The router's turn of 2026-11-07 (E230 #14): a GitHub search, then say with the answer, then the turn's final text. Replayed as
  // one message with the text first and both calls side by side, the next turn read its answer as written before the search
  // returned and told the user to distrust it.
  const msgs = reconstructHistory([
    {
      role: "assistant",
      content: "22 open pull requests",
      tool_calls: [
        { type: "toolUsed", tool: "mcp__github__issue_search", actionId: "s1", status: "start", argumentsDetail: { mcp__github__issue_search: { q: "is:pr is:open author:@me" } } },
        { type: "toolUsed", tool: "mcp__assistant__say", actionId: "s2", status: "start", argumentsDetail: { mcp__assistant__say: { text: "22 open pull requests" } } },
      ],
      tool_results: [
        { type: "toolUsed", tool: "mcp__github__issue_search", actionId: "s1", status: "success", description: "total_count 22" },
        { type: "toolUsed", tool: "mcp__assistant__say", actionId: "s2", status: "success", description: "said" },
      ],
    },
    { role: "user", content: "how many pull requests do I have open" },
  ], 100_000);
  const shape = msgs.map((m) => `${m.role}:${typeof m.content === "string" ? "text" : (m.content as Block[]).map((b) => b.type === "tool_use" ? `use(${String(b.name)})` : b.type === "tool_result" ? `result(${String(b.tool_use_id)})` : String(b.type)).join(",")}`);
  assert.deepEqual(shape, [
    "user:text",
    "assistant:use(mcp__github__issue_search)", "user:result(s1)",
    "assistant:use(mcp__assistant__say)", "user:result(s2)",
    "assistant:text",
  ]);
});

test("a turn whose calls have no stored results still pairs each call with a result", () => {
  const msgs = reconstructHistory([{
    role: "assistant", content: "", tool_calls: [{ type: "toolUsed", tool: "web_search", actionId: "w1", status: "start" }], tool_results: [],
  }], 100_000);
  assert.equal(msgs.length, 2);
  assert.equal(((msgs[1].content as Block[])[0]).tool_use_id, "w1");
  assert.equal(((msgs[1].content as Block[])[0]).content, "");
});

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
