// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox that could not be opened for a retryable reason must reach the
 * task runner, not the model.
 *
 * `BRAIN_LAZY_SANDBOX` defaults to true and is true in the deployment, so an
 * ordinary chat turn starts with no sandbox and opens one at the first tool
 * that needs `/workspace`. That open happens inside the tool-dispatch `try` in
 * `agent-loop`, whose catch renders anything thrown as result text for the
 * model -- correct for a tool that ran and failed, wrong for an open that means
 * nothing ran at all.
 *
 * The cost is a lost redelivery. `ensureHands` raises
 * `DagHandleContendedError` for a lost CAS race precisely so `isRetryable` can
 * nak and have the message delivered again; on the eager path -- the runner
 * awaiting `attachHands` itself -- that works. On this path the class became a
 * sentence, the model read it, finished its turn, and the task was acked and
 * reported `failed: false`. Which of two paths raised it is not a distinction a
 * redelivery should turn on, and the default path was the one losing.
 *
 * Deliberately not "rethrow everything an open throws": a sandbox that cannot
 * be built for a permanent reason is still better told to the model as text,
 * and those are the majority. The line is `isRetryable`, the same function the
 * runner consults -- so the two paths cannot disagree about what deserves
 * another delivery.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { agentLoop } from "../src/agent/agent-loop.js";
import { attachOrWrap, SandboxAttachError } from "../src/agent/attach-error.js";
import { DagHandleContendedError } from "../src/sandbox/errors.js";
import type { LlmContentBlock, Message } from "../src/llm/types.js";
import type { ToolRouter } from "../src/tools/router.js";

const TOOLS = [{ name: "bash", description: "d", input_schema: { type: "object" as const } }];

function scriptedSession(
  turns: Array<{ content: LlmContentBlock[]; stopReason: string }>,
  seen?: Message[][],
) {
  let i = 0;
  return {
    async streamTurn(messages: Message[]) {
      seen?.push(structuredClone(messages));
      const turn = turns[i++];
      if (!turn) throw new Error(`scripted session exhausted after ${i - 1} turns`);
      return {
        content: turn.content,
        stopReason: turn.stopReason,
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: 1,
      };
    },
    async complete() { return "summary"; },
  };
}

/** One tool call, which fails the way `opts.fail` says, then a plain turn. */
async function runOneToolCall(fail: () => Error): Promise<
  { threw: unknown; toolText: string[] }
> {
  const prompts: Message[][] = [];
  const router = {
    route: async () => { throw fail(); },
    setHands: () => { /* no-op */ },
  } as unknown as ToolRouter;

  let threw: unknown = null;
  try {
    await agentLoop([{ role: "user", content: "read a file" }], TOOLS, {
      model: "test-model",
      apiUrl: "http://localhost:0",
      apiKey: "test-key",
      maxTurns: 3,
      router,
      onEvent: async () => { /* no-op */ },
      sessionId: "sess-lazy",
      userId: "user-1",
      llmSession: scriptedSession([
        { content: [{ type: "tool_use", id: "t1", name: "bash", input: {} } as LlmContentBlock], stopReason: "tool_use" },
        { content: [{ type: "text", text: "done" } as LlmContentBlock], stopReason: "end_turn" },
      ], prompts) as never,
      recreateHands: async () => ({ hands: {} as never, action: "rebuilt" as const }),
    } as never);
  } catch (e) {
    threw = e;
  }
  const toolText = (prompts.at(-1) ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .flatMap((b) => {
      const blk = b as { type?: string; text?: string; content?: unknown };
      if (blk?.type === "text" && typeof blk.text === "string") return [blk.text];
      if (blk?.type === "tool_result") return [JSON.stringify(blk.content ?? "")];
      return [];
    });
  return { threw, toolText };
}

test("a retryable open reaches the runner as the original error", async () => {
  const { threw } = await runOneToolCall(
    () => new SandboxAttachError(new DagHandleContendedError("5 attempts exhausted")),
  );
  assert.equal(
    (threw as Error | null)?.name, "DagHandleContendedError",
    "the loop rethrows the CAUSE, so the runner's isRetryable sees the class it classified",
  );
});

test("a permanent open is still told to the model", async () => {
  // The majority case, and the one that must not change: a sandbox that cannot
  // be built because its image does not exist is a fact the model can act on,
  // and spending a redelivery on it just repeats the failure.
  const { threw, toolText } = await runOneToolCall(
    () => new SandboxAttachError(new Error("sandbox_image 'nope:latest' not found")),
  );
  assert.equal(threw, null, "the turn continues");
  assert.equal(
    toolText.some((t) => t.includes("nope:latest")), true,
    "and the reason reaches the model as tool output",
  );
});

test("an ordinary retryable tool failure is still told to the model", async () => {
  // The narrowing that keeps this from becoming "retryable means fail the
  // task". A `fetch failed` out of a tool that RAN is a tool result; only an
  // open that never produced a sandbox is not. Without the SandboxAttachError
  // tag, every transient MCP hiccup would end its delivery instead of being
  // retried by the model -- and the recovery path that exists for exactly that
  // would never run.
  const { threw, toolText } = await runOneToolCall(() => new Error("fetch failed"));
  assert.equal(threw, null, "a tool that failed transiently does not end the delivery");
  assert.equal(toolText.length > 0, true, "the model is told");
});

test("the engine tags what the open threw, and keeps it", async () => {
  // Asserted here and not only through the loop: the class only works if it is
  // actually applied at the open, and a test that drove just the catch would
  // pass against an engine that had stopped wrapping.
  const cause = new DagHandleContendedError("5 attempts exhausted");
  const err = await attachOrWrap(async () => { throw cause; }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal((err as Error).name, "SandboxAttachError");
  assert.equal((err as { cause?: unknown }).cause, cause, "by identity, not by message");
  assert.equal(
    (err as Error).message, cause.message,
    "and the text still reads as the real failure for anything that logs it",
  );
  assert.equal(
    await attachOrWrap(async () => "client"), "client",
    "a successful open is passed straight through",
  );
});
