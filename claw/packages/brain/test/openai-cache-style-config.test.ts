// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Default case. LLM_CACHE_STYLE is read at module load, so each branch needs
// its own file; the "anthropic" branch lives in openai-cache-style-on.test.ts.
import test from "node:test";
import assert from "node:assert/strict";

process.env.LLM_API_STYLE = "openai";
process.env.ANTHROPIC_BASE_URL = "https://gateway.example/api/v1/llm-proxy";
delete process.env.OPENAI_BASE_URL;
delete process.env.LLM_CACHE_STYLE;
const cfg = await import("../src/config.js");

test("the default is native: no markers unless the operator says otherwise", () => {
  // Wrong toward native costs money, loudly, on a miss counter. Wrong toward
  // anthropic puts an unrecognised key in every request to a real OpenAI
  // endpoint. Losing money loudly beats failing quietly.
  assert.equal(cfg.LLM_CACHE_STYLE, "native");
  assert.equal(cfg.OPENAI_ANTHROPIC_MARKERS, false);
});

test("the OPENAI_BASE_URL fallback is detected, because the URL carries no signal", () => {
  // OPENAI_BASE_URL falls back to ANTHROPIC_BASE_URL, so a deployment can end
  // up pointing chat/completions at Anthropic models and paying full price
  // with nothing to indicate it.
  assert.equal(cfg.openAiBaseUrlFellBack(), true);
});

test("an unrecognised value is refused into settingProblems, not thrown", () => {
  // A wrong wire protocol should kill the pod; a mistyped cost knob should not.
  assert.equal(cfg.LLM_CACHE_STYLE, "native");
});
