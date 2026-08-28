// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LITELLM_ROUTED_MODEL_HEADER,
  headerModelFromStream,
  resolveRoutedModel,
  wrapFetchCaptureRoutedModel,
} from "../src/llm/routed-model.js";

test("resolveRoutedModel prefers the LiteLLM header over the body alias", () => {
  assert.equal(
    resolveRoutedModel({
      bodyModel: "claude-auto",
      headerModel: "anthropic/claude-haiku-4-5",
    }),
    "claude-haiku-4-5",
  );
});

test("resolveRoutedModel uses the body model when the header is absent", () => {
  assert.equal(
    resolveRoutedModel({ bodyModel: "claude-sonnet-4-20250514" }),
    "claude-sonnet-4-20250514",
  );
});

test("resolveRoutedModel reports nothing when neither source named a model", () => {
  // Deliberately no fall back to the requested model: `routed_model` means
  // "the backend that served this turn", so echoing the alias back would be
  // a lie precisely when nothing reported a backend.
  assert.equal(resolveRoutedModel({}), undefined);
});

test("resolveRoutedModel treats blank strings as missing", () => {
  assert.equal(resolveRoutedModel({ bodyModel: "   ", headerModel: "" }), undefined);
});

test("resolveRoutedModel falls through a blank header to the body model", () => {
  assert.equal(
    resolveRoutedModel({ bodyModel: "claude-opus-4-7", headerModel: "  " }),
    "claude-opus-4-7",
  );
});

// ── provider prefix stripping ───────────────────────────────────────────────
//
// The prefix list is closed on purpose. Testing "looks like a lowercase
// identifier" also matches a Hugging Face org, so `Qwen/Qwen3-235B` lost its
// org while `deepseek-ai/DeepSeek-V3` kept one, purely because a hyphen failed
// the pattern -- same class of id, opposite result, and on a vLLM/SGLang
// backend the surviving value is not a model id anyone can reconcile.

test("a LiteLLM provider prefix is stripped", () => {
  for (const [raw, want] of [
    ["anthropic/claude-haiku-4-5", "claude-haiku-4-5"],
    ["openai/gpt-4o", "gpt-4o"],
    ["hosted_vllm/Qwen3-32B", "Qwen3-32B"],
    ["vertex_ai/gemini-2.0-flash", "gemini-2.0-flash"],
    ["bedrock/anthropic.claude-v2", "anthropic.claude-v2"],
  ] as const) {
    assert.equal(resolveRoutedModel({ headerModel: raw }), want, raw);
  }
});

test("an org/model id keeps its org, whatever punctuation it uses", () => {
  for (const raw of [
    "Qwen/Qwen3-235B",
    "mistralai/Mixtral-8x7B-Instruct-v0.1",
    "deepseek-ai/DeepSeek-V3",
    "meta-llama/Llama-3.3-70B",
    "nvidia/Llama-3.1-Nemotron-70B-Instruct",
  ]) {
    assert.equal(resolveRoutedModel({ headerModel: raw }), raw, raw);
  }
});

test("only the provider segment goes, not every segment", () => {
  assert.equal(
    resolveRoutedModel({ headerModel: "hosted_vllm/Qwen/Qwen3-235B" }),
    "Qwen/Qwen3-235B",
  );
});

test("headerModelFromStream reads x-litellm-model-name from a Response", () => {
  const stream = {
    response: new Response(null, {
      headers: { [LITELLM_ROUTED_MODEL_HEADER]: "anthropic/claude-opus-4-7" },
    }),
  };
  assert.equal(headerModelFromStream(stream), "anthropic/claude-opus-4-7");
});

test("headerModelFromStream ignores streams without a Response", () => {
  assert.equal(headerModelFromStream({}), undefined);
  assert.equal(headerModelFromStream(undefined), undefined);
});

test("wrapFetchCaptureRoutedModel records the header from the HTTP response", async () => {
  const sink: { headerModel?: string } = {};
  const fetchImpl = wrapFetchCaptureRoutedModel(sink, async () =>
    new Response("ok", { headers: { [LITELLM_ROUTED_MODEL_HEADER]: "anthropic/claude-haiku-4-5" } }),
  );
  await fetchImpl("https://example.invalid/v1/messages");
  assert.equal(sink.headerModel, "anthropic/claude-haiku-4-5");
});

test("wrapFetchCaptureRoutedModel does not record the header from an error response", async () => {
  const sink: { headerModel?: string } = { headerModel: "stale" };
  const fetchImpl = wrapFetchCaptureRoutedModel(sink, async () =>
    new Response("retry", {
      status: 429,
      headers: { [LITELLM_ROUTED_MODEL_HEADER]: "anthropic/claude-haiku-4-5" },
    }),
  );
  await fetchImpl("https://example.invalid/v1/messages");
  assert.equal(sink.headerModel, "stale");
});
