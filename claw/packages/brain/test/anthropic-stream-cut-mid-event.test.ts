// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stream the gateway cuts in the middle of an event is retried, not fatal.
 *
 * Observed 2026-11-07 19:18Z on a review worker: LiteLLM's own upstream
 * connection closed while it was forwarding a `content_block_delta`, and its
 * pass-through wrote the error frame straight after the partial line. The SDK
 * read `{"type":"content_block_delta","index"data: {"error": ...` as one event,
 * `JSON.parse` threw "Expected ':' after property name in JSON at position 37",
 * and the bare SyntaxError was not one the loop retries: the run failed after
 * it had already approved and merged the PR, with its final report unwritten.
 *
 * The server below sends those bytes; the loop is then driven with the error
 * the real provider produced from them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Message, ToolSchema } from "@claw/protocol";

import { AnthropicProvider } from "../src/llm/anthropic-provider.js";
import type { LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";

const frame = (o: Record<string, unknown>) => `event: ${o.type as string}\ndata: ${JSON.stringify(o)}\n\n`;

/** The bytes the gateway sent: a clean start, then an event cut after `"index"` with the error frame on the same line. */
const CUT_MID_EVENT =
  frame({ type: "message_start", message: { model: "claude-x", usage: { input_tokens: 3, output_tokens: 0 } } })
  + frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  + frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Merged. " } })
  + 'event: content_block_delta\ndata: {"type":"content_block_delta","index"'
  + 'data: {"error": {"message": "Connection closed.\\n\\nhttpx.ReadError: Connection closed.\\n", "type": "None", "param": "None", "code": "500"}}\n\n';

async function withServer(body: string, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** What the real provider throws for the cut stream. */
async function cutStreamError(): Promise<any> {
  let caught: any;
  await withServer(CUT_MID_EVENT, async (baseUrl) => {
    const session = new AnthropicProvider().createSession({
      model: "claude-x", apiUrl: baseUrl, apiKey: "test-key", userId: "u1", sessionId: "s1",
    });
    // The SDK prints the unparsable event on its way out; keep it off the test output.
    const consoleError = console.error;
    console.error = () => {};
    try {
      await session.streamTurn([{ role: "user", content: "hi" }], []);
    } catch (err) {
      caught = err;
    } finally {
      console.error = consoleError;
    }
  });
  assert.ok(caught, "a stream cut mid-event must not be read as a finished turn");
  return caught;
}

test("an event cut mid-line by the gateway's error frame is reported as a truncated stream", async () => {
  const err = await cutStreamError();
  assert.equal(err.code, "STREAM_TRUNCATED");
  assert.ok(err.cause instanceof SyntaxError, "the parse error is kept as the cause");
  assert.match(String(err.message), /not valid JSON/);
});

test("the loop retries that turn and finishes with the reply from the retry", async (t) => {
  const cut = await cutStreamError();
  const usage = { input_tokens: 10, output_tokens: 1, cache_create: 0, cache_read: 0 };
  let calls = 0;
  const session: LlmSession = {
    async streamTurn() {
      calls++;
      if (calls === 1) throw cut;
      return { content: [{ type: "text", text: "report: approved and merged" }], stopReason: "end_turn",
        usage, firstByteMs: 1, promptTokens: 10 } as unknown as LlmTurnResult;
    },
    async complete() { return "summary"; },
  };
  const opts: LoopOptions = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 5, depth: 0,
    router: ({ route: async () => "tool ok", setHands: () => {} }) as unknown as ToolRouter,
    sessionId: "s-cut", userId: "u", llmSession: session,
    onEvent: async () => {},
  };
  // The retry waits out a backoff of seconds; advance the clock instead of sleeping.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const run = agentLoop([{ role: "user", content: "review it" } as Message], [] as ToolSchema[], opts)
    .finally(() => { settled = true; });
  for (let i = 0; i < 200 && !settled; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(10_000);
  }
  const result = await run;
  assert.equal(calls, 2, "the cut turn was asked again");
  assert.equal(result.finalText, "report: approved and merged");
});
