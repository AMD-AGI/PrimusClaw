// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The opted-in branch, in its own file because the value is read at import.
import test from "node:test";
import assert from "node:assert/strict";

process.env.LLM_API_STYLE = "openai";
process.env.LLM_CACHE_STYLE = "anthropic";
process.env.OPENAI_BASE_URL = "https://gateway.example/api/v1/llm-proxy/v1";
const cfg = await import("../src/config.js");

test("declaring the backend anthropic turns markers on for the openai wire", () => {
  assert.equal(cfg.LLM_CACHE_STYLE, "anthropic");
  assert.equal(cfg.OPENAI_ANTHROPIC_MARKERS, true);
});

test("an explicit OPENAI_BASE_URL is not the fallback", () => {
  assert.equal(cfg.openAiBaseUrlFellBack(), false);
});
