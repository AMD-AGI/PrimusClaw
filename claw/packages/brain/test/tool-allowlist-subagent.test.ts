// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sub-agent is no way around the run's `tools_allowlist`.
 *
 * `runSubagent` is driven directly with parent schemas that were NOT narrowed
 * (the engine narrows them, so through the engine this layer is invisible) and
 * with the allowlist alone, so each row can only pass if the sub-agent applies
 * the list itself: to the schemas it offers its model, to the calls it
 * receives, and, through the forwarded list, to the calls its own loop handles.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";

const { runSubagent } = await import("../src/agent/sub-agent.js");
const { parseToolAllowlist, toolNotAllowedMessage } = await import("../src/tools/allowlist.js");
const { AnthropicProvider } = await import("../src/llm/anthropic-provider.js");
const { OpenAiProvider } = await import("../src/llm/openai-provider.js");
type HandsClient = import("../src/clients/hands.js").HandsClient;
type LlmSession = import("../src/llm/provider.js").LlmSession;
type LlmTurnResult = import("../src/llm/provider.js").LlmTurnResult;
type LlmContentBlock = import("../src/llm/provider.js").LlmContentBlock;
type SubagentType = import("../src/agent/sub-agent.js").SubagentType;

const schema = (name: string): ToolSchema =>
  ({ name, description: name, input_schema: { type: "object", properties: {} } }) as unknown as ToolSchema;

/** What the parent holds: more than any one row lets the sub-agent have. */
const PARENT = ["bash", "read", "write", "todo_write", "mcp__board__ping", "mcp__other__x"].map(schema);

const originalAnthropic = AnthropicProvider.prototype.createSession;
const originalOpenAi = OpenAiProvider.prototype.createSession;
let current: ReturnType<typeof scriptedSession>;

function scriptedSession(turns: Array<{ content: LlmContentBlock[]; stopReason: string }>) {
  const calls: Array<{ messages: Message[]; tools: ToolSchema[] }> = [];
  let i = 0;
  const session: LlmSession & { calls: typeof calls } = {
    calls,
    async streamTurn(messages, tools) {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools: [...tools] });
      const turn = turns[i++];
      if (!turn) throw new Error(`scripted session exhausted after ${i - 1} turns`);
      return {
        content: turn.content, stopReason: turn.stopReason,
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      } as LlmTurnResult;
    },
    async complete() { return "summary"; },
  };
  return session;
}

before(() => {
  const create = () => current;
  AnthropicProvider.prototype.createSession = create as never;
  OpenAiProvider.prototype.createSession = create as never;
});
after(() => {
  AnthropicProvider.prototype.createSession = originalAnthropic;
  OpenAiProvider.prototype.createSession = originalOpenAi;
});

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): LlmContentBlock =>
  ({ type: "tool_use", id, name, input });

function fakeHands() {
  const calls: string[] = [];
  const hands = {
    callTool: async (name: string) => { calls.push(name); return "ran"; },
    callToolFull: async (name: string) => { calls.push(name); return { text: "ran", isError: false }; },
  } as unknown as HandsClient;
  return { hands, calls };
}

async function sub(over: {
  allowlist: unknown;
  type?: SubagentType;
  allowedTools?: string[];
  emit?: string[];
}) {
  const emit = over.emit ?? [];
  current = scriptedSession([
    ...(emit.length
      ? [{ content: emit.map((name, i) => toolUse(`t${i}`, name, name === "todo_write" ? { todos: [{ id: "a", content: "c", status: "pending" }] } : {})), stopReason: "tool_use" }]
      : []),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const { hands, calls } = fakeHands();
  await runSubagent({
    description: "d", prompt: "p",
    subagentType: over.type,
    allowedTools: over.allowedTools,
    parentSchemas: PARENT, hands,
    onEvent: async () => {},
    model: "m", apiUrl: "http://localhost:0", apiKey: "k",
    maxTurns: 4, sessionId: "sub", depth: 1,
    toolAllowlist: parseToolAllowlist(over.allowlist),
  });
  const offered = current.calls[0].tools.map((t) => t.name);
  const answered = (id: string): string => {
    const block = current.calls[1].messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b: unknown) => (b as { type?: string; tool_use_id?: string }).type === "tool_result"
        && (b as { tool_use_id?: string }).tool_use_id === id) as { content?: unknown } | undefined;
    return String(block?.content);
  };
  return { offered, calls, answered };
}

interface OfferRow {
  name: string;
  allowlist: unknown;
  type?: SubagentType;
  allowedTools?: string[];
  offered: string[];
}

const offerRows: OfferRow[] = [
  {
    name: "no field: the profile's own set, as before",
    allowlist: undefined,
    offered: ["bash", "read", "write", "todo_write", "mcp__board__ping", "mcp__other__x"],
  },
  { name: "an empty list: as before", allowlist: [], offered: ["bash", "read", "write", "todo_write", "mcp__board__ping", "mcp__other__x"] },
  { name: "exact names", allowlist: ["read", "mcp__board__ping"], offered: ["read", "mcp__board__ping"] },
  { name: "a prefix pattern", allowlist: ["mcp__board__*"], offered: ["mcp__board__ping"] },
  { name: "exact and prefix", allowlist: ["read", "mcp__board__*"], offered: ["read", "mcp__board__ping"] },
  // The profile can only narrow: shell may use bash, and the run's list does not name it.
  { name: "a profile cannot widen the list", allowlist: ["read"], type: "shell", offered: [] },
  { name: "the list cannot widen a profile", allowlist: ["bash", "read", "write"], type: "readonly", offered: ["read"] },
  { name: "the model's own narrowing cannot widen the list", allowlist: ["read"], allowedTools: ["bash", "read"], offered: ["read"] },
  { name: "a malformed list offers nothing", allowlist: "bash", offered: [] },
];

for (const row of offerRows) {
  test(`sub-agent offers: ${row.name}`, async () => {
    const r = await sub({ allowlist: row.allowlist, type: row.type, allowedTools: row.allowedTools });
    assert.deepEqual(r.offered, row.offered);
  });
}

test("sub-agent: a call outside the list is denied and reaches no sandbox", async () => {
  const r = await sub({ allowlist: ["read"], emit: ["bash"] });
  assert.deepEqual(r.calls, [], "the sandbox never saw bash");
  // The forwarded list turns it away in the sub-agent's own loop; the router's
  // guard behind it (built from the narrowed schemas) is the second line.
  assert.equal(r.answered("t0"), toolNotAllowedMessage("bash"));
});

test("sub-agent: a listed call runs", async () => {
  const r = await sub({ allowlist: ["read"], emit: ["read"] });
  assert.deepEqual(r.calls, ["read"]);
});

test("sub-agent: a call its own loop handles, outside the list, is refused there", async () => {
  const refused = await sub({ allowlist: ["read"], emit: ["todo_write"] });
  assert.equal(refused.answered("t0"), toolNotAllowedMessage("todo_write"));

  // With no list the same call is the loop's own, exactly as before.
  const open = await sub({ allowlist: undefined, emit: ["todo_write"] });
  assert.match(open.answered("t0"), /Todos have been modified successfully/);

  // And a list that names it leaves it alone.
  const listed = await sub({ allowlist: ["todo_write"], emit: ["todo_write"] });
  assert.match(listed.answered("t0"), /Todos have been modified successfully/);
});
