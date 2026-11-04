// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sub-agent that uses every turn it was given still answers its caller.
 *
 * Its caller reads only its final text. A review's second pass that spent its 20 turns reading
 * and running checks ended on a tool call and returned nothing, and the main loop approved on the
 * empty answer. Such a sub-agent is now asked once more, for its findings in text, and nothing it
 * calls in that reply is run. A sub-agent that finished on its own, and a top-level run, are not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";

const usage = { input_tokens: 10, output_tokens: 1, cache_create: 0, cache_read: 0 };
const call = (id: string, text?: string) => ({
  content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id, name: "bash", input: { command: "true" } }],
  stopReason: "tool_use",
});
const say = (text: string) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

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

function run(turns: Array<{ content: unknown[]; stopReason: string }>, depth: number) {
  const { session, sent } = scripted(turns);
  const routed: string[] = [];
  const opts: LoopOptions = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 2, depth,
    router: ({ route: async (name: string) => { routed.push(name); return "tool ok"; }, setHands: () => {} }) as unknown as ToolRouter,
    sessionId: "s-cap", userId: "u", llmSession: session, onEvent: async () => {},
  };
  return { sent, routed, result: agentLoop([{ role: "user", content: "review it" } as Message], [] as ToolSchema[], opts) };
}

const isCapNotice = (m: Message) => m.role === "user" && typeof m.content === "string"
  && m.content.startsWith("[system-notice]: You have used every turn you were given");

test("a sub-agent cut off by its turn cap is asked for its findings, and that is its answer", async () => {
  const { sent, routed, result } = run([call("t1"), call("t2"), call("t3", "Found: drain releases the lease and leaves the queue.")], 1);
  const r = await result;
  assert.equal(sent.length, 3, "one reply asked for past the cap");
  assert.ok(isCapNotice(sent[2].at(-1)!), "the last request tells it the turns are used up");
  assert.equal(routed.length, 2, "the tool call in that reply was not run");
  assert.equal(r.finalText, "Found: drain releases the lease and leaves the queue.");
});

test("a sub-agent that finished within its turns is not asked again", async () => {
  const { sent, result } = run([call("t1"), say("No issues.")], 1);
  assert.equal((await result).finalText, "No issues.");
  assert.equal(sent.length, 2);
  assert.ok(!sent.flat().some(isCapNotice));
});

test("a top-level run that reaches its cap is not asked for a report", async () => {
  const { sent, result } = run([call("t1"), call("t2")], 0);
  await result;
  assert.equal(sent.length, 2);
  assert.ok(!sent.flat().some(isCapNotice));
});
