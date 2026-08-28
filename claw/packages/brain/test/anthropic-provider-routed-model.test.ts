// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Producer-side coverage for `routed_model`.
 *
 * routed-model.test.ts exercises the helpers in isolation, which proves the
 * branches work but not that anything reaches them: the header capture lives
 * in a `fetch` the provider installs on its SDK client, and the session id the
 * Auto Router pins on lives in a `defaultHeaders` entry. Neither is reachable
 * from a unit test, so both were previously deletable with the suite green.
 *
 * These drive the real `AnthropicProvider.createSession(...).streamTurn(...)`
 * against a local HTTP server, so the assertions fail if the production lines
 * that produce the header, the sink, or the resolved model are removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { AnthropicProvider } from "../src/llm/anthropic-provider.js";
import { LITELLM_ROUTED_MODEL_HEADER } from "../src/llm/routed-model.js";

/** Minimal well-formed Anthropic stream: one text block, clean stop_reason. */
function sseBody(bodyModel: string): string {
  const frame = (o: Record<string, unknown>) =>
    `event: ${o.type as string}\ndata: ${JSON.stringify(o)}\n\n`;
  return (
    frame({ type: "message_start", message: { model: bodyModel, usage: { input_tokens: 3, output_tokens: 0 } } })
    + frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })
    + frame({ type: "content_block_stop", index: 0 })
    + frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })
    + frame({ type: "message_stop" })
  );
}

interface Attempt {
  headers: http.IncomingHttpHeaders;
}

/**
 * Serve `responses` one per HTTP attempt, so a test can model the SDK's
 * internal retry (429 then 200) as two distinct attempts.
 */
async function withServer(
  responses: Array<{ status: number; routedHeader?: string; bodyModel?: string }>,
  run: (baseUrl: string, attempts: Attempt[]) => Promise<void>,
): Promise<void> {
  const attempts: Attempt[] = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    attempts.push({ headers: req.headers });
    const spec = responses[Math.min(i, responses.length - 1)];
    i++;
    const headers: Record<string, string> = { "content-type": "text/event-stream" };
    if (spec.routedHeader) headers[LITELLM_ROUTED_MODEL_HEADER] = spec.routedHeader;
    res.writeHead(spec.status, headers);
    if (spec.status >= 400) {
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "retry" } }));
      return;
    }
    res.end(sseBody(spec.bodyModel ?? "claude-auto"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, attempts);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function session(baseUrl: string, model = "claude-auto") {
  return new AnthropicProvider().createSession({
    model,
    apiUrl: baseUrl,
    apiKey: "test-key",
    userId: "u1",
    sessionId: "sess-42",
  });
}

test("the gateway header reaches routedModel", async () => {
  await withServer(
    [{ status: 200, routedHeader: "anthropic/claude-haiku-4-5", bodyModel: "claude-auto" }],
    async (baseUrl) => {
      const result = await session(baseUrl).streamTurn([{ role: "user", content: "hi" }], []);
      assert.equal(result.routedModel, "claude-haiku-4-5");
    },
  );
});

test("with no gateway header the body model is reported", async () => {
  await withServer(
    [{ status: 200, bodyModel: "claude-sonnet-4-20250514" }],
    async (baseUrl) => {
      const result = await session(baseUrl, "claude-sonnet-4-20250514")
        .streamTurn([{ role: "user", content: "hi" }], []);
      assert.equal(result.routedModel, "claude-sonnet-4-20250514");
    },
  );
});

test("every turn carries x-litellm-session-id, which is what session_affinity pins on", async () => {
  await withServer([{ status: 200 }], async (baseUrl, attempts) => {
    await session(baseUrl).streamTurn([{ role: "user", content: "hi" }], []);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].headers["x-litellm-session-id"], "sess-42");
  });
});

test("a retried turn reports the backend from the attempt that succeeded", async () => {
  // The SDK retries 429 internally. Recording the header from the failed
  // attempt would attribute the turn to a backend that served nothing.
  await withServer(
    [
      { status: 429, routedHeader: "anthropic/claude-opus-4-7" },
      { status: 200, routedHeader: "anthropic/claude-haiku-4-5", bodyModel: "claude-auto" },
    ],
    async (baseUrl, attempts) => {
      const result = await session(baseUrl).streamTurn([{ role: "user", content: "hi" }], []);
      assert.ok(attempts.length >= 2, `expected a retry, got ${attempts.length} attempt(s)`);
      assert.equal(result.routedModel, "claude-haiku-4-5");
    },
  );
});

test("a turn on a fresh session does not inherit a previous turn's backend", async () => {
  // The sink is per-session and long-lived; the reset before each attempt is
  // what stops a header-less turn from replaying the last one's backend.
  await withServer(
    [
      { status: 200, routedHeader: "anthropic/claude-opus-4-7", bodyModel: "claude-auto" },
      { status: 200, bodyModel: "claude-auto" },
    ],
    async (baseUrl) => {
      const s = session(baseUrl);
      const first = await s.streamTurn([{ role: "user", content: "hi" }], []);
      assert.equal(first.routedModel, "claude-opus-4-7");

      const second = await s.streamTurn([{ role: "user", content: "again" }], []);
      assert.equal(second.routedModel, "claude-auto");
    },
  );
});
