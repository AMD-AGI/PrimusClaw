// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * OpenAI-side twin of anthropic-provider-routed-model.test.ts.
 *
 * Both providers carry the same two production lines — the capturing `fetch`
 * and the `x-litellm-session-id` header — and a guard written while editing
 * one provider lands only on that provider. These pin the OpenAI copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { OpenAiProvider } from "../src/llm/openai-provider.js";
import { LITELLM_ROUTED_MODEL_HEADER } from "../src/llm/routed-model.js";

function sseBody(bodyModel: string): string {
  const chunk = (o: Record<string, unknown>) => `data: ${JSON.stringify(o)}\n\n`;
  return (
    chunk({ id: "1", model: bodyModel, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })
    + chunk({ id: "1", model: bodyModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    + "data: [DONE]\n\n"
  );
}

async function withServer(
  spec: { routedHeader?: string; bodyModel?: string },
  run: (baseUrl: string, headers: http.IncomingHttpHeaders[]) => Promise<void>,
): Promise<void> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const headers: Record<string, string> = { "content-type": "text/event-stream" };
    if (spec.routedHeader) headers[LITELLM_ROUTED_MODEL_HEADER] = spec.routedHeader;
    res.writeHead(200, headers);
    res.end(sseBody(spec.bodyModel ?? "claude-auto"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function session(baseUrl: string, model = "claude-auto") {
  return new OpenAiProvider().createSession({
    model,
    apiUrl: baseUrl,
    apiKey: "test-key",
    userId: "u1",
    sessionId: "sess-42",
  });
}

test("openai provider reports the gateway header", async () => {
  await withServer({ routedHeader: "anthropic/claude-haiku-4-5" }, async (baseUrl) => {
    const result = await session(baseUrl).streamTurn([{ role: "user", content: "hi" }], []);
    assert.equal(result.routedModel, "claude-haiku-4-5");
  });
});

test("openai provider reports a header-less turn from the body", async () => {
  await withServer({ bodyModel: "gpt-4o" }, async (baseUrl) => {
    const result = await session(baseUrl, "gpt-4o").streamTurn([{ role: "user", content: "hi" }], []);
    assert.equal(result.routedModel, "gpt-4o");
  });
});

test("openai provider sends x-litellm-session-id", async () => {
  await withServer({}, async (baseUrl, seen) => {
    await session(baseUrl).streamTurn([{ role: "user", content: "hi" }], []);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]["x-litellm-session-id"], "sess-42");
  });
});
