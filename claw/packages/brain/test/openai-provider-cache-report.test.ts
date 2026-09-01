// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// openai-provider-cache-report.test.ts
//
// The OpenAI path renders no cache markers -- toOpenAiMessages is not a 1:1
// mapping and collapses content to strings, so marking it is a separate and
// larger change. What it MUST do is tell the truth about what it can see, and
// that is what these pin.
//
// Both facts here were claimed by a commit message before they were true: the
// edit that was supposed to add them silently matched nothing and nobody
// noticed until the built image was grepped. A test is the difference.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import { buildOpenAiSession } from "../src/llm/openai-provider.js";

function stubClient(usage: Record<string, unknown>) {
  const bodies: Array<Record<string, any>> = [];
  return {
    bodies,
    client: {
      chat: { completions: { create: async (body: Record<string, any>) => {
        bodies.push(body);
        return {
          async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: "ok" }, finish_reason: null }] };
            yield { choices: [{ delta: {}, finish_reason: "stop" }], usage };
          },
        };
      } } },
    } as any,
  };
}

const MSGS: Message[] = [{ role: "user", content: "hello" }];

test("prompt size is reported as prompt_tokens, which already includes cached tokens", async () => {
  // Anthropic reports input_tokens as the UNCACHED REMAINDER and the whole
  // prompt is input + read + create. OpenAI's prompt_tokens is already the
  // whole thing, so adding the cache fields on top would double-count and
  // halve the effective compaction threshold on this path.
  const { client } = stubClient({
    prompt_tokens: 9_000, completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 8_000 },
  });
  const res = await buildOpenAiSession(client, "gpt-4o").streamTurn(MSGS, [] as ToolSchema[], undefined);
  assert.equal(res.usage.input_tokens, 9_000);
  assert.equal(res.usage.cache_read, 8_000);
  assert.equal(res.promptTokens, 9_000, "must not be input + read + create");
});

test("this path declares that it cannot observe cache writes", async () => {
  // usage.cache_create is initialised and never assigned here. Reporting that
  // structural zero as an observation is how "we cannot see writes" becomes
  // "there were no writes" once a dashboard averages it -- the exact shape of
  // the incident this work exists to prevent.
  const { client } = stubClient({
    prompt_tokens: 100, completion_tokens: 1,
    prompt_tokens_details: { cached_tokens: 40 },
  });
  const res = await buildOpenAiSession(client, "gpt-4o").streamTurn(MSGS, [] as ToolSchema[], undefined);
  const reported = [...(res.cacheReport?.reported ?? [])];
  assert.deepEqual(reported, ["cache_read"], "cache_create must not be claimed as observed");
  assert.equal(res.usage.cache_create, 0, "and it is indeed never assigned");
});

test("this path claims no breakpoints, because it renders none", async () => {
  const { client, bodies } = stubClient({ prompt_tokens: 10, completion_tokens: 1 });
  const res = await buildOpenAiSession(client, "gpt-4o").streamTurn(MSGS, [] as ToolSchema[], undefined);
  assert.equal(res.cacheReport?.breakpointsSent, 0);
  assert.equal(res.cacheReport?.enabled, false);
  assert.equal(
    JSON.stringify(bodies[0]).includes("cache_control"), false,
    "a marker here would be silently destroyed by the string collapse anyway",
  );
});

test("what the response reports is what gets claimed, not what the provider assumed", async () => {
  // Measured against the LiteLLM gateway this fleet talks to: an OpenAI-shaped
  // response carries the cache write in three places at once. Hardcoding
  // "this transport cannot report writes" was true of genuine OpenAI and false
  // of the deployment that matters, and a claim about the transport cannot be
  // right for both.
  const { client } = stubClient({
    prompt_tokens: 30037, completion_tokens: 4,
    cache_creation_input_tokens: 30028,
    cache_read_input_tokens: 0,
    prompt_tokens_details: {
      cached_tokens: 0,
      cache_creation_tokens: 30028,
      cache_creation_token_details: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 30028 },
    },
  });
  const res = await buildOpenAiSession(client, "claude-opus-4.5").streamTurn(MSGS, [] as ToolSchema[], undefined);
  assert.deepEqual([...(res.cacheReport?.reported ?? [])].sort(), ["cache_create", "cache_read"]);
  assert.equal(res.usage.cache_create, 30028);
  assert.equal(res.cacheReport?.createdEphemeral1h, 30028);
  assert.equal(res.cacheReport?.createdEphemeral5m, 0);
});

test("a backend that reports only reads claims only reads", async () => {
  // Genuine OpenAI: cached_tokens and nothing else. cache_create must stay
  // unclaimed rather than be reported as an observed zero.
  const { client } = stubClient({
    prompt_tokens: 100, completion_tokens: 1,
    prompt_tokens_details: { cached_tokens: 40 },
  });
  const res = await buildOpenAiSession(client, "gpt-4o").streamTurn(MSGS, [] as ToolSchema[], undefined);
  assert.deepEqual([...(res.cacheReport?.reported ?? [])], ["cache_read"]);
  assert.equal(res.usage.cache_read, 40);
});

test("a response with no cache fields at all claims nothing", async () => {
  const { client } = stubClient({ prompt_tokens: 50, completion_tokens: 1 });
  const res = await buildOpenAiSession(client, "gpt-4o").streamTurn(MSGS, [] as ToolSchema[], undefined);
  assert.deepEqual([...(res.cacheReport?.reported ?? [])], []);
});
